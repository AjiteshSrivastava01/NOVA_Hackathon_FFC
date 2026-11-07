// Compare vision models on the labelled test set.
//
//   node scripts/eval-vision.js <model-id> [<model-id> ...]
//   (API key from functions/vision.local.env or the OPENROUTER_API_KEY env var)
//
// Reads vision-testset/labels.json + photos. Prints a comparison table and writes
// per-photo details to vision-testset/results-<time>.json so you can see what
// each model got wrong.

const fs = require("node:fs");
const path = require("node:path");
const vision = require("../src/vision");
const { evaluate } = require("../src/matching");

const DIR = path.join(__dirname, "..", "vision-testset");
const models = process.argv.slice(2);
if (!models.length || !process.env.OPENROUTER_API_KEY) {
  console.error("Usage: node scripts/eval-vision.js <model-id> [<model-id> ...]  (put OPENROUTER_API_KEY in functions/vision.local.env)");
  process.exit(1);
}
const cases = JSON.parse(fs.readFileSync(path.join(DIR, "labels.json"), "utf8"));
if (!cases.length) { console.error("vision-testset/labels.json is empty. Add photos and labels first."); process.exit(1); }

const mime = (f) => ({ ".png": "image/png", ".webp": "image/webp" }[path.extname(f).toLowerCase()] || "image/jpeg");

async function runCase(model, c) {
  const order = { items: c.ticket.map((l, i) => ({ line_id: i + 1, qty: 1, modifiers: {}, ...l })) };
  const buf = fs.readFileSync(path.join(DIR, c.photo));
  const out = { photo: c.photo };
  try {
    const pred = await vision.analyze(buf, mime(c.photo), order, { model, throwOnError: true });
    out.pred = pred;
    out.latency_ms = pred.latency_ms;
    out.cost = pred.cost_usd;
    out.pred_verdict = pred.retake ? "retake" : evaluate(order.items, pred).verdict;
    if (c.truth === "retake") {
      out.true_verdict = "retake";
      out.correct = pred.retake;
      return out;
    }
    out.true_verdict = evaluate(order.items, { items: c.truth }).verdict;
    out.correct = !pred.retake && out.pred_verdict === out.true_verdict;
    // Component-level accuracy (only where the truth is known).
    out.comp = { right: 0, wrong: 0, unknown: 0 };
    const predBy = {};
    for (const it of pred.items) (predBy[it.menu_id] ||= []).push(it);
    for (const t of c.truth) {
      const p = (predBy[t.menu_id] || []).shift();
      for (const [cid, state] of Object.entries(t.components)) {
        if (state === "unknown") continue;
        const ps = p?.components[cid] ?? "unknown";
        if (ps === "unknown") out.comp.unknown++;
        else if (ps === state) out.comp.right++;
        else out.comp.wrong++;
      }
    }
  } catch (e) {
    out.error = e.message;
    out.correct = false;
  }
  return out;
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k]); }
  }));
  return results;
}

(async () => {
  const all = {};
  const rows = [];
  for (const model of models) {
    process.stdout.write(`Running ${model} on ${cases.length} photos... `);
    const res = await pool(cases, 3, (c) => runCase(model, c));
    all[model] = res;
    const ok = res.filter((r) => !r.error);
    const sum = (f) => ok.reduce((s, r) => s + (f(r) || 0), 0);
    const comp = ok.filter((r) => r.comp).reduce((a, r) => ({
      right: a.right + r.comp.right, wrong: a.wrong + r.comp.wrong, unknown: a.unknown + r.comp.unknown,
    }), { right: 0, wrong: 0, unknown: 0 });
    const compTotal = comp.right + comp.wrong + comp.unknown || 1;
    const lat = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
    rows.push({
      model,
      "verdict acc": `${Math.round((res.filter((r) => r.correct).length / res.length) * 100)}%`,
      // The dangerous one: a wrong meal that the system would let through.
      "missed mistakes": res.filter((r) => r.true_verdict === "fail" && r.pred_verdict === "pass").length,
      "false alarms": res.filter((r) => r.true_verdict === "pass" && r.pred_verdict === "fail").length,
      "component acc": `${Math.round((comp.right / compTotal) * 100)}%`,
      "unknown rate": `${Math.round((comp.unknown / compTotal) * 100)}%`,
      "retakes caught": `${res.filter((r) => r.true_verdict === "retake" && r.correct).length}/${res.filter((r) => r.true_verdict === "retake").length}`,
      "median s": lat.length ? (lat[Math.floor(lat.length / 2)] / 1000).toFixed(1) : "-",
      "$ / photo": ok.length ? (sum((r) => r.cost) / ok.length).toFixed(4) : "-",
      errors: res.length - ok.length,
    });
    console.log("done");
  }
  console.table(rows);
  const file = path.join(DIR, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  console.log(`Per-photo details: ${path.relative(process.cwd(), file)}`);
})();
