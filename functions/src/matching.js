// Decision logic: does an *observation* satisfy a *ticket*?
//
// Vision only reports what it sees (observations). This module is the only
// place that decides pass / fail / needs_review.
//
// Observation format (what vision.js must return):
//   {
//     items: [                       // one entry per physical unit seen
//       { menu_id: "burger",
//         components: { lettuce: "present" | "absent" | "unknown", ... } },
//     ],
//     notes: "free text from the model (optional)"
//   }
// A component missing from `components` is treated as "unknown".

const { MENU, expectedComponents } = require("./menu");

const PASS = "pass";
const FAIL = "fail";
const REVIEW = "needs_review";
const TRI_STATE = new Set(["present", "absent", "unknown"]);

/** Turn order lines (with qty) into one expected unit per physical item. */
function expandOrder(items) {
  const units = [];
  for (const line of items) {
    const expected = expectedComponents(line.menu_id, line.modifiers);
    for (let i = 0; i < (line.qty || 1); i++) {
      units.push({ menu_id: line.menu_id, line_id: line.line_id, expected });
    }
  }
  return units;
}

function compareUnit(expected, observed = {}) {
  const contradictions = [];
  const unknowns = [];
  for (const [cid, should] of Object.entries(expected)) {
    let seen = observed[cid] ?? "unknown";
    if (!TRI_STATE.has(seen)) seen = "unknown";
    if (seen === "unknown") unknowns.push(cid);
    else if (should && seen === "absent") contradictions.push(`${cid} missing`);
    else if (!should && seen === "present") contradictions.push(`${cid} present but should not be`);
  }
  return { contradictions, unknowns };
}

const score = (r) => r.contradictions.length * 10 + r.unknowns.length;

function* permutations(arr) {
  if (arr.length <= 1) { yield arr; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

/** Pair expected and observed units of one menu_id, minimising errors. */
function bestAssignment(exp, obs) {
  const n = exp.length;
  const idx = [...Array(n).keys()];
  if (n <= 6) {
    let best = null;
    for (const perm of permutations(idx)) {
      const res = idx.map((i) => compareUnit(exp[i].expected, obs[perm[i]].components));
      const total = res.reduce((s, r) => s + score(r), 0);
      if (!best || total < best.total) best = { total, res };
    }
    return best.res;
  }
  // Greedy fallback for big orders.
  const remaining = new Set(idx);
  return exp.map((e) => {
    let pick = null;
    for (const j of remaining) {
      const r = compareUnit(e.expected, obs[j].components);
      if (!pick || score(r) < score(pick.r)) pick = { j, r };
    }
    remaining.delete(pick.j);
    return pick.r;
  });
}

/** Compare observations against one order. Returns {verdict, reasons}. */
function evaluate(orderItems, observations) {
  const expected = expandOrder(orderItems);
  const observed = (observations && observations.items) || [];
  const reasons = [];
  let hasFail = false;
  let hasUnknown = false;

  const group = (list) => list.reduce((m, u) => ((m[u.menu_id] ||= []).push(u), m), {});
  const expBy = group(expected);
  const obsBy = group(observed);

  for (const menuId of [...new Set([...Object.keys(expBy), ...Object.keys(obsBy)])].sort()) {
    const e = expBy[menuId] || [];
    const o = obsBy[menuId] || [];
    const label = MENU[menuId]?.name || menuId;
    if (e.length !== o.length) {
      hasFail = true;
      reasons.push(`${label}: expected ${e.length}, saw ${o.length}`);
      continue;
    }
    bestAssignment(e, o).forEach((r, i) => {
      const tag = e.length > 1 ? `${label} #${i + 1}` : label;
      if (r.contradictions.length) {
        hasFail = true;
        reasons.push(`${tag}: ${r.contradictions.join(", ")}`);
      }
      if (r.unknowns.length) {
        hasUnknown = true;
        reasons.push(`${tag}: can't confirm ${r.unknowns.join(", ")}`);
      }
    });
  }

  const verdict = hasFail ? FAIL : hasUnknown ? REVIEW : PASS;
  if (verdict === PASS) reasons.push("Everything on the ticket is visible and correct.");
  return { verdict, reasons };
}

/**
 * Secondary hint only: does this meal look like a *different* open ticket?
 * Never reassigns anything -- staff must confirm.
 */
function suggestSwap(observations, otherOrders) {
  let best = null;
  for (const o of otherOrders) {
    const result = evaluate(o.items, observations);
    if (result.verdict === FAIL) continue;
    const rank = result.verdict === PASS ? 0 : 1;
    // Prefer exact matches, then the oldest ticket.
    if (!best || rank < best.rank || (rank === best.rank && o.id < best.order.id)) {
      best = { rank, order: o, result };
    }
  }
  if (!best) return null;
  return {
    order_id: best.order.id,
    verdict: best.result.verdict,
    message: `This meal appears to match Order #${best.order.id} — possible swap. Staff must confirm.`,
  };
}

module.exports = { PASS, FAIL, REVIEW, expandOrder, evaluate, suggestSwap };
