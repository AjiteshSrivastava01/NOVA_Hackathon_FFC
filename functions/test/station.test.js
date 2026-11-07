// Input station flow: voice -> order on the dashboard; photo -> order checked off or flagged.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createMemoryStore } = require("../src/store/memory");

const realFetch = global.fetch;
const server = createApp(createMemoryStore()).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });

const call = (m, p, body) => realFetch(base + p, { method: m, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, data: await r.json() }));
const PHOTO = "data:image/jpeg;base64," + Buffer.from("fakejpeg").toString("base64");
const WAV = "data:audio/wav;base64," + Buffer.alloc(4000).toString("base64");

const BURGER = { bun: "present", patty: "present", lettuce: "present", tomato: "present", cheese: "present", onion: "absent", pickles: "absent" };
let seesOnPlate = [];     // what the fake vision model reports
let heardOrder = null;    // what the fake voice model reports
function fakeModels() {
  global.fetch = async (url, init) => {
    if (!String(url).includes("openrouter.ai")) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const isVoice = String(body.messages[0].content).startsWith("You take restaurant orders");
    const reply = isVoice ? heardOrder : {
      photo_quality: "good", confidence: 0.9, notes: "",
      items: seesOnPlate.map(([menu_id, comps]) => ({ menu_id, components: Object.entries(comps).map(([component, state]) => ({ component, state })) })),
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  };
}
const order = (name, items) => call("POST", "/api/orders", { customer_name: name, items, source: "voice" }).then((r) => r.data);
const events = () => call("GET", "/api/events").then((r) => r.data);

beforeEach(async () => { await call("POST", "/api/reset"); process.env.OPENROUTER_API_KEY = "test"; fakeModels(); });

test("voice audio -> order in menu format (not saved until confirmed)", async () => {
  heardOrder = { transcript: "two burgers no lettuce add onion and fries for Sam", customer_name: "Sam",
    items: [{ menu_id: "burger", qty: 2, remove: ["lettuce"], add: ["onion"] }, { menu_id: "fries", qty: 1, remove: [], add: [] }] };
  const r = await call("POST", "/api/voice/understand", { audio_base64: WAV });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.customer_name, "Sam");
  assert.deepEqual(r.data.items[0], { menu_id: "burger", qty: 2, modifiers: { lettuce: "no", onion: "add" } });
  assert.equal(r.data.summary, "2× Burger (no lettuce, add onion), Fries");
  assert.equal((await call("GET", "/api/orders")).data.length, 0);
});

test("voice with no menu items -> friendly 422", async () => {
  heardOrder = { transcript: "hello there", customer_name: "Guest", items: [] };
  const r = await call("POST", "/api/voice/understand", { text: "hello there" });
  assert.equal(r.status, 422);
  assert.match(r.data.detail, /no menu items/);
});

test("photo matches an open order -> checked off into a cubby", async () => {
  await order("Ava", [{ menu_id: "fries" }]);
  const o = await order("Ben", [{ menu_id: "burger", modifiers: { lettuce: "no" } }]);
  seesOnPlate = [["burger", { ...BURGER, lettuce: "absent" }]];
  const r = (await call("POST", "/api/check-meal", { photo: PHOTO })).data;
  assert.equal(r.outcome, "checked_off");
  assert.equal(r.order_id, o.id);
  assert.equal(r.cubby.label, "C1");
  const got = (await call("GET", `/api/orders/${o.id}`)).data;
  assert.equal(got.status, "in_cubby");
  assert.ok((await events()).some((e) => e.kind === "checked_off" && e.level === "success"));
});

test("wrong meal -> closest order flagged with reasons and an error alert", async () => {
  const o = await order("Cy", [{ menu_id: "burger", modifiers: { lettuce: "no" } }]);
  seesOnPlate = [["burger", BURGER]]; // lettuce present
  const r = (await call("POST", "/api/check-meal", { photo: PHOTO })).data;
  assert.equal(r.outcome, "flagged");
  assert.equal(r.order_id, o.id);
  assert.match(r.reasons[0], /lettuce present but should not be/);
  assert.equal((await call("GET", `/api/orders/${o.id}`)).data.status, "needs_attention");
  const alert = (await events()).find((e) => e.kind === "check_failed");
  assert.equal(alert.level, "error");
  assert.match(alert.detail, /Order #\d+ \(Cy\) is wrong/);
});

test("matches a newer order but one change off an older one -> possible mix-up warning", async () => {
  const older = await order("Dee", [{ menu_id: "burger", modifiers: { lettuce: "no" } }]);
  const newer = await order("Eve", [{ menu_id: "burger" }]);
  seesOnPlate = [["burger", BURGER]]; // matches Eve exactly, Dee except lettuce
  const r = (await call("POST", "/api/check-meal", { photo: PHOTO })).data;
  assert.equal(r.outcome, "checked_off");
  assert.equal(r.order_id, newer.id);
  assert.match(r.warning, new RegExp(`#${older.id}`));
  const w = (await events()).find((e) => e.kind === "possible_mixup");
  assert.equal(w.order_id, older.id);
  assert.equal(w.level, "warning");
});

test("photo of something no open order has -> no_match, nothing flagged", async () => {
  const o = await order("Fay", [{ menu_id: "soda" }]);
  seesOnPlate = [["fries", { fries: "present" }]];
  const r = (await call("POST", "/api/check-meal", { photo: PHOTO })).data;
  assert.equal(r.outcome, "no_match");
  assert.equal((await call("GET", `/api/orders/${o.id}`)).data.status, "pending");
});

test("blurry photo -> retake, nothing changes", async () => {
  const o = await order("Gus", [{ menu_id: "fries" }]);
  global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ photo_quality: "bad", confidence: 0.2, notes: "", items: [] }) } }] }));
  const r = (await call("POST", "/api/check-meal", { photo: PHOTO })).data;
  assert.equal(r.outcome, "retake");
  assert.equal((await call("GET", `/api/orders/${o.id}`)).data.status, "pending");
});

test("a flagged order can be re-checked after the kitchen fixes it", async () => {
  const o = await order("Hal", [{ menu_id: "burger", modifiers: { lettuce: "no" } }]);
  seesOnPlate = [["burger", BURGER]];
  assert.equal((await call("POST", "/api/check-meal", { photo: PHOTO })).data.outcome, "flagged");
  seesOnPlate = [["burger", { ...BURGER, lettuce: "absent" }]];
  const r = (await call("POST", "/api/check-meal", { photo: PHOTO })).data;
  assert.equal(r.outcome, "checked_off");
  assert.equal(r.order_id, o.id);
});
