import type { OrderItem } from "./types";

const URL = "https://openrouter.ai/api/v1/chat/completions";

// Override in .env.local if you want a different model.
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL ?? "google/gemini-2.5-flash";
const ORDER_MODEL = process.env.ORDER_MODEL ?? "openai/gpt-4o-mini";

async function chat(body: Record<string, unknown>): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not set. Add it to .env.local and restart the dev server.");
  }
  const res = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: { text?: string }) => p.text ?? "").join("");
  }
  throw new Error("OpenRouter returned an empty response.");
}

/** Speech -> text using an audio-capable model. Expects base64 WAV. */
export async function transcribeAudio(wavBase64: string): Promise<string> {
  const text = await chat({
    model: TRANSCRIBE_MODEL,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Transcribe this audio word for word. It is a restaurant waiter either dictating a food order " +
              "(with a table number) or asking for the order of a table. Output ONLY the transcript, with " +
              "no commentary or quotes. If there is no speech, output nothing.",
          },
          { type: "input_audio", input_audio: { data: wavBase64, format: "wav" } },
        ],
      },
    ],
  });
  return text.trim();
}

export type ParsedOrder = { table: number | null; items: OrderItem[] };

const ORDER_SYSTEM_PROMPT = `You turn a waiter's dictated restaurant order into JSON.
Return ONLY a JSON object: {"table": <integer or null>, "items": [{"name": string, "quantity": integer, "notes": string}]}
Rules:
- "table" is the table number as an integer (convert words like "twelve" to 12). null if no table is mentioned.
- "name" is the dish or drink, singular, Title Case (e.g. "Burger", "Fries", "Coke").
- "quantity" defaults to 1.
- "notes" holds modifications such as "no lettuce", "extra cheese", "well done". Use "" if none.
- Do not invent items that were not said. If no food or drinks were said, return an empty "items" array.`;

export async function parseOrder(transcript: string): Promise<ParsedOrder> {
  const raw = await chat({
    model: ORDER_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ORDER_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ],
  });

  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    throw new Error("The AI returned an order I couldn't read. Please try again.");
  }

  const obj = json as { table?: unknown; items?: unknown };
  const tableNum = typeof obj.table === "number" ? obj.table : parseInt(String(obj.table ?? ""), 10);
  const table = Number.isInteger(tableNum) && tableNum > 0 ? tableNum : null;

  const items: OrderItem[] = Array.isArray(obj.items)
    ? obj.items
        .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
        .map((i) => ({
          name: String(i.name ?? "").trim(),
          quantity: Math.max(1, Math.round(Number(i.quantity) || 1)),
          notes: String(i.notes ?? "").trim() || undefined,
        }))
        .filter((i) => i.name.length > 0)
    : [];

  return { table, items };
}
