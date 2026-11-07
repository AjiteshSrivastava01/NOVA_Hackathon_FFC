// Photo -> voice-style order string, and voice-vs-vision matching.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const vision = require("../src/vision");
const { toOrderItems, formatSummary, parseSummary, compareOrders } = require("../src/vision-string");

const burger = (over = {}) => ({
  menu_id: "burger",
  components: { bun: "present", patty: "present", lettuce: "present", tomato: "present", cheese: "present", onion: "absent", pickles: "absent", ...over },
});

test("observations -> voice-style items and summary", () => {
  const items = toOrderItems({ items: [burger({ lettuce: "absent", onion: "present" }), burger({ lettuce: "absent", onion: "present" }), { menu_id: "fries", components: { fries: "present" } }] });
  assert.deepEqual(items, [
    { name: "Burger", quantity: 2, notes: "no lettuce, add onion" },
    { name: "Fries", quantity: 1, notes: undefined },
  ]);
  assert.equal(formatSummary(items), "2× Burger (no lettuce, add onion), Fries");
});

test("retake -> empty", () => {
  assert.deepEqual(toOrderItems({ retake: true, items: [burger()] }), []);
});

test("parseSummary reads the voice app's string", () => {
  assert.deepEqual(parseSummary("2× Burger (no lettuce, extra cheese), Fries for table 12"), [
    { name: "Burger", quantity: 2, notes: "no lettuce, extra cheese" },
    { name: "Fries", quantity: 1, notes: undefined },
  ]);
});

test("compareOrders tolerates wording differences", () => {
  const seen = toOrderItems({ items: [burger({ lettuce: "absent", onion: "present" }), burger({ lettuce: "absent", onion: "present" })] });
  assert.equal(compareOrders(parseSummary("2× Burgers (without lettuce and with onions)"), seen).match, true);
  assert.equal(compareOrders([{ name: "Coke", quantity: 1 }], [{ name: "Soda", quantity: 1 }]).match, true);
});

test("compareOrders reports what is missing and extra", () => {
  const r = compareOrders(parseSummary("Burger (no lettuce), Fries"), toOrderItems({ items: [burger()] }));
  assert.equal(r.match, false);
  assert.deepEqual(r.missing, ["burger (no lettuce)", "fries"]);
  assert.deepEqual(r.extra, ["burger"]);
});

// ---------- describePhoto with a fake model ----------
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });

test("describePhoto: photo -> summary string, no ticket in the prompt", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  let sent;
  global.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    const b = burger({ lettuce: "absent" });
    const reply = { photo_quality: "good", confidence: 0.9, notes: "", items: [{ menu_id: "burger", components: Object.entries(b.components).map(([component, state]) => ({ component, state })) }] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { cost: 0.002 } }) };
  };
  const r = await vision.describePhoto(Buffer.from("x"), "image/jpeg");
  assert.equal(r.ok, true);
  assert.equal(r.summary, "Burger (no lettuce)");
  assert.deepEqual(r.items, [{ name: "Burger", quantity: 1, notes: "no lettuce" }]);
  assert.doesNotMatch(JSON.stringify(sent.messages[1].content), /expected on this tray/);
});

test("describePhoto: bad photo -> ok:false with a retake reason", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ photo_quality: "bad", confidence: 0.2, notes: "", items: [] }) } }] }) });
  const r = await vision.describePhoto(Buffer.from("x"), "image/jpeg");
  assert.equal(r.ok, false);
  assert.equal(r.summary, "");
  assert.match(r.retake_reason, /unclear/i);
});
