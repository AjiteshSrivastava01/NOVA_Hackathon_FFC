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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const raw = data.error?.metadata?.raw;
        const detail = [data.error?.message, typeof raw === "string" ? raw.slice(0, 300) : raw && JSON.stringify(raw).slice(0, 300)]
          .filter(Boolean).join(" | ") || JSON.stringify(data).slice(0, 300);
        throw Object.assign(new Error(`OpenRouter ${res.status}: ${detail}`), { status: res.status });
      }
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
    // Some providers (e.g. Gemini) reject parts of strict JSON schema with a 400:
    // retry once relying on the prompt alone. Auth / credit / rate-limit errors are not retried.
    const retry = /response_format|json_schema|structured|schema|additionalProperties|INVALID_ARGUMENT/i.test(e.message)
      || (e.status >= 400 && e.status < 500 && ![401, 402, 403, 429].includes(e.status));
    if (!schema || !retry) throw e;
    return call(false);
  }
}

module.exports = { chatJson, hasKey };
