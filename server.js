require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const Database = require("better-sqlite3");
const Razorpay = require("razorpay");
const twilio = require("twilio");

const app = express();
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\\/$/, "");
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "zohoo.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    address TEXT NOT NULL,
    items_json TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    razorpay_order_id TEXT UNIQUE,
    razorpay_payment_id TEXT,
    payment_status TEXT NOT NULL DEFAULT 'created',
    notification_status TEXT NOT NULL DEFAULT 'pending'
  );
`);

const PRODUCTS = [
  { id: "tee-01", name: "Everyday Essential Tee", category: "T-Shirts", price: 499, oldPrice: 699, badge: "BESTSELLER", color: "Cream", sizes: ["S","M","L","XL"], image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=85", description: "Soft cotton comfort for everyday styling." },
  { id: "shirt-01", name: "Classic Linen Shirt", category: "Shirts", price: 1199, oldPrice: 1499, badge: "NEW", color: "Sage", sizes: ["S","M","L","XL"], image: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=900&q=85", description: "A relaxed fit with a clean, timeless finish." },
  { id: "hoodie-01", name: "Weekend Hoodie", category: "Hoodies", price: 1499, oldPrice: 1899, badge: "POPULAR", color: "Charcoal", sizes: ["S","M","L","XL"], image: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=900&q=85", description: "A cozy layer for slower days and cool nights." },
  { id: "dress-01", name: "Everyday Midi Dress", category: "Dresses", price: 1799, oldPrice: 2199, badge: "", color: "Black", sizes: ["XS","S","M","L"], image: "https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=900&q=85", description: "Easy elegance made for day-to-night plans." },
  { id: "denim-01", name: "Straight Fit Denim", category: "Jeans", price: 1599, oldPrice: 1999, badge: "", color: "Blue", sizes: ["28","30","32","34"], image: "https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=900&q=85", description: "A versatile denim staple with a modern fit." },
  { id: "jacket-01", name: "Utility Overshirt", category: "Outerwear", price: 1999, oldPrice: 2499, badge: "LIMITED", color: "Olive", sizes: ["S","M","L","XL"], image: "https://images.unsplash.com/photo-1591047139829-d91aecb6caea?auto=format&fit=crop&w=900&q=85", description: "Lightweight structure for effortless layering." },
  { id: "sweat-01", name: "Minimal Crew Sweatshirt", category: "Sweatshirts", price: 1299, oldPrice: 1599, badge: "", color: "Grey", sizes: ["S","M","L","XL"], image: "https://images.unsplash.com/photo-1578681994506-b8f463449011?auto=format&fit=crop&w=900&q=85", description: "Clean lines, soft feel, easy to pair." },
  { id: "top-01", name: "Ribbed Everyday Top", category: "Tops", price: 799, oldPrice: 999, badge: "NEW", color: "White", sizes: ["XS","S","M","L"], image: "https://images.unsplash.com/photo-1564257577-0a9d9c6a4d83?auto=format&fit=crop&w=900&q=85", description: "A flattering wardrobe essential with subtle texture." }
];

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function rupees(paise) { return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function validPhone(phone) {
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone.trim());
}
function getOrder(id) { return db.prepare("SELECT * FROM orders WHERE id = ?").get(id); }

async function sendNotifications(order) {
  if (!twilioClient) {
    console.warn("Notifications not sent: configure Twilio credentials in .env");
    return { skipped: true };
  }
  const fromWhatsApp = process.env.TWILIO_WHATSAPP_FROM;
  const ownerWhatsApp = process.env.OWNER_WHATSAPP;
  const fromSms = process.env.TWILIO_SMS_FROM;
  if (!fromWhatsApp || !ownerWhatsApp || !fromSms) {
    console.warn("Notifications not sent: Twilio sender / owner number missing");
    return { skipped: true };
  }
  const items = JSON.parse(order.items_json);
  const itemLines = items.map(i => `• ${i.name} (${i.size}) x${i.quantity}`).join("\n");
  const total = rupees(order.amount_paise);
  const orderMessage = `Zohoo order confirmed 🎉\nOrder: ${order.id}\nItems:\n${itemLines}\nTotal paid: ${total}\nShip to: ${order.customer_name}, ${order.address}\nThank you for shopping with Zohoo!`;
  const ownerMessage = `🛍️ NEW ZOHOO ORDER\nOrder: ${order.id}\nCustomer: ${order.customer_name}\nPhone: ${order.phone}\nItems:\n${itemLines}\nPaid: ${total}\nAddress: ${order.address}`;
  const results = await Promise.allSettled([
    twilioClient.messages.create({ from: fromWhatsApp, to: `whatsapp:${order.phone}`, body: orderMessage }),
    twilioClient.messages.create({ from: fromSms, to: order.phone, body: `Zohoo: payment received for order ${order.id}. Total ${total}. Confirmation sent on WhatsApp.` }),
    twilioClient.messages.create({ from: fromWhatsApp, to: ownerWhatsApp, body: ownerMessage })
  ]);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(["Customer WhatsApp","Customer SMS","Owner WhatsApp"][i], r.reason.message);
  });
  return { sent: results.filter(r => r.status === "fulfilled").length, failed: results.filter(r => r.status === "rejected").length };
}

async function notifyPaidOrder(orderId) {
  const order = getOrder(orderId);
  if (!order || order.payment_status !== "paid" || order.notification_status !== "pending") return;
  // Claim notification processing to avoid concurrent webhook + checkout callbacks sending duplicates.
  const claimed = db.prepare("UPDATE orders SET notification_status='processing' WHERE id=? AND notification_status='pending'").run(orderId);
  if (!claimed.changes) return;
  const fresh = getOrder(orderId);
  try {
    const result = await sendNotifications(fresh);
    db.prepare("UPDATE orders SET notification_status=? WHERE id=?").run(result.skipped ? "not_configured" : "sent", orderId);
  } catch (err) {
    console.error("Notification error:", err.message);
    db.prepare("UPDATE orders SET notification_status='failed' WHERE id=?").run(orderId);
  }
}

// Basic CORS for a separately hosted Netlify frontend. Set FRONTEND_URL to the exact deployed site origin.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && FRONTEND_URL && origin === FRONTEND_URL) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Razorpay-Signature");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Razorpay webhook must receive the raw body to verify its signature.
app.post("/api/razorpay-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];
  if (!secret || !signature) return res.status(400).send("Webhook secret/signature missing");
  const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!safeEqualHex(expected, signature)) return res.status(400).send("Invalid webhook signature");
  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("Invalid JSON"); }
  if (event.event === "payment.captured" || event.event === "order.paid") {
    const payment = event.payload?.payment?.entity;
    const razorOrderId = payment?.order_id || event.payload?.order?.entity?.id;
    if (razorOrderId) {
      const row = db.prepare("SELECT id FROM orders WHERE razorpay_order_id=?").get(razorOrderId);
      if (row) {
        db.prepare("UPDATE orders SET payment_status='paid', razorpay_payment_id=COALESCE(?, razorpay_payment_id) WHERE id=?")
          .run(payment?.id || null, row.id);
        await notifyPaidOrder(row.id);
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/products", (req, res) => res.json(PRODUCTS));
app.get("/api/config", (req, res) => res.json({ razorpayKeyId: process.env.RAZORPAY_KEY_ID || null, currency: "INR" }));

app.post("/api/create-order", async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Online payment is not configured yet. Add Razorpay keys to .env." });
    const { customer, items } = req.body || {};
    if (!customer || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "Customer and cart items are required." });
    const name = String(customer.name || "").trim();
    const phone = String(customer.phone || "").trim();
    const email = String(customer.email || "").trim();
    const address = String(customer.address || "").trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Enter your full name." });
    if (!validPhone(phone)) return res.status(400).json({ error: "Enter phone in international format, e.g. +919876543210." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (address.length < 8 || address.length > 500) return res.status(400).json({ error: "Enter your complete delivery address." });

    const normalized = [];
    for (const item of items) {
      const product = PRODUCTS.find(p => p.id === item.productId);
      const quantity = Number(item.quantity);
      const size = String(item.size || "");
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10 || !product.sizes.includes(size)) {
        return res.status(400).json({ error: "One or more cart items are invalid. Refresh the page and try again." });
      }
      normalized.push({ productId: product.id, name: product.name, price: product.price, size, quantity });
    }
    const amountPaise = normalized.reduce((sum, item) => sum + item.price * item.quantity * 100, 0);
    if (amountPaise < 100 || amountPaise > 50000000) return res.status(400).json({ error: "Order total is outside the supported range." });

    const internalId = `ZH${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const rpOrder = await razorpay.orders.create({
      amount: amountPaise, currency: "INR", receipt: internalId,
      notes: { zohoo_order_id: internalId, customer_name: name }
    });
    db.prepare(`INSERT INTO orders (id, created_at, customer_name, phone, email, address, items_json, amount_paise, razorpay_order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      internalId, new Date().toISOString(), name, phone, email, address,
      JSON.stringify(normalized), amountPaise, rpOrder.id
    );
    res.json({ orderId: internalId, razorpayOrderId: rpOrder.id, amount: amountPaise, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID, customer: { name, email, phone } });
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(500).json({ error: "Could not create payment order. Please try again." });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  try {
    const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const order = getOrder(String(orderId || ""));
    if (!order || order.razorpay_order_id !== razorpay_order_id) return res.status(400).json({ error: "Order not found." });
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
    if (!safeEqualHex(expected, String(razorpay_signature || ""))) return res.status(400).json({ error: "Payment signature verification failed." });
    db.prepare("UPDATE orders SET payment_status='paid', razorpay_payment_id=? WHERE id=?").run(razorpay_payment_id, order.id);
    await notifyPaidOrder(order.id);
    res.json({ ok: true, orderId: order.id });
  } catch (err) {
    console.error("Verify payment error:", err.message);
    res.status(500).json({ error: "Could not verify payment. If money was deducted, contact the store with your order ID." });
  }
});

app.get("/api/order/:id", (req, res) => {
  const order = getOrder(String(req.params.id || ""));
  if (!order) return res.status(404).json({ error: "Order not found." });
  // Only return a limited status view; never expose address or phone.
  res.json({ orderId: order.id, status: order.payment_status, notificationStatus: order.notification_status, total: rupees(order.amount_paise), items: JSON.parse(order.items_json) });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Zohoo is running at ${BASE_URL}`));
