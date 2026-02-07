// WhatsApp Ordering System v3 — Cloudflare Worker (MPM Catalog)
// Handles: webhook verification, message processing, state machine, dashboard API
// Target: HKP Road businesses — exclusive delivery with 2 free chai on first order
// Uses Meta Commerce Catalog + Multi-Product Messages for native cart with quantity selector

// ── Product catalog mapping: retailer_id → Odoo product + price ──
const CATALOG_ID = '1639757440737691';

const PRODUCTS = {
  'NCH-IC':  { name: 'Irani Chai',            price: 15,  odooId: 1028 },
  'NCH-NSC': { name: 'Nawabi Special Coffee',  price: 30,  odooId: 1102 },
  'NCH-LT':  { name: 'Lemon Tea',             price: 20,  odooId: 1103 },
  'NCH-BM':  { name: 'Bun Maska',             price: 40,  odooId: 1029 },
  'NCH-OB3': { name: 'Osmania Biscuit x3',    price: 20,  odooId: 1033 },
  'NCH-CC':  { name: 'Chicken Cutlet',        price: 25,  odooId: 1031 },
  'NCH-PS':  { name: 'Pyaaz Samosa',          price: 15,  odooId: 1115 },
  'NCH-CB':  { name: 'Cheese Balls (2pcs)',   price: 50,  odooId: 1117 },
};

const NCH_LAT = 12.9868674;
const NCH_LNG = 77.6044311;
const MAX_DELIVERY_RADIUS_M = 600;
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const RUNNERS = ['FAROOQ', 'AMIN', 'NCH Runner 03', 'NCH Runner 04', 'NCH Runner 05'];

const BIZ_CATEGORIES = [
  { id: 'biz_shop', title: 'Shop / Retail' },
  { id: 'biz_restaurant', title: 'Restaurant / Café' },
  { id: 'biz_office', title: 'Office / Other' },
];

// Odoo POS Integration
const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB = 'main';
const ODOO_UID = 2;
const POS_CONFIG_ID = 29;
const PRICELIST_ID = 3;
const PAYMENT_METHOD_COD = 50;
const PAYMENT_METHOD_UPI = 51;

export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');

  if (action) {
    return handleDashboardAPI(context, action, url, corsHeaders);
  }

  if (context.request.method === 'GET') {
    return handleWebhookVerify(context, url);
  }

  if (context.request.method === 'POST') {
    try {
      const body = await context.request.json();
      await processWebhook(context, body);
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Webhook error:', error.message, error.stack);
      return new Response('OK', { status: 200 });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────
function handleWebhookVerify(context, url) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === context.env.WA_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ─── WEBHOOK MESSAGE PROCESSING ───────────────────────────────────
async function processWebhook(context, body) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  if (!value?.messages?.length) return;

  const message = value.messages[0];
  const waId = message.from;
  const phoneId = context.env.WA_PHONE_ID;
  const token = context.env.WA_ACCESS_TOKEN;
  const db = context.env.DB;

  // Mark message as read
  await sendWhatsApp(phoneId, token, { messaging_product: 'whatsapp', status: 'read', message_id: message.id });

  // Load or create session
  let session = await db.prepare('SELECT * FROM wa_sessions WHERE wa_id = ?').bind(waId).first();
  if (!session) {
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO wa_sessions (wa_id, state, cart, cart_total, updated_at) VALUES (?, ?, ?, ?, ?)').bind(waId, 'idle', '[]', 0, now).run();
    session = { wa_id: waId, state: 'idle', cart: '[]', cart_total: 0, updated_at: now };
  }

  // Check session expiry
  const lastUpdate = new Date(session.updated_at).getTime();
  if (Date.now() - lastUpdate > SESSION_TIMEOUT_MS && session.state !== 'idle') {
    session.state = 'idle';
    session.cart = '[]';
    session.cart_total = 0;
  }

  // Load or create user
  let user = await db.prepare('SELECT * FROM wa_users WHERE wa_id = ?').bind(waId).first();
  if (!user) {
    const now = new Date().toISOString();
    const name = value.contacts?.[0]?.profile?.name || '';
    const phone = waId;
    await db.prepare('INSERT INTO wa_users (wa_id, name, phone, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)').bind(waId, name, phone, now, now).run();
    user = { wa_id: waId, name, phone, first_order_redeemed: 0, total_orders: 0, last_order_id: null, location_lat: null, location_lng: null, business_type: null };
  } else {
    await db.prepare('UPDATE wa_users SET last_active_at = ? WHERE wa_id = ?').bind(new Date().toISOString(), waId).run();
  }

  const msgType = getMessageType(message);
  await routeState(context, session, user, message, msgType, waId, phoneId, token, db);
}

function getMessageType(message) {
  if (message.type === 'interactive') {
    const interactive = message.interactive;
    if (interactive.type === 'list_reply') return { type: 'list_reply', id: interactive.list_reply.id, title: interactive.list_reply.title };
    if (interactive.type === 'button_reply') return { type: 'button_reply', id: interactive.button_reply.id, title: interactive.button_reply.title };
  }
  if (message.type === 'location') {
    return { type: 'location', lat: message.location.latitude, lng: message.location.longitude, name: message.location.name || '', address: message.location.address || '' };
  }
  if (message.type === 'order') {
    // Native cart submission from MPM
    const order = message.order;
    const items = (order.product_items || []).map(item => ({
      retailer_id: item.product_retailer_id,
      qty: parseInt(item.quantity) || 1,
      price: parseFloat(item.item_price) || 0,
      currency: item.currency || 'INR',
    }));
    return { type: 'order', catalog_id: order.catalog_id, items, text: order.text || '' };
  }
  if (message.type === 'text') {
    return { type: 'text', body: message.text.body.trim(), bodyLower: message.text.body.trim().toLowerCase() };
  }
  return { type: message.type };
}

// ─── STATE MACHINE ROUTER ─────────────────────────────────────────
// States: idle → awaiting_biz_type → awaiting_name → awaiting_location → awaiting_menu → awaiting_payment → order_placed
async function routeState(context, session, user, message, msg, waId, phoneId, token, db) {
  const state = session.state;

  // Order message can come at any time from the MPM cart — handle it directly
  if (msg.type === 'order') {
    return handleOrderMessage(context, session, user, msg, waId, phoneId, token, db);
  }

  if (state === 'order_placed' || state === 'idle') {
    return handleIdle(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_biz_type') {
    return handleBizType(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_name') {
    return handleName(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_location') {
    return handleLocation(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_menu') {
    return handleMenuState(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_payment') {
    return handlePayment(context, session, user, msg, waId, phoneId, token, db);
  }

  return handleIdle(context, session, user, msg, waId, phoneId, token, db);
}

// ─── STATE: IDLE → Greeting / Reorder / Biz Verification ─────────
async function handleIdle(context, session, user, msg, waId, phoneId, token, db) {
  // ── RETURNING USER: show reorder prompt ──
  if (user.total_orders > 0 && user.last_order_id) {
    const lastOrder = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(user.last_order_id).first();
    if (lastOrder) {
      const items = JSON.parse(lastOrder.items);
      const itemSummary = items.map(i => `${i.qty}x ${i.name}`).join(', ');
      const body = `Welcome back${user.name ? ' ' + user.name.split(' ')[0] : ''}! *Nawabi Chai House* here.\n\nYour last order:\n${itemSummary} — *₹${lastOrder.total}*`;
      const buttons = [
        { type: 'reply', reply: { id: 'reorder', title: `Reorder ₹${lastOrder.total}` } },
        { type: 'reply', reply: { id: 'new_order', title: 'New Order' } }
      ];
      await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
      await updateSession(db, waId, 'awaiting_menu', session.cart, session.cart_total);
      return;
    }
  }

  // ── PREVIOUSLY VERIFIED USER (no orders yet): show MPM catalog ──
  if (user.business_type && user.name && user.location_lat) {
    const greeting = `Welcome back${user.name ? ' ' + user.name.split(' ')[0] : ''}!\n\n🎁 *Your first 2 Irani Chai are FREE!*\n\nBrowse our menu, add items to cart, and send your order 👇`;
    await sendWhatsApp(phoneId, token, buildMPM(waId, greeting));
    await updateSession(db, waId, 'awaiting_menu', '[]', 0);
    return;
  }

  // ── BRAND NEW USER: business verification flow ──
  const greeting = `*☕ Nawabi Chai House — HKP Road, Shivajinagar*\n\nFresh Irani Chai & snacks delivered to your doorstep in 5 minutes!\n\n🎁 *Exclusive for HKP Road businesses:*\nYour first *2 Irani Chai are FREE!*\n\nTo get started, what type of business are you with?`;
  const buttons = BIZ_CATEGORIES.map(c => ({ type: 'reply', reply: { id: c.id, title: c.title } }));
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, greeting, buttons));
  await updateSession(db, waId, 'awaiting_biz_type', '[]', 0);
}

// ─── STATE: AWAITING BIZ TYPE ─────────────────────────────────────
async function handleBizType(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type === 'button_reply' && msg.id.startsWith('biz_')) {
    const categoryTitle = BIZ_CATEGORIES.find(c => c.id === msg.id)?.title || msg.title;
    await db.prepare('UPDATE wa_users SET business_type = ? WHERE wa_id = ?').bind(categoryTitle, waId).run();
    user.business_type = categoryTitle;

    await sendWhatsApp(phoneId, token, buildText(waId, `Great! What's your name?`));
    await updateSession(db, waId, 'awaiting_name', '[]', 0);
    return;
  }

  const buttons = BIZ_CATEGORIES.map(c => ({ type: 'reply', reply: { id: c.id, title: c.title } }));
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, 'Please select your business type to continue:', buttons));
}

// ─── STATE: AWAITING NAME ─────────────────────────────────────────
async function handleName(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type === 'text' && msg.body.length > 0) {
    const name = msg.body.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ').slice(0, 50);
    await db.prepare('UPDATE wa_users SET name = ? WHERE wa_id = ?').bind(name, waId).run();
    user.name = name;

    // Check if user already has saved location within range
    if (user.location_lat && user.location_lng) {
      const dist = haversineDistance(user.location_lat, user.location_lng, NCH_LAT, NCH_LNG);
      if (dist <= MAX_DELIVERY_RADIUS_M) {
        const isNew = !user.first_order_redeemed && user.total_orders === 0;
        let menuIntro = `Thanks ${name.split(' ')[0]}! Browse our menu, pick what you like, and send your order 👇`;
        if (isNew) menuIntro = `Thanks ${name.split(' ')[0]}!\n\n🎁 *Your first 2 Irani Chai are FREE!*\n\nBrowse our menu 👇`;
        await sendWhatsApp(phoneId, token, buildMPM(waId, menuIntro));
        await updateSession(db, waId, 'awaiting_menu', '[]', 0);
        return;
      }
    }

    const body = `Welcome ${name.split(' ')[0]}! 📍 Please share your location so we can deliver to you.`;
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, body));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
    return;
  }

  await sendWhatsApp(phoneId, token, buildText(waId, 'Please type your name to continue.'));
}

// ─── STATE: AWAITING LOCATION ─────────────────────────────────────
async function handleLocation(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type !== 'location') {
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Please share your delivery location using the attach (📎) button → Location'));
    return;
  }

  const { lat, lng, name, address } = msg;
  const distance = haversineDistance(lat, lng, NCH_LAT, NCH_LNG);

  if (distance > MAX_DELIVERY_RADIUS_M) {
    const distStr = distance > 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)}m`;
    const body = `😔 Sorry, you're *${distStr}* away. We currently deliver only along *HKP Road, Shivajinagar*.\n\nVisit us at the shop — we'd love to see you! ☕`;
    await sendWhatsApp(phoneId, token, buildText(waId, body));
    await updateSession(db, waId, 'idle', '[]', 0);
    return;
  }

  const locationText = name || address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  await db.prepare('UPDATE wa_users SET location_lat = ?, location_lng = ?, location_address = ? WHERE wa_id = ?').bind(lat, lng, locationText, waId).run();
  user.location_lat = lat;
  user.location_lng = lng;
  user.location_address = locationText;
  user.delivery_distance_m = Math.round(distance);

  // Check if cart already has items (reorder flow needing location)
  const cart = JSON.parse(session.cart || '[]');
  if (cart.length > 0) {
    const body = `📍 Location saved! (${Math.round(distance)}m from NCH)\n\nHow would you like to pay?`;
    const buttons = [
      { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
    await updateSession(db, waId, 'awaiting_payment', session.cart, session.cart_total);
    return;
  }

  // Show MPM catalog
  const isNew = !user.first_order_redeemed && user.total_orders === 0;
  const firstName = user.name ? user.name.split(' ')[0] : '';
  let menuIntro = `📍 Saved! You're ${Math.round(distance)}m from NCH — we'll be there in minutes!\n\nBrowse our menu 👇`;
  if (isNew) {
    menuIntro = `📍 Saved! You're ${Math.round(distance)}m from NCH.\n\n🎁 *${firstName ? firstName + ', your' : 'Your'} first 2 Irani Chai are FREE!*\n\nBrowse our menu 👇`;
  }
  await sendWhatsApp(phoneId, token, buildMPM(waId, menuIntro));
  await updateSession(db, waId, 'awaiting_menu', '[]', 0);
}

// ─── STATE: AWAITING MENU → Waiting for cart or reorder ───────────
async function handleMenuState(context, session, user, msg, waId, phoneId, token, db) {
  // ── Reorder button ──
  if (msg.type === 'button_reply' && msg.id === 'reorder') {
    const lastOrder = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(user.last_order_id).first();
    if (lastOrder) {
      const items = JSON.parse(lastOrder.items);
      // Recalculate prices from current PRODUCTS
      const updatedItems = items.map(item => {
        const prod = Object.values(PRODUCTS).find(p => p.odooId === item.odooId);
        return prod ? { ...item, price: prod.price } : item;
      });
      const cartTotal = updatedItems.reduce((sum, i) => sum + (i.price * i.qty), 0);

      if (user.location_lat && user.location_lng) {
        await updateSession(db, waId, 'awaiting_payment', JSON.stringify(updatedItems), cartTotal);
        const body = `📍 Delivering to your saved location.\n\nHow would you like to pay?`;
        const buttons = [
          { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
          { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
        ];
        await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
        return;
      }

      await updateSession(db, waId, 'awaiting_location', JSON.stringify(updatedItems), cartTotal);
      await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location so we can get your order to you!'));
      return;
    }
  }

  // ── New Order button ──
  if (msg.type === 'button_reply' && msg.id === 'new_order') {
    await sendWhatsApp(phoneId, token, buildMPM(waId, 'Browse our menu, pick what you like, and send your order 👇'));
    await updateSession(db, waId, 'awaiting_menu', '[]', 0);
    return;
  }

  // ── Any text → resend catalog ──
  await sendWhatsApp(phoneId, token, buildMPM(waId, 'Browse our menu below, add items to cart, and tap Send to order! 👇'));
}

// ─── HANDLE ORDER MESSAGE (from MPM native cart) ──────────────────
async function handleOrderMessage(context, session, user, msg, waId, phoneId, token, db) {
  const orderItems = msg.items;
  if (!orderItems || orderItems.length === 0) {
    await sendWhatsApp(phoneId, token, buildText(waId, "We couldn't read your order. Please try again from the menu."));
    await sendWhatsApp(phoneId, token, buildMPM(waId, 'Browse our menu 👇'));
    return;
  }

  // Build cart from catalog order
  const cart = [];
  let cartTotal = 0;
  for (const item of orderItems) {
    const product = PRODUCTS[item.retailer_id];
    if (!product) continue;
    const qty = item.qty;
    const price = product.price; // Use our price, not the catalog price (in case of sync issues)
    cart.push({
      code: item.retailer_id,
      name: product.name,
      price,
      qty,
      odooId: product.odooId,
    });
    cartTotal += price * qty;
  }

  if (cart.length === 0) {
    await sendWhatsApp(phoneId, token, buildText(waId, "Sorry, we couldn't process those items. Please try again."));
    return;
  }

  // Save cart to session
  await updateSession(db, waId, 'awaiting_payment', JSON.stringify(cart), cartTotal);

  // Check if user has location
  if (!user.location_lat || !user.location_lng) {
    // Need location first
    await updateSession(db, waId, 'awaiting_location', JSON.stringify(cart), cartTotal);
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Great choices! Share your delivery location so we can get your order to you.'));
    return;
  }

  // Show order summary + payment buttons
  const cartSummary = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');

  // Preview discount for first-time users
  let discountPreview = '';
  if (!user.first_order_redeemed) {
    const chaiInCart = cart.filter(c => c.odooId === 1028).reduce((sum, c) => sum + c.qty, 0);
    if (chaiInCart > 0) {
      const freeCount = Math.min(chaiInCart, 2);
      const discountAmt = freeCount * 15;
      discountPreview = `\n🎁 ${freeCount}x FREE Irani Chai — -₹${discountAmt}`;
      cartTotal = Math.max(0, cartTotal - discountAmt);
    }
  }

  const body = `*Your order:*\n${cartSummary}${discountPreview}\n\n💰 *Total: ₹${cartTotal}*\n\nHow would you like to pay?`;
  const buttons = [
    { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
    { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
  ];
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
}

// ─── STATE: AWAITING PAYMENT → COD or UPI ─────────────────────────
async function handlePayment(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type !== 'button_reply' || !msg.id.startsWith('pay_')) {
    const buttons = [
      { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, 'Please select a payment method:', buttons));
    return;
  }

  const paymentMethod = msg.id === 'pay_cod' ? 'cod' : 'upi';
  const cart = JSON.parse(session.cart || '[]');
  const subtotal = cart.reduce((sum, c) => sum + (c.price * c.qty), 0);

  // Free first chai logic — 2 free Irani Chai at ₹15 each
  let discount = 0;
  let discountReason = null;
  if (!user.first_order_redeemed) {
    const chaiInCart = cart.filter(c => c.odooId === 1028).reduce((sum, c) => sum + c.qty, 0);
    if (chaiInCart > 0) {
      const freeChaiCount = Math.min(chaiInCart, 2);
      discount = freeChaiCount * 15;
      discountReason = 'first_order_2_free_chai';
    }
  }

  const total = Math.max(0, subtotal - discount);
  const now = new Date().toISOString();

  const countResult = await db.prepare("SELECT COUNT(*) as cnt FROM wa_orders WHERE created_at >= date('now', 'start of day')").first();
  const todayCount = (countResult?.cnt || 0) + 1;
  const orderCode = `WA-${String(todayCount).padStart(4, '0')}`;

  // Assign runner (round-robin)
  const runnerCounts = await db.prepare("SELECT runner_name, COUNT(*) as cnt FROM wa_orders WHERE created_at >= date('now', 'start of day') AND runner_name IS NOT NULL GROUP BY runner_name").all();
  const countMap = {};
  (runnerCounts.results || []).forEach(r => { countMap[r.runner_name] = r.cnt; });
  let assignedRunner = RUNNERS[0];
  let minOrders = Infinity;
  RUNNERS.forEach(name => {
    const cnt = countMap[name] || 0;
    if (cnt < minOrders) { minOrders = cnt; assignedRunner = name; }
  });

  const deliveryLat = user.location_lat;
  const deliveryLng = user.location_lng;
  const deliveryAddress = user.location_address || '';
  const deliveryDistance = user.delivery_distance_m || (deliveryLat ? Math.round(haversineDistance(deliveryLat, deliveryLng, NCH_LAT, NCH_LNG)) : null);

  const result = await db.prepare(`INSERT INTO wa_orders (order_code, wa_id, items, subtotal, discount, discount_reason, total, payment_method, delivery_lat, delivery_lng, delivery_address, delivery_distance_m, runner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(orderCode, waId, JSON.stringify(cart), subtotal, discount, discountReason, total, paymentMethod, deliveryLat, deliveryLng, deliveryAddress, deliveryDistance, assignedRunner, now, now).run();

  const orderId = result.meta?.last_row_id;

  await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?').bind(discount, orderId, total, waId).run();

  // Create order in Odoo POS
  const odooResult = await createOdooOrder(context, orderCode, cart, total, discount, paymentMethod, waId, user.name, user.phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, assignedRunner, user.business_type);

  const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
  let confirmMsg = `✅ *Order ${orderCode} confirmed!*\n\n${itemLines}`;
  if (discount > 0) {
    const freeCount = Math.round(discount / 15);
    confirmMsg += `\n🎁 ${freeCount}x FREE Irani Chai — -₹${discount}`;
  }
  confirmMsg += `\n\n💰 *Total: ₹${total}* (${paymentMethod === 'cod' ? 'Cash on Delivery' : 'UPI'})`;
  confirmMsg += `\n📍 ${deliveryAddress}`;
  confirmMsg += `\n🏃 Runner: ${assignedRunner}`;
  confirmMsg += `\n⏱️ *Arriving in ~5 minutes!*`;
  if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;

  await sendWhatsApp(phoneId, token, buildText(waId, confirmMsg));
  await updateSession(db, waId, 'order_placed', '[]', 0);
}

// ─── SESSION HELPER ───────────────────────────────────────────────
async function updateSession(db, waId, state, cart, cartTotal) {
  await db.prepare('UPDATE wa_sessions SET state = ?, cart = ?, cart_total = ?, updated_at = ? WHERE wa_id = ?')
    .bind(state, cart, cartTotal, new Date().toISOString(), waId).run();
}

// ─── WHATSAPP CLOUD API HELPERS ───────────────────────────────────
async function sendWhatsApp(phoneId, token, payload) {
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('WA API error:', response.status, err);
    }
    return response;
  } catch (e) {
    console.error('WA send error:', e.message);
  }
}

function buildText(to, body) {
  return { messaging_product: 'whatsapp', to, type: 'text', text: { body } };
}

function buildReplyButtons(to, body, buttons) {
  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: { type: 'button', body: { text: body }, action: { buttons } }
  };
}

// ── Multi-Product Message (MPM) — Native catalog with cart + qty selector ──
function buildMPM(to, bodyText) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: '☕ Nawabi Chai House' },
      body: { text: bodyText },
      footer: { text: 'HKP Road delivery • ~5 min' },
      action: {
        catalog_id: CATALOG_ID,
        sections: [
          {
            title: 'Chai & Beverages',
            product_items: [
              { product_retailer_id: 'NCH-IC' },
              { product_retailer_id: 'NCH-NSC' },
              { product_retailer_id: 'NCH-LT' },
            ]
          },
          {
            title: 'Snacks',
            product_items: [
              { product_retailer_id: 'NCH-BM' },
              { product_retailer_id: 'NCH-OB3' },
              { product_retailer_id: 'NCH-CC' },
              { product_retailer_id: 'NCH-PS' },
              { product_retailer_id: 'NCH-CB' },
            ]
          }
        ]
      }
    }
  };
}

function buildLocationRequest(to, body) {
  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: body },
      action: { name: 'send_location' }
    }
  };
}

// ─── HAVERSINE DISTANCE (meters) ──────────────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── ODOO POS ORDER CREATION ──────────────────────────────────────
async function createOdooOrder(context, orderCode, cart, total, discount, paymentMethod, waId, userName, phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, runnerName, businessType) {
  const apiKey = context.env.ODOO_API_KEY;
  if (!apiKey) { console.error('ODOO_API_KEY not set'); return null; }

  try {
    const sessionRes = await odooRPC(apiKey, 'pos.session', 'search_read',
      [[['config_id', '=', POS_CONFIG_ID], ['state', '=', 'opened']]],
      { fields: ['id', 'name'], limit: 1 });
    if (!sessionRes || sessionRes.length === 0) {
      console.error('No active session for NCH-Delivery POS');
      return null;
    }
    const sessionId = sessionRes[0].id;

    const lines = cart.map(item => [0, 0, {
      product_id: item.odooId,
      qty: item.qty,
      price_unit: item.price,
      price_subtotal: item.price * item.qty,
      price_subtotal_incl: item.price * item.qty,
      discount: 0,
      tax_ids: [[6, 0, []]],
      full_product_name: item.name,
    }]);

    const mapsLink = deliveryLat ? `https://maps.google.com/?q=${deliveryLat},${deliveryLng}` : '';
    const customerPhone = phone || waId;
    const formattedPhone = customerPhone.startsWith('91') ? '+' + customerPhone : customerPhone;
    const noteLines = [
      `📱 WHATSAPP ORDER: ${orderCode}`,
      `👤 ${userName || 'Customer'} — ${formattedPhone}`,
      businessType ? `🏢 ${businessType}` : '',
      `📍 ${deliveryAddress || 'Location shared'} (${deliveryDistance || '?'}m)`,
      mapsLink ? `🗺️ ${mapsLink}` : '',
      `🏃 Runner: ${runnerName}`,
      `💰 ${paymentMethod === 'cod' ? 'CASH ON DELIVERY' : 'UPI (Pre-paid)'}`,
      discount > 0 ? `🎁 FREE Irani Chai applied (-₹${discount})` : '',
    ].filter(Boolean).join('\n');

    const odooPaymentMethodId = paymentMethod === 'cod' ? PAYMENT_METHOD_COD : PAYMENT_METHOD_UPI;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const orderId = await odooRPC(apiKey, 'pos.order', 'create', [{
      session_id: sessionId,
      config_id: POS_CONFIG_ID,
      pricelist_id: PRICELIST_ID,
      amount_total: total,
      amount_paid: total,
      amount_tax: 0,
      amount_return: 0,
      date_order: now,
      lines: lines,
      internal_note: noteLines,
      state: 'draft',
    }]);

    if (!orderId) { console.error('Failed to create POS order'); return null; }

    await odooRPC(apiKey, 'pos.payment', 'create', [{
      pos_order_id: orderId,
      payment_method_id: odooPaymentMethodId,
      amount: total,
      payment_date: now,
      session_id: sessionId,
    }]);

    await odooRPC(apiKey, 'pos.order', 'action_pos_order_paid', [[orderId]]);

    const orderData = await odooRPC(apiKey, 'pos.order', 'search_read',
      [[['id', '=', orderId]]], { fields: ['name'] });
    const odooOrderName = orderData?.[0]?.name || `Order #${orderId}`;

    console.log(`Odoo POS order created: ${odooOrderName} (ID: ${orderId})`);
    return { id: orderId, name: odooOrderName };
  } catch (error) {
    console.error('Odoo order creation error:', error.message);
    return null;
  }
}

async function odooRPC(apiKey, model, method, args, kwargs) {
  const payload = {
    jsonrpc: '2.0', method: 'call', id: 1,
    params: { service: 'object', method: 'execute_kw',
      args: [ODOO_DB, ODOO_UID, apiKey, model, method, ...args, kwargs || {}] }
  };
  const res = await fetch(ODOO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.error) {
    console.error('Odoo RPC error:', JSON.stringify(data.error.data?.message || data.error.message));
    return null;
  }
  return data.result;
}

// ─── DASHBOARD API ────────────────────────────────────────────────
async function handleDashboardAPI(context, action, url, corsHeaders) {
  const db = context.env.DB;

  try {
    // Temporary: Odoo query for POS config extraction
    if (action === 'odoo-query') {
      const model = url.searchParams.get('model');
      const fields = url.searchParams.get('fields');
      const domain = url.searchParams.get('domain') || '[]';
      if (!model || !fields) return new Response(JSON.stringify({error:'need model and fields'}), {headers: corsHeaders});
      const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
      const payload = {jsonrpc:'2.0',method:'call',id:1,params:{service:'object',method:'execute_kw',args:['main',2,context.env.ODOO_API_KEY,model,'search_read',JSON.parse(domain),{fields:fields.split(',')}]}};
      const res = await fetch(ODOO_URL, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data = await res.json();
      return new Response(JSON.stringify(data?.result || data), {headers: corsHeaders});
    }

    if (action === 'orders') {
      const status = url.searchParams.get('status');
      let query = 'SELECT * FROM wa_orders';
      const params = [];

      if (status && status !== 'all') {
        query += ' WHERE status = ?';
        params.push(status);
      } else {
        query += " WHERE created_at >= date('now', 'start of day')";
      }
      query += ' ORDER BY created_at DESC LIMIT 100';

      const result = params.length > 0
        ? await db.prepare(query).bind(...params).all()
        : await db.prepare(query).all();

      return new Response(JSON.stringify({ success: true, orders: result.results || [] }), { headers: corsHeaders });
    }

    if (action === 'stats') {
      const today = await db.prepare("SELECT COUNT(*) as orders, COALESCE(SUM(total), 0) as revenue, COUNT(DISTINCT wa_id) as customers FROM wa_orders WHERE created_at >= date('now', 'start of day')").first();
      const newCustomers = await db.prepare("SELECT COUNT(*) as cnt FROM wa_users WHERE created_at >= date('now', 'start of day')").first();
      const delivered = await db.prepare("SELECT COUNT(*) as cnt, AVG(CAST((julianday(delivered_at) - julianday(created_at)) * 1440 AS INTEGER)) as avg_mins FROM wa_orders WHERE status = 'delivered' AND created_at >= date('now', 'start of day')").first();

      return new Response(JSON.stringify({
        success: true,
        stats: {
          totalOrders: today?.orders || 0,
          revenue: today?.revenue || 0,
          uniqueCustomers: today?.customers || 0,
          newCustomers: newCustomers?.cnt || 0,
          delivered: delivered?.cnt || 0,
          avgDeliveryMins: delivered?.avg_mins ? Math.round(delivered.avg_mins) : null
        }
      }), { headers: corsHeaders });
    }

    if (action === 'update-status' && context.request.method === 'POST') {
      const body = await context.request.json();
      const { orderId, status } = body;
      if (!orderId || !status) {
        return new Response(JSON.stringify({ success: false, error: 'Missing orderId or status' }), { status: 400, headers: corsHeaders });
      }

      const validStatuses = ['confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid status' }), { status: 400, headers: corsHeaders });
      }

      const now = new Date().toISOString();
      const deliveredAt = status === 'delivered' ? now : null;

      await db.prepare('UPDATE wa_orders SET status = ?, updated_at = ?, delivered_at = COALESCE(?, delivered_at) WHERE id = ?')
        .bind(status, now, deliveredAt, orderId).run();

      const order = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(orderId).first();
      if (order) {
        const phoneId = context.env.WA_PHONE_ID;
        const token = context.env.WA_ACCESS_TOKEN;

        let notifyMsg = null;
        if (status === 'preparing') notifyMsg = `🍵 Your order *${order.order_code}* is being prepared!`;
        if (status === 'out_for_delivery') notifyMsg = `🏃 *${order.order_code}* is out for delivery! ${order.runner_name} is on the way.`;
        if (status === 'delivered') notifyMsg = `✅ *${order.order_code}* delivered! Enjoy your chai! ☕\n\nOrder again anytime — just message us!`;
        if (status === 'cancelled') notifyMsg = `❌ Sorry, your order *${order.order_code}* has been cancelled. Please contact us if you have questions.`;

        if (notifyMsg) {
          await sendWhatsApp(phoneId, token, buildText(order.wa_id, notifyMsg));
        }
      }

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action' }), { status: 400, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}
