// VISION: photo of a meal -> observations (what is SEEN, never pass/fail).
//
// How it works (few-shot recognition, no training):
//   1. We send a vision model on OpenRouter: the menu catalog, a few labelled
//      reference photos of THIS restaurant's dishes, and the new photo.
//   2. The model returns JSON in the observation format (see matching.js).
//   3. matching.js (plain code) decides pass / fail / needs_review.
//
// Config (environment variables):
//   OPENROUTER_API_KEY       required; without it analyze() returns null and the
//                            dashboard falls back to sample results
//   OPENROUTER_VISION_MODEL  model id copied from openrouter.ai/models (image input)
//   VISION_MIN_CONFIDENCE    below this the photo is flagged "please retake" (default 0.6)
//
// Reference photos: functions/vision-refs/<menu_id>/<caption>.jpg
//   e.g. vision-refs/burger/no lettuce, with cheese.jpg
//   Keep them small (~512px wide, <100KB). Only refs for dishes on the selected
//   ticket are sent, which keeps each request cheap.

const fs = require("node:fs");
const path = require("node:path");
const { MENU, expectedComponents } = require("./menu");

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const REFS_DIR = path.join(__dirname, "..", "vision-refs");
const DEFAULT_MODEL = "google/gemini-2.5-flash"; // placeholder: pick yours from the eval

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
- For each component of each item answer exactly one of:
    "present"  - you can clearly see it
    "absent"   - the area where it would be is clearly visible and it is not there
    "unknown"  - it could be hidden (e.g. under a bun or another item) or the photo is unclear
  If in doubt, use "unknown". Never guess "absent" for something that could be hidden.
- photo_quality: "good", or "bad" if blurry, too dark, cropped, or the food is not visible.
- confidence: 0-1, your overall confidence in the item list.
- notes: one short sentence about anything unusual.
Return JSON only, shaped like:
{"photo_quality":"good","confidence":0.9,"notes":"...",
 "items":[{"menu_id":"burger","components":[{"component":"lettuce","state":"unknown"}]}]}`;

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
                state: { type: "string", enum: ["present", "absent", "unknown"] },
              },
            },
          },
        },
      },
    },
  },
};

function buildMessages(photoDataUrl, order) {
  // The ticket tells the model WHICH dishes/components to look for. We deliberately
  // don't say which modifiers were requested, so it can't just echo the ticket.
  const ticketIds = [...new Set(order.items.map((l) => l.menu_id))];
  const catalogIds = Object.keys(MENU); // full catalog: lets it report an unexpected dish
  const content = [{
    type: "text",
    text: `Menu catalog:\n${menuCatalog(catalogIds)}\n\n` +
      `Dishes expected on this tray (check carefully, but report what you actually see): ` +
      order.items.map((l) => `${l.qty}x ${l.menu_id}`).join(", ") + ".",
  }];
  for (const id of ticketIds) {
    for (const ref of REFS[id] || []) {
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
        components[cid] = ["present", "absent", "unknown"].includes(v) ? v : "unknown";
      }
      return { menu_id: it.menu_id, components };
    });
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  const retake = raw.photo_quality === "bad" || confidence < minConf;
  return {
    items,
    confidence,
    photo_quality: raw.photo_quality === "bad" ? "bad" : "good",
    retake,
    retake_reason: retake ? (raw.photo_quality === "bad" ? "Photo unclear" : `Low confidence (${confidence.toFixed(2)})`) : null,
    notes: String(raw.notes || ""),
  };
}

/**
 * Called by the API. Returns observations, or null if vision isn't configured
 * (the dashboard then uses sample results).
 */
async function analyze(photoBuffer, contentType, order, { model } = {}) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const useModel = model || process.env.OPENROUTER_VISION_MODEL || DEFAULT_MODEL;
  const photo = `data:${contentType};base64,${photoBuffer.toString("base64")}`;
  const { text, latencyMs, cost } = await callModel(buildMessages(photo, order), useModel);
  const obs = normalize(parseJson(text));
  obs.model = useModel;
  obs.latency_ms = latencyMs;
  obs.cost_usd = cost;
  return obs;
}

module.exports = { analyze, buildMessages, callModel, normalize, parseJson, SYSTEM_PROMPT };
