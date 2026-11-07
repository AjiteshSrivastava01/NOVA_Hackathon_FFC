// Vision -> order string, in the SAME shape the voice app produces, so the
// integration step can compare a photo with a spoken order directly.
//
// Voice app (voice-order-app/lib/types.ts + format.ts) produces:
//   items:   [{ name: "Burger", quantity: 2, notes: "no lettuce" }]
//   summary: "2× Burger (no lettuce), Fries"
// This file turns vision observations into exactly that, plus a matcher.
//
// Canonical notes, generated from the menu (src/menu.js):
//   a standard ingredient that is missing  -> "no <ingredient>"   e.g. "no lettuce"
//   an optional ingredient that is present -> "add <ingredient>"  e.g. "add onion"
//   several notes are joined with ", " in menu order: "no lettuce, add onion"
// compareOrders() treats "extra/with" like "add" and "without/hold the" like "no".

const { MENU } = require("./menu");

/** Observations (from vision.js) -> voice-style items. Identical dishes are merged. */
function toOrderItems(observations) {
  if (!observations || observations.retake) return [];
  const merged = new Map();
  for (const unit of observations.items || []) {
    const dish = MENU[unit.menu_id];
    if (!dish) continue;
    const notes = [];
    for (const [cid, comp] of Object.entries(dish.components)) {
      const seen = unit.components?.[cid];
      if (comp.default && seen === "absent") notes.push(`no ${comp.name.toLowerCase()}`);
      if (!comp.default && seen === "present") notes.push(`add ${comp.name.toLowerCase()}`);
    }
    const item = { name: dish.name, quantity: 1, notes: notes.join(", ") || undefined };
    const key = `${item.name}|${item.notes ?? ""}`;
    if (merged.has(key)) merged.get(key).quantity += 1;
    else merged.set(key, item);
  }
  return [...merged.values()];
}

/** Same formatting as voice-order-app/lib/format.ts: "2× Burger (no lettuce), Fries" */
function formatItem(item) {
  const qty = item.quantity > 1 ? `${item.quantity}× ` : "";
  return `${qty}${item.name}${item.notes ? ` (${item.notes})` : ""}`;
}
const formatSummary = (items) => items.map(formatItem).join(", ");

/**
 * Parse a voice summary back into items, e.g.
 * "2× Burger (no lettuce, add onion), Fries for table 12"
 * (handy when all you have is the string).
 */
function parseSummary(text) {
  const body = String(text || "").replace(/\s+for table\s+\d+\s*$/i, "").trim();
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of body) { // split on commas that are NOT inside (...)
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const m = /^\s*(?:(\d+)\s*[×x]\s*)?([^()]+?)\s*(?:\((.*)\))?\s*$/i.exec(p);
    if (!m) return null;
    return { name: m[2].trim(), quantity: m[1] ? +m[1] : 1, notes: m[3]?.trim() || undefined };
  }).filter(Boolean);
}

// ---------- matching voice vs vision ----------
const NAME_ALIASES = { coke: "soda", pop: "soda", drink: "soda", salad: "side salad", "chips": "fries", hamburger: "burger", cheeseburger: "burger" };
// burgers -> burger, sandwiches -> sandwich, tomatoes -> tomato, fries -> fries
function singular(s) {
  if (/(ch|sh|ss|x|o)es$/i.test(s)) return s.slice(0, -2);
  if (/(ies|ss|us)$/i.test(s)) return s;
  return s.replace(/s$/i, "");
}
function normName(name) {
  const n = String(name || "").toLowerCase().trim();
  return NAME_ALIASES[n] || NAME_ALIASES[singular(n)] || singular(n);
}
function normNotes(notes) {
  return String(notes || "").toLowerCase()
    .split(/,|\band\b/).map((s) => s.trim()).filter(Boolean)
    .map((s) => s
      .replace(/^(without|hold the|hold|minus)\s+/, "no ")
      .replace(/^(extra|with|plus|add)\s+/, "add ")
      .replace(/\w+$/, singular))
    .sort().join(", ");
}
const keyOf = (it) => `${normName(it.name)}|${normNotes(it.notes)}`;

/**
 * Compare what was ordered (voice) with what was seen (vision).
 * Both are lists of {name, quantity, notes}. Returns
 *   { match: boolean, missing: [...], extra: [...] }
 * where "missing" = ordered but not seen, "extra" = seen but not ordered.
 */
function compareOrders(ordered, seen) {
  const count = (list) => list.reduce((m, it) => m.set(keyOf(it), (m.get(keyOf(it)) || 0) + (it.quantity || 1)), new Map());
  const a = count(ordered), b = count(seen);
  const label = (key, qty) => {
    const [name, notes] = key.split("|");
    return `${qty > 1 ? `${qty}× ` : ""}${name}${notes ? ` (${notes})` : ""}`;
  };
  const missing = [], extra = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const d = (a.get(k) || 0) - (b.get(k) || 0);
    if (d > 0) missing.push(label(k, d));
    if (d < 0) extra.push(label(k, -d));
  }
  return { match: !missing.length && !extra.length, missing, extra };
}

module.exports = { toOrderItems, formatItem, formatSummary, parseSummary, compareOrders };
