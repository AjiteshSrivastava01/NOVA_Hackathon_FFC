// Firestore store (project nova-ffc).
//
// Two ways to run it:
//   * Local, free Spark plan (functions/server.js with FFC_STORE=firestore):
//       createFirestoreStore({ photos: "local", cache: true })
//       - data goes to Firestore; photos stay on this computer (functions/local-photos/)
//       - credentials from functions/firebase-key.local.json (service-account key, git-ignored)
//       - cache: live listeners keep a copy of each collection in memory, so the
//         dashboards' polling doesn't burn Spark's 50k reads/day
//   * Deployed Cloud Function (Blaze plan, index.js):
//       createFirestoreStore()  -> photos in Cloud Storage, no cache
//
// Store contract (memory.js implements the same):
//   get(collection, id)              -> doc | null
//   list(collection, {orderBy, desc, limit}) -> docs
//   tx(async t => ...)               -> atomic; t has get, list, nextId, set, update.
//                                       Do ALL reads (get/list/nextId) before any write
//                                       (set/update) -- Firestore requires it.
//   reset()
//   savePhoto(name, buffer, contentType) / readPhoto(name) -> {buffer, contentType} | null

const fs = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "nova-ffc";
const KEY_FILE = path.join(__dirname, "..", "..", "firebase-key.local.json");
const LOCAL_PHOTO_DIR = path.join(__dirname, "..", "..", "local-photos");
const COLLECTIONS = ["orders", "inspections", "events", "counters", "cubbies", "vision_results"];
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

function initAdmin() {
  if (admin.apps.length) return;
  if (fs.existsSync(KEY_FILE)) {
    // Local: service-account key downloaded from the Firebase console.
    const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id || PROJECT_ID });
  } else {
    // Cloud Functions / emulators / `gcloud auth application-default login`.
    admin.initializeApp(process.env.FIREBASE_CONFIG ? undefined : { projectId: PROJECT_ID });
  }
}

function createFirestoreStore({ photos = "storage", cache = false } = {}) {
  initAdmin();
  const db = admin.firestore();
  if (!db.__ffcConfigured) { // settings() may only be called once per process
    db.settings({ ignoreUndefinedProperties: true });
    db.__ffcConfigured = true;
  }
  const bucket = () => admin.storage().bucket();
  const ref = (c, id) => db.collection(c).doc(String(id));
  const data = (snap) => (snap.exists ? snap.data() : null);

  // ---------- optional live cache (one listener per collection) ----------
  const mirrors = new Map(); // collection -> { docs: Map(id -> data), ready: Promise }
  function mirror(c) {
    if (!mirrors.has(c)) {
      const m = { docs: new Map() };
      m.ready = new Promise((resolve, reject) => {
        let first = true;
        db.collection(c).onSnapshot((snap) => {
          for (const ch of snap.docChanges()) {
            if (ch.type === "removed") m.docs.delete(ch.doc.id);
            else m.docs.set(ch.doc.id, ch.doc.data());
          }
          if (first) { first = false; resolve(); }
        }, (err) => { if (first) reject(err); else console.error(`Firestore listener (${c}) failed:`, err.message); });
      });
      mirrors.set(c, m);
    }
    return mirrors.get(c);
  }
  // Apply our own committed writes right away (the listener catches up a moment later).
  function applyLocal(writes) {
    for (const w of writes) {
      const m = mirrors.get(w.c);
      if (!m) continue;
      const id = String(w.id);
      if (w.op === "set") m.docs.set(id, structuredClone(w.v));
      else m.docs.set(id, { ...(m.docs.get(id) || {}), ...structuredClone(w.v) });
    }
  }

  function sortLimit(docs, { orderBy, desc, limit } = {}) {
    if (orderBy) docs.sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : a[orderBy] > b[orderBy] ? 1 : 0) * (desc ? -1 : 1));
    return limit ? docs.slice(0, limit) : docs;
  }

  return {
    kind: "firestore",
    project: PROJECT_ID,
    photos,

    async get(c, id) { return data(await ref(c, id).get()); },

    async list(c, opts = {}) {
      if (cache) {
        const m = mirror(c);
        await m.ready;
        return sortLimit([...m.docs.values()].map((d) => structuredClone(d)), opts);
      }
      let q = db.collection(c);
      if (opts.orderBy) q = q.orderBy(opts.orderBy, opts.desc ? "desc" : "asc");
      if (opts.limit) q = q.limit(opts.limit);
      return (await q.get()).docs.map((d) => d.data());
    },

    async tx(fn) {
      const writes = [];
      const result = await db.runTransaction(async (tr) => {
        writes.length = 0; // transactions can retry
        return fn({
          get: async (c, id) => data(await tr.get(ref(c, id))),
          list: async (c) => (await tr.get(db.collection(c))).docs.map((d) => d.data()),
          nextId: async (c) => {
            const counter = ref("counters", c);
            const n = ((data(await tr.get(counter)) || {}).n || 0) + 1;
            tr.set(counter, { n });
            writes.push({ op: "set", c: "counters", id: c, v: { n } });
            return n;
          },
          set: (c, id, v) => { tr.set(ref(c, id), v); writes.push({ op: "set", c, id, v }); },
          update: (c, id, v) => { tr.update(ref(c, id), v); writes.push({ op: "update", c, id, v }); },
        });
      });
      if (cache) applyLocal(writes);
      return result;
    },

    async reset() {
      for (const c of COLLECTIONS) await db.recursiveDelete(db.collection(c));
      for (const m of mirrors.values()) m.docs.clear();
      if (photos === "local") fs.rmSync(LOCAL_PHOTO_DIR, { recursive: true, force: true });
      else await bucket().deleteFiles({ prefix: "photos/" }).catch(() => {});
    },

    async savePhoto(name, buffer, contentType) {
      if (photos === "local") {
        fs.mkdirSync(LOCAL_PHOTO_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_PHOTO_DIR, path.basename(name)), buffer);
        return;
      }
      await bucket().file(`photos/${name}`).save(buffer, { contentType, resumable: false });
    },

    async readPhoto(name) {
      if (photos === "local") {
        const file = path.join(LOCAL_PHOTO_DIR, path.basename(name));
        if (!fs.existsSync(file)) return null;
        return { buffer: fs.readFileSync(file), contentType: MIME[path.extname(file).slice(1).toLowerCase()] || "application/octet-stream" };
      }
      const file = bucket().file(`photos/${name}`);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [[buffer], [meta]] = await Promise.all([file.download(), file.getMetadata()]);
      return { buffer, contentType: meta.contentType };
    },
  };
}

module.exports = { createFirestoreStore };
