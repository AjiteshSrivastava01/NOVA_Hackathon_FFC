// /api/vision/* endpoints through the real Express app (memory store, fake model).
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createMemoryStore } = require("../src/store/memory");

const realFetch = global.fetch;
const server = createApp(createMemoryStore()).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });

const post = (p, body) => realFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, data: await r.json() }));
const PHOTO = "data:image/jpeg;base64," + Buffer.from("fakejpeg").toString("base64");

function fakeModelSees(items) {
  global.fetch = async (url, init) => {
    if (!String(url).includes("openrouter.ai")) return realFetch(url, init);
    const reply = { photo_quality: "good", confidence: 0.9, notes: "",
      items: items.map(([menu_id, comps]) => ({ menu_id, components: Object.entries(comps).map(([component, state]) => ({ component, state })) })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { cost: 0.003 } }));
  };
}
const BURGER_NO_LETTUCE = { bun: "present", patty: "present", lettuce: "absent", tomato: "present", cheese: "present", onion: "absent", pickles: "absent" };

test("describe without a key -> 501", async () => {
  delete process.env.OPENROUTER_API_KEY;
  const r = await post("/api/vision/describe", { photo: PHOTO });
  assert.equal(r.status, 501);
});

test("describe -> string, saved, photo served, listed in results", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  fakeModelSees([["burger", BURGER_NO_LETTUCE], ["burger", BURGER_NO_LETTUCE], ["fries", { fries: "present" }]]);
  const r = await post("/api/vision/describe", { photo: PHOTO, order_id: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.summary, "2× Burger (no lettuce), Fries");
  assert.equal(r.data.order_id, 7);
  assert.match(r.data.photo_url, /^\/photos\//);
  assert.equal((await realFetch(base + r.data.photo_url)).status, 200);
  const list = await (await realFetch(base + "/api/vision/results")).json();
  assert.equal(list[0].id, r.data.id);
  assert.equal(list[0].summary, "2× Burger (no lettuce), Fries");
});

test("compare a voice string with the vision string", async () => {
  const yes = await post("/api/vision/compare", { ordered: "2× Burgers (without lettuce), Fries for table 12", seen: "2× Burger (no lettuce), Fries" });
  assert.equal(yes.data.match, true);
  const no = await post("/api/vision/compare", { ordered: "Burger, Coke", seen: "Burger" });
  assert.deepEqual(no.data, { match: false, missing: ["soda"], extra: [] });
});

test("config reports model and storage", async () => {
  const cfg = await (await realFetch(base + "/api/vision/config")).json();
  assert.equal(cfg.storage, "memory");
  assert.ok(cfg.model);
});
