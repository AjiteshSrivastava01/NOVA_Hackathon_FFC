// Local dev server: API + dashboard on one port, in-memory data by default.
//   npm start                      -> http://localhost:8000, data resets on restart
//   FFC_STORE=firestore npm start  -> use real Firestore (needs `gcloud auth application-default login`
//                                     and GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT set)
const path = require("node:path");
const express = require("express");
const { createApp } = require("./src/app");

const store = process.env.FFC_STORE === "firestore"
  ? require("./src/store/firestore").createFirestoreStore()
  : require("./src/store/memory").createMemoryStore();

const app = createApp(store);
app.use(express.static(path.join(__dirname, "..", "frontend")));

const port = +(process.env.PORT || 8000);
app.listen(port, () => console.log(`FFC Kitchen on http://localhost:${port} (store: ${store.kind})`));
