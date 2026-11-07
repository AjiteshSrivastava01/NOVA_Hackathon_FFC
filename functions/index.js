// Firebase Cloud Function entry point. Firebase Hosting rewrites /api/** and
// /photos/** to this function (see ../firebase.json).
const { onRequest } = require("firebase-functions/v2/https");
const { createApp } = require("./src/app");
const { createFirestoreStore } = require("./src/store/firestore");

const app = createApp(createFirestoreStore());

exports.api = onRequest({ region: "us-central1", memory: "512MiB", timeoutSeconds: 60 }, app);
