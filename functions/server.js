// Local server: API + dashboard + Vision Lab on one port.
//
//   npm start  -> http://localhost:8000          (dashboard)
//                 http://localhost:8000/vision-lab/
//
// Where data goes is set in functions/vision.local.env (git-ignored):
//   (nothing)             -> in memory, resets on restart
//   FFC_STORE=firestore   -> shared Firestore database (project nova-ffc, free Spark plan).
//                            Needs functions/firebase-key.local.json (service-account key).
//                            Photos are processed here and stay on this computer;
//                            only the results (strings, items, statuses) go to Firestore.
const path = require("node:path");
const express = require("express");
const { createApp } = require("./src/app"); // loads vision.local.env (via src/vision.js)

const store = process.env.FFC_STORE === "firestore"
  ? require("./src/store/firestore").createFirestoreStore({ photos: "local", cache: true })
  : require("./src/store/memory").createMemoryStore();

const app = createApp(store);
app.use(express.static(path.join(__dirname, "..", "frontend")));

const port = +(process.env.PORT || 8000);
app.listen(port, () => {
  console.log(`FFC Kitchen on http://localhost:${port}  (Vision Lab: http://localhost:${port}/vision-lab/)`);
  console.log(`  data:   ${store.kind === "firestore" ? `Firestore (${store.project}), photos kept on this computer` : "in memory (set FFC_STORE=firestore to share via Firestore)"}`);
  console.log(`  vision: ${process.env.OPENROUTER_API_KEY ? "OpenRouter key set" : "no OPENROUTER_API_KEY (sample results only)"}`);
});
