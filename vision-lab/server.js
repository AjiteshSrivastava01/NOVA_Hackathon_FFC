// Vision Lab: photo -> order string, the same way voice turns speech into a string.
// Uses ../functions/src (vision.js, vision-string.js, menu.js) read-only, so it
// runs exactly what the real app runs. No npm packages needed.
//
//   node server.js                 -> http://localhost:8090
//
// API (for the integration person; mirrors the voice app's { ok, summary } replies):
//   POST /api/vision/describe  { photo: "data:image/jpeg;base64,...", model? }
//        -> { ok, summary: "2× Burger (no lettuce), Fries", items: [{name, quantity, notes}],
//             retake_reason, model, latency_ms, cost_usd, id, photo_url }
//   POST /api/vision/compare   { ordered: <voice summary string or items>, seen: <string or items> }
//        -> { match, missing: [...], extra: [...] }
//   GET  /api/vision/results   -> recent results (FIREBASE TODO: from Firestore)
//
// Env vars:
//   OPENROUTER_API_KEY        required (locally read from functions/vision.local.env)
//   OPENROUTER_VISION_MODEL   optional; otherwise the team default in vision.js
//   LAB_PASSWORD              set this when hosting publicly so strangers can't spend your credit
//   PORT                      default 8090
//   USE_FIREBASE, FIREBASE_*  see firebase.js

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const vision = require("../functions/src/vision");
const { parseSummary, compareOrders } = require("../functions/src/vision-string");
const { MENU } = require("../functions/src/menu");
const store = require("./firebase");

const PORT = +(process.env.PORT || 8090);
const PASSWORD = process.env.LAB_PASSWORD || "";
const MAX_BODY = 12 * 1024 * 1024;
const INDEX = path.join(__dirname, "public", "index.html");

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "Photo too large (max 12 MB)")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new HttpError(400, "Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function checkPassword(req) {
  if (!PASSWORD) return;
  const given = Buffer.from(String(req.headers["x-lab-password"] || ""));
  const want = Buffer.from(PASSWORD);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(401, "Wrong or missing lab password");
}

const currentModel = () => process.env.OPENROUTER_VISION_MODEL || vision.DEFAULT_MODEL;
const asItems = (v) => (typeof v === "string" ? parseSummary(v) : Array.isArray(v) ? v : []);

async function describe(body) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/s.exec(body.photo || "");
  if (!m) throw new HttpError(422, "Send a photo as a data URL (data:image/jpeg;base64,...)");
  const model = body.model ? String(body.model).trim() : undefined;
  if (model && !/^[\w.-]+\/[\w.:-]+$/.test(model)) throw new HttpError(422, "Model id looks wrong (expected provider/model)");
  const buffer = Buffer.from(m[2], "base64");
  const result = await vision.describePhoto(buffer, m[1], { model, throwOnError: true });
  if (!result) throw new HttpError(500, "No OPENROUTER_API_KEY on the server");
  const saved = await store.saveResult(result, buffer, m[1]);
  return { ...result, id: saved.id, photo_url: saved.photo_url };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, fs.readFileSync(INDEX), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { model: currentModel(), password_required: !!PASSWORD, key_set: !!process.env.OPENROUTER_API_KEY,
        storage: store.storageMode(), menu: Object.values(MENU).map((d) => d.name) });
    }
    if (req.method === "GET" && url.pathname === "/api/vision/results") return send(res, 200, await store.listResults(30));
    if (req.method === "GET" && url.pathname.startsWith("/photos/")) {
      const p = await store.getPhoto(url.pathname.slice(8));
      return p ? send(res, 200, p.buffer, p.contentType) : send(res, 404, { error: "Not found" });
    }
    if (req.method === "POST" && url.pathname === "/api/vision/describe") {
      checkPassword(req);
      return send(res, 200, await describe(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/vision/compare") {
      const b = await readJson(req);
      return send(res, 200, compareOrders(asItems(b.ordered), asItems(b.seen)));
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    const status = e.status || 502;
    if (status >= 500) console.error(e);
    send(res, status, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Vision Lab on http://localhost:${PORT}`);
  console.log(`  model:    ${currentModel()}`);
  console.log(`  key:      ${process.env.OPENROUTER_API_KEY ? "set" : "MISSING - add it to functions/vision.local.env"}`);
  console.log(`  storage:  ${store.storageMode()}`);
  console.log(`  password: ${PASSWORD ? "on" : "off (set LAB_PASSWORD before hosting publicly)"}`);
});
