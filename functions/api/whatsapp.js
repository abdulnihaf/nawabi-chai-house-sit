// WhatsApp Ordering System v2 — Cloudflare Worker
// Handles: webhook verification, message processing, state machine, dashboard API
// Target: HKP Road businesses — exclusive delivery with 2 free chai on first order

const MENU = {
  'IC1':  { name: 'Irani Chai',            qty: 1, price: 15,  odooId: 1028, section: 'Chai' },
  'IC2':  { name: 'Irani Chai',            qty: 2, price: 15,  odooId: 1028, section: 'Chai' },
  'IC5':  { name: 'Irani Chai',            qty: 5, price: 15,  odooId: 1028, section: 'Chai' },
  'NSC1': { name: 'Nawabi Special Coffee',  qty: 1, price: 30,  odooId: 1102, section: 'Chai' },
  'LT1':  { name: 'Lemon Tea',             qty: 1, price: 20,  odooId: 1103, section: 'Chai' },
  'BM1':  { name: 'Bun Maska',             qty: 1, price: 40,  odooId: 1029, section: 'Snacks' },
  'OB3':  { name: 'Osmania Biscuit x3',    qty: 1, price: 20,  odooId: 1033, section: 'Snacks' },
  'CC1':  { name: 'Chicken Cutlet',        qty: 1, price: 25,  odooId: 1031, section: 'Snacks' },
  'PS1':  { name: 'Pyaaz Samosa',          qty: 1, price: 15,  odooId: 1115, section: 'Snacks' },
  'CB1':  { name: 'Cheese Balls (2pcs)',   qty: 1, price: 50,  odooId: 1117, section: 'Snacks' },
};

const NCH_LAT = 12.9868674;
const NCH_LNG = 77.6044311;
const MAX_DELIVERY_RADIUS_M = 600; // Covers entire HKP Road stretch
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
    user = { wa_id: waId, name, phone, first_order_redeemed: 0, total_orders: 0, last_order_id: null, location_lat: null, location_lng: null, business_type: null };
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
  if (message.type === 'text') {
    return { type: 'text', body: message.text.body.trim(), bodyLower: message.text.body.trim().toLowerCase() };
  }
  return { type: message.type };
}

// ─── STATE MACHINE ROUTER ─────────────────────────────────────────
async function routeState(context, session, user, message, msg, waId, phoneId, token, db) {
  const state = session.state;

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
  if (state === 'awaiting_selection') {
    return handleSelection(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_more_or_checkout') {
    return handleMoreOrCheckout(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_payment') {
    return handlePayment(context, session, user, msg, waId, phoneId, token, db);
  }

  // Fallback — reset to idle
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
      await updateSession(db, waId, 'awaiting_selection', session.cart, session.cart_total);
      return;
    }
  }

  // ── PREVIOUSLY VERIFIED USER (no orders yet): go straight to menu ──
  if (user.business_type && user.name && user.location_lat) {
    const greeting = `Welcome back${user.name ? ' ' + user.name.split(' ')[0] : ''}! Browse our menu 👇\n\n🎁 *Your first 2 Irani Chai are FREE!*`;
    await sendWhatsApp(phoneId, token, buildMenuList(waId, greeting));
    await updateSession(db, waId, 'awaiting_selection', '[]', 0);
    return;
  }

  // ── BRAND NEW USER: business verification flow ──
  const greeting = `*☕ Nawabi Chai House — HKP Road, Shivajinagar*\n\nFresh Irani Chai & snacks delivered to your doorstep in 5 minutes!\n\n🎁 *Exclusive for HKP Road businesses:*\nYour first *2 Irani Chai are FREE!*\n\nTo get started, what type of business are you with?`;
  const buttons = BIZ_CATEGORIES.map(c => ({ type: 'reply', reply: { id: c.id, title: c.title } }));
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, greeting, buttons));
  await updateSession(db, waId, 'awaiting_biz_type', '[]', 0);
}

// ─── STATE: AWAITING BIZ TYPE → Business category selected ───────
async function handleBizType(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type === 'button_reply' && msg.id.startsWith('biz_')) {
    const categoryTitle = BIZ_CATEGORIES.find(c => c.id === msg.id)?.title || msg.title;

    // Save business_type to wa_users
    await db.prepare('UPDATE wa_users SET business_type = ? WHERE wa_id = ?').bind(categoryTitle, waId).run();
    user.business_type = categoryTitle;

    // Ask for name
    await sendWhatsApp(phoneId, token, buildText(waId, `Great! What's your name?`));
    await updateSession(db, waId, 'awaiting_name', '[]', 0);
    return;
  }

  // Unrecognized — resend buttons
  const buttons = BIZ_CATEGORIES.map(c => ({ type: 'reply', reply: { id: c.id, title: c.title } }));
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, 'Please select your business type to continue:', buttons));
}

// ─── STATE: AWAITING NAME → Name typed ───────────────────────────
async function handleName(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type === 'text' && msg.body.length > 0) {
    // Capitalize first letter of each word
    const name = msg.body.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ').slice(0, 50);

    // Save to wa_users
    await db.prepare('UPDATE wa_users SET name = ? WHERE wa_id = ?').bind(name, waId).run();
    user.name = name;

    // Check if user already has saved location
    if (user.location_lat && user.location_lng) {
      const dist = haversineDistance(user.location_lat, user.location_lng, NCH_LAT, NCH_LNG);
      if (dist <= MAX_DELIVERY_RADIUS_M) {
        // Saved location is valid — skip to menu
        const isNew = !user.first_order_redeemed && user.total_orders === 0;
        let menuIntro = `Thanks ${name.split(' ')[0]}! Browse our menu 👇`;
        if (isNew) menuIntro = `Thanks ${name.split(' ')[0]}!\n\n🎁 *Remember: your first 2 Irani Chai are FREE!*\n\nBrowse our menu 👇`;
        await sendWhatsApp(phoneId, token, buildMenuList(waId, menuIntro));
        await updateSession(db, waId, 'awaiting_selection', '[]', 0);
        return;
      }
    }

    // Request location
    const body = `Welcome ${name.split(' ')[0]}! 📍 Please share your location so we can deliver to you.`;
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, body));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
    return;
  }

  // Non-text input
  await sendWhatsApp(phoneId, token, buildText(waId, 'Please type your name to continue.'));
}

// ─── STATE: AWAITING LOCATION → Pin drop ─────────────────────────
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

  // Save location to user
  const locationText = name || address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  await db.prepare('UPDATE wa_users SET location_lat = ?, location_lng = ?, location_address = ? WHERE wa_id = ?').bind(lat, lng, locationText, waId).run();
  user.location_lat = lat;
  user.location_lng = lng;
  user.location_address = locationText;
  user.delivery_distance_m = Math.round(distance);

  // Check if cart already has items (reorder flow where location was missing)
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

  // Normal new-user flow — show menu after location
  const isNew = !user.first_order_redeemed && user.total_orders === 0;
  const firstName = user.name ? user.name.split(' ')[0] : '';
  let menuIntro = `📍 Saved! You're ${Math.round(distance)}m from NCH — we'll be there in minutes!\n\nBrowse our menu 👇`;
  if (isNew) {
    menuIntro = `📍 Saved! You're ${Math.round(distance)}m from NCH.\n\n🎁 *${firstName ? firstName + ', your' : 'Your'} first 2 Irani Chai are FREE!*\n\nBrowse our menu 👇`;
  }
  await sendWhatsApp(phoneId, token, buildMenuList(waId, menuIntro));
  await updateSession(db, waId, 'awaiting_selection', '[]', 0);
}

// ─── STATE: AWAITING SELECTION → Item picked / Reorder ───────────
async function handleSelection(context, session, user, msg, waId, phoneId, token, db) {
  // ── Reorder button ──
  if (msg.type === 'button_reply' && msg.id === 'reorder') {
    const lastOrder = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(user.last_order_id).first();
    if (lastOrder) {
      const items = JSON.parse(lastOrder.items);
      // Recalculate prices from current menu
      const updatedItems = items.map(item => {
        const currentMenuItem = Object.values(MENU).find(m => m.odooId === item.odooId);
        return currentMenuItem ? { ...item, price: currentMenuItem.price } : item;
      });
      const cartTotal = updatedItems.reduce((sum, i) => sum + (i.price * i.qty), 0);

      if (user.location_lat && user.location_lng) {
        // Saved location — skip to payment
        await updateSession(db, waId, 'awaiting_payment', JSON.stringify(updatedItems), cartTotal);
        const body = `📍 Delivering to your saved location.\n\nHow would you like to pay?`;
        const buttons = [
          { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
          { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
        ];
        await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
        return;
      }

      // Need location
      await updateSession(db, waId, 'awaiting_location', JSON.stringify(updatedItems), cartTotal);
      await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location so we can get your order to you!'));
      return;
    }
  }

  // ── New Order button ──
  if (msg.type === 'button_reply' && msg.id === 'new_order') {
    await sendWhatsApp(phoneId, token, buildMenuList(waId, 'Pick from our menu 👇'));
    await updateSession(db, waId, 'awaiting_selection', '[]', 0);
    return;
  }

  // ── List item selection (quantity baked in) ──
  if (msg.type === 'list_reply') {
    const itemCode = msg.id;
    const menuItem = MENU[itemCode];
    if (!menuItem) {
      await sendWhatsApp(phoneId, token, buildText(waId, "Sorry, that item isn't available. Please pick from the menu."));
      return;
    }

    const cart = JSON.parse(session.cart || '[]');
    const qty = menuItem.qty;
    const itemName = menuItem.name;
    const itemPrice = menuItem.price;
    const lineTotal = itemPrice * qty;

    // Merge with existing cart entry for same product (by odooId)
    const existing = cart.find(c => c.odooId === menuItem.odooId);
    if (existing) {
      existing.qty += qty;
    } else {
      cart.push({ code: itemCode, name: itemName, price: itemPrice, qty, odooId: menuItem.odooId });
    }
    const cartTotal = cart.reduce((sum, c) => sum + (c.price * c.qty), 0);

    const cartSummary = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
    const body = `✅ Added ${qty}x ${itemName} — ₹${lineTotal}\n\n*Your cart:*\n${cartSummary}\n*Total: ₹${cartTotal}*`;
    const buttons = [
      { type: 'reply', reply: { id: 'add_more', title: 'Add More' } },
      { type: 'reply', reply: { id: 'checkout', title: `Checkout ₹${cartTotal}` } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
    await updateSession(db, waId, 'awaiting_more_or_checkout', JSON.stringify(cart), cartTotal);
    return;
  }

  // Unrecognized — show menu again
  await sendWhatsApp(phoneId, token, buildMenuList(waId, 'Please pick an item from our menu 👇'));
}

// ─── STATE: ADD MORE / CHECKOUT ───────────────────────────────────
async function handleMoreOrCheckout(context, session, user, msg, waId, phoneId, token, db) {
  if (msg.type === 'button_reply' && msg.id === 'add_more') {
    await sendWhatsApp(phoneId, token, buildMenuList(waId, 'Pick another item 👇'));
    await updateSession(db, waId, 'awaiting_selection', session.cart, session.cart_total);
    return;
  }

  if (msg.type === 'button_reply' && msg.id === 'checkout') {
    // Location should already be saved (collected before menu for new users)
    // Fallback: if somehow missing, request it
    if (!user.location_lat || !user.location_lng) {
      await updateSession(db, waId, 'awaiting_location', session.cart, session.cart_total);
      await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location so we can get your order to you!'));
      return;
    }

    await updateSession(db, waId, 'awaiting_payment', session.cart, session.cart_total);
    const body = `How would you like to pay?`;
    const buttons = [
      { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
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
      const freeChaiCount = Math.min(chaiInCart, 2); // Up to 2 free
      discount = freeChaiCount * 15;
      discountReason = 'first_order_2_free_chai';
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
  const odooResult = await createOdooOrder(context, orderCode, cart, total, discount, paymentMethod, waId, user.name, user.phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, assignedRunner, user.business_type);

  // Build confirmation message
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

function buildMenuList(to, bodyText) {
  const sections = [
    {
      title: 'Chai & Beverages',
      rows: [
        { id: 'IC1',  title: '1x Irani Chai',          description: '₹15' },
        { id: 'IC2',  title: '2x Irani Chai',          description: '₹30' },
        { id: 'IC5',  title: '5x Irani Chai',          description: '₹75' },
        { id: 'NSC1', title: 'Nawabi Special Coffee',   description: '₹30' },
        { id: 'LT1',  title: 'Lemon Tea',              description: '₹20' },
      ]
    },
    {
      title: 'Snacks',
      rows: [
        { id: 'BM1', title: 'Bun Maska',              description: '₹40' },
        { id: 'OB3', title: 'Osmania Biscuit x3',     description: '₹20' },
        { id: 'CC1', title: 'Chicken Cutlet',          description: '₹25' },
        { id: 'PS1', title: 'Pyaaz Samosa',            description: '₹15' },
        { id: 'CB1', title: 'Cheese Balls (2pcs)',     description: '₹50' },
      ]
    }
  ];

  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '☕ Nawabi Chai House' },
      body: { text: bodyText },
      footer: { text: 'HKP Road delivery • ~5 min' },
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
async function createOdooOrder(context, orderCode, cart, total, discount, paymentMethod, waId, userName, phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, runnerName, businessType) {
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

    // 3. Build delivery note for staff — phone, maps link, runner, business type
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
