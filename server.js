require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const Database = require("better-sqlite3");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const stripTrailingSlashes = (s) => String(s || "").trim().replace(/\/+$/, "");
// Values copied unchanged from .env.example must not count as real credentials.
const isPlaceholder = (v) => /your_|xxxx|replace_with|changeme|<.*>/i.test(String(v || ""));
const realValue = (v) => (v && !isPlaceholder(v) ? String(v).trim() : "");

function parseOrigins(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try { return new URL(s).origin; } catch { return stripTrailingSlashes(s); }
    });
}

// Whole-rupee env value -> paise; anything missing or invalid falls back to the default.
function rupeesToPaise(value, fallbackRupees) {
  const n = Number(String(value === undefined ? "" : value).trim());
  return String(value || "").trim() !== "" && Number.isInteger(n) && n >= 0 ? n * 100 : fallbackRupees * 100;
}

function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  return {
    shipping: {
      feePaise: rupeesToPaise(env.SHIPPING_FEE, 99),
      freeAbovePaise: rupeesToPaise(env.FREE_SHIPPING_ABOVE, 1499)
    },
    isProduction: env.NODE_ENV === "production",
    port,
    baseUrl: stripTrailingSlashes(env.BASE_URL) || `http://localhost:${port}`,
    dataDir: env.DATA_DIR || path.join(__dirname, "data"),
    dataDirExplicit: Boolean(env.DATA_DIR),
    frontendOrigins: parseOrigins(env.FRONTEND_URL),
    razorpay: {
      keyId: realValue(env.RAZORPAY_KEY_ID),
      keySecret: realValue(env.RAZORPAY_KEY_SECRET),
      webhookSecret: realValue(env.RAZORPAY_WEBHOOK_SECRET),
      placeholders: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"].filter((k) => env[k] && isPlaceholder(env[k]))
    },
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || "",
      authToken: env.TWILIO_AUTH_TOKEN || "",
      smsFrom: env.TWILIO_SMS_FROM || "",
      whatsappFrom: env.TWILIO_WHATSAPP_FROM || "",
      ownerWhatsapp: env.OWNER_WHATSAPP || ""
    }
  };
}

// Variables the store cannot take real payments without. Names only; values are never printed.
function missingRequiredConfig(config) {
  const missing = [];
  if (!config.razorpay.keyId) missing.push("RAZORPAY_KEY_ID");
  if (!config.razorpay.keySecret) missing.push("RAZORPAY_KEY_SECRET");
  if (!config.razorpay.webhookSecret) missing.push("RAZORPAY_WEBHOOK_SECRET");
  return missing;
}

function missingOptionalConfig(config) {
  const t = config.twilio;
  const missing = [];
  if (!t.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!t.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!t.whatsappFrom) missing.push("TWILIO_WHATSAPP_FROM");
  if (!t.smsFrom) missing.push("TWILIO_SMS_FROM");
  if (!t.ownerWhatsapp) missing.push("OWNER_WHATSAPP");
  return missing;
}

function assertProductionConfig(config) {
  if (!config.isProduction) return;
  const missing = missingRequiredConfig(config);
  if (missing.length) {
    throw new Error(`Missing required environment variables for production: ${missing.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Catalog (server-side source of truth for prices, in rupees)
// ---------------------------------------------------------------------------
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
const PRODUCT_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));

const MAX_QTY_PER_LINE = 10;
const MAX_LINES = 20;
const MIN_ORDER_PAISE = 100;
const MAX_ORDER_PAISE = 50000000; // ₹5,00,000
const CURRENCY = "INR";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const CHANNELS = ["customer_whatsapp", "customer_sms", "owner_whatsapp"];

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "zohoo.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
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
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  // Additive, non-destructive migrations: existing orders are never dropped or rewritten.
  const existing = new Set(db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name));
  const addColumn = (name, ddl) => { if (!existing.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${ddl}`); };
  addColumn("paid_at", "TEXT");
  addColumn("shipping_paise", "INTEGER NOT NULL DEFAULT 0"); // part of amount_paise; old orders had no shipping
  for (const ch of CHANNELS) addColumn(`notify_${ch}`, "TEXT NOT NULL DEFAULT 'pending'");
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rupees(paise) { return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }

const HEX64 = /^[0-9a-f]{64}$/i;
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !HEX64.test(a) || !HEX64.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
const hmacHex = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

const validPhone = (phone) => typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone.trim());
const validEmail = (email) => typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const RZP_ORDER_ID = /^order_[A-Za-z0-9]{6,40}$/;
const RZP_PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const INTERNAL_ORDER_ID = /^ZH[A-Z0-9]{6,40}$/;

function overallNotificationStatus(statuses) {
  const attempted = statuses.filter((s) => s !== "not_configured");
  if (attempted.length === 0) return "not_configured";
  const sent = attempted.filter((s) => s === "sent").length;
  const failed = attempted.filter((s) => s === "failed").length;
  if (sent === attempted.length && attempted.length === statuses.length) return "sent";
  if (failed === attempted.length) return "failed";
  return "partial"; // some delivered, some failed or not configured
}

// ---------------------------------------------------------------------------
// App factory (dependencies are injectable so tests never touch real services)
// ---------------------------------------------------------------------------
function createApp(options = {}) {
  const config = options.config || loadConfig();
  const db = options.db || openDatabase(config.dataDir);
  const log = options.logger || console;

  let razorpay = options.razorpay || null;
  if (!razorpay && config.razorpay.keyId && config.razorpay.keySecret) {
    const Razorpay = require("razorpay");
    razorpay = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  }
  let twilioClient = options.twilioClient || null;
  if (!twilioClient && config.twilio.accountSid && config.twilio.authToken) {
    twilioClient = require("twilio")(config.twilio.accountSid, config.twilio.authToken);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in front of the service

  const getOrder = (id) => db.prepare("SELECT * FROM orders WHERE id = ?").get(id);

  // ---- Notifications -------------------------------------------------------
  const pendingNotifications = new Set();

  function channelPlan(order) {
    const t = config.twilio;
    const items = JSON.parse(order.items_json);
    const itemLines = items.map((i) => `• ${i.name} (${i.size}) x${i.quantity}`).join("\n");
    const total = rupees(order.amount_paise);
    const shippingLine = order.shipping_paise ? `\nShipping: ${rupees(order.shipping_paise)}` : "";
    return {
      customer_whatsapp: {
        ready: Boolean(twilioClient && t.whatsappFrom),
        params: () => ({ from: t.whatsappFrom, to: `whatsapp:${order.phone}`, body: `Zohoo order confirmed 🎉\nOrder: ${order.id}\nItems:\n${itemLines}${shippingLine}\nTotal paid: ${total}\nShip to: ${order.customer_name}, ${order.address}\nThank you for shopping with Zohoo!` })
      },
      customer_sms: {
        ready: Boolean(twilioClient && t.smsFrom),
        params: () => ({ from: t.smsFrom, to: order.phone, body: `Zohoo: payment received for order ${order.id}. Total ${total}. Confirmation sent on WhatsApp.` })
      },
      owner_whatsapp: {
        ready: Boolean(twilioClient && t.whatsappFrom && t.ownerWhatsapp),
        params: () => ({ from: t.whatsappFrom, to: t.ownerWhatsapp, body: `🛍️ NEW ZOHOO ORDER\nOrder: ${order.id}\nCustomer: ${order.customer_name}\nPhone: ${order.phone}\nItems:\n${itemLines}${shippingLine}\nPaid: ${total}\nAddress: ${order.address}` })
      }
    };
  }

  async function notifyPaidOrder(orderId) {
    const order = getOrder(orderId);
    if (!order || order.payment_status !== "paid") return;
    // Atomic claim: only one caller (checkout callback or webhook) ever sends for an order.
    const claimed = db.prepare("UPDATE orders SET notification_status='processing' WHERE id=? AND notification_status='pending'").run(orderId);
    if (!claimed.changes) return;

    const plan = channelPlan(order);
    const results = await Promise.all(CHANNELS.map(async (ch) => {
      if (!plan[ch].ready) return "not_configured";
      try {
        await twilioClient.messages.create(plan[ch].params());
        return "sent";
      } catch (err) {
        // Log only the channel and Twilio error code: provider messages can echo phone numbers.
        log.error(`Notification failed: ${ch} (order ${orderId}, code ${err && err.code ? err.code : "unknown"})`);
        return "failed";
      }
    }));
    try {
      const set = CHANNELS.map((ch) => `notify_${ch}=?`).join(", ");
      db.prepare(`UPDATE orders SET ${set}, notification_status=? WHERE id=?`).run(...results, overallNotificationStatus(results), orderId);
    } catch (err) {
      log.error(`Could not record notification status for order ${orderId}: ${err.message}`);
    }
  }

  function queueNotification(orderId) {
    const p = notifyPaidOrder(orderId)
      .catch((err) => log.error(`Notification error (order ${orderId}): ${err.message}`))
      .finally(() => pendingNotifications.delete(p));
    pendingNotifications.add(p);
    return p;
  }
  app.locals.drainNotifications = () => Promise.allSettled([...pendingNotifications]);
  app.locals.db = db;
  app.locals.config = config;

  // Idempotent paid transition. Returns "paid_now", "already_paid_same", or "already_paid_other".
  function markPaid(order, paymentId) {
    const res = db.prepare(
      "UPDATE orders SET payment_status='paid', razorpay_payment_id=?, paid_at=? WHERE id=? AND payment_status != 'paid'"
    ).run(paymentId, new Date().toISOString(), order.id);
    if (res.changes) return "paid_now";
    const fresh = getOrder(order.id);
    return fresh.razorpay_payment_id === paymentId ? "already_paid_same" : "already_paid_other";
  }

  // Confirms a payment entity really is a captured payment for exactly this order.
  function paymentMatchesOrder(payment, order) {
    return Boolean(payment)
      && payment.id && payment.order_id === order.razorpay_order_id
      && payment.amount === order.amount_paise
      && payment.currency === order.currency;
  }

  // ---- CORS / origin policy ------------------------------------------------
  const allowedOrigins = new Set(config.frontendOrigins);
  if (config.baseUrl) { try { allowedOrigins.add(new URL(config.baseUrl).origin); } catch { /* ignore */ } }

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader("Vary", "Origin");
    const sameOrigin = (() => { try { return Boolean(origin) && new URL(origin).host === req.headers.host; } catch { return false; } })();
    const allowed = Boolean(origin) && (config.frontendOrigins.includes(origin) || sameOrigin || allowedOrigins.has(origin));
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return allowed ? res.sendStatus(204) : res.sendStatus(403);
    // Browsers always send Origin on cross-origin POSTs. Refuse state-changing calls from unknown sites.
    // (Server-to-server calls such as the Razorpay webhook send no Origin header.)
    if (origin && !allowed && req.method !== "GET" && req.method !== "HEAD") {
      return res.status(403).json({ error: "Origin not allowed." });
    }
    next();
  });

  // ---- Razorpay webhook (raw body required for signature check) -------------
  app.post("/api/razorpay-webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const secret = config.razorpay.webhookSecret;
    const signature = req.headers["x-razorpay-signature"];
    if (!secret) return res.status(503).json({ error: "Webhook is not configured." });
    if (!signature || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Missing signature or body." });
    if (!safeEqualHex(hmacHex(secret, req.body), String(signature))) return res.status(400).json({ error: "Invalid webhook signature." });

    let event;
    try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).json({ error: "Invalid JSON." }); }
    if (!event || typeof event !== "object" || typeof event.event !== "string") return res.status(400).json({ error: "Malformed event." });

    const eventId = String(req.headers["x-razorpay-event-id"] || "") || `sha256:${crypto.createHash("sha256").update(req.body).digest("hex")}`;
    try {
      if (db.prepare("SELECT 1 FROM webhook_events WHERE event_id=?").get(eventId)) return res.json({ received: true, duplicate: true });

      if (event.event !== "payment.captured" && event.event !== "order.paid") {
        return res.json({ received: true, ignored: true }); // unsupported events are acknowledged, never acted on
      }
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      const rzOrder = event.payload && event.payload.order && event.payload.order.entity;
      if (!payment || !RZP_PAYMENT_ID.test(String(payment.id || "")) || !RZP_ORDER_ID.test(String(payment.order_id || ""))) {
        return res.status(400).json({ error: "Malformed payment payload." });
      }
      const order = db.prepare("SELECT * FROM orders WHERE razorpay_order_id=?").get(payment.order_id);
      if (!order) {
        log.warn(`Webhook for unknown Razorpay order ${payment.order_id} ignored`);
        return res.json({ received: true, matched: false });
      }
      const orderPaid = event.event === "order.paid" ? (!rzOrder || rzOrder.status === "paid") : true;
      if (payment.status !== "captured" || !orderPaid || !paymentMatchesOrder(payment, order)) {
        log.warn(`Webhook payment did not match order ${order.id}; not marked paid`);
        db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, event, received_at) VALUES (?,?,?)").run(eventId, event.event, new Date().toISOString());
        return res.json({ received: true, matched: false });
      }
      const outcome = markPaid(order, payment.id);
      if (outcome === "already_paid_other") log.warn(`Order ${order.id} already paid; extra payment ${payment.id} needs manual review/refund`);
      db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, event, received_at) VALUES (?,?,?)").run(eventId, event.event, new Date().toISOString());
      if (outcome !== "already_paid_other") queueNotification(order.id); // no-op if already claimed
      return res.json({ received: true });
    } catch (err) {
      log.error("Webhook processing error:", err.message);
      return res.status(500).json({ error: "Webhook processing failed." }); // non-2xx so Razorpay retries
    }
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  // ---- Public catalog / config ---------------------------------------------
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.get("/api/products", (req, res) => res.json(PRODUCTS));
  app.get("/api/config", (req, res) => res.json({
    razorpayKeyId: config.razorpay.keyId || null,
    currency: CURRENCY,
    shipping: { fee: config.shipping.feePaise / 100, freeAbove: config.shipping.freeAbovePaise / 100 }
  }));

  // ---- Create order --------------------------------------------------------
  app.post("/api/create-order", async (req, res) => {
    let internalId = null;
    try {
      if (!razorpay) return res.status(503).json({ error: "Online payment is not configured yet. The store owner needs to add real Razorpay keys to the server settings." });
      const { customer, items } = req.body || {};
      if (!customer || typeof customer !== "object" || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: "Customer and cart items are required." });
      }
      const name = typeof customer.name === "string" ? customer.name.trim() : "";
      const phone = typeof customer.phone === "string" ? customer.phone.trim() : "";
      const email = typeof customer.email === "string" ? customer.email.trim() : "";
      const address = typeof customer.address === "string" ? customer.address.trim() : "";
      if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Enter your full name." });
      if (!validPhone(phone)) return res.status(400).json({ error: "Enter phone in international format, e.g. +919876543210." });
      if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
      if (address.length < 8 || address.length > 500) return res.status(400).json({ error: "Enter your complete delivery address." });

      if (items.length > MAX_LINES * 5) return res.status(400).json({ error: "Too many cart items." });
      const lines = new Map(); // merge repeated product+size entries before enforcing limits
      for (const item of items) {
        const product = item && typeof item.productId === "string" ? PRODUCT_BY_ID.get(item.productId) : null;
        const size = item && typeof item.size === "string" ? item.size : "";
        const quantity = item ? item.quantity : undefined;
        if (!product || !product.sizes.includes(size) || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) {
          return res.status(400).json({ error: "One or more cart items are invalid. Refresh the page and try again." });
        }
        const key = `${product.id}|${size}`;
        const line = lines.get(key) || { productId: product.id, name: product.name, price: product.price, size, quantity: 0 };
        line.quantity += quantity;
        lines.set(key, line);
      }
      const normalized = [...lines.values()];
      if (normalized.length > MAX_LINES || normalized.some((l) => l.quantity > MAX_QTY_PER_LINE)) {
        return res.status(400).json({ error: `Maximum ${MAX_QTY_PER_LINE} of each item and ${MAX_LINES} different items per order.` });
      }
      const subtotalPaise = normalized.reduce((sum, l) => sum + Math.round(l.price * 100) * l.quantity, 0);
      if (subtotalPaise < MIN_ORDER_PAISE || subtotalPaise > MAX_ORDER_PAISE) return res.status(400).json({ error: "Order total is outside the supported range." });
      // Shipping is decided only here, from server rules; nothing the browser sends can change it.
      const shippingPaise = subtotalPaise >= config.shipping.freeAbovePaise ? 0 : config.shipping.feePaise;
      const amountPaise = subtotalPaise + shippingPaise;

      // Persist first, so a payment can never exist at Razorpay without a matching local order.
      internalId = `ZH${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      db.prepare(`INSERT INTO orders (id, created_at, customer_name, phone, email, address, items_json, amount_paise, shipping_paise, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(internalId, new Date().toISOString(), name, phone, email, address, JSON.stringify(normalized), amountPaise, shippingPaise, CURRENCY);

      let rpOrder;
      try {
        rpOrder = await razorpay.orders.create({ amount: amountPaise, currency: CURRENCY, receipt: internalId, notes: { zohoo_order_id: internalId } });
      } catch (err) {
        db.prepare("DELETE FROM orders WHERE id=? AND payment_status='created' AND razorpay_order_id IS NULL").run(internalId);
        throw err;
      }
      db.prepare("UPDATE orders SET razorpay_order_id=? WHERE id=?").run(rpOrder.id, internalId);
      res.json({ orderId: internalId, razorpayOrderId: rpOrder.id, subtotal: subtotalPaise, shipping: shippingPaise, amount: amountPaise, currency: CURRENCY, keyId: config.razorpay.keyId, customer: { name, email, phone } });
    } catch (err) {
      const rzDescription = err && err.error && err.error.description ? err.error.description : null;
      const authFailed = Boolean(err && err.statusCode === 401);
      log.error(`Create order error${internalId ? ` (order ${internalId})` : ""}: ${rzDescription || (err && err.message) || "unknown"}${authFailed ? " -> Razorpay rejected RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. Use a matching key pair from the Razorpay dashboard (same Test or Live mode)." : ""}`);
      const hint = !config.isProduction && authFailed ? " (Razorpay rejected the API keys in .env: check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.)" : "";
      res.status(500).json({ error: `Could not create payment order. Please try again.${hint}` });
    }
  });

  // ---- Verify payment (checkout callback) ----------------------------------
  app.post("/api/verify-payment", async (req, res) => {
    try {
      if (!razorpay) return res.status(503).json({ error: "Online payment is not configured." });
      const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (![orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature].every((v) => typeof v === "string" && v.length > 0 && v.length < 100)
        || !INTERNAL_ORDER_ID.test(orderId) || !RZP_ORDER_ID.test(razorpay_order_id) || !RZP_PAYMENT_ID.test(razorpay_payment_id)) {
        return res.status(400).json({ error: "Incomplete or invalid payment details." });
      }
      const order = getOrder(orderId);
      if (!order || !order.razorpay_order_id || order.razorpay_order_id !== razorpay_order_id) return res.status(400).json({ error: "Order not found." });

      const expected = hmacHex(config.razorpay.keySecret, `${razorpay_order_id}|${razorpay_payment_id}`);
      if (!safeEqualHex(expected, razorpay_signature)) return res.status(400).json({ error: "Payment signature verification failed." });

      // Already settled (earlier callback, retry, or webhook): confirm without touching anything.
      if (order.payment_status === "paid") {
        if (order.razorpay_payment_id === razorpay_payment_id) {
          queueNotification(order.id); // no-op unless a previous attempt never started
          return res.json({ ok: true, orderId: order.id, status: "paid", alreadyPaid: true });
        }
        log.warn(`Order ${order.id} already paid; extra payment ${razorpay_payment_id} needs manual review/refund`);
        return res.status(409).json({ error: "This order has already been paid. Contact the store with your order ID if you were charged twice." });
      }

      // The signature proves the checkout result; confirm amount/currency/status with Razorpay itself.
      let payment;
      try { payment = await razorpay.payments.fetch(razorpay_payment_id); }
      catch (err) {
        log.error(`Could not fetch payment for order ${order.id}: ${err && err.statusCode ? err.statusCode : "error"}`);
        return res.status(502).json({ error: "Could not confirm the payment with Razorpay yet. Please retry in a moment. Keep your order ID: " + order.id });
      }
      if (!paymentMatchesOrder(payment, order)) return res.status(400).json({ error: "Payment details do not match this order." });
      if (payment.status === "authorized") {
        return res.status(202).json({ ok: false, orderId: order.id, status: "pending", error: "Payment authorised but not yet captured. We will confirm your order once it completes. Keep your order ID: " + order.id });
      }
      if (payment.status !== "captured") return res.status(402).json({ error: "Payment was not completed." });

      const outcome = markPaid(order, razorpay_payment_id);
      if (outcome === "already_paid_other") return res.status(409).json({ error: "This order has already been paid. Contact the store with your order ID if you were charged twice." });
      queueNotification(order.id);
      res.json({ ok: true, orderId: order.id, status: "paid", alreadyPaid: outcome !== "paid_now" });
    } catch (err) {
      log.error("Verify payment error:", err && err.message ? err.message : "unknown");
      res.status(500).json({ error: "Could not verify payment. If money was deducted, contact the store with your order ID." });
    }
  });

  // ---- Public order status (no personal data) -------------------------------
  app.get("/api/order/:id", (req, res) => {
    try {
      const id = String(req.params.id || "");
      const order = INTERNAL_ORDER_ID.test(id) ? getOrder(id) : null;
      if (!order) return res.status(404).json({ error: "Order not found." });
      const items = JSON.parse(order.items_json).map((i) => ({ name: i.name, size: i.size, quantity: i.quantity }));
      res.json({ orderId: order.id, status: order.payment_status, notificationStatus: order.notification_status, total: rupees(order.amount_paise), items });
    } catch (err) {
      log.error("Order status error:", err.message);
      res.status(500).json({ error: "Could not load order." });
    }
  });

  // ---- Fallbacks -------------------------------------------------------------
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
  app.get("*", (req, res) => {
    if (path.extname(req.path)) return res.status(404).send("Not found");
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
    log.error("Unhandled error:", err && err.message ? err.message : "unknown");
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function start() {
  const config = loadConfig();
  try {
    assertProductionConfig(config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  let app;
  try {
    app = createApp({ config });
  } catch (err) {
    console.error(`Startup failed (check DATA_DIR "${config.dataDir}" is writable): ${err.message}`);
    process.exit(1);
  }
  if (config.razorpay.placeholders.length) console.warn(`Ignoring placeholder values (still the example text) for: ${config.razorpay.placeholders.join(", ")}. Put your real Razorpay values in .env and restart.`);
  const missingRequired = missingRequiredConfig(config);
  if (missingRequired.length) console.warn(`Payments disabled until these are set: ${missingRequired.join(", ")}`);
  const missingOptional = missingOptionalConfig(config);
  if (missingOptional.length) console.warn(`WhatsApp/SMS notifications limited; missing: ${missingOptional.join(", ")}`);
  if (config.isProduction && !config.dataDirExplicit) console.warn("DATA_DIR is not set: orders are stored in the app folder and may be lost on redeploy.");
  if (config.isProduction && !config.frontendOrigins.length) console.warn("FRONTEND_URL is not set: a separately hosted frontend will be blocked by CORS.");
  return app.listen(config.port, () => console.log(`Zohoo is running at ${config.baseUrl} (port ${config.port})`));
}

if (require.main === module) start();

module.exports = { createApp, loadConfig, openDatabase, assertProductionConfig, missingRequiredConfig, missingOptionalConfig, overallNotificationStatus, PRODUCTS, CHANNELS };
