// FFC kitchen API (Express).
//
// Integration contract (do not break without telling the team):
//   POST /api/orders                    save a confirmed order
//   GET  /api/orders                    populate the dashboard
//   POST /api/orders/:id/inspect        inspect a photo against the SELECTED order
//   POST /api/orders/:id/assign-cubby   reserve a cubby (verified, or staff override)
//   POST /api/orders/:id/pickup         confirm pickup, release the cubby

const crypto = require("node:crypto");
const express = require("express");
const { MENU, expectedComponents } = require("./menu");
const matching = require("./matching");
const vision = require("./vision");
const voice = require("./voice");

const CUBBY_COUNT = +(process.env.FFC_CUBBIES || 8);
const DONE = ["in_cubby", "picked_up"];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => new Date().toISOString();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function createApp(store) {
  const app = express();
  app.use(express.json({ limit: "15mb" })); // photos arrive as base64

  // ---------- helpers ----------
  let cubbiesReady = null;
  function ensureCubbies() {
    cubbiesReady ||= store.tx(async (t) => {
      const have = new Set((await t.list("cubbies")).map((c) => c.id));
      for (let i = 1; i <= CUBBY_COUNT; i++) {
        if (!have.has(i)) t.set("cubbies", i, { id: i, label: `C${i}`, order_id: null });
      }
    }).catch((e) => { cubbiesReady = null; throw e; });
    return cubbiesReady;
  }

  const route = (fn) => async (req, res, next) => {
    try {
      await ensureCubbies();
      const out = await fn(req, res);
      if (out !== undefined) res.status(res.statusCode || 200).json(out);
    } catch (e) { next(e); }
  };

  function logEvent(t, orderId, kind, detail = null) {
    const created_at = now();
    t.set("events", `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      { order_id: orderId, kind, detail, created_at });
  }

  async function getOrder(t, id) {
    const o = await t.get("orders", id);
    if (!o) throw new HttpError(404, `Order ${id} not found`);
    return o;
  }

  function withInspections(order, allInspections) {
    const inspections = allInspections.filter((i) => i.order_id === order.id).sort((a, b) => b.id - a.id);
    return { ...order, inspections, latest_inspection: inspections[0] || null };
  }

  async function fullOrder(id) {
    const order = await store.get("orders", id);
    if (!order) throw new HttpError(404, `Order ${id} not found`);
    return withInspections(order, await store.list("inspections"));
  }

  function validateItems(items) {
    if (!Array.isArray(items) || !items.length) throw new HttpError(422, "items must be a non-empty list");
    return items.map((line, i) => {
      const qty = line.qty == null ? 1 : line.qty;
      if (!MENU[line.menu_id]) throw new HttpError(422, `Unknown menu_id '${line.menu_id}'`);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(422, "qty must be an integer 1-20");
      const modifiers = line.modifiers || {};
      try { expectedComponents(line.menu_id, modifiers); } catch (e) { throw new HttpError(422, e.message); }
      return { line_id: i + 1, menu_id: line.menu_id, qty, modifiers };
    });
  }

  async function createOrder({ customer_name, items, source = "manual" }) {
    const name = String(customer_name || "").trim();
    if (!name || name.length > 60) throw new HttpError(422, "customer_name is required (max 60 chars)");
    const clean = validateItems(items);
    const id = await store.tx(async (t) => {
      const id = await t.nextId("orders");
      t.set("orders", id, {
        id, customer_name: name, items: clean, source, status: "pending",
        cubby_id: null, created_at: now(), picked_up_at: null,
      });
      logEvent(t, id, "created", source);
      return id;
    });
    return fullOrder(id);
  }

  /** Save an inspection RECORD (never overwrites) and update order status. */
  async function recordInspection(orderId, observations, source, photoPath, reassignedFrom = null) {
    const id = await store.tx(async (t) => {
      // reads first (Firestore rule)
      const order = await getOrder(t, orderId);
      if (DONE.includes(order.status)) throw new HttpError(409, `Order ${orderId} is already ${order.status}`);
      const result = matching.evaluate(order.items, observations);
      let swap = null;
      if (result.verdict !== matching.PASS) {
        const others = (await t.list("orders")).filter((o) => o.id !== order.id && !DONE.includes(o.status));
        swap = matching.suggestSwap(observations, others);
      }
      const id = await t.nextId("inspections");
      // writes
      t.set("inspections", id, {
        id, order_id: order.id, photo_path: photoPath, source, observations,
        verdict: result.verdict, reasons: result.reasons, swap_suggestion: swap,
        reassigned_from: reassignedFrom, created_at: now(),
      });
      t.update("orders", order.id, { status: result.verdict === matching.PASS ? "verified" : "needs_attention" });
      logEvent(t, order.id, "inspected", `${source}: ${result.verdict}`);
      return id;
    });
    return store.get("inspections", id);
  }

  /** Fake what vision would report. mode: correct | mistake | hidden. */
  function sampleObservations(order, mode) {
    const items = matching.expandOrder(order.items).map((u) => ({
      menu_id: u.menu_id,
      components: Object.fromEntries(Object.entries(u.expected).map(([c, v]) => [c, v ? "present" : "absent"])),
    }));
    if (mode === "mistake") {
      const flippable = [];
      items.forEach((it, i) => Object.keys(it.components).forEach((c) => {
        if (MENU[it.menu_id].components[c].removable) flippable.push([i, c]);
      }));
      if (flippable.length) {
        const [i, c] = pick(flippable);
        items[i].components[c] = items[i].components[c] === "present" ? "absent" : "present";
      } else {
        items.pop();
      }
    } else if (mode === "hidden") {
      const it = items.find((x) => "lettuce" in x.components) || items[0];
      const c = "lettuce" in it.components ? "lettuce" : Object.keys(it.components)[0];
      it.components[c] = "unknown";
    }
    return { items, notes: `sample inspection (${mode})` };
  }

  function decodeBase64(s) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(s);
    return m ? { buffer: Buffer.from(m[2], "base64"), contentType: m[1] }
      : { buffer: Buffer.from(s, "base64"), contentType: "image/jpeg" };
  }

  async function savePhoto({ buffer, contentType }) {
    const ext = (contentType.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
    const name = `${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
    await store.savePhoto(name, buffer, contentType);
    return `/photos/${name}`;
  }

  const id = (req) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n)) throw new HttpError(422, "id must be a number");
    return n;
  };

  // ---------- menu ----------
  app.get("/api/menu", route(() => MENU));

  // ---------- orders ----------
  app.post("/api/orders", route(async (req, res) => {
    res.status(201);
    return createOrder(req.body || {});
  }));

  app.post("/api/orders/demo", route(async (req, res) => {
    const lines = [{
      menu_id: "burger", qty: pick([1, 1, 2]),
      modifiers: pick([{}, { lettuce: "no" }, { onion: "add" }, { cheese: "no", pickles: "add" }]),
    }];
    if (Math.random() < 0.7) lines.push({ menu_id: "fries", qty: 1 });
    if (Math.random() < 0.4) lines.push({ menu_id: pick(["chicken_sandwich", "salad"]), qty: 1 });
    if (Math.random() < 0.5) lines.push({ menu_id: "soda", qty: 1 });
    res.status(201);
    return createOrder({
      customer_name: pick(["Ava", "Ben", "Chloe", "Dev", "Ella", "Finn", "Grace", "Hugo", "Isla", "Jay"]),
      items: lines, source: "demo",
    });
  }));

  app.get("/api/orders", route(async (req) => {
    const includeDone = req.query.include_done === "true";
    const [orders, inspections] = await Promise.all([
      store.list("orders", { orderBy: "id" }), store.list("inspections"),
    ]);
    return orders.filter((o) => includeDone || o.status !== "picked_up").map((o) => withInspections(o, inspections));
  }));

  app.get("/api/orders/:id", route((req) => fullOrder(id(req))));

  // Body (JSON): { observations?, source?, photo_base64?, fallback_sample? }
  //   photo_base64 may be a data URL ("data:image/jpeg;base64,...") or bare base64.
  //   With no observations, vision.analyze() is asked. If vision isn't wired yet and
  //   fallback_sample is "correct" | "mistake" | "hidden", fake observations are used
  //   so the camera path can be tested end to end.
  // Every call creates a NEW inspection record -- retakes never overwrite.
  app.post("/api/orders/:id/inspect", route(async (req) => {
    const orderId = id(req);
    const body = req.body || {};
    let { observations = null, source = "vision" } = body;
    const photo = body.photo_base64 ? decodeBase64(body.photo_base64) : null;
    const order = await fullOrder(orderId);
    if (DONE.includes(order.status)) throw new HttpError(409, `Order ${orderId} is already ${order.status}`);
    if (!observations) {
      if (!photo) throw new HttpError(422, "Send a photo, observations, or both");
      try {
        observations = await vision.analyze(photo.buffer, photo.contentType, order);
      } catch (e) {
        console.error("vision failed:", e);
        throw new HttpError(502, `Vision model failed: ${e.message}. Retake, or use a sample inspection.`);
      }
      if (!observations && ["correct", "mistake", "hidden"].includes(body.fallback_sample)) {
        observations = sampleObservations(order, body.fallback_sample);
        source = "sample+photo";
      }
      if (!observations) {
        throw new HttpError(501, "Vision model not wired up yet (functions/src/vision.js). Send observations alongside the photo for now.");
      }
    }
    const photoPath = photo ? await savePhoto(photo) : null;
    return recordInspection(orderId, observations, source, photoPath);
  }));

  // Dashboard button: pretend vision looked at the meal.
  app.post("/api/orders/:id/inspect/sample", route(async (req) => {
    const mode = req.query.mode || "correct";
    if (!["correct", "mistake", "hidden"].includes(mode)) throw new HttpError(422, "mode must be correct | mistake | hidden");
    const order = await fullOrder(id(req));
    return recordInspection(order.id, sampleObservations(order, mode), "sample", null);
  }));

  // Staff confirms a suggested swap. The original inspection is kept; a new
  // linked inspection is created on the target order.
  app.post("/api/inspections/:id/reassign", route(async (req) => {
    const insp = await store.get("inspections", id(req));
    if (!insp) throw new HttpError(404, "Inspection not found");
    const targetId = Number(req.body?.target_order_id);
    if (!Number.isInteger(targetId)) throw new HttpError(422, "target_order_id is required");
    const out = await recordInspection(targetId, insp.observations, "reassigned", insp.photo_path, insp.id);
    await store.tx(async (t) => logEvent(t, insp.order_id, "meal_reassigned", `to order ${targetId}`));
    return out;
  }));

  // Body: { override?: boolean, staff_note?: string }
  app.post("/api/orders/:id/assign-cubby", route(async (req) => {
    const orderId = id(req);
    const { override = false, staff_note = null } = req.body || {};
    const cubby = await store.tx(async (t) => {
      const order = await getOrder(t, orderId);
      const cubbies = await t.list("cubbies");
      if (DONE.includes(order.status)) throw new HttpError(409, `Order ${orderId} is already ${order.status}`);
      if (order.status !== "verified" && !override) {
        throw new HttpError(409, "Order is not verified. Re-inspect, or pass override=true with a staff note.");
      }
      const free = cubbies.filter((c) => c.order_id == null).sort((a, b) => a.id - b.id)[0];
      if (!free) throw new HttpError(409, "No free cubbies");
      t.update("cubbies", free.id, { order_id: orderId });
      t.update("orders", orderId, { status: "in_cubby", cubby_id: free.id });
      logEvent(t, orderId, "cubby_assigned",
        `cubby ${free.label}` + (override ? ` (STAFF OVERRIDE: ${staff_note || "no note"})` : ""));
      return { ...free, order_id: orderId };
    });
    return { ...(await fullOrder(orderId)), cubby };
  }));

  app.post("/api/orders/:id/pickup", route(async (req) => {
    const orderId = id(req);
    await store.tx(async (t) => {
      const order = await getOrder(t, orderId);
      if (order.status !== "in_cubby") throw new HttpError(409, `Order ${orderId} is ${order.status}, not in a cubby`);
      t.update("cubbies", order.cubby_id, { order_id: null });
      t.update("orders", orderId, { status: "picked_up", picked_up_at: now() });
      logEvent(t, orderId, "picked_up", `cubby C${order.cubby_id}`);
    });
    return fullOrder(orderId);
  }));

  // ---------- cubbies / events / reset ----------
  app.get("/api/cubbies", route(async () => {
    const [cubbies, orders] = await Promise.all([store.list("cubbies", { orderBy: "id" }), store.list("orders")]);
    const byId = new Map(orders.map((o) => [o.id, o]));
    return cubbies.map((c) => ({ ...c, customer_name: byId.get(c.order_id)?.customer_name ?? null }));
  }));

  app.get("/api/events", route(async (req) =>
    store.list("events", { orderBy: "created_at", desc: true, limit: Math.min(+req.query.limit || 30, 200) })));

  // Wipe everything (demo convenience).
  app.post("/api/reset", route(async () => {
    await store.reset();
    cubbiesReady = null;
    await ensureCubbies();
    return { ok: true };
  }));

  // ---------- voice (stub hooks for the voice team) ----------
  // Transcript -> draft order. The dashboard shows it for confirmation before POST /api/orders.
  app.post("/api/voice/parse", route(async (req) => {
    const transcript = req.body?.transcript;
    if (typeof transcript !== "string" || !transcript.trim()) throw new HttpError(422, "transcript is required");
    return voice.parseOrder(transcript);
  }));

  // Body: { audio_base64: "data:audio/webm;base64,..." }
  app.post("/api/voice/transcribe", route(async (req) => {
    const raw = req.body?.audio_base64;
    if (!raw) throw new HttpError(422, "audio_base64 is required");
    const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
    const buffer = Buffer.from(m ? m[2] : raw, "base64");
    const transcript = await voice.transcribe(buffer, m ? m[1] : "audio/webm");
    return {
      bytes: buffer.length, transcript,
      note: transcript ? null : "Speech-to-text not wired yet (functions/src/voice.js). Audio was received OK.",
    };
  }));

  // ---------- photos ----------
  app.get("/photos/:name", route(async (req, res) => {
    if (!/^[a-z0-9]+\.[a-z0-9]+$/.test(req.params.name)) throw new HttpError(404, "Not found");
    const photo = await store.readPhoto(req.params.name);
    if (!photo) throw new HttpError(404, "Not found");
    res.set("Content-Type", photo.contentType).set("Cache-Control", "private, max-age=86400").send(photo.buffer);
  }));

  // ---------- errors ----------
  app.use("/api", (req, res) => res.status(404).json({ detail: "Not found" }));
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === "entity.too.large" ? 413 : err.type === "entity.parse.failed" ? 400 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ detail: status === 500 ? "Internal error" : err.message });
  });

  return app;
}

module.exports = { createApp };
