// VOICE TEAM: plug speech-to-text / order parsing in here.
//
// Contract:
//   transcribe(audioBuffer, contentType) -> Promise<string | null>
//   parseOrder(transcript) -> Promise<{ customer_name, items }>
// Items must use the stable IDs in menu.js, e.g.
//   [{ menu_id: "burger", qty: 2, modifiers: { lettuce: "no" } }]
//
// The keyword parser below is a placeholder so the pipeline works end to end.
// Replace it with an LLM call when ready; keep the output shape.

const { MENU } = require("./menu");

const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const ALIASES = {
  burger: "burger", burgers: "burger", hamburger: "burger", cheeseburger: "burger",
  "chicken sandwich": "chicken_sandwich", "chicken sandwiches": "chicken_sandwich",
  fries: "fries", fry: "fries", salad: "salad", salads: "salad",
  soda: "soda", sodas: "soda", coke: "soda", drink: "soda", drinks: "soda",
};
const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function transcribe(audioBuffer, contentType) {
  return null; // Not wired yet.
}

async function parseOrder(transcript) {
  const text = transcript.toLowerCase();
  const nameMatch = text.match(/(?:for|name is|this is|i'm|i am)\s+([a-z]+)/);
  const customer_name = nameMatch ? nameMatch[1][0].toUpperCase() + nameMatch[1].slice(1) : "Guest";
  const items = [];
  // Split on commas / "and" so modifiers attach to the right item
  // (but keep "and no lettuce" with its item).
  for (const chunk of text.split(/,|\band\b(?!\s+(?:no|extra|add)\b)/)) {
    for (const alias of ALIAS_KEYS) {
      const m = chunk.match(new RegExp(`(?:(\\d+|a|an|one|two|three|four|five)\\s+)?${escape(alias)}\\b`));
      if (!m) continue;
      const menu_id = ALIASES[alias];
      const q = m[1];
      const qty = q ? (/^\d+$/.test(q) ? +q : NUMBERS[q]) : 1;
      const modifiers = {};
      for (const [cid, meta] of Object.entries(MENU[menu_id].components)) {
        if (new RegExp(`\\b(no|without|hold the)\\s+${cid}`).test(chunk) && meta.removable) modifiers[cid] = "no";
        else if (new RegExp(`\\b(extra|add|with)\\s+${cid}`).test(chunk) && !meta.default) modifiers[cid] = "add";
      }
      items.push({ menu_id, qty, modifiers });
      break;
    }
  }
  return { customer_name, items };
}

module.exports = { transcribe, parseOrder };
