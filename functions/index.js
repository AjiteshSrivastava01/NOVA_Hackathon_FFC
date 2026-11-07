// Firebase Cloud Function entry point. Firebase Hosting rewrites /api/** and
// /photos/** to this function (see ../firebase.json).
//
// Vision key: firebase functions:secrets:set OPENROUTER_API_KEY
// Vision model: set OPENROUTER_VISION_MODEL in functions/.env (not secret).
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
