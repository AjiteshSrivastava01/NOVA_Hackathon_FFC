// Vision plumbing tests with a fake OpenRouter (no network, no API key needed).
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const vision = require("../src/vision");
const { evaluate } = require("../src/matching");

const order = { items: [{ line_id: 1, menu_id: "burger", qty: 1, modifiers: { lettuce: "no" } }] };
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });

function fakeModel(reply, { failStructured = false } = {}) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (failStructured && body.response_format) {
      return { ok: false, status: 400, json: async () => ({ error: { message: "response_format not supported" } }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: reply } }], usage: { cost: 0.001 } }) };
  };
  return calls;
}

test("no API key -> null (dashboard falls back to samples)", async () => {
  delete process.env.OPENROUTER_API_KEY; // in case vision.local.env set it
  assert.equal(await vision.analyze(Buffer.from("x"), "image/jpeg", order), null);
});

test("parses present/absent answers and drops invented dishes", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  const comps = { bun: "present", patty: "present", lettuce: "present", tomato: "present" };
  fakeModel("```json\n" + JSON.stringify({
    photo_quality: "good", confidence: 0.9, notes: "",
    items: [
      { menu_id: "burger", components: Object.entries(comps).map(([component, state]) => ({ component, state })) },
      { menu_id: "sushi", components: [] },
    ],
  }) + "\n```");
  const obs = await vision.analyze(Buffer.from("x"), "image/jpeg", order);
  assert.equal(obs.items.length, 1);
  assert.deepEqual(obs.items[0].components, comps);
  assert.equal(obs.retake, false);
  assert.ok(!Object.values(obs.items[0].components).includes("unknown"));
  // lettuce present on a no-lettuce ticket -> fail
  assert.equal(evaluate(order.items, obs).verdict, "fail");
});

test("model skips a component or says 'unknown' -> retake, never a silent guess", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  fakeModel(JSON.stringify({
    photo_quality: "good", confidence: 0.9, notes: "",
    items: [{ menu_id: "burger", components: [{ component: "lettuce", state: "unknown" }, { component: "bun", state: "present" }] }],
  }));
  const obs = await vision.analyze(Buffer.from("x"), "image/jpeg", order);
  assert.equal(obs.retake, true);
  assert.match(obs.retake_reason, /burger\.lettuce/);
  assert.equal(evaluate(order.items, obs).verdict, "needs_review");
});

test("low confidence or bad photo -> all unknown -> needs_review (retake)", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  fakeModel(JSON.stringify({ photo_quality: "bad", confidence: 0.3, notes: "blurry", items: [] }));
  const obs = await vision.analyze(Buffer.from("x"), "image/jpeg", order);
  assert.equal(obs.retake, true);
  assert.ok(Object.values(obs.items[0].components).every((v) => v === "unknown"));
  assert.equal(evaluate(order.items, obs).verdict, "needs_review");
});

test("model error -> retake instead of crashing the request", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  global.fetch = async () => { throw new Error("network down"); };
  const obs = await vision.analyze(Buffer.from("x"), "image/jpeg", order);
  assert.equal(obs.retake, true);
  assert.match(obs.retake_reason, /network down/);
  assert.equal(evaluate(order.items, obs).verdict, "needs_review");
  await assert.rejects(vision.analyze(Buffer.from("x"), "image/jpeg", order, { throwOnError: true }));
});

test("falls back to prompt-only JSON when a model rejects structured output", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  const calls = fakeModel(JSON.stringify({ photo_quality: "good", confidence: 0.8, notes: "", items: [] }), { failStructured: true });
  await vision.analyze(Buffer.from("x"), "image/jpeg", order);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].response_format && !calls[1].response_format);
});

test("prompt does not leak the requested modifiers", () => {
  const msgs = vision.buildMessages("data:image/jpeg;base64,eA==", order);
  const text = JSON.stringify(msgs[1].content);
  assert.match(text, /1x burger/);
  assert.doesNotMatch(text, /no lettuce|"lettuce":"no"/i);
});
