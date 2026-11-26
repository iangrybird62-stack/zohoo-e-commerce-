const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const Database = require("better-sqlite3");
const { openDatabase } = require("../server");
const { request } = require("./helpers");

const root = path.join(__dirname, "..");
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : p.endsWith(".js") ? [p] : [];
  });
}

test("every JavaScript file in the project passes node --check", () => {
  const files = jsFiles(root);
  assert.ok(files.some((f) => f.endsWith("server.js")) && files.some((f) => f.endsWith(path.join("public", "app.js"))));
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    assert.equal(r.status, 0, `${path.relative(root, f)}: ${r.stderr}`);
  }
});

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test("server process starts without Razorpay or Twilio credentials and serves the storefront", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zohoo-start-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  try {
    const deadline = Date.now() + 10000;
    while (!/Zohoo is running/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /Zohoo is running/);
    assert.match(out, /Payments disabled until these are set: RAZORPAY_KEY_ID/); // missing config reported by name
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await request(base, "GET", "/api/health")).json.ok, true);
    const home = await request(base, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.text, /zohoo/i);
    const orderTry = await request(base, "POST", "/api/create-order", { body: { customer: {}, items: [] } });
    assert.ok([400, 503].includes(orderTry.status));
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("production mode refuses to start when Razorpay variables are missing, naming them but not leaking values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zohoo-prod-"));
  const r = spawnSync(process.execPath, ["server.js"], { cwd: root, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, NODE_ENV: "production", DATA_DIR: dir, RAZORPAY_KEY_ID: "rzp_test_visible_id" } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RAZORPAY_KEY_SECRET/);
  assert.match(r.stderr, /RAZORPAY_WEBHOOK_SECRET/);
  assert.doesNotMatch(r.stderr, /rzp_test_visible_id/);
});

test("schema migration keeps existing orders and adds the new columns idempotently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zohoo-mig-"));
  const old = new Database(path.join(dir, "zohoo.sqlite"));
  old.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, address TEXT NOT NULL, items_json TEXT NOT NULL, amount_paise INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', razorpay_order_id TEXT UNIQUE, razorpay_payment_id TEXT, payment_status TEXT NOT NULL DEFAULT 'created', notification_status TEXT NOT NULL DEFAULT 'pending');`);
  old.prepare("INSERT INTO orders (id, created_at, customer_name, phone, email, address, items_json, amount_paise, razorpay_order_id, razorpay_payment_id, payment_status, notification_status) VALUES ('ZHOLD1','2026-01-01','Old Customer','+911234567890','o@example.com','Old address 1','[]',49900,'order_OLD001','pay_OLD001','paid','sent')").run();
  old.close();
  for (let i = 0; i < 2; i++) {
    const db = openDatabase(dir);
    const row = db.prepare("SELECT * FROM orders WHERE id='ZHOLD1'").get();
    assert.equal(row.payment_status, "paid");
    assert.equal(row.notification_status, "sent");
    assert.equal(row.amount_paise, 49900);
    assert.equal(row.shipping_paise, 0); // pre-existing orders were charged without shipping and stay that way
    for (const col of ["paid_at", "shipping_paise", "notify_customer_whatsapp", "notify_customer_sms", "notify_owner_whatsapp"]) assert.ok(col in row, col);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='webhook_events'").get());
    db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
