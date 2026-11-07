// VISION: photo of a meal -> observations (what is SEEN, never pass/fail).
//
// How it works (few-shot recognition, no training):
//   1. We send a vision model on OpenRouter: the menu catalog, a few labelled
//      reference photos of THIS restaurant's dishes, and the new photo.
//   2. The model returns JSON in the observation format (see matching.js).
//   3. matching.js (plain code) decides pass / fail / needs_review.
//
// Config (environment variables, or put them in functions/vision.local.env,
// which is git-ignored by functions/.gitignore):
//   OPENROUTER_API_KEY       required; without it analyze() returns null and the
//                            dashboard falls back to sample results
//   OPENROUTER_VISION_MODEL  model id copied from openrouter.ai/models (image input)
//   VISION_MIN_CONFIDENCE    below this the photo is flagged "please retake" (default 0.6)
//
// The model answers every component with "present" or "absent" only.
// Bad photo / low confidence / incomplete answer / model error -> we return a
// "please retake" result instead (all components "unknown", which the existing
// matching logic turns into needs_review). The model itself never says unknown.
//
// Reference photos: functions/vision-refs/<menu_id>/<caption>.jpg
//   e.g. vision-refs/burger/no lettuce, with cheese.jpg
//   Keep them small (~512px wide, <100KB). Only refs for dishes on the selected
//   ticket are sent, which keeps each request cheap.

const fs = require("node:fs");
const path = require("node:path");
const { MENU, expectedComponents } = require("./menu");
const { toOrderItems, formatSummary } = require("./vision-string");

// Local secrets file (never committed). Real environment variables win.
const LOCAL_ENV = path.join(__dirname, "..", "vision.local.env");
if (fs.existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV);

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const REFS_DIR = path.join(__dirname, "..", "vision-refs");
const DEFAULT_MODEL = "google/gemini-3.8-flash"; // team default; override per person with OPENROUTER_VISION_MODEL

// ---------- reference photos (loaded once) ----------
function loadRefs() {
  const refs = {};
  if (!fs.existsSync(REFS_DIR)) return refs;
  for (const menuId of fs.readdirSync(REFS_DIR)) {
    const dir = path.join(REFS_DIR, menuId);
    if (!MENU[menuId] || !fs.statSync(dir).isDirectory()) continue;
    refs[menuId] = fs.readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .slice(0, 3) // cap per dish to control cost
      .map((f) => {
        const ext = path.extname(f).slice(1).toLowerCase().replace("jpg", "jpeg");
        return {
          caption: path.basename(f, path.extname(f)),
          dataUrl: `data:image/${ext};base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`,
        };
      });
  }
  return refs;
}
const REFS = loadRefs();

// ---------- prompt ----------
function menuCatalog(menuIds) {
  return menuIds.map((id) => {
    const comps = Object.entries(MENU[id].components)
      .map(([cid, c]) => `${cid} (${c.name}${c.default ? ", normally included" : ", optional"})`).join(", ");
    return `- ${id}: ${MENU[id].name}. Components: ${comps}`;
  }).join("\n");
}

const SYSTEM_PROMPT = `You are a food-inspection camera in a restaurant kitchen.
You report ONLY what is visible in the photo. You never judge whether the order is correct.

Rules:
- Use only menu_id and component ids from the catalog. Never invent dishes.
- One entry in "items" per physical unit (two burgers = two entries).
- For EVERY component listed for that dish in the catalog, answer exactly one of:
    "present" - it is on the item
    "absent"  - it is not on the item
  If a component is partly hidden (e.g. under a bun), decide from the visible
  evidence: edges or colour peeking out, the height of the stack, shadows.
- photo_quality: "good", or "bad" if blurry, too dark, cropped, or the food is not visible.
- confidence: 0-1, your overall confidence in the item list.
- notes: one short sentence about anything unusual.
Return JSON only, shaped like:
{"photo_quality":"good","confidence":0.9,"notes":"...",
 "items":[{"menu_id":"burger","components":[{"component":"lettuce","state":"absent"}]}]}`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["photo_quality", "confidence", "items", "notes"],
  properties: {
    photo_quality: { type: "string", enum: ["good", "bad"] },
    confidence: { type: "number" },
    notes: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["menu_id", "components"],
        properties: {
          menu_id: { type: "string" },
          // A list (not a map) because strict JSON-schema mode can't express open-ended keys.
          components: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["component", "state"],
              properties: {
                component: { type: "string" },
                state: { type: "string", enum: ["present", "absent"] },
              },
            },
          },
        },
      },
    },
  },
};

function buildMessages(photoDataUrl, order) {
  // With an order: the ticket tells the model WHICH dishes to look for. We deliberately
  // don't say which modifiers were requested, so it can't just echo the ticket.
  // Without an order (describe mode): the model identifies everything on its own.
  const catalogIds = Object.keys(MENU); // full catalog: lets it report an unexpected dish
  const refIds = order ? [...new Set(order.items.map((l) => l.menu_id))] : catalogIds;
  const content = [{
    type: "text",
    text: `Menu catalog:\n${menuCatalog(catalogIds)}\n\n` + (order
      ? `Dishes expected on this tray (check carefully, but report what you actually see): ` +
        order.items.map((l) => `${l.qty}x ${l.menu_id}`).join(", ") + "."
      : "Identify every menu dish in the photo, with every component of each."),
  }];
  for (const id of refIds) {
    for (const ref of (REFS[id] || []).slice(0, order ? 3 : 1)) { // describe mode: 1 ref per dish keeps it cheap
      content.push({ type: "text", text: `Reference photo - ${MENU[id].name}: ${ref.caption}` });
      content.push({ type: "image_url", image_url: { url: ref.dataUrl } });
    }
  }
  content.push({ type: "text", text: "Photo to inspect:" });
  content.push({ type: "image_url", image_url: { url: photoDataUrl } });
  return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content }];
}

// ---------- model call ----------
async function callModel(messages, model, opts = {}) {
  try {
    return await callModelOnce(messages, model, { ...opts, structured: true });
  } catch (e) {
    // Not every model supports strict JSON schema; retry once relying on the prompt alone.
    if (!/response_format|json_schema|structured/i.test(e.message)) throw e;
    return callModelOnce(messages, model, { ...opts, structured: false });
  }
}

async function callModelOnce(messages, model, { timeoutMs = 30000, structured = true } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "FFC Kitchen",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        ...(structured && { response_format: { type: "json_schema", json_schema: { name: "observations", strict: true, schema: SCHEMA } } }),
        usage: { include: true }, // OpenRouter returns cost in usage.cost
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
    const text = data.choices?.[0]?.message?.content || "";
    return { text, latencyMs: Date.now() - t0, cost: data.usage?.cost ?? null };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  // Some models wrap JSON in ```json fences or add prose; grab the outermost object.
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(s, e + 1));
}

/** Clean model output into the strict observation format matching.js expects. */
function normalize(raw) {
  const minConf = +(process.env.VISION_MIN_CONFIDENCE || 0.6);
  const missing = []; // components the model skipped or answered with something else
  const items = (raw.items || [])
    .filter((it) => MENU[it.menu_id]) // drop invented dishes
    .map((it) => {
      // Accept both [{component, state}] and {component: state}.
      const given = Array.isArray(it.components)
        ? Object.fromEntries(it.components.map((c) => [c.component, c.state]))
        : it.components || {};
      const components = {};
      for (const cid of Object.keys(MENU[it.menu_id].components)) {
        const v = given[cid];
        if (v === "present" || v === "absent") components[cid] = v;
        else missing.push(`${it.menu_id}.${cid}`);
      }
      return { menu_id: it.menu_id, components };
    });
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  const retake = raw.photo_quality === "bad" || confidence < minConf || missing.length > 0;
  return {
    items,
    confidence,
    photo_quality: raw.photo_quality === "bad" ? "bad" : "good",
    retake,
    retake_reason: !retake ? null
      : raw.photo_quality === "bad" ? "Photo unclear"
      : confidence < minConf ? `Low confidence (${confidence.toFixed(2)})`
      : `Model gave no clear answer for ${missing.join(", ")}`,
    notes: String(raw.notes || ""),
  };
}

/**
 * A "please retake" result. Every component of every expected dish is
 * "unknown", so matching.js returns needs_review without any changes there.
 * (These are NOT detections; retake: true marks them as "couldn't see".)
 */
function retakeObservations(order, reason, extra = {}) {
  const items = [];
  for (const line of order ? order.items : []) {
    for (let i = 0; i < (line.qty || 1); i++) {
      items.push({
        menu_id: line.menu_id,
        components: Object.fromEntries(Object.keys(MENU[line.menu_id].components).map((c) => [c, "unknown"])),
      });
    }
  }
  return { items, confidence: 0, photo_quality: "bad", retake: true, retake_reason: reason,
    notes: `Please retake the photo: ${reason}`, ...extra };
}

/**
 * Called by the API. Returns observations, or null if vision isn't configured
 * (the dashboard then uses sample results).
 * Options: model (override), throwOnError (used by the eval script).
 */
async function analyze(photoBuffer, contentType, order, { model, throwOnError = false } = {}) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const useModel = model || process.env.OPENROUTER_VISION_MODEL || DEFAULT_MODEL;
  const photo = `data:${contentType};base64,${photoBuffer.toString("base64")}`;
  let result;
  try {
    const { text, latencyMs, cost } = await callModel(buildMessages(photo, order), useModel);
    result = { obs: normalize(parseJson(text)), latencyMs, cost };
  } catch (e) {
    if (throwOnError) throw e;
    console.error("vision failed:", e);
    return retakeObservations(order, `vision model error (${e.message})`, { model: useModel });
  }
  const meta = { model: useModel, latency_ms: result.latencyMs, cost_usd: result.cost };
  if (result.obs.retake) return retakeObservations(order, result.obs.retake_reason, { ...meta, raw: result.obs });
  return { ...result.obs, ...meta };
}

/**
 * Photo -> order string, like voice turns speech into a string. No ticket needed.
 * Returns {
 *   ok, summary: "2× Burger (no lettuce), Fries",          // same format as the voice app
 *   items: [{ name, quantity, notes }],                      // same shape as the voice app
 *   retake, retake_reason, model, latency_ms, cost_usd, observations
 * } or null if no API key is configured.
 */
async function describePhoto(photoBuffer, contentType, { model, throwOnError = false } = {}) {
  const observations = await analyze(photoBuffer, contentType, null, { model, throwOnError });
  if (!observations) return null;
  const items = toOrderItems(observations);
  return {
    ok: !observations.retake,
    summary: formatSummary(items),
    items,
    retake: !!observations.retake,
    retake_reason: observations.retake_reason || null,
    model: observations.model,
    latency_ms: observations.latency_ms ?? null,
    cost_usd: observations.cost_usd ?? null,
    observations,
  };
}

module.exports = { analyze, describePhoto, buildMessages, callModel, normalize, parseJson, SYSTEM_PROMPT, DEFAULT_MODEL };
