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
const { parseSummary, compareOrders, toOrderItems, formatSummary } = require("./vision-string");

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

  // level: "info" | "success" | "warning" | "error". The dashboard turns warning/error
  // events into alerts.
  function logEvent(t, orderId, kind, detail = null, level = "info") {
    const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    t.set("events", id, { id, order_id: orderId, kind, detail, level, created_at: now() });
  }

  /** Order lines -> "2× Burger (no lettuce), Fries" */
  function orderText(order) {
    return formatSummary(order.items.map((l) => {
      const dish = MENU[l.menu_id];
      const notes = Object.entries(l.modifiers || {})
        .map(([cid, a]) => `${a === "no" ? "no" : "add"} ${(dish?.components[cid]?.name || cid).toLowerCase()}`).join(", ");
      return { name: dish?.name || l.menu_id, quantity: l.qty, notes: notes || undefined };
    }));
  }

  /** Put an order in the first free cubby. Returns the cubby, or null if all are full. */
  async function assignCubby(orderId, { override = false, staff_note = null, auto = false } = {}) {
    return store.tx(async (t) => {
      const order = await getOrder(t, orderId);
      const cubbies = await t.list("cubbies");
      if (DONE.includes(order.status)) throw new HttpError(409, `Order ${orderId} is already ${order.status}`);
      if (order.status !== "verified" && !override) {
        throw new HttpError(409, "Order is not verified. Re-inspect, or pass override=true with a staff note.");
      }
      const free = cubbies.filter((c) => c.order_id == null).sort((a, b) => a.id - b.id)[0];
      if (!free) {
        if (auto) { logEvent(t, orderId, "no_cubby", `Order #${orderId} is checked but all cubbies are full`, "warning"); return null; }
        throw new HttpError(409, "No free cubbies");
      }
      t.update("cubbies", free.id, { order_id: orderId });
      t.update("orders", orderId, { status: "in_cubby", cubby_id: free.id });
      logEvent(t, orderId, "cubby_assigned",
        `cubby ${free.label}` + (override ? ` (STAFF OVERRIDE: ${staff_note || "no note"})` : ""), "success");
      return { ...free, order_id: orderId };
    });
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

  // Orders are identified by number only (#5). customer_name is kept as an empty
  // field so older clients that send or read it keep working.
  async function createOrder({ items, source = "manual" }) {
    const clean = validateItems(items);
    const id = await store.tx(async (t) => {
      const id = await t.nextId("orders");
      t.set("orders", id, {
        id, customer_name: "", items: clean, source, status: "pending",
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
      observations = await vision.analyze(photo.buffer, photo.contentType, order);
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
    const cubby = await assignCubby(orderId, { override, staff_note });
    return { ...(await fullOrder(orderId)), cubby };
  }));

  app.post("/api/orders/:id/pickup", route(async (req) => {
    const orderId = id(req);
    await store.tx(async (t) => {
      const order = await getOrder(t, orderId);
      if (order.status !== "in_cubby") throw new HttpError(409, `Order ${orderId} is ${order.status}, not in a cubby`);
      t.update("cubbies", order.cubby_id, { order_id: null });
      t.update("orders", orderId, { status: "picked_up", picked_up_at: now() });
      logEvent(t, orderId, "picked_up", `cubby C${order.cubby_id}`, "success");
    });
    return fullOrder(orderId);
  }));

  // ---------- cubbies / events / reset ----------
  app.get("/api/cubbies", route(async () => {
    const [cubbies, orders] = await Promise.all([store.list("cubbies", { orderBy: "id" }), store.list("orders")]);
    const byId = new Map(orders.map((o) => [o.id, o]));
    return cubbies.map((c) => ({ ...c, customer_name: byId.get(c.order_id) ? "" : null }));
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

  // ---------- input station: voice -> order, camera -> check an order off ----------

  // Body: { audio_base64: "data:audio/wav;base64,..." } or { text: "two burgers no lettuce for Sam" }
  // -> { transcript, items (menu format), summary }   (nothing is saved yet:
  //    the station shows it, and on "Add" posts it to POST /api/orders with source "voice")
  app.post("/api/voice/understand", route(async (req) => {
    const b = req.body || {};
    let audio = null, audioFormat = "wav";
    if (b.audio_base64) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(b.audio_base64);
      audio = Buffer.from(m ? m[2] : b.audio_base64, "base64");
      if (m && /mp3|mpeg/.test(m[1])) audioFormat = "mp3";
      if (audio.length < 1000) throw new HttpError(422, "No audio was recorded. Try again and speak clearly.");
    } else if (!b.text || !String(b.text).trim()) {
      throw new HttpError(422, "Send audio_base64 or text");
    }
    let r;
    try {
      r = await voice.understandOrder({ audio, audioFormat, text: b.text ? String(b.text) : undefined });
    } catch (e) {
      console.error("voice/understand failed:", e.message);
      throw new HttpError(502, e.message);
    }
    if (!r.items.length) {
      throw new HttpError(422, `I heard "${r.transcript || "nothing"}" but no menu items. Try again.`);
    }
    return { ...r, summary: orderText({ items: r.items }) };
  }));

  // Body: { photo: "data:image/jpeg;base64,...", order_id? }
  // Finds which open order the meal is (or uses order_id), then:
  //   matches exactly  -> inspection pass, order goes to a free cubby ("checked off")
  //   doesn't match    -> closest order is flagged with the differences (dashboard alert)
  //   also: "possible mix-up" warning when it matches a newer order but is one change
  //   away from an older one (kitchens usually cook in order)
  app.post("/api/check-meal", route(async (req) => {
    const b = req.body || {};
    const raw = b.photo || b.photo_base64;
    if (!raw) throw new HttpError(422, "Send a photo as a data URL");
    const photo = decodeBase64(raw);
    const observations = await vision.analyze(photo.buffer, photo.contentType, null);
    if (!observations) throw new HttpError(501, "Vision needs OPENROUTER_API_KEY (functions/vision.local.env).");
    const seen = formatSummary(toOrderItems(observations));
    const log = (orderId, kind, detail, level) => store.tx(async (t) => logEvent(t, orderId, kind, detail, level));

    if (observations.retake || !observations.items.length) {
      const why = observations.retake_reason || "nothing from the menu in the photo";
      await log(null, "retake", `Photo unclear (${why}). Please retake.`, "warning");
      return { outcome: "retake", message: `Please retake the photo: ${why}.`, seen };
    }

    const open = (await store.list("orders", { orderBy: "id" }))
      .filter((o) => (b.order_id != null ? o.id === Number(b.order_id) : ["pending", "needs_attention"].includes(o.status)));
    if (b.order_id != null && !open.length) throw new HttpError(409, `Order #${b.order_id} isn't waiting for a check`);
    const seenDishes = new Set(observations.items.map((i) => i.menu_id));
    const scored = open.map((o) => {
      const r = matching.evaluate(o.items, observations);
      const overlap = o.items.some((l) => seenDishes.has(l.menu_id));
      return { o, r, overlap, score: r.verdict === matching.PASS ? 0 : r.reasons.length };
    });
    const candidates = b.order_id != null ? scored : scored.filter((x) => x.overlap);
    if (!candidates.length) {
      await log(null, "no_match", `Camera saw "${seen}" but no open order has that.`, "warning");
      return { outcome: "no_match", message: `No open order matches "${seen}".`, seen };
    }

    const photoPath = await savePhoto(photo);
    const exact = candidates.filter((x) => x.r.verdict === matching.PASS).sort((a, b2) => a.o.id - b2.o.id)[0];
    if (exact) {
      const o = exact.o;
      await recordInspection(o.id, observations, "camera", photoPath);
      // one ingredient off (not a different count) on an OLDER ticket -> likely the cook swapped them
      const mixup = candidates.find((x) => x.o.id < o.id && x.r.verdict === matching.FAIL
        && x.r.reasons.length === 1 && !/expected \d+, saw \d+/.test(x.r.reasons[0]));
      if (mixup) {
        await log(mixup.o.id, "possible_mixup",
          `Meal matched Order #${o.id}, but older Order #${mixup.o.id} differs only by: ${mixup.r.reasons[0]}. Check #${mixup.o.id} was made right.`,
          "warning");
      }
      await log(o.id, "checked_off", `Order #${o.id} checked: ${seen}`, "success");
      const cubby = await assignCubby(o.id, { auto: true });
      return {
        outcome: "checked_off", order_id: o.id, seen, cubby,
        message: `✓ Order #${o.id} is correct` + (cubby ? ` → cubby ${cubby.label}` : " (no free cubby)"),
        warning: mixup ? `Possible mix-up with older Order #${mixup.o.id}` : null,
      };
    }

    const best = candidates.sort((a, b2) => a.score - b2.score || a.o.id - b2.o.id)[0];
    const insp = await recordInspection(best.o.id, observations, "camera", photoPath);
    await log(best.o.id, "check_failed",
      `Order #${best.o.id} is wrong: ${insp.reasons.join("; ")}. Ordered: ${orderText(best.o)}. Camera saw: ${seen}.`,
      "error");
    return {
      outcome: "flagged", order_id: best.o.id, seen,
      reasons: insp.reasons, swap_suggestion: insp.swap_suggestion,
      message: `✕ Order #${best.o.id} doesn't match: ${insp.reasons.join("; ")}`,
    };
  }));

  // ---------- vision: photo -> order string (same format as the voice app) ----------
  // Saved to the "vision_results" collection (Firestore when deployed, memory locally);
  // photos go through store.savePhoto (Cloud Storage when deployed).
  const LAB_PASSWORD = process.env.LAB_PASSWORD || "";
  function checkLabPassword(req) {
    if (!LAB_PASSWORD) return;
    const given = Buffer.from(String(req.get("x-lab-password") || ""));
    const want = Buffer.from(LAB_PASSWORD);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new HttpError(401, "Wrong or missing lab password");
    }
  }
  const asItems = (v) => (typeof v === "string" ? parseSummary(v) : Array.isArray(v) ? v : []);

  app.get("/api/vision/config", route(async () => ({
    model: process.env.OPENROUTER_VISION_MODEL || vision.DEFAULT_MODEL,
    key_set: !!process.env.OPENROUTER_API_KEY,
    password_required: !!LAB_PASSWORD,
    storage: store.kind,
    photos: store.kind === "firestore" ? store.photos : "memory", // "local" = photos never leave this computer
  })));

  // Body: { photo: "data:image/jpeg;base64,..." (or photo_base64), model?, order_id? }
  // -> { ok, summary: "2× Burger (no lettuce), Fries", items: [{name, quantity, notes}], retake_reason, ... }
  app.post("/api/vision/describe", route(async (req) => {
    checkLabPassword(req);
    const body = req.body || {};
    const raw = body.photo || body.photo_base64;
    if (!raw) throw new HttpError(422, "Send a photo as a data URL (data:image/jpeg;base64,...)");
    const photo = decodeBase64(raw);
    const model = body.model ? String(body.model).trim() : undefined;
    if (model && !/^[\w.-]+\/[\w.:-]+$/.test(model)) throw new HttpError(422, "Model id looks wrong (expected provider/model)");
    const result = await vision.describePhoto(photo.buffer, photo.contentType, { model });
    if (!result) throw new HttpError(501, "Vision isn't configured: OPENROUTER_API_KEY is not set.");
    const photo_url = await savePhoto(photo);
    const orderId = Number.isInteger(Number(body.order_id)) && body.order_id != null ? Number(body.order_id) : null;
    const doc = await store.tx(async (t) => {
      const id = await t.nextId("vision_results");
      const d = {
        id, created_at: now(), summary: result.summary, items: result.items, ok: result.ok,
        retake_reason: result.retake_reason, model: result.model, latency_ms: result.latency_ms,
        cost_usd: result.cost_usd, photo_url, order_id: orderId,
        observations: result.observations.items || [],
      };
      t.set("vision_results", id, d);
      return d;
    });
    return { ...doc, observations: result.observations };
  }));

  // Body: { ordered: <voice summary string or items>, seen: <string or items> }
  app.post("/api/vision/compare", route(async (req) => {
    const b = req.body || {};
    return compareOrders(asItems(b.ordered), asItems(b.seen));
  }));

  app.get("/api/vision/results", route(async (req) =>
    store.list("vision_results", { orderBy: "id", desc: true, limit: Math.min(+req.query.limit || 30, 100) })));

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
