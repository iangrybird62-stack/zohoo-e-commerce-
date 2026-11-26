const test = require("node:test");
const assert = require("node:assert/strict");
const { startStore, CUSTOMER, CART, createOrder } = require("./helpers");

let store;
test.before(async () => { store = await startStore(); });
test.after(() => store.close());

test("GET /api/products returns the catalog with sizes and prices", async () => {
  const res = await store.get("/api/products");
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 8);
  assert.ok(res.json.every((p) => p.id && p.name && Number.isInteger(p.price) && Array.isArray(p.sizes) && p.sizes.length));
});

test("order total is computed from server prices in integer paise; browser prices are ignored", async () => {
  const items = CART.map((i) => ({ ...i, price: 1, amount: 1, unitPrice: 1 }));
  const res = await store.post("/api/create-order", { customer: CUSTOMER, items, amount: 100, total: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.json.amount, 249700); // 2 x ₹499 + 1 x ₹1,499
  assert.equal(res.json.currency, "INR");
  assert.equal(store.rp.createdOrders.at(-1).amount, 249700);
  const row = store.row(res.json.orderId);
  assert.equal(row.amount_paise, 249700);
  assert.equal(row.razorpay_order_id, res.json.razorpayOrderId); // internal order and Razorpay order are associated
  assert.equal(row.payment_status, "created");
  assert.equal(store.rp.createdOrders.at(-1).receipt, res.json.orderId);
});

test("repeated lines for the same product and size are merged before limits apply", async () => {
  const ok = await store.post("/api/create-order", { customer: CUSTOMER, items: [{ productId: "tee-01", size: "S", quantity: 4 }, { productId: "tee-01", size: "S", quantity: 4 }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.amount, 8 * 49900);
  const tooMany = await store.post("/api/create-order", { customer: CUSTOMER, items: [{ productId: "tee-01", size: "S", quantity: 6 }, { productId: "tee-01", size: "S", quantity: 6 }] });
  assert.equal(tooMany.status, 400);
});

test("invalid products, sizes and quantities are rejected and create nothing", async () => {
  const before = store.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  const bad = [
    [{ productId: "nope-99", size: "M", quantity: 1 }],
    [{ productId: "tee-01", size: "XXL", quantity: 1 }],
    [{ productId: "denim-01", size: "M", quantity: 1 }], // size belongs to another product
    [{ productId: "tee-01", size: "M", quantity: 0 }],
    [{ productId: "tee-01", size: "M", quantity: -2 }],
    [{ productId: "tee-01", size: "M", quantity: 1.5 }],
    [{ productId: "tee-01", size: "M", quantity: "2" }],
    [{ productId: "tee-01", size: "M", quantity: 11 }],
    [{ productId: "tee-01", size: "M" }],
    [{ productId: ["tee-01"], size: "M", quantity: 1 }],
    [null], [42], []
  ];
  for (const items of bad) {
    const res = await store.post("/api/create-order", { customer: CUSTOMER, items });
    assert.equal(res.status, 400, JSON.stringify(items));
    assert.ok(res.json.error);
  }
  assert.equal((await store.post("/api/create-order", { customer: CUSTOMER, items: "tee-01" })).status, 400);
  const tooManyLines = Array.from({ length: 101 }, () => ({ productId: "tee-01", size: "M", quantity: 1 }));
  assert.equal((await store.post("/api/create-order", { customer: CUSTOMER, items: tooManyLines })).status, 400);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, before);
});

test("invalid customer details are rejected", async () => {
  const cases = [
    { name: "A" }, { name: "" }, { name: "x".repeat(101) }, { name: ["Asha", "Rao"] },
    { phone: "9876543210" }, { phone: "+0123456789" }, { phone: "+91 98765 43210" }, { phone: 919876543210 },
    { email: "not-an-email" }, { email: "a@b" }, { email: `${"a".repeat(250)}@example.com` },
    { address: "short" }, { address: "x".repeat(501) }, { address: null }
  ];
  for (const override of cases) {
    const res = await store.post("/api/create-order", { customer: { ...CUSTOMER, ...override }, items: CART });
    assert.equal(res.status, 400, JSON.stringify(override));
  }
  assert.equal((await store.post("/api/create-order", { items: CART })).status, 400);
  assert.equal((await store.post("/api/create-order", {})).status, 400);
});

test("malformed JSON gets a clean 400 without a stack trace", async () => {
  const { request } = require("./helpers");
  const res = await request(store.base, "POST", "/api/create-order", { raw: "{not json", headers: { "Content-Type": "application/json" } });
  assert.equal(res.status, 400);
  assert.doesNotMatch(res.text, /at .*\.js/);
});

test("a Razorpay outage returns a safe error and leaves no orphan order row", async () => {
  const before = store.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  store.rp.failCreate = true;
  const res = await store.post("/api/create-order", { customer: CUSTOMER, items: CART });
  store.rp.failCreate = false;
  assert.equal(res.status, 500);
  assert.doesNotMatch(res.text, /razorpay unavailable|stack|at /i);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, before);
});

test("checkout reports unavailable payments clearly when Razorpay is not configured", async () => {
  const bare = await startStore({ razorpay: false, env: { RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" } });
  try {
    const res = await bare.post("/api/create-order", { customer: CUSTOMER, items: CART });
    assert.equal(res.status, 503);
    assert.equal((await bare.get("/api/products")).status, 200); // storefront still works
  } finally { await bare.close(); }
});

test("order ids are unique and unguessable-looking", async () => {
  const a = await createOrder(store), b = await createOrder(store);
  assert.notEqual(a.orderId, b.orderId);
  assert.match(a.orderId, /^ZH[A-Z0-9]{14,}$/);
});

test("placeholder Razorpay values copied from .env.example are treated as not configured", async () => {
  const placeholders = { RAZORPAY_KEY_ID: "rzp_test_your_key_id", RAZORPAY_KEY_SECRET: "your_razorpay_key_secret", RAZORPAY_WEBHOOK_SECRET: "your_razorpay_webhook_secret" };
  const bare = await startStore({ razorpay: false, env: placeholders });
  try {
    assert.deepEqual(bare.config.razorpay.placeholders.sort(), Object.keys(placeholders).sort());
    assert.equal(bare.config.razorpay.keyId, "");
    const res = await bare.post("/api/create-order", { customer: CUSTOMER, items: CART });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /not configured/i);
  } finally { await bare.close(); }
});

test("Razorpay rejecting the keys (401) is logged with a clear hint and shown to the owner only outside production", async () => {
  for (const production of [false, true]) {
    const s = await startStore({ env: { NODE_ENV: production ? "production" : "test" } });
    try {
      s.rp.orders.create = async () => { throw Object.assign(new Error("401"), { statusCode: 401, error: { description: "Authentication failed" } }); };
      const res = await s.post("/api/create-order", { customer: CUSTOMER, items: CART });
      assert.equal(res.status, 500);
      assert.ok(s.logs.some((l) => /Authentication failed/.test(l) && /RAZORPAY_KEY_ID/.test(l)));
      assert.equal(/Razorpay rejected the API keys/.test(res.json.error), !production);
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
    } finally { await s.close(); }
  }
});

test("shipping is added below the free-shipping threshold, from server rules only", async () => {
  // ₹499 x1 is below ₹1,499 -> + ₹99 shipping
  const res = await store.post("/api/create-order", { customer: CUSTOMER, items: [{ productId: "tee-01", size: "M", quantity: 1 }], shipping: 0, shippingFee: 0, shipping_paise: 0, amount: 49900 });
  assert.equal(res.status, 200);
  assert.equal(res.json.subtotal, 49900);
  assert.equal(res.json.shipping, 9900);
  assert.equal(res.json.amount, 59800);
  assert.equal(store.rp.createdOrders.at(-1).amount, 59800); // Razorpay is asked for subtotal + shipping
  const row = store.row(res.json.orderId);
  assert.equal(row.amount_paise, 59800);
  assert.equal(row.shipping_paise, 9900);
});

test("free shipping starts exactly at the threshold", async () => {
  const exact = await store.post("/api/create-order", { customer: CUSTOMER, items: [{ productId: "hoodie-01", size: "M", quantity: 1 }] }); // ₹1,499
  assert.equal(exact.json.shipping, 0);
  assert.equal(exact.json.amount, 149900);
  const justUnder = await store.post("/api/create-order", { customer: CUSTOMER, items: [{ productId: "tee-01", size: "M", quantity: 3 }] }); // ₹1,497
  assert.equal(justUnder.json.shipping, 9900);
  assert.equal(justUnder.json.amount, 149700 + 9900);
  assert.equal(store.row(exact.json.orderId).shipping_paise, 0);
});

test("shipping rules can be changed with SHIPPING_FEE and FREE_SHIPPING_ABOVE; bad values fall back to defaults", async () => {
  const custom = await startStore({ env: { SHIPPING_FEE: "50", FREE_SHIPPING_ABOVE: "1000" } });
  const free = await startStore({ env: { SHIPPING_FEE: "0" } });
  const bad = await startStore({ env: { SHIPPING_FEE: "abc", FREE_SHIPPING_ABOVE: "-5" } });
  try {
    const one = [{ productId: "tee-01", size: "M", quantity: 1 }], three = [{ productId: "tee-01", size: "M", quantity: 3 }];
    assert.equal((await custom.post("/api/create-order", { customer: CUSTOMER, items: one })).json.amount, 49900 + 5000);
    assert.equal((await custom.post("/api/create-order", { customer: CUSTOMER, items: three })).json.shipping, 0);
    assert.equal((await free.post("/api/create-order", { customer: CUSTOMER, items: one })).json.amount, 49900);
    assert.equal((await bad.post("/api/create-order", { customer: CUSTOMER, items: one })).json.shipping, 9900);
    assert.deepEqual((await custom.get("/api/config")).json.shipping, { fee: 50, freeAbove: 1000 });
  } finally { await custom.close(); await free.close(); await bad.close(); }
});

test("/api/config publishes shipping rules in rupees and no secrets", async () => {
  const res = await store.get("/api/config");
  assert.deepEqual(res.json.shipping, { fee: 99, freeAbove: 1499 });
  assert.ok(!res.text.includes("test_key_secret_not_real") && !res.text.includes("test_webhook_secret_not_real"));
});

test("payment must cover shipping: a product-only amount is rejected, the full amount is accepted", async () => {
  const { payment } = require("./helpers");
  const order = (await store.post("/api/create-order", { customer: CUSTOMER, items: [{ productId: "tee-01", size: "M", quantity: 1 }] })).json;
  const short = await store.post("/api/verify-payment", payment(store, order, { id: "pay_TESTship01", amount: 49900 })); // forgot shipping
  assert.equal(short.status, 400);
  assert.equal(store.row(order.orderId).payment_status, "created");
  const full = await store.post("/api/verify-payment", payment(store, order, { id: "pay_TESTship02", amount: 59800 }));
  assert.equal(full.status, 200);
  assert.equal(store.row(order.orderId).payment_status, "paid");
});
