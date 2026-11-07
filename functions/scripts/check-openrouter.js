// Check the OpenRouter key and list models that can look at images.
//
//   node scripts/check-openrouter.js            key status + image models (cheapest first)
//   node scripts/check-openrouter.js gemini     only models whose id/name contains "gemini"
//
// Reads OPENROUTER_API_KEY from functions/vision.local.env. Never prints the key.

const fs = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, "..", "vision.local.env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const key = process.env.OPENROUTER_API_KEY;
const filter = (process.argv[2] || "").toLowerCase();

(async () => {
  // 1. Key status
  console.log("\n=== Your key ===");
  if (!key) {
    console.log("No OPENROUTER_API_KEY found. Put it in functions/vision.local.env");
  } else {
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`Key NOT working (HTTP ${res.status}): ${body.error?.message || "unknown error"}`);
    } else {
      const d = body.data || {};
      const money = (v) => (v == null ? "no limit" : `$${Number(v).toFixed(2)}`);
      console.log(`Key works (ends in ...${key.slice(-4)})`);
      console.log(`  label:      ${d.label ?? "-"}`);
      console.log(`  spent:      ${money(d.usage)}`);
      console.log(`  limit:      ${money(d.limit)}`);
      if (d.limit_remaining != null) console.log(`  remaining:  ${money(d.limit_remaining)}`);
      console.log(`  free tier:  ${d.is_free_tier ? "yes (free models only / low limits)" : "no"}`);
    }
  }

  // 2. Image-capable models
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const { data = [] } = await res.json();
  const perM = (p) => Number(p || 0) * 1e6;
  const models = data
    .filter((m) => m.architecture?.input_modalities?.includes("image"))
    .filter((m) => m.architecture?.output_modalities?.includes("text"))
    .filter((m) => Number(m.pricing?.prompt) >= 0) // skip auto-routers (variable price)
    .filter((m) => !filter || m.id.toLowerCase().includes(filter) || (m.name || "").toLowerCase().includes(filter))
    .map((m) => ({
      id: m.id,
      "$ per 1M in": perM(m.pricing?.prompt).toFixed(2),
      "$ per 1M out": perM(m.pricing?.completion).toFixed(2),
      "json schema": m.supported_parameters?.includes("structured_outputs") ? "yes" : "",
    }))
    .sort((a, b) => a["$ per 1M in"] - b["$ per 1M in"]);
  console.log(`\n=== Models that accept images${filter ? ` matching "${filter}"` : ""} (${models.length}, cheapest first) ===`);
  console.table(filter ? models : models.slice(0, 40));
  if (!filter && models.length > 40) console.log(`...showing 40. Narrow it down, e.g.: node scripts/check-openrouter.js gemini`);
  console.log("Copy a model id into vision.local.env as OPENROUTER_VISION_MODEL=<id>\n");
})();
