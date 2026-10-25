# Zohoo — Fashion E-commerce

A responsive clothes/fashion storefront with a Node.js backend, SQLite order storage, Razorpay online payments, and Twilio WhatsApp + SMS notifications. For the requested Netlify setup, deploy `public/` to Netlify and deploy the Node backend separately to Render.

## Important: what is live vs what needs your accounts

- The storefront and cart work locally.
- Orders are stored in `data/zohoo.sqlite`.
- Online payments use Razorpay Checkout. **Use test keys first.**
- After a payment is verified, the backend attempts:
  1. WhatsApp confirmation to the customer
  2. SMS confirmation to the customer
  3. WhatsApp new-order notification to the owner
- Real payments/messages will not work until you configure your own Razorpay and Twilio credentials and complete any required account/sender approvals. Never put secrets in front-end files.

## Requirements

- Node.js 18 or newer
- A Razorpay account: https://razorpay.com/
- A Twilio account with SMS and WhatsApp enabled: https://www.twilio.com/

## Run locally

1. Extract the ZIP and open a terminal in the `zohoo-ecommerce` folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in credentials:

   ```bash
   cp .env.example .env
   ```

   On Windows, copy `.env.example` to `.env` using File Explorer or `copy .env.example .env`.

4. Start the server:

   ```bash
   npm start
   ```

5. Open http://localhost:3000

Do not deploy `.env`, share it, or commit it to Git.

## Razorpay setup

1. Create/sign in to your Razorpay account and open **Account & Settings → API Keys**.
2. Generate **Test Mode** keys and copy the Key ID and Key Secret into `.env`.
3. Restart the server. The site will show Razorpay Checkout when configured.
4. Complete a test payment using the test methods documented in your Razorpay dashboard. Do not use real customer cards while in test mode.
5. For production, activate your Razorpay account, complete KYC/website review as required, then generate Live Mode keys. Change `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to live keys only after testing.
6. Add a Razorpay webhook:
   - Webhook URL: `https://YOUR-DOMAIN.example/api/razorpay-webhook`
   - Events: `payment.captured` and `order.paid`
   - Set a webhook secret and copy it into `RAZORPAY_WEBHOOK_SECRET`.
   - Your deployed server must be publicly reachable over HTTPS.

The app verifies the checkout signature on the server. The webhook is an additional payment confirmation path and is signature-verified.

## Twilio WhatsApp + SMS setup

1. Create a Twilio account and find Account SID and Auth Token in the Twilio Console.
2. Add these to `.env`: `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
3. For initial testing, activate the Twilio WhatsApp Sandbox and follow its join instructions from your own WhatsApp. Set `TWILIO_WHATSAPP_FROM` to the exact sandbox sender shown in the console, usually `whatsapp:+14155238886`.
4. Set `OWNER_WHATSAPP=whatsapp:+91YOURNUMBER` (E.164 format).
5. Set `TWILIO_SMS_FROM` to your Twilio SMS-enabled number in E.164 format. Confirm your Twilio account/number can send SMS to the target country. India delivery, sender registration, and local compliance requirements may apply.
6. Sandbox WhatsApp can message only opted-in sandbox participants and is for testing. For a real store, set up an approved WhatsApp sender/business profile and use approved WhatsApp templates for business-initiated notifications where required. Customer opt-in is required. Follow Twilio/WhatsApp policy and applicable local laws.
7. Restart the server after changing `.env`.

The code sends free-form WhatsApp text messages. In production, business-initiated messages outside the allowed customer-service window may require approved message templates. Configure approved templates or adapt the integration before going live.

## Deploy

Use a Node.js host that supports a persistent disk/volume for SQLite, environment variables, and HTTPS (for example, a VPS or a suitable Node hosting service).

- Build/start command: `npm install` / `npm start`
- Set `BASE_URL` to your public HTTPS URL.
- Set all secrets in the host's environment-variable settings, not in source code.
- Ensure the `data/` directory is on persistent storage; otherwise orders may be lost on redeploy.
- Configure the Razorpay webhook to the public `/api/razorpay-webhook` URL.
- Add HTTPS, backups, logging, rate limiting, and monitoring before production.
- If your host has an ephemeral filesystem, replace SQLite with a managed database such as PostgreSQL before launch.

## Admin / orders

This starter saves orders in `data/zohoo.sqlite`. It intentionally does not expose a public order-admin page because customer phone/address details are private. To inspect orders, use a secure SQLite viewer on the server or add an authenticated admin dashboard. Do not expose the SQLite file publicly.

## Customizing products

Edit the `PRODUCTS` array near the top of `server.js`. Product prices are validated and calculated on the server; never trust prices sent by the browser. Replace the sample image URLs with images you own or are licensed to use.

## Before launch checklist

- [ ] Razorpay test checkout works
- [ ] Webhook signature verifies
- [ ] Customer WhatsApp opt-in and templates are approved as needed
- [ ] Customer SMS is delivered to the intended country
- [ ] Owner WhatsApp receives order messages
- [ ] Live payment keys are configured securely
- [ ] HTTPS and persistent database backups are set
- [ ] Privacy policy, terms, refund/return policy, shipping policy, and contact details are published
- [ ] Real products, accurate inventory, prices, and licensed images are added

## Troubleshooting

- **Online payment not configured**: add Razorpay keys to `.env`, then restart.
- **No WhatsApp/SMS**: check Twilio credentials, sender IDs, customer number in `+countrycode` format, opt-in/sandbox membership, Twilio message logs, and template requirements.
- **Orders are recorded but messages failed**: inspect server logs and Twilio logs. This starter records notification status; implement a secure retry/admin workflow before production.
- **Payment succeeds but page doesn't confirm**: check server logs and Razorpay dashboard/webhook. Keep the Zohoo order ID shown by the site for support.


## Netlify frontend + Render backend deployment

This ZIP includes `public/config.js` and CORS support for a split deployment.

1. Deploy the **whole repository** to Render as a Node.js Web Service (Build: `npm install`, Start: `npm start`) for the backend. The backend also serves the storefront, so you can test it directly on Render first.
2. In Render Environment, set all Razorpay/Twilio variables from `.env.example`. Set `FRONTEND_URL` to your exact Netlify site origin, e.g. `https://your-site-name.netlify.app` (no trailing slash). Set `DATA_DIR=/var/data`.
3. Add a persistent disk to the Render service with mount path `/var/data`. Persistent disks require a paid Render service; without one, SQLite order data can be lost when the service restarts or redeploys.
4. In `public/config.js`, set `window.ZOHOO_API_URL` to your Render URL, e.g. `https://zohoo-api.onrender.com` (no trailing slash).
5. Deploy the `public` folder as the Netlify site. On Android, easiest reliable workflow is to put the project in a GitHub repository and connect that repository to Netlify; configure the Netlify **Publish directory** as `public`. If the same repo is used for Render, set Netlify base directory to the repo root and publish directory to `public`.
6. After the Netlify URL is known, update Render's `FRONTEND_URL` to that exact origin and redeploy.
7. Set `BASE_URL` to the Render backend URL and configure Razorpay webhook at `https://YOUR-RENDER-URL/api/razorpay-webhook`.

Important: for a split frontend/backend deployment, only the public storefront files go to Netlify. Never upload `.env`, secrets, the SQLite database, or private customer data to Netlify.
