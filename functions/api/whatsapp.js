// WhatsApp Ordering System — Cloudflare Worker
// Handles: webhook verification, message processing, state machine, dashboard API

const MENU = {
  'NCH-IC':    { name: 'Irani Chai',           price: 20,  odooId: 1028, section: 'Chai' },
  'NCH-NSC':   { name: 'Nawabi Special Coffee', price: 30,  odooId: 1102, section: 'Chai' },
  'LT':        { name: 'Lemon Tea',             price: 20,  odooId: 1103, section: 'Chai' },
  'NCH-BM':    { name: 'Bun Maska',             price: 40,  odooId: 1029, section: 'Snacks' },
  'NCH-OB':    { name: 'Osmania Biscuit',       price: 8,   odooId: 1030, section: 'Snacks' },
  'NCH-OB3':   { name: 'Osmania Biscuit x3',    price: 20,  odooId: 1033, section: 'Snacks' },
  'NCH-CC':    { name: 'Chicken Cutlet',         price: 25,  odooId: 1031, section: 'Snacks' },
  'NCH-PS':    { name: 'Pyaaz Samosa',           price: 15,  odooId: 1115, section: 'Snacks' },
  'NCH-CB':    { name: 'Cheese Balls (2pcs)',    price: 50,  odooId: 1117, section: 'Snacks' },
  'NCH-OBBOX': { name: 'Niloufer Osmania 500g',  price: 250, odooId: 1111, section: 'Other' },
};

const NCH_LAT = 12.9780;
const NCH_LNG = 77.6010;
const MAX_DELIVERY_RADIUS_M = 500;
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const RUNNERS = ['FAROOQ', 'AMIN', 'NCH Runner 03', 'NCH Runner 04', 'NCH Runner 05'];

// Odoo POS Integration
const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB = 'main';
const ODOO_UID = 2;
const POS_CONFIG_ID = 29;         // NCH - Delivery
const PRICELIST_ID = 3;           // NCH Retail (INR)
const PAYMENT_METHOD_COD = 50;    // NCH WABA COD
const PAYMENT_METHOD_UPI = 51;    // NCH WABA UPI

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

  // Dashboard API routes
  if (action) {
    return handleDashboardAPI(context, action, url, corsHeaders);
  }

  // WhatsApp webhook verification (GET)
  if (context.request.method === 'GET') {
    return handleWebhookVerify(context, url);
  }

  // WhatsApp webhook messages (POST)
  if (context.request.method === 'POST') {
    try {
      const body = await context.request.json();
      await processWebhook(context, body);
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Webhook error:', error.message, error.stack);
      return new Response('OK', { status: 200 }); // Always 200 for Meta
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

  if (!value?.messages?.length) return; // Status update or no message

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
    user = { wa_id: waId, name, phone, first_order_redeemed: 0, total_orders: 0, last_order_id: null, location_lat: null, location_lng: null };
  } else {
    await db.prepare('UPDATE wa_users SET last_active_at = ? WHERE wa_id = ?').bind(new Date().toISOString(), waId).run();
  }

  // Route to state handler
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
  if (message.type === 'text') return { type: 'text', body: message.text.body.trim().toLowerCase() };
  return { type: message.type };
}

// ─── STATE MACHINE ROUTER ─────────────────────────────────────────
async function routeState(context, session, user, message, msg, waId, phoneId, token, db) {
  const state = session.state;

  // Any text message while in order_placed → treat as new conversation
  if (state === 'order_placed' || state === 'idle') {
    return handleIdle(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_selection') {
    return handleSelection(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_quantity') {
    return handleQuantity(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_more_or_checkout') {
    return handleMoreOrCheckout(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_location') {
    return handleLocation(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_payment') {
    return handlePayment(context, session, user, msg, waId, phoneId, token, db);
  }

  // Fallback — reset to idle
  return handleIdle(context, session, user, msg, waId, phoneId, token, db);
}

// ─── STATE: IDLE → Greeting + Menu or Reorder ─────────────────────
async function handleIdle(context, session, user, msg, waId, phoneId, token, db) {
  // Check if returning user with last order
  if (user.last_order_id && user.total_orders > 0) {
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
      await updateSession(db, waId, 'awaiting_selection', session.cart, session.cart_total, null);
      return;
    }
  }

  // New user greeting + menu
  const isNew = user.total_orders === 0 && !user.first_order_redeemed;
  let greeting = `*Nawabi Chai House* — Shivajinagar\nFresh Irani Chai & snacks delivered in 5 minutes!`;
  if (isNew) greeting += `\n\n🎉 *First order? Your Irani Chai is FREE!*`;
  greeting += `\n\nTap below to browse our menu 👇`;

  await sendWhatsApp(phoneId, token, buildMenuList(waId, greeting));
  await updateSession(db, waId, 'awaiting_selection', '[]', 0, null);
}

// ─── STATE: AWAITING SELECTION → Item picked from list ────────────
async function handleSelection(context, session, user, msg, waId, phoneId, token, db) {
  // Handle reorder button
  if (msg.type === 'button_reply' && msg.id === 'reorder') {
    const lastOrder = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(user.last_order_id).first();
    if (lastOrder) {
      const items = JSON.parse(lastOrder.items);
      const cartTotal = items.reduce((sum, i) => sum + (i.price * i.qty), 0);

      // If user has saved location, skip to payment
      if (user.location_lat && user.location_lng) {
        await updateSession(db, waId, 'awaiting_payment', JSON.stringify(items), cartTotal, null);
        const body = `📍 Delivering to your saved location.\n\nHow would you like to pay?`;
        const buttons = [
          { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
          { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
        ];
        await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
        return;
      }

      // Need location
      await updateSession(db, waId, 'awaiting_location', JSON.stringify(items), cartTotal, null);
      await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location so we can get your order to you!'));
      return;
    }
  }

  // Handle "New Order" button — show menu
  if (msg.type === 'button_reply' && msg.id === 'new_order') {
    await sendWhatsApp(phoneId, token, buildMenuList(waId, 'Pick from our menu 👇'));
    await updateSession(db, waId, 'awaiting_selection', '[]', 0, null);
    return;
  }

  // Handle list item selection
  if (msg.type === 'list_reply') {
    const itemCode = msg.id;
    const item = MENU[itemCode];
    if (!item) {
      await sendWhatsApp(phoneId, token, buildText(waId, "Sorry, that item isn't available. Please pick from the menu."));
      return;
    }

    const body = `*${item.name}* — ₹${item.price}\nHow many would you like?`;
    const buttons = [
      { type: 'reply', reply: { id: 'qty_1', title: '1' } },
      { type: 'reply', reply: { id: 'qty_2', title: '2' } },
      { type: 'reply', reply: { id: 'qty_3', title: '3' } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
    await updateSession(db, waId, 'awaiting_quantity', session.cart, session.cart_total, itemCode);
    return;
  }

  // Unrecognized input — show menu again
  await sendWhatsApp(phoneId, token, buildMenuList(waId, 'Please pick an item from our menu 👇'));
}

// ─── STATE: AWAITING QUANTITY → 1/2/3 picked ─────────────────────
async function handleQuantity(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type !== 'button_reply' || !msg.id.startsWith('qty_')) {
    const body = 'Please tap a quantity button: 1, 2, or 3';
    const buttons = [
      { type: 'reply', reply: { id: 'qty_1', title: '1' } },
      { type: 'reply', reply: { id: 'qty_2', title: '2' } },
      { type: 'reply', reply: { id: 'qty_3', title: '3' } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
    return;
  }

  const qty = parseInt(msg.id.replace('qty_', ''));
  const itemCode = session.pending_item_code;
  const item = MENU[itemCode];
  if (!item) {
    await sendWhatsApp(phoneId, token, buildMenuList(waId, 'Something went wrong. Please pick again 👇'));
    await updateSession(db, waId, 'awaiting_selection', session.cart, session.cart_total, null);
    return;
  }

  // Add to cart
  const cart = JSON.parse(session.cart || '[]');
  const existing = cart.find(c => c.code === itemCode);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({ code: itemCode, name: item.name, price: item.price, qty, odooId: item.odooId });
  }
  const cartTotal = cart.reduce((sum, c) => sum + (c.price * c.qty), 0);

  const cartSummary = cart.map(c => `${c.qty}x ${c.name}`).join('\n');
  const body = `✓ Added ${qty}x ${item.name}\n\n*Your cart:*\n${cartSummary}\n*Total: ₹${cartTotal}*`;
  const buttons = [
    { type: 'reply', reply: { id: 'add_more', title: 'Add More' } },
    { type: 'reply', reply: { id: 'checkout', title: `Checkout ₹${cartTotal}` } }
  ];
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
  await updateSession(db, waId, 'awaiting_more_or_checkout', JSON.stringify(cart), cartTotal, null);
}

// ─── STATE: ADD MORE / CHECKOUT ───────────────────────────────────
async function handleMoreOrCheckout(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type === 'button_reply' && msg.id === 'add_more') {
    await sendWhatsApp(phoneId, token, buildMenuList(waId, 'Pick another item 👇'));
    await updateSession(db, waId, 'awaiting_selection', session.cart, session.cart_total, null);
    return;
  }

  if (msg.type === 'button_reply' && msg.id === 'checkout') {
    // If user has saved location, skip location request
    if (user.location_lat && user.location_lng) {
      const dist = haversineDistance(user.location_lat, user.location_lng, NCH_LAT, NCH_LNG);
      if (dist <= MAX_DELIVERY_RADIUS_M) {
        await updateSession(db, waId, 'awaiting_payment', session.cart, session.cart_total, null);
        const body = `📍 Delivering to your saved location.\n\nHow would you like to pay?`;
        const buttons = [
          { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
          { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
        ];
        await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
        return;
      }
    }

    // Request location
    await updateSession(db, waId, 'awaiting_location', session.cart, session.cart_total, null);
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location so we can get your order to you!'));
    return;
  }

  // Unrecognized — repeat options
  const cartTotal = session.cart_total;
  const buttons = [
    { type: 'reply', reply: { id: 'add_more', title: 'Add More' } },
    { type: 'reply', reply: { id: 'checkout', title: `Checkout ₹${cartTotal}` } }
  ];
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, 'Would you like to add more or checkout?', buttons));
}

// ─── STATE: AWAITING LOCATION → Pin drop ──────────────────────────
async function handleLocation(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type !== 'location') {
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Please share your delivery location using the attach (📎) button → Location'));
    return;
  }

  const { lat, lng, name, address } = msg;
  const distance = haversineDistance(lat, lng, NCH_LAT, NCH_LNG);

  if (distance > MAX_DELIVERY_RADIUS_M) {
    const distStr = distance > 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)}m`;
    const body = `😔 Sorry, you're *${distStr}* away from us. We currently deliver within *500m* of Nawabi Chai House, Shivajinagar.\n\nVisit us at the shop or try a closer location!`;
    await sendWhatsApp(phoneId, token, buildText(waId, body));
    await updateSession(db, waId, 'idle', '[]', 0, null);
    return;
  }

  // Save location to user
  const locationText = name || address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  await db.prepare('UPDATE wa_users SET location_lat = ?, location_lng = ?, location_address = ? WHERE wa_id = ?').bind(lat, lng, locationText, waId).run();

  // Store location in session context (we'll need it at order creation)
  user.location_lat = lat;
  user.location_lng = lng;
  user.location_address = locationText;
  user.delivery_distance_m = Math.round(distance);

  const body = `📍 Location saved! (${Math.round(distance)}m from NCH)\n\nHow would you like to pay?`;
  const buttons = [
    { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
    { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
  ];
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
  await updateSession(db, waId, 'awaiting_payment', session.cart, session.cart_total, null);
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

  // Free first chai logic
  let discount = 0;
  let discountReason = null;
  if (!user.first_order_redeemed) {
    const chaiItem = cart.find(c => c.code === 'NCH-IC');
    if (chaiItem) {
      discount = 20; // One free Irani Chai
      discountReason = 'first_order_free_chai';
    }
  }

  const total = Math.max(0, subtotal - discount);
  const now = new Date().toISOString();

  // Generate order code
  const countResult = await db.prepare("SELECT COUNT(*) as cnt FROM wa_orders WHERE created_at >= date('now', 'start of day')").first();
  const todayCount = (countResult?.cnt || 0) + 1;
  const orderCode = `WA-${String(todayCount).padStart(4, '0')}`;

  // Assign runner (round-robin — fewest WA orders today)
  const runnerCounts = await db.prepare("SELECT runner_name, COUNT(*) as cnt FROM wa_orders WHERE created_at >= date('now', 'start of day') AND runner_name IS NOT NULL GROUP BY runner_name").all();
  const countMap = {};
  (runnerCounts.results || []).forEach(r => { countMap[r.runner_name] = r.cnt; });
  let assignedRunner = RUNNERS[0];
  let minOrders = Infinity;
  RUNNERS.forEach(name => {
    const cnt = countMap[name] || 0;
    if (cnt < minOrders) { minOrders = cnt; assignedRunner = name; }
  });

  // Get delivery location
  const deliveryLat = user.location_lat;
  const deliveryLng = user.location_lng;
  const deliveryAddress = user.location_address || '';
  const deliveryDistance = user.delivery_distance_m || (deliveryLat ? Math.round(haversineDistance(deliveryLat, deliveryLng, NCH_LAT, NCH_LNG)) : null);

  // Insert order
  const result = await db.prepare(`INSERT INTO wa_orders (order_code, wa_id, items, subtotal, discount, discount_reason, total, payment_method, delivery_lat, delivery_lng, delivery_address, delivery_distance_m, runner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(orderCode, waId, JSON.stringify(cart), subtotal, discount, discountReason, total, paymentMethod, deliveryLat, deliveryLng, deliveryAddress, deliveryDistance, assignedRunner, now, now).run();

  const orderId = result.meta?.last_row_id;

  // Update user
  await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?').bind(discount, orderId, total, waId).run();

  // Create order in Odoo POS (NCH - Delivery)
  const odooResult = await createOdooOrder(context, orderCode, cart, total, discount, paymentMethod, waId, user.name, user.phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, assignedRunner);

  // Build confirmation message
  const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
  let confirmMsg = `✅ *Order ${orderCode} confirmed!*\n\n${itemLines}`;
  if (discount > 0) confirmMsg += `\n🎉 1x FREE Irani Chai — -₹${discount}`;
  confirmMsg += `\n\n💰 *Total: ₹${total}* (${paymentMethod === 'cod' ? 'Cash on Delivery' : 'UPI'})`;
  confirmMsg += `\n📍 ${deliveryAddress}`;
  confirmMsg += `\n🏃 Runner: ${assignedRunner}`;
  confirmMsg += `\n⏱️ *Arriving in ~5 minutes!*`;
  if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;

  await sendWhatsApp(phoneId, token, buildText(waId, confirmMsg));
  await updateSession(db, waId, 'order_placed', '[]', 0, null);
}

// ─── SESSION HELPER ───────────────────────────────────────────────
async function updateSession(db, waId, state, cart, cartTotal, pendingItemCode) {
  await db.prepare('UPDATE wa_sessions SET state = ?, cart = ?, cart_total = ?, pending_item_code = ?, updated_at = ? WHERE wa_id = ?')
    .bind(state, cart, cartTotal, pendingItemCode, new Date().toISOString(), waId).run();
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

function buildMenuList(to, bodyText) {
  const sections = [
    {
      title: 'Chai & Beverages',
      rows: Object.entries(MENU).filter(([, v]) => v.section === 'Chai').map(([code, item]) => ({
        id: code, title: item.name, description: `₹${item.price}`
      }))
    },
    {
      title: 'Snacks',
      rows: Object.entries(MENU).filter(([, v]) => v.section === 'Snacks').map(([code, item]) => ({
        id: code, title: item.name, description: `₹${item.price}`
      }))
    },
    {
      title: 'Other',
      rows: Object.entries(MENU).filter(([, v]) => v.section === 'Other').map(([code, item]) => ({
        id: code, title: item.name, description: `₹${item.price}`
      }))
    }
  ];

  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '☕ Nawabi Chai House' },
      body: { text: bodyText },
      footer: { text: 'Delivery within 500m • ~5 min' },
      action: { button: 'View Menu', sections }
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
async function createOdooOrder(context, orderCode, cart, total, discount, paymentMethod, waId, userName, phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, runnerName) {
  const apiKey = context.env.ODOO_API_KEY;
  if (!apiKey) { console.error('ODOO_API_KEY not set'); return null; }

  try {
    // 1. Get active session for config 29
    const sessionRes = await odooRPC(apiKey, 'pos.session', 'search_read',
      [[['config_id', '=', POS_CONFIG_ID], ['state', '=', 'opened']]],
      { fields: ['id', 'name'], limit: 1 });
    if (!sessionRes || sessionRes.length === 0) {
      console.error('No active session for NCH-Delivery POS');
      return null;
    }
    const sessionId = sessionRes[0].id;

    // 2. Build order lines
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

    // 3. Build delivery note for staff — phone, maps link, runner
    const mapsLink = deliveryLat ? `https://maps.google.com/?q=${deliveryLat},${deliveryLng}` : '';
    const customerPhone = phone || waId;
    const formattedPhone = customerPhone.startsWith('91') ? '+' + customerPhone : customerPhone;
    const noteLines = [
      `📱 WHATSAPP ORDER: ${orderCode}`,
      `👤 ${userName || 'Customer'} — ${formattedPhone}`,
      `📍 ${deliveryAddress || 'Location shared'} (${deliveryDistance || '?'}m)`,
      mapsLink ? `🗺️ ${mapsLink}` : '',
      `🏃 Runner: ${runnerName}`,
      `💰 ${paymentMethod === 'cod' ? 'CASH ON DELIVERY' : 'UPI (Pre-paid)'}`,
      discount > 0 ? `🎉 FREE Irani Chai applied (-₹${discount})` : '',
    ].filter(Boolean).join('\n');

    // 4. Create the POS order
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

    // 5. Add payment
    await odooRPC(apiKey, 'pos.payment', 'create', [{
      pos_order_id: orderId,
      payment_method_id: odooPaymentMethodId,
      amount: total,
      payment_date: now,
      session_id: sessionId,
    }]);

    // 6. Mark order as paid
    await odooRPC(apiKey, 'pos.order', 'action_pos_order_paid', [[orderId]]);

    // 7. Get the order name for reference
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
    if (action === 'orders') {
      const status = url.searchParams.get('status');
      let query = 'SELECT * FROM wa_orders';
      const params = [];

      if (status && status !== 'all') {
        query += ' WHERE status = ?';
        params.push(status);
      } else {
        // Default: today's orders
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

      // Notify customer via WhatsApp
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
