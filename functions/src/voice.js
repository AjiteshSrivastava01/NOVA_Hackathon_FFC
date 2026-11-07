// VOICE: speech (or typed text) -> an order in the menu format the backend uses.
//
//   understandOrder({ audio: Buffer, audioFormat: "wav", text?: string })
//     -> { transcript, customer_name, items: [{ menu_id, qty, modifiers: { lettuce: "no", onion: "add" } }] }
//
// One call to an audio-capable model on OpenRouter does both steps (speech -> text -> order),
// restricted to menu.js so it can't invent dishes. Without an API key, typed text still works
// through the simple keyword parser below.
//
// Config (env or functions/vision.local.env):
//   OPENROUTER_API_KEY
//   OPENROUTER_VOICE_MODEL   default: google/gemini-3.8-flash (accepts audio)

const { MENU, expectedComponents } = require("./menu");
const { chatJson, hasKey } = require("./openrouter");

const DEFAULT_VOICE_MODEL = "google/gemini-3.8-flash";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["transcript", "customer_name", "items"],
  properties: {
    transcript: { type: "string" },
    customer_name: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["menu_id", "qty", "remove", "add"],
        properties: {
          menu_id: { type: "string", enum: Object.keys(MENU) },
          qty: { type: "integer" },
          remove: { type: "array", items: { type: "string" } },
          add: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function menuText() {
  return Object.entries(MENU).map(([id, d]) => {
    const std = Object.entries(d.components).filter(([, c]) => c.default && c.removable).map(([cid]) => cid);
    const opt = Object.entries(d.components).filter(([, c]) => !c.default).map(([cid]) => cid);
    return `- ${id} (${d.name}). Can remove: ${std.join(", ") || "nothing"}. Can add: ${opt.join(", ") || "nothing"}.`;
  }).join("\n");
}

const SYSTEM = `You take restaurant orders spoken by staff and turn them into JSON.
Menu (use ONLY these menu_id and ingredient ids):
${menuText()}

Rules:
- "transcript": exactly what was said (for audio), or the text you were given.
- "customer_name": the name or table the order is for, e.g. "Sam" or "Table 12". Use "Guest" if none.
- One entry per distinct dish + changes. "two burgers no lettuce" = one entry with qty 2.
- "remove": ingredient ids the customer does NOT want ("no lettuce", "hold the cheese", "without onion").
- "add": optional ingredient ids the customer wants added ("add onion", "extra pickles", "with tomato").
- Map synonyms to the menu: cheeseburger/hamburger -> burger, chips -> fries, coke/pop/drink -> soda, salad -> salad.
- Never invent dishes or ingredients. Ignore anything not on the menu.
Return JSON only: {"transcript":"...","customer_name":"...","items":[{"menu_id":"burger","qty":2,"remove":["lettuce"],"add":[]}]}`;

/** Turn the model's items into validated backend order lines (drops anything invalid). */
function cleanItems(rawItems) {
  const out = [];
  for (const it of rawItems || []) {
    const dish = MENU[it.menu_id];
    if (!dish) continue;
    const modifiers = {};
    for (const cid of it.remove || []) if (dish.components[cid]?.removable && dish.components[cid].default) modifiers[cid] = "no";
    for (const cid of it.add || []) if (dish.components[cid] && !dish.components[cid].default) modifiers[cid] = "add";
    try { expectedComponents(it.menu_id, modifiers); } catch { continue; }
    out.push({ menu_id: it.menu_id, qty: Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1)), modifiers });
  }
  return out;
}

async function understandOrder({ audio, audioFormat = "wav", text, model } = {}) {
  if (!hasKey()) {
    if (text) return { ...(await parseOrder(text)), transcript: text, model: "keyword-parser" };
    throw new Error("Voice needs OPENROUTER_API_KEY (or type the order instead).");
  }
  const useModel = model || process.env.OPENROUTER_VOICE_MODEL || DEFAULT_VOICE_MODEL;
  const content = audio
    ? [{ type: "text", text: "Here is the spoken order:" },
       { type: "input_audio", input_audio: { data: audio.toString("base64"), format: audioFormat } }]
    : [{ type: "text", text: `Here is the typed order: ${text}` }];
  const t0 = Date.now();
  const { json, cost } = await chatJson({ model: useModel, name: "order", schema: SCHEMA,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content }] });
  return {
    transcript: String(json.transcript || text || "").trim(),
    customer_name: String(json.customer_name || "").trim().slice(0, 60) || "Guest",
    items: cleanItems(json.items),
    model: useModel, latency_ms: Date.now() - t0, cost_usd: cost,
  };
}

// ---------- offline fallback: simple keyword parser for typed text ----------
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const ALIASES = {
  burger: "burger", burgers: "burger", hamburger: "burger", cheeseburger: "burger",
  "chicken sandwich": "chicken_sandwich", "chicken sandwiches": "chicken_sandwich",
  fries: "fries", fry: "fries", chips: "fries", salad: "salad", salads: "salad",
  soda: "soda", sodas: "soda", coke: "soda", drink: "soda", drinks: "soda",
};
const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function parseOrder(transcript) {
  const text = transcript.toLowerCase();
  const nameMatch = text.match(/(?:for|name is|this is|i'm|i am)\s+(table\s+\d+|[a-z]+)/);
  const customer_name = nameMatch ? nameMatch[1].replace(/\b\w/g, (c) => c.toUpperCase()) : "Guest";
  const items = [];
  for (const chunk of text.split(/,|\band\b(?!\s+(?:no|extra|add)\b)/)) {
    for (const alias of ALIAS_KEYS) {
      const m = chunk.match(new RegExp(`(?:(\\d+|a|an|one|two|three|four|five)\\s+)?${escape(alias)}\\b`));
      if (!m) continue;
      const menu_id = ALIASES[alias];
      const q = m[1];
      const qty = q ? (/^\d+$/.test(q) ? +q : NUMBERS[q]) : 1;
      const modifiers = {};
      for (const [cid, meta] of Object.entries(MENU[menu_id].components)) {
        if (new RegExp(`\\b(no|without|hold the)\\s+${cid}`).test(chunk) && meta.removable && meta.default) modifiers[cid] = "no";
        else if (new RegExp(`\\b(extra|add|with)\\s+${cid}`).test(chunk) && !meta.default) modifiers[cid] = "add";
      }
      items.push({ menu_id, qty, modifiers });
      break;
    }
  }
  return { customer_name, items };
}

// Kept for the older /api/voice/transcribe route.
async function transcribe(audioBuffer, contentType) {
  if (!hasKey() || !/wav|mp3|mpeg/.test(contentType || "")) return null;
  return (await understandOrder({ audio: audioBuffer, audioFormat: /mp3|mpeg/.test(contentType) ? "mp3" : "wav" })).transcript;
}

module.exports = { understandOrder, parseOrder, transcribe, cleanItems, DEFAULT_VOICE_MODEL };
