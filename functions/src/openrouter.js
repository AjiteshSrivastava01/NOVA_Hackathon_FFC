// Minimal OpenRouter chat helper shared by voice.js (vision.js has its own, tuned for photos).
// Reads OPENROUTER_API_KEY from the environment or functions/vision.local.env.

const fs = require("node:fs");
const path = require("node:path");

const LOCAL_ENV = path.join(__dirname, "..", "vision.local.env");
if (!process.env.OPENROUTER_API_KEY && fs.existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV);

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const hasKey = () => !!process.env.OPENROUTER_API_KEY;

/** Send messages, get parsed JSON back. `schema` (optional) enables strict structured output. */
async function chatJson({ model, messages, schema, name = "result", timeoutMs = 30000 }) {
  const call = async (structured) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "FFC Kitchen" },
        body: JSON.stringify({
          model, messages, temperature: 0, usage: { include: true },
          ...(structured && schema && { response_format: { type: "json_schema", json_schema: { name, strict: true, schema } } }),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
      let text = data.choices?.[0]?.message?.content ?? "";
      if (Array.isArray(text)) text = text.map((p) => p.text ?? "").join("");
      const s = text.indexOf("{"), e = text.lastIndexOf("}");
      if (s < 0 || e < 0) throw new Error("Model did not return JSON");
      return { json: JSON.parse(text.slice(s, e + 1)), cost: data.usage?.cost ?? null };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await call(true);
  } catch (e) {
    if (!/response_format|json_schema|structured/i.test(e.message)) throw e;
    return call(false); // model without structured-output support: rely on the prompt
  }
}

module.exports = { chatJson, hasKey };
