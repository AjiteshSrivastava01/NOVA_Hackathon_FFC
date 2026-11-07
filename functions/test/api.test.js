
// Run: npm test (uses the in-memory store, no Firebase needed)

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/app");
const { createMemoryStore } = require("../src/store/memory");

let server;
let base;

// Give each test its own application and fresh in-memory database.
beforeEach(async () => {
  const app = createApp(createMemoryStore());
  server = app.listen(0);

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  base = `http://127.0.0.1:${server.address().port}`;
});

// Close the server after each test.
afterEach(async () => {
  if (!server?.listening) return;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data };
}

const post = (path, body) => call("POST", path, body);
const get = (path) => call("GET", path);

async function make(name, items) {
  const r = await post("/api/orders", {
    customer_name: name,
    items,
  });

  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

function burgerObs(lettuce = "present") {
  return {
    menu_id: "burger",
    components: {
      bun: "present",
      patty: "present",
      lettuce,
      tomato: "present",
      cheese: "present",
      onion: "absent",
      pickles: "absent",
    },
  };
}

test("full flow: create -> inspect -> cubby -> pickup", async () => {
  const o = await make("Ava", [
    { menu_id: "burger", qty: 2 },
    { menu_id: "fries" },
  ]);

  assert.deepEqual(
    (await get("/api/orders")).data.map((x) => x.id),
    [o.id]
  );

  const insp = await post(
    `/api/orders/${o.id}/inspect/sample?mode=correct`
  );

  assert.equal(insp.data.verdict, "pass");

  const a = await post(`/api/orders/${o.id}/assign-cubby`, {});

  assert.equal(a.status, 200);
  assert.equal(a.data.cubby.label, "C1");

  assert.equal(
    (await get("/api/cubbies")).data[0].order_id,
    o.id
  );

  const p = await post(`/api/orders/${o.id}/pickup`);

  assert.equal(p.data.status, "picked_up");

  assert.equal(
    (await get("/api/cubbies")).data[0].order_id,
    null
  );

  assert.deepEqual((await get("/api/orders")).data, []);
});

test("two burgers are not one burger", async () => {
  const o = await make("Ben", [
    { menu_id: "burger", qty: 2 },
  ]);

  const r = await post(`/api/orders/${o.id}/inspect`, {
    observations: {
      items: [burgerObs()],
    },
  });

  assert.equal(r.data.verdict, "fail");
  assert.match(r.data.reasons[0], /expected 2, saw 1/);
});

test("hidden lettuce needs review, cubby requires override", async () => {
  const o = await make("Cy", [
    { menu_id: "burger" },
  ]);

  const r = await post(`/api/orders/${o.id}/inspect`, {
    observations: {
      items: [burgerObs("unknown")],
    },
  });

  assert.equal(r.data.verdict, "needs_review");

  assert.equal(
    (await post(`/api/orders/${o.id}/assign-cubby`, {})).status,
    409
  );

  assert.equal(
    (
      await post(`/api/orders/${o.id}/assign-cubby`, {
        override: true,
        staff_note: "checked",
      })
    ).status,
    200
  );
});

test("retakes keep history; swap is only a suggestion until staff confirm", async () => {
  const a = await make("Dee", [
    { menu_id: "burger", modifiers: { lettuce: "no" } },
  ]);

  const b = await make("Eve", [
    { menu_id: "burger" },
  ]);

  const r = await post(`/api/orders/${a.id}/inspect`, {
    observations: {
      items: [burgerObs()],
    },
  });

  assert.equal(r.data.verdict, "fail");
  assert.equal(r.data.swap_suggestion.order_id, b.id);

  assert.deepEqual(
    (await get(`/api/orders/${b.id}`)).data.inspections,
    []
  );

  await post(`/api/orders/${a.id}/inspect`, {
    observations: {
      items: [burgerObs("absent")],
    },
  });

  assert.deepEqual(
    (await get(`/api/orders/${b.id}`)).data.inspections,
    []
  );

  const hist = (await get(`/api/orders/${a.id}`)).data.inspections;

  assert.deepEqual(
    hist.map((h) => h.verdict),
    ["pass", "fail"]
  );

  const re = await post(
    `/api/inspections/${hist[1].id}/reassign`,
    { target_order_id: b.id }
  );

  assert.equal(re.data.verdict, "pass");
  assert.equal(re.data.reassigned_from, hist[1].id);
});

test("rejects bad menu ids and modifiers", async () => {
  assert.equal(
    (
      await post("/api/orders", {
        customer_name: "X",
        items: [
          {
            menu_id: "burger",
            modifiers: { patty: "no" },
          },
        ],
      })
    ).status,
    422
  );

  assert.equal(
    (
      await post("/api/orders", {
        customer_name: "X",
        items: [{ menu_id: "pizza" }],
      })
    ).status,
    422
  );

  assert.equal(
    (
      await post("/api/orders", {
        customer_name: "",
        items: [{ menu_id: "soda" }],
      })
    ).status,
    422
  );
});

test("photo upload: 501 without vision, works with fallback, photo is served", async () => {
  const o = await make("Flo", [
    { menu_id: "fries" },
  ]);

  const photo =
    "data:image/jpeg;base64," +
    Buffer.from("fakejpeg").toString("base64");

  assert.equal(
    (
      await post(`/api/orders/${o.id}/inspect`, {
        photo_base64: photo,
      })
    ).status,
    501
  );

  const r = await post(`/api/orders/${o.id}/inspect`, {
    photo_base64: photo,
    fallback_sample: "correct",
  });

  assert.equal(r.status, 200);

  assert.match(
    r.data.photo_path,
    /^\/photos\/[a-z0-9]+\.jpg$/
  );

  const img = await fetch(base + r.data.photo_path);

  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
});

test("cubbies run out", async () => {
  let r;

  for (let i = 0; i < 9; i++) {
    const o = await make(`P${i}`, [
      { menu_id: "soda" },
    ]);

    r = await post(`/api/orders/${o.id}/assign-cubby`, {
      override: true,
    });
  }

  assert.equal(r.status, 409);
  assert.match(r.data.detail, /No free cubbies/);
});

test("concurrent cubby requests never double-book", async () => {
  const orders = [];

  for (let i = 0; i < 8; i++) {
    orders.push(
      await make(`Q${i}`, [
        { menu_id: "soda" },
      ])
    );
  }

  const res = await Promise.all(
    orders.map((o) =>
      post(`/api/orders/${o.id}/assign-cubby`, {
        override: true,
      })
    )
  );

  const labels = res.map((r) => r.data.cubby.label);

  assert.equal(new Set(labels).size, 8);
});

test("voice parser placeholder", async () => {
  const r = await post("/api/voice/parse", {
    transcript: "Two burgers no lettuce and fries for Sam",
  });

  assert.equal(r.data.customer_name, "Sam");

  assert.deepEqual(r.data.items[0], {
    menu_id: "burger",
    qty: 2,
    modifiers: { lettuce: "no" },
  });

  assert.equal(r.data.items[1].menu_id, "fries");
});

test("destructive reset endpoint is not exposed", async () => {
  const r = await post("/api/reset");

  assert.equal(r.status, 404);
});
