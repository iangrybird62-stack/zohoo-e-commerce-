// Backend URL comes from config.js. Empty means "same origin" (the Node server also serves this page).
const RAW_API_URL = String(window.ZOHOO_API_URL || "").trim().replace(/\/+$/, "");
const API_BASE = /^https?:\/\//i.test(RAW_API_URL) ? RAW_API_URL : "";
const API_MISCONFIGURED = Boolean(RAW_API_URL) && !API_BASE;
// A static host with no backend URL would answer /api/* itself, so say so instead of failing mysteriously.
const API_MISSING = !API_BASE && /\.netlify\.app$/i.test(location.hostname);
const apiUrl = (path) => `${API_BASE}${path}`;

const MAX_QTY = 10;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const PAY_LABEL = 'Pay securely <span>↗</span>';
// Display-only defaults; the server recomputes shipping and sends the real rules via /api/config.
const state = { products: [], cart: [], filter: "All", busy: false, shipping: { fee: 99, freeAbove: 1499 } };
const $ = (selector) => document.querySelector(selector);
const money = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const findProduct = (id) => state.products.find((p) => p.id === id);

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ---------------------------------------------------------------------------
// API client: timeouts, non-JSON responses and network failures become readable errors
// ---------------------------------------------------------------------------
async function api(path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  if (API_MISCONFIGURED) throw new Error("The store is misconfigured: ZOHOO_API_URL in config.js must start with https://.");
  if (API_MISSING) throw new Error("The store backend is not connected yet. Set ZOHOO_API_URL in config.js to your backend URL.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch {
    throw new Error("Could not reach the store server. Check your connection and try again; the server may be waking up.");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    throw new Error((data && data.error) || (response.status >= 500 ? "The store server had a problem. Please try again shortly." : "The request could not be completed."));
  }
  if (data === null) throw new Error("The store server sent an unexpected response.");
  return data;
}

// ---------------------------------------------------------------------------
// Dialog helpers: focus management, Escape to close, focus trap
// ---------------------------------------------------------------------------
let lastFocus = null;
function focusables(container) {
  return [...container.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
}
function topDialog() {
  if ($("#sizeModal").classList.contains("show")) return { el: $("#sizeModal"), close: closeSizePicker };
  if ($("#checkoutModal").classList.contains("show")) return { el: $("#checkoutModal"), close: closeCheckout };
  if ($("#cartDrawer").classList.contains("open")) return { el: $("#cartDrawer"), close: closeCart };
  return null;
}
document.addEventListener("keydown", (e) => {
  const dialog = topDialog();
  if (!dialog) return;
  if (e.key === "Escape") { e.preventDefault(); dialog.close(); return; }
  if (e.key !== "Tab") return;
  const items = focusables(dialog.el);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
function rememberFocus() { lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; }
function restoreFocus() { if (lastFocus && document.contains(lastFocus)) lastFocus.focus(); lastFocus = null; }

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
function shippingFor(subtotal) {
  if (subtotal <= 0) return 0;
  return subtotal >= state.shipping.freeAbove ? 0 : state.shipping.fee;
}
function applyShippingConfig(cfg) {
  const sh = cfg && cfg.shipping;
  if (!sh || !Number.isFinite(sh.fee) || !Number.isFinite(sh.freeAbove) || sh.fee < 0 || sh.freeAbove < 0) return;
  state.shipping = { fee: sh.fee, freeAbove: sh.freeAbove };
  const banner = $("#shippingBanner");
  if (banner) banner.textContent = (sh.fee === 0 || sh.freeAbove === 0) ? "Free shipping on all orders" : `Free shipping on orders of ${money(sh.freeAbove)} and above`;
}

async function loadProducts() {
  const grid = $("#productGrid");
  grid.innerHTML = '<div class="loading" id="loadingNote">Curating your collection…</div>';
  const slow = setTimeout(() => {
    const note = $("#loadingNote");
    if (note) note.textContent = "Waking up the store. This can take up to a minute the first time…";
  }, 5000);
  try {
    // Shipping rules are only for display, so a failure here must never block the storefront.
    api("/api/config").then(applyShippingConfig).then(renderCart).catch(() => {});
    const products = await api("/api/products", { timeoutMs: 70000 });
    if (!Array.isArray(products)) throw new Error("The store server sent an unexpected response.");
    state.products = products;
    state.cart = state.cart.filter((i) => findProduct(i.productId));
    renderProducts();
    renderCart();
  } catch (e) {
    grid.innerHTML = `<div class="no-products" role="alert">${escapeHtml(e.message || "Could not load products.")}<br><br><button class="button button-dark" type="button" data-retry>Try again <span>↻</span></button></div>`;
  } finally {
    clearTimeout(slow);
  }
}

function renderProducts() {
  const products = state.products.filter((p) => state.filter === "All" || p.category === state.filter);
  if (!products.length) { $("#productGrid").innerHTML = '<div class="no-products">More lovely pieces coming soon.</div>'; return; }
  $("#productGrid").innerHTML = products.map((p) => `<article class="product-card">
    <div class="product-image"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" loading="lazy">${p.badge ? `<span class="product-badge">${escapeHtml(p.badge)}</span>` : ""}
    <button class="quick-add" type="button" data-add="${escapeHtml(p.id)}" aria-label="Choose a size for ${escapeHtml(p.name)}"><span>Choose a size</span><span aria-hidden="true">＋</span></button></div>
    <div class="product-info"><p class="product-category">${escapeHtml(p.category)} · ${escapeHtml(p.color)}</p><h3 class="product-name">${escapeHtml(p.name)}</h3><div class="product-price">${money(p.price)} <span class="old-price">${money(p.oldPrice)}</span></div>
    <button class="mobile-add" type="button" data-add="${escapeHtml(p.id)}" aria-label="Choose a size for ${escapeHtml(p.name)}"><span>Choose a size</span><span aria-hidden="true">＋</span></button></div></article>`).join("");
}

// ---------------------------------------------------------------------------
// Size picker (replaces the old window.prompt)
// ---------------------------------------------------------------------------
function openSizePicker(product) {
  rememberFocus();
  $("#sizeProduct").textContent = `${product.name} · ${money(product.price)}`;
  $("#sizeOptions").innerHTML = product.sizes.map((s) => `<button type="button" class="size-option" data-size="${escapeHtml(s)}" data-product="${escapeHtml(product.id)}">${escapeHtml(s)}</button>`).join("");
  $("#sizeModal").classList.add("show");
  $("#sizeModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  const first = $("#sizeOptions button");
  if (first) first.focus();
}
function closeSizePicker() {
  $("#sizeModal").classList.remove("show");
  $("#sizeModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = ($("#cartDrawer").classList.contains("open") || $("#checkoutModal").classList.contains("show")) ? "hidden" : "";
  restoreFocus();
}
function addToCart(productId, size) {
  const product = findProduct(productId);
  if (!product || !product.sizes.includes(size)) return toast("That size is not available.");
  const found = state.cart.find((i) => i.productId === productId && i.size === size);
  if (found) {
    if (found.quantity >= MAX_QTY) return toast(`Maximum ${MAX_QTY} of each size per order.`);
    found.quantity += 1;
  } else {
    state.cart.push({ productId, size, quantity: 1 });
  }
  lastFocus = null; // the cart drawer takes focus next
  closeSizePicker();
  renderCart();
  openCart();
  toast("Added to your bag.");
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------
function cartTotal() {
  return state.cart.reduce((s, i) => { const p = findProduct(i.productId); return s + (p ? p.price * i.quantity : 0); }, 0);
}
function renderCart() {
  state.cart = state.cart.filter((i) => findProduct(i.productId) && Number.isInteger(i.quantity) && i.quantity > 0);
  const count = state.cart.reduce((s, i) => s + i.quantity, 0);
  const subtotal = cartTotal();
  const shipping = shippingFor(subtotal);
  const total = subtotal + shipping;
  const shippingLabel = subtotal <= 0 ? "—" : shipping === 0 ? "Free" : money(shipping);
  const allFree = state.shipping.fee === 0 || state.shipping.freeAbove === 0;
  const payNote = "Secure payment powered by Razorpay.";
  $("#shippingNote").textContent = allFree ? `Free shipping on all orders. ${payNote}`
    : subtotal <= 0 ? `Free shipping on orders of ${money(state.shipping.freeAbove)} and above. ${payNote}`
    : shipping === 0 ? `You've unlocked free shipping. ${payNote}`
    : `Add ${money(state.shipping.freeAbove - subtotal)} more for free shipping. ${payNote}`;
  $("#cartCount").textContent = count;
  $("#cartOpen").setAttribute("aria-label", `Open shopping bag, ${count} ${count === 1 ? "item" : "items"}`);
  $("#drawerCount").textContent = `(${count})`;
  $("#subtotal").textContent = money(subtotal);
  $("#shippingCost").textContent = shippingLabel;
  $("#cartTotal").textContent = money(total);
  $("#checkoutSubtotal").textContent = money(subtotal);
  $("#checkoutShipping").textContent = shippingLabel;
  $("#checkoutTotal").textContent = money(total);
  if (!state.cart.length) {
    $("#cartItems").innerHTML = '<div class="empty-cart">Your bag is taking a little breather.<br>Find something you love and it will show up here.</div>';
    $("#checkoutOpen").disabled = true;
    return;
  }
  $("#checkoutOpen").disabled = false;
  $("#cartItems").innerHTML = state.cart.map((i, index) => {
    const p = findProduct(i.productId);
    return `<div class="cart-item"><img src="${escapeHtml(p.image)}" alt=""><div><h3>${escapeHtml(p.name)}</h3><p>Size: ${escapeHtml(i.size)} · ${money(p.price)}</p><div class="quantity"><button type="button" data-action="minus" data-index="${index}" aria-label="Decrease quantity of ${escapeHtml(p.name)}">−</button><span aria-live="polite">${i.quantity}</span><button type="button" data-action="plus" data-index="${index}" aria-label="Increase quantity of ${escapeHtml(p.name)}">+</button></div><button type="button" class="remove" data-action="remove" data-index="${index}" aria-label="Remove ${escapeHtml(p.name)} size ${escapeHtml(i.size)}">Remove</button></div><strong>${money(p.price * i.quantity)}</strong></div>`;
  }).join("");
}
function handleCartClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const item = state.cart[Number(btn.dataset.index)];
  if (!item) return;
  if (btn.dataset.action === "minus") item.quantity -= 1;
  if (btn.dataset.action === "plus") {
    if (item.quantity >= MAX_QTY) return toast(`Maximum ${MAX_QTY} of each size per order.`);
    item.quantity += 1;
  }
  if (btn.dataset.action === "remove") item.quantity = 0;
  renderCart();
}
function openCart() {
  rememberFocus();
  $("#overlay").classList.add("show");
  const drawer = $("#cartDrawer");
  drawer.removeAttribute("inert");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  $("#cartClose").focus();
}
function closeCart() {
  $("#overlay").classList.remove("show");
  const drawer = $("#cartDrawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawer.setAttribute("inert", "");
  document.body.style.overflow = "";
  restoreFocus();
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
function setMessage(text, kind) {
  const el = $("#formMessage");
  el.textContent = text || "";
  el.classList.toggle("ok", kind === "ok");
  if (text && el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); // modal can be taller than the screen
}
function setPayBusy(busy, label) {
  state.busy = busy;
  const button = $("#payButton");
  button.disabled = busy;
  if (busy) button.textContent = label || "Preparing secure checkout…";
  else button.innerHTML = PAY_LABEL;
}
function showCheckoutForm() {
  $("#checkoutForm").hidden = false;
  $("#orderSuccess").hidden = true;
  $("#retryVerify").hidden = true;
}
function openCheckout() {
  if (!state.cart.length) return;
  rememberFocus();
  showCheckoutForm();
  setMessage("");
  if (pendingVerification) { // a payment went through but confirmation has not succeeded yet
    $("#checkoutForm").hidden = true;
    setMessage(`Your payment still needs to be confirmed. Keep your order ID: ${pendingVerification.orderId}.`);
    $("#retryVerify").hidden = false;
  }
  const modal = $("#checkoutModal");
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  const first = pendingVerification ? $("#retryVerify") : modal.querySelector("input");
  if (first) first.focus();
}
function closeCheckout() {
  $("#checkoutModal").classList.remove("show");
  $("#checkoutModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  restoreFocus();
}
function showOrderSuccess(orderId, pending) {
  state.cart = [];
  renderCart();
  setMessage("");
  $("#checkoutForm").hidden = true;
  $("#retryVerify").hidden = true;
  $("#successText").textContent = pending
    ? "Your payment was received and is awaiting final confirmation from the payment provider. We will confirm your order shortly. Please keep your order ID."
    : "Payment verified successfully. WhatsApp and SMS updates will follow if the store's notification service is set up.";
  $("#successOrderId").textContent = orderId;
  $("#orderSuccess").hidden = false;
  $("#successClose").focus();
  toast(pending ? "Payment received. Confirmation pending." : "Payment confirmed!");
}

let pendingVerification = null; // { orderId, payment } kept so a network failure can be retried safely
async function verifyPayment() {
  if (!pendingVerification) return;
  const { orderId, payment } = pendingVerification;
  $("#retryVerify").hidden = true;
  setMessage("Verifying your payment securely…", "ok");
  try {
    const result = await api("/api/verify-payment", { method: "POST", body: { orderId, ...payment }, timeoutMs: 45000 });
    pendingVerification = null;
    setPayBusy(false);
    showOrderSuccess(result.orderId || orderId, result.ok === false && result.status === "pending");
  } catch (err) {
    setMessage(`${err.message} Keep your order ID: ${orderId}.`);
    $("#retryVerify").hidden = false;
    $("#retryVerify").focus();
  }
}

async function handleCheckout(e) {
  e.preventDefault();
  if (state.busy) return;
  if (!state.cart.length) return toast("Your bag is empty.");
  const form = new FormData(e.currentTarget);
  const customer = {
    name: String(form.get("name") || "").trim(),
    phone: String(form.get("phone") || "").trim(),
    email: String(form.get("email") || "").trim(),
    address: String(form.get("address") || "").trim()
  };
  if (customer.name.length < 2) return setMessage("Please enter your full name.");
  if (!PHONE_RE.test(customer.phone)) return setMessage("Enter your phone with country code, e.g. +919876543210.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) return setMessage("Please enter a valid email address.");
  if (customer.address.length < 8) return setMessage("Please enter your complete delivery address.");
  if (typeof Razorpay === "undefined") return setMessage("Payment checkout could not load. Check your internet connection and refresh the page.");

  setMessage("");
  setPayBusy(true);
  let settled = false;
  try {
    const data = await api("/api/create-order", {
      method: "POST",
      body: { customer, items: state.cart.map(({ productId, size, quantity }) => ({ productId, size, quantity })) }
    });
    const checkout = new Razorpay({
      key: data.keyId, amount: data.amount, currency: data.currency, name: "Zohoo", description: "Fashion order", order_id: data.razorpayOrderId,
      prefill: { name: data.customer.name, email: data.customer.email, contact: data.customer.phone },
      notes: { zohoo_order_id: data.orderId },
      theme: { color: "#25241f" },
      handler: (payment) => {
        settled = true;
        setPayBusy(true, "Verifying payment…");
        pendingVerification = {
          orderId: data.orderId,
          payment: { razorpay_order_id: payment.razorpay_order_id, razorpay_payment_id: payment.razorpay_payment_id, razorpay_signature: payment.razorpay_signature }
        };
        verifyPayment();
      },
      modal: { ondismiss: () => { if (!settled) { setPayBusy(false); setMessage("Payment cancelled. Your bag is unchanged."); } } }
    });
    checkout.on("payment.failed", (r) => {
      setMessage((r && r.error && r.error.description) || "Payment failed. Please try another method.");
      setPayBusy(false);
    });
    checkout.open();
  } catch (err) {
    setMessage(err.message);
    setPayBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Init: listeners are attached first so the page stays usable while the API wakes up
// ---------------------------------------------------------------------------
function init() {
  $("#year").textContent = new Date().getFullYear();
  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    document.querySelectorAll(".filter").forEach((b) => { const on = b === btn; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    renderProducts();
  });
  $("#productGrid").addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return loadProducts();
    const btn = e.target.closest("[data-add]");
    if (!btn) return;
    const product = findProduct(btn.dataset.add);
    if (product) openSizePicker(product);
  });
  $("#sizeOptions").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-size]");
    if (btn) addToCart(btn.dataset.product, btn.dataset.size);
  });
  $("#sizeClose").addEventListener("click", closeSizePicker);
  $("#sizeModal").addEventListener("click", (e) => { if (e.target === $("#sizeModal")) closeSizePicker(); });
  $("#cartOpen").addEventListener("click", openCart);
  $("#cartClose").addEventListener("click", closeCart);
  $("#overlay").addEventListener("click", closeCart);
  $("#cartItems").addEventListener("click", handleCartClick);
  $("#checkoutOpen").addEventListener("click", () => {
    if (!state.cart.length) return toast("Your bag is waiting for something lovely.");
    closeCart();
    openCheckout();
  });
  $("#checkoutClose").addEventListener("click", closeCheckout);
  $("#successClose").addEventListener("click", closeCheckout);
  $("#retryVerify").addEventListener("click", verifyPayment);
  $("#checkoutModal").addEventListener("click", (e) => { if (e.target === $("#checkoutModal")) closeCheckout(); });
  $("#checkoutForm").addEventListener("submit", handleCheckout);
  $("#newsletterForm").addEventListener("submit", (e) => { e.preventDefault(); toast("Newsletter signup needs an email service connection."); });
  renderCart();
  loadProducts();
}
init();
