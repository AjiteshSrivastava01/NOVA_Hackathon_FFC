// In-memory store for local development and tests. Data is lost on restart.
// Same interface as firestore.js -- see that file for the contract.

function createMemoryStore() {
  let cols = {};
  let photos = new Map();
  let lock = Promise.resolve();
  const clone = (v) => (v == null ? null : structuredClone(v));
  const col = (c) => (cols[c] ||= new Map());

  function list(c, { orderBy, desc, limit } = {}) {
    let docs = [...col(c).values()].map(clone);
    if (orderBy) docs.sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : a[orderBy] > b[orderBy] ? 1 : 0) * (desc ? -1 : 1));
    return limit ? docs.slice(0, limit) : docs;
  }

  return {
    kind: "memory",
    async get(c, id) { return clone(col(c).get(String(id))); },
    async list(c, opts) { return list(c, opts); },

    // Runs fn exclusively, so check-then-write logic is safe like a Firestore transaction.
    tx(fn) {
      const run = lock.then(() => {
        const writes = [];
        const t = {
          get: async (c, id) => clone(col(c).get(String(id))),
          list: async (c) => list(c),
          nextId: async (c) => {
            const counter = col("counters").get(c) || { n: 0 };
            const n = counter.n + 1;
            writes.push(() => col("counters").set(c, { n }));
            return n;
          },
          set: (c, id, v) => writes.push(() => col(c).set(String(id), clone(v))),
          update: (c, id, v) => writes.push(() => col(c).set(String(id), { ...col(c).get(String(id)), ...clone(v) })),
        };
        return fn(t).then((result) => { writes.forEach((w) => w()); return result; });
      });
      lock = run.catch(() => {});
      return run;
    },

    async reset() { cols = {}; photos = new Map(); },
    async savePhoto(name, buffer, contentType) { photos.set(name, { buffer, contentType }); },
    async readPhoto(name) { return photos.get(name) || null; },
  };
}

module.exports = { createMemoryStore };
