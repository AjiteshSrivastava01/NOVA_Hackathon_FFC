// Firestore + Cloud Storage store, used when deployed.
//
// Store contract (memory.js implements the same):
//   get(collection, id)              -> doc | null
//   list(collection, {orderBy, desc, limit}) -> docs
//   tx(async t => ...)               -> atomic; t has get, list, nextId, set, update.
//                                       Do ALL reads (get/list/nextId) before any write
//                                       (set/update) -- Firestore requires it.
//   reset()
//   savePhoto(name, buffer, contentType) / readPhoto(name) -> {buffer, contentType} | null

const admin = require("firebase-admin");

function createFirestoreStore() {
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  const bucket = () => admin.storage().bucket();
  const ref = (c, id) => db.collection(c).doc(String(id));
  const data = (snap) => (snap.exists ? snap.data() : null);

  return {
    kind: "firestore",
    async get(c, id) { return data(await ref(c, id).get()); },

    async list(c, { orderBy, desc, limit } = {}) {
      let q = db.collection(c);
      if (orderBy) q = q.orderBy(orderBy, desc ? "desc" : "asc");
      if (limit) q = q.limit(limit);
      return (await q.get()).docs.map((d) => d.data());
    },

    tx(fn) {
      return db.runTransaction(async (tr) => fn({
        get: async (c, id) => data(await tr.get(ref(c, id))),
        list: async (c) => (await tr.get(db.collection(c))).docs.map((d) => d.data()),
        nextId: async (c) => {
          const counter = ref("counters", c);
          const n = ((data(await tr.get(counter)) || {}).n || 0) + 1;
          tr.set(counter, { n });
          return n;
        },
        set: (c, id, v) => { tr.set(ref(c, id), v); },
        update: (c, id, v) => { tr.update(ref(c, id), v); },
      }));
    },

    async reset() {
      for (const c of ["orders", "inspections", "events", "counters", "cubbies"]) {
        await db.recursiveDelete(db.collection(c));
      }
      await bucket().deleteFiles({ prefix: "photos/" }).catch(() => {});
    },

    async savePhoto(name, buffer, contentType) {
      await bucket().file(`photos/${name}`).save(buffer, { contentType, resumable: false });
    },

    async readPhoto(name) {
      const file = bucket().file(`photos/${name}`);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [[buffer], [meta]] = await Promise.all([file.download(), file.getMetadata()]);
      return { buffer, contentType: meta.contentType };
    },
  };
}

module.exports = { createFirestoreStore };
