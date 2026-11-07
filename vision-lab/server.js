// Vision Lab: a standalone test page for the vision model.
// Uses ../functions/src (vision.js, matching.js, menu.js) read-only, so it tests
// exactly what the real app runs. No npm packages needed.
//
//   node server.js                 -> http://localhost:8090
//
// Env vars:
//   OPENROUTER_API_KEY        required (locally it's read from functions/vision.local.env)
//   OPENROUTER_VISION_MODEL   optional; otherwise the team default in vision.js
//   LAB_PASSWORD              set this when hosting publicly so strangers can't spend your credit
//   PORT                      default 8090

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const vision = require("../functions/src/vision");
const { evaluate, expandOrder } = require("../functions/src/matching");
const { MENU, expectedComponents } = require("../functions/src/menu");

const PORT = +(process.env.PORT || 8090);
const PASSWORD = process.env.LAB_PASSWORD || "";
const MAX_BODY = 12 * 1024 * 1024;
const INDEX = path.join(__dirname, "public", "index.html");

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
      if (size > MAX_BODY) { reject(Object.assign(new Error("Photo too large (max 12 MB)"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function passwordOk(req) {
  if (!PASSWORD) return true;
  const given = Buffer.from(String(req.headers["x-lab-password"] || ""));
  const want = Buffer.from(PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const currentModel = () => process.env.OPENROUTER_VISION_MODEL || vision.DEFAULT_MODEL;

async function inspect(body) {
  const items = (body.order?.items || []).map((l, i) => ({
    line_id: i + 1, menu_id: l.menu_id, qty: Math.max(1, Math.min(10, parseInt(l.qty, 10) || 1)), modifiers: l.modifiers || {},
  }));
  if (!items.length) throw Object.assign(new Error("Add at least one dish to the order"), { status: 422 });
  for (const l of items) {
    try { expectedComponents(l.menu_id, l.modifiers); }
    catch (e) { throw Object.assign(new Error(e.message), { status: 422 }); }
  }
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/s.exec(body.photo || "");
  if (!m) throw Object.assign(new Error("Take or choose a photo first"), { status: 422 });
  const model = body.model ? String(body.model).trim() : undefined;
  if (model && !/^[\w.-]+\/[\w.:-]+$/.test(model)) throw Object.assign(new Error("Model id looks wrong (expected provider/model)"), { status: 422 });

  const order = { items };
  const t0 = Date.now();
  const observations = await vision.analyze(Buffer.from(m[2], "base64"), m[1], order, { model, throwOnError: true });
  if (!observations) throw Object.assign(new Error("No OPENROUTER_API_KEY on the server"), { status: 500 });
  const { verdict, reasons } = evaluate(items, observations);
  return { verdict, reasons, observations, expected: expandOrder(items), total_ms: Date.now() - t0 };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, fs.readFileSync(INDEX), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { menu: MENU, model: currentModel(), password_required: !!PASSWORD, key_set: !!process.env.OPENROUTER_API_KEY });
    }
    if (req.method === "POST" && url.pathname === "/api/inspect") {
      if (!passwordOk(req)) return send(res, 401, { error: "Wrong or missing lab password" });
      return send(res, 200, await inspect(await readJson(req)));
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    const status = e.status || 502;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Vision Lab on http://localhost:${PORT}`);
  console.log(`  model: ${currentModel()}`);
  console.log(`  key:   ${process.env.OPENROUTER_API_KEY ? "set" : "MISSING - add it to functions/vision.local.env"}`);
  console.log(`  password: ${PASSWORD ? "on" : "off (set LAB_PASSWORD before hosting publicly)"}`);
});
