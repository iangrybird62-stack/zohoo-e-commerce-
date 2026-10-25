// For Netlify + separate backend, set this to your backend URL after deployment.
const API_BASE = (window.ZOHOO_API_URL || "").replace(/\\/$/, "");
const apiUrl = (path) => `${API_BASE}${path}`;
const state = { products: [], cart: [], filter: "All", config: {} };
const $ = (selector) => document.querySelector(selector);
const money = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
let toastTimer;
function toast(message) { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),2800); }
async function init() {
  $("#year").textContent = new Date().getFullYear();
  try {
    const [p, c] = await Promise.all([fetch(apiUrl("/api/products")), fetch(apiUrl("/api/config"))]);
    if (!p.ok || !c.ok) throw new Error("Could not load store");
    state.products = await p.json(); state.config = await c.json();
    renderProducts(); renderCart();
  } catch (e) {
    $("#productGrid").innerHTML = '<div class="no-products">Could not load products. Please refresh the page.</div>';
  }
  $("#filters").addEventListener("click", e => {
    const btn=e.target.closest("[data-filter]"); if(!btn)return;
    state.filter=btn.dataset.filter;
    document.querySelectorAll(".filter").forEach(b=>b.classList.toggle("active",b===btn));
    renderProducts();
  });
  $("#productGrid").addEventListener("click", e => {
    const btn=e.target.closest("[data-add]"); if(!btn)return;
    const product=state.products.find(p=>p.id===btn.dataset.add);
    if(product) openSizePicker(product);
  });
  $("#cartOpen").addEventListener("click", openCart);
  $("#cartClose").addEventListener("click", closeCart);
  $("#overlay").addEventListener("click", closeCart);
  $("#cartItems").addEventListener("click", handleCartClick);
  $("#checkoutOpen").addEventListener("click", () => {
    if(!state.cart.length) return toast("Your bag is waiting for something lovely.");
    closeCart(); openCheckout();
  });
  $("#checkoutClose").addEventListener("click", closeCheckout);
  $("#checkoutModal").addEventListener("click", e=>{if(e.target===$("#checkoutModal"))closeCheckout();});
  $("#checkoutForm").addEventListener("submit", handleCheckout);
  $("#newsletterForm").addEventListener("submit", e=>{e.preventDefault();toast("Newsletter signup needs an email service connection.");});
}
function renderProducts() {
  const products=state.products.filter(p=>state.filter==="All"||p.category===state.filter);
  if(!products.length){$("#productGrid").innerHTML='<div class="no-products">More lovely pieces coming soon.</div>';return;}
  $("#productGrid").innerHTML=products.map(p=>`<article class="product-card">
    <div class="product-image"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" loading="lazy">${p.badge?`<span class="product-badge">${escapeHtml(p.badge)}</span>`:""}
    <button class="quick-add" data-add="${p.id}"><span>Choose a size</span><span>＋</span></button></div>
    <div class="product-info"><p class="product-category">${escapeHtml(p.category)} · ${escapeHtml(p.color)}</p><h3 class="product-name">${escapeHtml(p.name)}</h3><div class="product-price">${money(p.price)} <span class="old-price">${money(p.oldPrice)}</span></div>
    <button class="mobile-add" data-add="${p.id}"><span>Choose a size</span><span>＋</span></button></div></article>`).join("");
}
function openSizePicker(product) {
  const size=prompt(`${product.name}\nAvailable sizes: ${product.sizes.join(", ")}\n\nEnter your size:`);
  if(size===null)return;
  const normalized=size.trim().toUpperCase();
  if(!product.sizes.includes(normalized)){toast(`Please choose: ${product.sizes.join(", ")}`);return;}
  const found=state.cart.find(i=>i.productId===product.id&&i.size===normalized);
  if(found){if(found.quantity>=10)return toast("Maximum 10 of each size per order.");found.quantity++;}
  else state.cart.push({productId:product.id,size:normalized,quantity:1});
  renderCart();openCart();toast("Added to your bag.");
}
function renderCart() {
  const count=state.cart.reduce((s,i)=>s+i.quantity,0);
  const total=state.cart.reduce((s,i)=>{const p=state.products.find(p=>p.id===i.productId);return s+(p?p.price*i.quantity:0);},0);
  $("#cartCount").textContent=count;$("#drawerCount").textContent=`(${count})`;$("#subtotal").textContent=money(total);$("#checkoutTotal").textContent=money(total);
  if(!state.cart.length){$("#cartItems").innerHTML='<div class="empty-cart">Your bag is taking a little breather.<br>Find something you love and it will show up here.</div>';$("#checkoutOpen").disabled=true;return;}
  $("#checkoutOpen").disabled=false;
  $("#cartItems").innerHTML=state.cart.map((i,index)=>{const p=state.products.find(p=>p.id===i.productId);if(!p)return"";return `<div class="cart-item"><img src="${escapeHtml(p.image)}" alt=""><div><h3>${escapeHtml(p.name)}</h3><p>Size: ${escapeHtml(i.size)} · ${money(p.price)}</p><div class="quantity"><button data-action="minus" data-index="${index}" aria-label="Decrease quantity">−</button><span>${i.quantity}</span><button data-action="plus" data-index="${index}" aria-label="Increase quantity">+</button></div><button class="remove" data-action="remove" data-index="${index}">Remove</button></div><strong>${money(p.price*i.quantity)}</strong></div>`;}).join("");
}
function handleCartClick(e) {
  const btn=e.target.closest("[data-action]");if(!btn)return;
  const i=state.cart[Number(btn.dataset.index)];if(!i)return;
  if(btn.dataset.action==="minus")i.quantity--;
  if(btn.dataset.action==="plus"){if(i.quantity>=10)return toast("Maximum 10 of each size per order.");i.quantity++;}
  if(btn.dataset.action==="remove")i.quantity=0;
  state.cart=state.cart.filter(i=>i.quantity>0);renderCart();
}
function openCart(){$("#overlay").classList.add("show");$("#cartDrawer").classList.add("open");$("#cartDrawer").setAttribute("aria-hidden","false");document.body.style.overflow="hidden";}
function closeCart(){$("#overlay").classList.remove("show");$("#cartDrawer").classList.remove("open");$("#cartDrawer").setAttribute("aria-hidden","true");document.body.style.overflow="";}
function openCheckout(){if(!state.cart.length)return;$("#formMessage").textContent="";$("#checkoutModal").classList.add("show");$("#checkoutModal").setAttribute("aria-hidden","false");document.body.style.overflow="hidden";}
function closeCheckout(){$("#checkoutModal").classList.remove("show");$("#checkoutModal").setAttribute("aria-hidden","true");document.body.style.overflow="";}
async function handleCheckout(e) {
  e.preventDefault();
  if(!state.cart.length)return toast("Your bag is empty.");
  if(!state.config.razorpayKeyId){$("#formMessage").textContent="Online payment is not configured yet. The store owner must add Razorpay keys in the server .env file.";return;}
  if(typeof Razorpay==="undefined"){ $("#formMessage").textContent="Payment checkout could not load. Check your internet connection and try again.";return;}
  const form=new FormData(e.currentTarget);
  const customer={name:form.get("name").trim(),phone:form.get("phone").trim(),email:form.get("email").trim(),address:form.get("address").trim()};
  const button=$("#payButton");button.disabled=true;button.textContent="Preparing secure checkout…";$("#formMessage").textContent="";
  try {
    const response=await fetch(apiUrl("/api/create-order"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({customer,items:state.cart})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not start checkout.");
    const options={
      key:data.keyId,amount:data.amount,currency:data.currency,name:"Zohoo",description:"Fashion order",order_id:data.razorpayOrderId,
      prefill:{name:data.customer.name,email:data.customer.email,contact:data.customer.phone},
      notes:{zohoo_order_id:data.orderId},
      theme:{color:"#25241f"},
      handler:async function(payment){
        $("#formMessage").textContent="Verifying your payment securely…";
        try{
          const verify=await fetch(apiUrl("/api/verify-payment"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:data.orderId,...payment})});
          const result=await verify.json();if(!verify.ok)throw new Error(result.error||"Payment verification failed.");
          state.cart=[];renderCart();closeCheckout();toast(`Payment confirmed! Your order ID is ${result.orderId}`);
          alert(`Thank you for shopping at Zohoo!\n\nOrder ID: ${result.orderId}\nPayment verified successfully.\nWhatsApp/SMS updates will be sent if the store's notification service is configured.`);
        }catch(err){$("#formMessage").textContent=err.message+" Keep your order ID: "+data.orderId;}
      },
      modal:{ondismiss:function(){button.disabled=false;button.innerHTML='Pay securely <span>↗</span>';}}
    };
    const checkout=new Razorpay(options);
    checkout.on("payment.failed",function(r){$("#formMessage").textContent=r.error?.description||"Payment failed. Please try another method.";button.disabled=false;button.innerHTML='Pay securely <span>↗</span>';});
    checkout.open();
  } catch(err){$("#formMessage").textContent=err.message;button.disabled=false;button.innerHTML='Pay securely <span>↗</span>';}
  if(!button.disabled)button.innerHTML='Pay securely <span>↗</span>';
}
init();