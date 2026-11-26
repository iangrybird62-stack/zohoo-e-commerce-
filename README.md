# Zohoo — Fashion E-commerce MVP

A small-store MVP: a static storefront (`public/`), a Node.js/Express backend, SQLite order storage, Razorpay Checkout with server-side payment verification, and optional Twilio WhatsApp + SMS notifications.

- **Frontend** → Netlify (publishes `public/`, configured in `netlify.toml`)
- **Backend** → Render Node.js Web Service (`npm install` / `npm start`)
- The backend can also serve the storefront itself, so you can test everything on Render before touching Netlify, or run it all locally.

## What must be configured before checkout can work

Nothing here is pre-filled. You need your own accounts:

| Variable | Required? | Purpose |
|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | **Yes** for checkout | Razorpay API keys. Start with `rzp_test_…` keys. |
| `RAZORPAY_WEBHOOK_SECRET` | **Yes** for production | Secret you choose when creating the Razorpay webhook. |
| `NODE_ENV=production` | Yes on Render | Makes startup fail loudly if the three Razorpay values are missing. |
| `FRONTEND_URL` | Yes if frontend is on Netlify | Exact Netlify origin, e.g. `https://your-site.netlify.app` (no path, no trailing slash). Comma-separate several origins (e.g. custom domain too). |
| `DATA_DIR` | Yes on Render | Folder for the SQLite file. Use your persistent disk mount, e.g. `/var/data`. |
| `BASE_URL` | Recommended | Public URL of the backend (used in startup logs). |
| `SHIPPING_FEE`, `FREE_SHIPPING_ABOVE` | Optional | Whole rupees. Orders below `FREE_SHIPPING_ABOVE` (default 1499) pay `SHIPPING_FEE` (default 99). `SHIPPING_FEE=0` makes shipping free. |
| `PORT` | No | Render sets it automatically. Defaults to 3000 locally. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Optional | Enable WhatsApp/SMS. |
| `TWILIO_WHATSAPP_FROM`, `OWNER_WHATSAPP` | Optional | WhatsApp sender (`whatsapp:+…`) and your own number for new-order alerts. |
| `TWILIO_SMS_FROM` | Optional | SMS-capable Twilio number (E.164). |

Plus one frontend value: `window.ZOHOO_API_URL` in `public/config.js` = your Render URL (no trailing slash). Leave it `""` only when the Node server also serves the page.

Without Razorpay keys the storefront still loads but checkout reports that payment is unavailable. Without Twilio values orders and payments work normally; each notification channel is recorded as `not_configured`. Secrets live only in environment variables, never in `public/`. Startup logs list missing variable **names**, never values.

## Run locally

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env  — then fill in test keys
npm start                 # http://localhost:3000
```

Leave `FRONTEND_URL` and `ZOHOO_API_URL` alone locally: the server serves the page and the browser calls the same origin. To try the split setup locally, serve `public/` from another port, set `ZOHOO_API_URL=http://localhost:3000` and `FRONTEND_URL=http://localhost:5000` (matching origin exactly).

## Deployment

Deploy the backend first (it has no dependency on Netlify), then the frontend, then close the loop with CORS.

### 1. Render (backend)

1. Push this project to GitHub (`.env` and `data/` are git-ignored).
2. Render → **New → Web Service** → select the repo. Runtime **Node**, root directory = repo root.
3. **Build command** `npm install` · **Start command** `npm start` · **Health check path** `/api/health`. Node 20 or newer is required (`engines` in `package.json`).
4. **Disk** (see persistence below): add a persistent disk, mount path `/var/data`.
5. **Environment**: `NODE_ENV=production`, `DATA_DIR=/var/data`, `BASE_URL=https://YOUR-SERVICE.onrender.com`, the three Razorpay variables, and any Twilio variables. Leave `FRONTEND_URL` empty for now (or set it if you already know the Netlify URL).
6. Deploy. Open `https://YOUR-SERVICE.onrender.com/api/health` → `{"ok":true}`. The storefront itself is also served at `/`.

### 2. Razorpay webhook

Razorpay Dashboard → Settings → Webhooks → Add:
- URL: `https://YOUR-SERVICE.onrender.com/api/razorpay-webhook`
- Active events: `payment.captured` and `order.paid`
- Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`

**Payment capture must be automatic** (Dashboard → Settings → Payment Capture → auto-capture). The server only treats a *captured* payment as paid; an *authorized-only* payment is reported to the shopper as "pending" and completes when the `payment.captured` webhook arrives after capture.

### 3. Netlify (frontend)

1. Edit `public/config.js`: `window.ZOHOO_API_URL = "https://YOUR-SERVICE.onrender.com";` and commit.
2. Netlify → **Add new site → Import from Git** → select the repo. **Publish directory** `public` (already set by `netlify.toml`), **build command** empty.
   Or without Git: drag-and-drop only the `public` folder in Netlify's *Deploys* page.
3. Note the site URL (e.g. `https://your-site.netlify.app`).

### 4. Close the loop

On Render set `FRONTEND_URL=https://your-site.netlify.app` (exact origin) and redeploy. Then test a payment with Razorpay test keys using the test cards/UPI IDs from Razorpay's docs. Only switch to `rzp_live_…` keys after test mode works end to end and your Razorpay account is activated.

### Persistence (important)

Orders are stored in SQLite at `$DATA_DIR/zohoo.sqlite`.
- Render's filesystem is **ephemeral** unless a persistent disk is attached. Persistent disks require a paid instance type. Without one, **orders are lost on every redeploy/restart**; use it for experiments only.
- A disk-backed service runs as a single instance, which is what SQLite needs; do not scale to multiple instances.
- Back the database up regularly (Render disk snapshots or your own export). Schema upgrades are additive and never delete existing orders.
- The database is never inside `public/`, so it cannot be served over HTTP.

## How payment and notification handling works

- `POST /api/create-order` validates customer details and every cart line (known product, valid size, integer quantity 1–10, max 20 lines) and computes the total **only from server-side prices in integer paise**. Browser-sent prices are ignored. The local order is saved first, then the Razorpay order is created and linked.
- **Shipping:** the server adds the flat fee when the product subtotal is below the free-shipping threshold (free at exactly the threshold or above). The charged amount is `subtotal + shipping`, stored with the order (`shipping_paise`) and sent to Razorpay; payments are verified against that full amount. The browser only displays the rules published at `/api/config` and cannot change them.
- `POST /api/verify-payment` checks the Razorpay signature, confirms the internal and Razorpay order ids belong together, then fetches the payment from Razorpay and requires matching order, amount, currency and `captured` status before marking the order paid.
- `POST /api/razorpay-webhook` verifies the raw-body signature, accepts only `payment.captured` / `order.paid`, applies the same order/amount/currency/status checks, and records event ids so redeliveries are harmless.
- "Mark as paid" is one atomic database update, so the checkout callback, retries and webhooks can arrive in any order or at once: the order is paid once, never downgraded, and a second different payment cannot overwrite it (it is logged for manual refund review).
- Notifications start only after payment is established, are claimed atomically (sent once per order), and run after the HTTP response. Each of customer WhatsApp, customer SMS and owner WhatsApp is tracked separately as `sent`, `failed` or `not_configured`; overall status is `sent`, `partial`, `failed`, `not_configured` or `pending`. A failed message never reverses a payment. Failures are logged by channel and Twilio error code only, without phone numbers.
- `GET /api/order/:id` returns only status, total, item names/sizes/quantities and notification status. Names, phones, emails and addresses are never exposed publicly.

## Twilio notes

Add `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, a WhatsApp sender, an SMS number and `OWNER_WHATSAPP`. The WhatsApp sandbox only reaches numbers that have joined it; production WhatsApp needs an approved sender and, for business-initiated messages, approved templates (this MVP sends free-form text). Check SMS delivery rules and sender registration for India. Notifications are not retried automatically; check `notify_*` columns and Twilio logs for failures.

## Tests

```bash
npm test      # 55 automated tests, ~3 seconds
npm run check # syntax check of server and frontend scripts
```

Tests use Node's built-in runner, a temporary SQLite database per test group, and fake Razorpay/Twilio clients. They need no credentials, make no network calls and cannot charge money or send messages. They cover startup and syntax, validation and totals, signature/order/amount/currency checks, duplicate and concurrent verification, webhook signatures and duplicates, notification isolation, public-response privacy and CORS. **Not covered by automation:** real Razorpay Checkout, real webhook delivery from Razorpay, real Twilio delivery, and visual layout in real browsers — verify those manually in test mode.

## Inspecting orders

There is deliberately no admin page. Inspect `zohoo.sqlite` with a SQLite tool on the server (Render shell), or build an authenticated admin view later.

## Customizing products

Edit the `PRODUCTS` array near the top of `server.js` (prices in rupees; sizes per product). If you add a new `category`, add a matching filter button in `public/index.html`. Replace the sample Unsplash images with ones you are licensed to use.

## Troubleshooting

- **Page says the backend is not connected / products won't load** → `ZOHOO_API_URL` in `public/config.js` is empty or wrong. On free Render the first request after idle can take up to a minute; the page waits and offers *Try again*.
- **Checkout works on Render's URL but not on Netlify** → `FRONTEND_URL` must equal the Netlify origin exactly (scheme + host, no trailing path); redeploy after changing it.
- **"Online payment is not configured"** → Razorpay keys missing on the server.
- **Paid on Razorpay but order stays unpaid** → check Render logs, the webhook delivery log in Razorpay, and that auto-capture is on and the webhook secret matches.
- **Orders disappeared after redeploy** → no persistent disk or `DATA_DIR` not pointing at it.

## Before going live

- [ ] Test-mode payment, webhook delivery and (if used) WhatsApp/SMS verified end to end
- [ ] Persistent disk attached and backups arranged
- [ ] Live Razorpay keys and webhook configured; auto-capture on
- [ ] Privacy, terms, refund/shipping policies and contact details published
- [ ] Real products and licensed images added; rate limiting/monitoring considered (see limitations)
