// Providers like Gemini can reject strict JSON schema with a 400. Both voice and vision
// must retry without it; auth/credit errors must NOT be retried; typed orders fall back.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const voice = require("../src/voice");
const vision = require("../src/vision");

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });

const GEMINI_400 = { error: { code: 400, message: "Provider returned error",
  metadata: { raw: '{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"additionalProperties\\"","status":"INVALID_ARGUMENT"}}', provider_name: "Google" } } };

function fake(handler) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const [status, json] = handler(body, calls.length);
    return new Response(JSON.stringify(json), { status });
  };
  return calls;
}
const ok = (obj) => [200, { choices: [{ message: { content: JSON.stringify(obj) } }] }];

test("voice: Gemini rejects the schema -> retried without it -> order understood", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  const calls = fake((body) => (body.response_format ? [400, GEMINI_400]
    : ok({ transcript: "burger no lettuce for Sam", customer_name: "Sam", items: [{ menu_id: "burger", qty: 1, remove: ["lettuce"], add: [] }] })));
  const r = await voice.understandOrder({ text: "burger no lettuce for Sam" });
  assert.equal(calls.length, 2);
  assert.deepEqual(r.items, [{ menu_id: "burger", qty: 1, modifiers: { lettuce: "no" } }]);
  assert.equal(r.model, "google/gemini-3.8-flash");
});

test("vision: Gemini rejects the schema -> retried without it", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  const calls = fake((body) => (body.response_format ? [400, GEMINI_400]
    : ok({ photo_quality: "good", confidence: 0.9, notes: "", items: [{ menu_id: "fries", components: [{ component: "fries", state: "present" }] }] })));
  const r = await vision.describePhoto(Buffer.from("x"), "image/jpeg");
  assert.equal(calls.length, 2);
  assert.equal(r.summary, "Fries");
});

test("bad key (401) is not retried and the message says why", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  const calls = fake(() => [401, { error: { code: 401, message: "No auth credentials found" } }]);
  await assert.rejects(voice.understandOrder({ audio: Buffer.alloc(2000) }), /401: No auth credentials found/);
  assert.equal(calls.length, 1);
});

test("typed order still works if the AI call fails completely", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  fake(() => [402, { error: { code: 402, message: "Insufficient credits" } }]);
  const r = await voice.understandOrder({ text: "two burgers no lettuce and fries for Sam" });
  assert.equal(r.model, "keyword-parser");
  assert.match(r.ai_error, /Insufficient credits/);
  assert.equal(r.customer_name, "Sam");
  assert.deepEqual(r.items[0], { menu_id: "burger", qty: 2, modifiers: { lettuce: "no" } });
});
