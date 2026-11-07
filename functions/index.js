// Firebase Cloud Function entry point (project: nova-ffc). Firebase Hosting
// rewrites /api/** and /photos/** to this function (see ../firebase.json).
//
// Data lives in Firestore, photos in Cloud Storage (src/store/firestore.js).
// Secrets/config (set once, before the first deploy):
//   firebase functions:secrets:set OPENROUTER_API_KEY     <- vision (required)
//   functions/.env.nova-ffc  (git-ignored, optional):
//     OPENROUTER_VISION_MODEL=google/gemini-3.8-flash
//     LAB_PASSWORD=...        <- protects /api/vision/describe on the public site
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { createApp } = require("./src/app");
const { createFirestoreStore } = require("./src/store/firestore");

const OPENROUTER_API_KEY = defineSecret("OPENROUTER_API_KEY");
const app = createApp(createFirestoreStore());

exports.api = onRequest(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, secrets: [OPENROUTER_API_KEY] },
  app,
);
