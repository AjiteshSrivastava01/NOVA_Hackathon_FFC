// =============================================================================
//  STORAGE FOR VISION RESULTS: placeholder until Firebase is set up
// =============================================================================
//
//  Right now results and photos live in memory: they vanish when the server
//  restarts and aren't shared between computers. Every place that must change
//  when Firebase exists is marked  "FIREBASE TODO".
//
//  When Firebase is ready:
//    1. cd vision-lab && npm install firebase-admin
//    2. Fill in FIREBASE_CONFIG below (or set the env vars it reads).
//    3. Credentials: on Firebase/Cloud Run nothing is needed; locally run
//         gcloud auth application-default login
//       or point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON file
//       (never commit that file).
//    4. Set USE_FIREBASE=true (env var) and uncomment the FIREBASE TODO blocks.
//
//  Document shape stored per photo (collection "vision_results"). It's the same
//  shape the voice app uses for orders, so the integration step can compare them:
//    {
//      id:           "a1b2c3...",
//      created_at:   "2026-11-07T20:52:34.000Z",
//      summary:      "2× Burger (no lettuce), Fries",           // <- the string
//      items:        [{ name: "Burger", quantity: 2, notes: "no lettuce" }, ...],
//      ok:           true,                                     // false = retake
//      retake_reason: null,
//      model:        "google/gemini-3.8-flash",
//      latency_ms:   2310,
//      cost_usd:     0.0042,
//      photo_url:    "/photos/a1b2c3..."    // FIREBASE TODO: becomes a Storage URL
//      order_id:     null                   // FIREBASE TODO: link to the ticket/voice order
//    }
// =============================================================================

const crypto = require("node:crypto");

// FIREBASE TODO: fill these in (or set the env vars).
const FIREBASE_CONFIG = {
  projectId: process.env.FIREBASE_PROJECT_ID || "YOUR-FIREBASE-PROJECT-ID",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "YOUR-FIREBASE-PROJECT-ID.firebasestorage.app",
  resultsCollection: "vision_results",
  photosFolder: "vision-photos",
};
const USE_FIREBASE = process.env.USE_FIREBASE === "true";

// ---------- FIREBASE TODO: uncomment when firebase-admin is installed ----------
// const admin = require("firebase-admin");
// if (USE_FIREBASE && !admin.apps.length) {
//   admin.initializeApp({ projectId: FIREBASE_CONFIG.projectId, storageBucket: FIREBASE_CONFIG.storageBucket });
// }
// const db = () => admin.firestore();
// const bucket = () => admin.storage().bucket();
// -----------------------------------------------------------------------------

// In-memory placeholder (used while USE_FIREBASE is false).
const MAX_KEEP = 50;
const memResults = [];          // newest first
const memPhotos = new Map();    // id -> { buffer, contentType }

async function saveResult(result, photoBuffer, contentType) {
  const id = crypto.randomUUID().replace(/-/g, "");
  const doc = {
    id,
    created_at: new Date().toISOString(),
    summary: result.summary,
    items: result.items,
    ok: result.ok,
    retake_reason: result.retake_reason,
    model: result.model,
    latency_ms: result.latency_ms,
    cost_usd: result.cost_usd,
    photo_url: `/photos/${id}`,
    order_id: null,
  };

  if (USE_FIREBASE) {
    // FIREBASE TODO: upload the photo to Storage and save the doc to Firestore.
    // const file = bucket().file(`${FIREBASE_CONFIG.photosFolder}/${id}.jpg`);
    // await file.save(photoBuffer, { contentType, resumable: false });
    // doc.photo_url = `gs://${FIREBASE_CONFIG.storageBucket}/${FIREBASE_CONFIG.photosFolder}/${id}.jpg`;
    // await db().collection(FIREBASE_CONFIG.resultsCollection).doc(id).set(doc);
    // return doc;
    throw new Error("USE_FIREBASE=true but the Firebase code in vision-lab/firebase.js is still commented out");
  }

  memPhotos.set(id, { buffer: photoBuffer, contentType });
  memResults.unshift(doc);
  for (const old of memResults.splice(MAX_KEEP)) memPhotos.delete(old.id);
  return doc;
}

async function listResults(limit = 20) {
  if (USE_FIREBASE) {
    // FIREBASE TODO:
    // const snap = await db().collection(FIREBASE_CONFIG.resultsCollection)
    //   .orderBy("created_at", "desc").limit(limit).get();
    // return snap.docs.map((d) => d.data());
  }
  return memResults.slice(0, limit);
}

async function getPhoto(id) {
  if (USE_FIREBASE) {
    // FIREBASE TODO: photos are served straight from Storage (photo_url), so
    // this route isn't needed. Delete it, or stream from bucket() here.
  }
  return memPhotos.get(id) || null;
}

const storageMode = () => (USE_FIREBASE ? `firebase (${FIREBASE_CONFIG.projectId})` : "in-memory placeholder (FIREBASE TODO)");

module.exports = { saveResult, listResults, getPhoto, storageMode, FIREBASE_CONFIG };
