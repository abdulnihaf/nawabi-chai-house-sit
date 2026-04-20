// NCH Token Settlement — Cloudflare Worker
// Weighs physical beverage tokens (poured into a tared cover/bag) against Odoo POS sales.
//
// Logic: ALL beverages sold at POS 27 (Cash Counter) only.
// Pink tokens (counted): Cash (37), UPI (38), Card (39) → dropped immediately.
//                         Token Issue (48) → runner delivers, customer drops later.
// NOT counted: Complimentary (49) → uses different colored token, excluded.
// Carry-forward: previous unsold tokens surface next period but aren't in Odoo for that period.
// Formula: expected = carry_forward + (odoo_beverages - comp_beverages) - current_unsold
//
// Weighing: staff tares scale with empty cover on it, pours tokens in, enters NET weight.
// No container tare constant — the scale's TARE button absorbs whatever cover is used.
// Optional manual_count override bypasses weight math (for wet/dirty tokens or scale issues).

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;

  const PINS = {
    // Runners — identified by code, consistent with v2
    '3678': 'R01', '4421': 'R02', '5503': 'R03', '6604': 'R04', '7705': 'R05',
    // Cashiers
    '7115': 'CASH001', '8241': 'CASH002', '2847': 'CASH003', '5190': 'CASH004',
    // Staff
    '8523': 'Basheer', '6890': 'Tanveer', '2026': 'Zoya',
    '3697': 'Yashwant', '3754': 'Naveen', '0305': 'Nihaf'
  };
  const ADMIN_USERS = ['Nihaf']; // Only these users can perform destructive actions (reset)

  const BOX_TARE_G = 0;       // weightless-cover flow: staff tares scale before pouring tokens
  const TOKEN_WEIGHT_G = 1.1; // ~1.1 gram per token (physical constant of pink token)
  const MIN_NET_WEIGHT_G = 0; // 0 allowed for zero-activity periods
  const BEVERAGE_IDS = [1028, 1102, 1103]; // Irani Chai, Coffee, Lemon Tea
  const BEVERAGE_NAMES = {1028: 'chai', 1102: 'coffee', 1103: 'lemon_tea'};
  const PM_TOKEN_ISSUE = 48;
  const PM_COMP = 49;
  const POS_CASH_COUNTER = 27;

  // ── Odoo JSON-RPC helper ──
  async function odooCall(model, method, domain, fields, kwargs) {
    const payload = {
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: {
        service: 'object', method: 'execute_kw',
        args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, model, method, [domain], kwargs || {fields, order: 'id asc'}]
      }
    };
    const res = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    const data = await res.json();
    if (data.error) throw new Error(`Odoo ${model}.${method}: ${JSON.stringify(data.error)}`);
    return data.result || [];
  }

  const RUNNER_IDS_FALLBACK = [64, 65, 66, 67, 68];
  const RUNNER_CODE_MAP = {64: 'R01', 65: 'R02', 66: 'R03', 67: 'R04', 68: 'R05'}; // partner_id → display code (consistent with v2)

  // Discover active runners from Token Issue orders in last 90 days; falls back to hardcoded list
  async function discoverRunners() {
    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const orders = await odooCall('pos.order', 'search_read',
      [['config_id', '=', POS_CASH_COUNTER], ['date_order', '>=', cutoff],
       ['state', 'in', ['paid', 'done', 'invoiced', 'posted']], ['partner_id', '!=', false]],
      ['id', 'partner_id', 'payment_ids']
    );
    const allPayIds = orders.flatMap(o => o.payment_ids);
    const tiOrderIds = new Set();
    if (allPayIds.length) {
      const pays = await odooCall('pos.payment', 'search_read', [['id', 'in', allPayIds]], ['id', 'pos_order_id', 'payment_method_id']);
      for (const p of pays) { if (p.payment_method_id[0] === PM_TOKEN_ISSUE) tiOrderIds.add(p.pos_order_id[0]); }
    }
    const partnerIds = new Set();
    for (const o of orders) { if (tiOrderIds.has(o.id) && o.partner_id) partnerIds.add(o.partner_id[0]); }
    if (!partnerIds.size) return RUNNER_IDS_FALLBACK.map(id => ({id, name: RUNNER_CODE_MAP[id] || `R-${id}`}));
    // Map known partner_ids to codes; fetch Odoo names only for unrecognised IDs
    const known = [...partnerIds].filter(id => RUNNER_CODE_MAP[id]).map(id => ({id, name: RUNNER_CODE_MAP[id]}));
    const unknownIds = [...partnerIds].filter(id => !RUNNER_CODE_MAP[id]);
    if (unknownIds.length) {
      const partners = await odooCall('res.partner', 'search_read', [['id', 'in', unknownIds]], ['id', 'name']);
      known.push(...partners.map(p => ({id: p.id, name: p.name})));
    }
    return known.sort((a, b) => a.id - b.id);
  }

  // ── Fetch beverage data for a period (POS 27 only) ──
  async function fetchBeverageData(periodStart, periodEnd) {
    // Both D1 timestamps and Odoo date_order are stored in UTC — no conversion needed
    const fromOdoo = new Date(periodStart).toISOString().slice(0, 19).replace('T', ' ');
    const toOdoo = new Date(periodEnd).toISOString().slice(0, 19).replace('T', ' ');

    // 1. POS 27 orders only
    const orders = await odooCall('pos.order', 'search_read',
      [['config_id', '=', POS_CASH_COUNTER], ['date_order', '>=', fromOdoo], ['date_order', '<=', toOdoo], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]],
      ['id', 'payment_ids']
    );

    if (!orders.length) {
      return {total: 0, chai: 0, coffee: 0, lemon_tea: 0, tokenIssueQty: 0, compQty: 0};
    }

    const orderIds = orders.map(o => o.id);
    const orderMap = {};
    for (const o of orders) orderMap[o.id] = {hasTokenIssue: false, isComp: false};

    // 2. Payments — flag Token Issue (PM 48) and Complimentary (PM 49)
    const allPaymentIds = orders.flatMap(o => o.payment_ids);
    if (allPaymentIds.length) {
      const payments = await odooCall('pos.payment', 'search_read',
        [['id', 'in', allPaymentIds]],
        ['id', 'pos_order_id', 'payment_method_id']
      );
      for (const p of payments) {
        const orderId = p.pos_order_id[0];
        if (!orderMap[orderId]) continue;
        if (p.payment_method_id[0] === PM_TOKEN_ISSUE) orderMap[orderId].hasTokenIssue = true;
        if (p.payment_method_id[0] === PM_COMP) orderMap[orderId].isComp = true;
      }
    }

    // 3. Beverage lines
    const lines = await odooCall('pos.order.line', 'search_read',
      [['order_id', 'in', orderIds], ['product_id', 'in', BEVERAGE_IDS]],
      ['order_id', 'product_id', 'qty']
    );

    let chai = 0, coffee = 0, lemon_tea = 0, total = 0, tokenIssueQty = 0, compQty = 0;
    for (const line of lines) {
      const orderId = line.order_id[0];
      const productKey = BEVERAGE_NAMES[line.product_id[0]];
      const qty = Math.round(line.qty);
      if (!productKey) continue;

      // Count all beverages for breakdown display
      if (productKey === 'chai') chai += qty;
      else if (productKey === 'coffee') coffee += qty;
      else if (productKey === 'lemon_tea') lemon_tea += qty;

      if (orderMap[orderId] && orderMap[orderId].isComp) {
        // Complimentary — different token, NOT in box
        compQty += qty;
      } else {
        // Pink token — goes in box (Cash/UPI/Card/Token Issue)
        total += qty;
        if (orderMap[orderId] && orderMap[orderId].hasTokenIssue) {
          tokenIssueQty += qty;
        }
      }
    }

    return {total, chai, coffee, lemon_tea, tokenIssueQty, compQty};
  }

  try {
    // ── verify-pin ──
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PINS[pin]) return new Response(JSON.stringify({success: true, user: PINS[pin]}), {headers: corsHeaders});
      return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
    }

    // ── get-status ──
    if (action === 'get-status') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      const last = await DB.prepare('SELECT * FROM token_box_settlements ORDER BY settled_at DESC LIMIT 1').first();
      return new Response(JSON.stringify({success: true, lastSettlement: last || null}), {headers: corsHeaders});
    }

    // ── get-beverage-data (preview) ──
    if (action === 'get-beverage-data') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return new Response(JSON.stringify({success: false, error: 'from and to required'}), {headers: corsHeaders});

      const data = await fetchBeverageData(from, to);
      return new Response(JSON.stringify({success: true, ...data}), {headers: corsHeaders});
    }

    // ── get-runners (dynamic runner list for frontend initialisation) ──
    if (action === 'get-runners') {
      const runners = await discoverRunners();
      return new Response(JSON.stringify({success: true, runners}), {headers: corsHeaders});
    }

    // ── get-runner-context (per-runner Token Issue data from Odoo + last settlement) ──
    if (action === 'get-runner-context') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      // 1. Discover active runners dynamically
      const activeRunners = await discoverRunners();
      const activeRunnerIds = activeRunners.map(r => r.id);
      const runnerCodeMap = Object.fromEntries(activeRunners.map(r => [r.id, r.name]));

      // 2. Get last runner settlement per runner from D1 (best-effort; separate settlements table may not exist)
      const lastSettlements = {};
      for (const rid of activeRunnerIds) {
        try {
          const row = await DB.prepare('SELECT settled_at, unsold_tokens FROM settlements WHERE runner_id = ? ORDER BY settled_at DESC LIMIT 1').bind(rid).first();
          lastSettlements[rid] = row ? {settledAt: row.settled_at, unsold: Math.round(row.unsold_tokens || 0)} : null;
        } catch { lastSettlements[rid] = null; }
      }

      // 3. Find earliest settlement time across all runners
      let earliestTime = null;
      for (const rid of activeRunnerIds) {
        if (lastSettlements[rid] && (!earliestTime || lastSettlements[rid].settledAt < earliestTime)) {
          earliestTime = lastSettlements[rid].settledAt;
        }
      }
      if (!earliestTime) earliestTime = '2026-01-01T00:00:00.000Z';

      // 4. Query Odoo: Token Issue orders at POS 27 since earliest time, filtered to active runner partner_ids
      const fromOdoo = new Date(earliestTime).toISOString().slice(0, 19).replace('T', ' ');
      const orders = await odooCall('pos.order', 'search_read',
        [['config_id', '=', POS_CASH_COUNTER], ['date_order', '>=', fromOdoo], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']], ['partner_id', 'in', activeRunnerIds]],
        ['id', 'date_order', 'partner_id', 'payment_ids']
      );

      // 5. Filter to Token Issue orders only
      const allPaymentIds = orders.flatMap(o => o.payment_ids);
      const tokenIssueOrderIds = new Set();
      if (allPaymentIds.length) {
        const payments = await odooCall('pos.payment', 'search_read',
          [['id', 'in', allPaymentIds]],
          ['id', 'pos_order_id', 'payment_method_id']
        );
        for (const p of payments) {
          if (p.payment_method_id[0] === PM_TOKEN_ISSUE) tokenIssueOrderIds.add(p.pos_order_id[0]);
        }
      }
      const tokenIssueOrders = orders.filter(o => tokenIssueOrderIds.has(o.id));

      // 6. Get beverage lines for these orders
      const orderIds = tokenIssueOrders.map(o => o.id);
      let bevLines = [];
      if (orderIds.length) {
        bevLines = await odooCall('pos.order.line', 'search_read',
          [['order_id', 'in', orderIds], ['product_id', 'in', BEVERAGE_IDS]],
          ['order_id', 'product_id', 'qty']
        );
      }

      // Build order-to-runner map
      const orderRunnerMap = {};
      for (const o of tokenIssueOrders) orderRunnerMap[o.id] = {runnerId: o.partner_id[0], dateOrder: o.date_order};

      // 7. Calculate per-runner issued since their last settlement
      const runnersOut = {};
      for (const rid of activeRunnerIds) {
        const lastSett = lastSettlements[rid];
        const sinceOdoo = lastSett ? new Date(lastSett.settledAt).toISOString().slice(0, 19).replace('T', ' ') : fromOdoo;
        let issuedSince = 0;
        for (const line of bevLines) {
          const info = orderRunnerMap[line.order_id[0]];
          if (info && info.runnerId === rid && info.dateOrder >= sinceOdoo) issuedSince += Math.round(line.qty);
        }
        const lastUnsold = lastSett ? lastSett.unsold : 0;
        runnersOut[rid] = {
          name: runnerCodeMap[rid],
          lastSettledAt: lastSett ? lastSett.settledAt : null,
          lastUnsold,
          issuedSince,
          maxUnsold: lastUnsold + issuedSince
        };
      }

      return new Response(JSON.stringify({success: true, runners: runnersOut}), {headers: corsHeaders});
    }

    // ── reset (delete all token box settlements — admin only, PIN re-verification required) ──
    if (action === 'reset' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      const body = await context.request.json();
      const {pin} = body;
      if (!pin || !PINS[pin]) return new Response(JSON.stringify({success: false, error: 'Invalid PIN — re-enter your PIN to authorise reset'}), {headers: corsHeaders});
      const resetUser = PINS[pin];
      if (!ADMIN_USERS.includes(resetUser)) return new Response(JSON.stringify({success: false, error: `Reset requires admin access. Contact ${ADMIN_USERS.join(' or ')}.`}), {headers: corsHeaders});
      await DB.prepare('DELETE FROM token_box_settlements').run();
      return new Response(JSON.stringify({success: true, message: 'Token tracking reset. Bootstrap again to start fresh.'}), {headers: corsHeaders});
    }

    // ── bootstrap ──
    if (action === 'bootstrap' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {settled_by, unsold_tokens, unsold_detail, emptied_at} = body;

      const existing = await DB.prepare('SELECT id FROM token_box_settlements LIMIT 1').first();
      if (existing) return new Response(JSON.stringify({success: false, error: 'Already bootstrapped. Use reset first, then bootstrap.'}), {headers: corsHeaders});

      const runnerUnsold = unsold_tokens || 0;
      let notesStr = 'Bootstrap — token tracking started';
      if (unsold_detail && Object.keys(unsold_detail).length) {
        const parts = Object.entries(unsold_detail).filter(([, v]) => v > 0).map(([name, qty]) => `${name}=${qty}`);
        if (parts.length) notesStr += ' | Unsold: ' + parts.join(', ');
      }

      const now = new Date().toISOString();
      // emptied_at: when the box was physically emptied (user-specified); defaults to now
      const periodAnchor = emptied_at ? new Date(emptied_at).toISOString() : now;
      await DB.prepare(`
        INSERT INTO token_box_settlements (settled_at, settled_by, period_start, period_end, is_bootstrap, runner_unsold_qty, carry_forward_qty, notes)
        VALUES (?, ?, ?, ?, 1, ?, 0, ?)
      `).bind(now, settled_by, periodAnchor, periodAnchor, runnerUnsold, notesStr).run();

      return new Response(JSON.stringify({success: true, message: 'Token tracking started', settled_at: now, periodAnchor, runnerUnsold}), {headers: corsHeaders});
    }

    // ── settle ──
    if (action === 'settle' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {settled_by, gross_weight_kg: rawWeight, manual_count, count_mode, unsold_tokens, unsold_detail, notes} = body;

      if (!settled_by) return new Response(JSON.stringify({success: false, error: 'settled_by required'}), {headers: corsHeaders});

      // Two modes: "weight" (default, sum of net weights from tared cover) or "manual" (hand count override)
      const useManual = count_mode === 'manual' || (manual_count !== undefined && manual_count !== null && (rawWeight === undefined || rawWeight === null));
      let net_weight_g = 0;
      let tokenCount = 0;

      if (useManual) {
        const mc = parseInt(manual_count);
        if (isNaN(mc) || mc < 0) return new Response(JSON.stringify({success: false, error: 'manual_count must be >= 0'}), {headers: corsHeaders});
        tokenCount = mc;
        // If weight was also provided, keep it for the record; else derive nominal weight
        net_weight_g = (rawWeight !== undefined && rawWeight !== null) ? rawWeight : Math.round(mc * TOKEN_WEIGHT_G);
      } else {
        if (rawWeight === undefined || rawWeight === null) return new Response(JSON.stringify({success: false, error: 'Weight required (or provide manual_count)'}), {headers: corsHeaders});
        // Frontend always sends grams. Only auto-convert if clearly a fractional kg value (< 1).
        // Previous threshold (<50) broke small-count periods where net weight < 50g is legitimate.
        net_weight_g = rawWeight > 0 && rawWeight < 1 ? Math.round(rawWeight * 1000) : rawWeight;
        if (net_weight_g < MIN_NET_WEIGHT_G) return new Response(JSON.stringify({success: false, error: `Net weight ${net_weight_g}g invalid (min ${MIN_NET_WEIGHT_G}g)`}), {headers: corsHeaders});
        // Sanity cap: 10kg = ~9000 tokens in one settlement. If higher, likely a unit/typo error.
        if (net_weight_g > 10000) return new Response(JSON.stringify({success: false, error: `Net weight ${net_weight_g}g exceeds 10kg — check unit or use manual count`}), {headers: corsHeaders});
        tokenCount = Math.round(net_weight_g / TOKEN_WEIGHT_G);
      }

      // Duplicate prevention (5 min window) — use ISO timestamp to match stored format
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const recentDup = await DB.prepare(
        "SELECT id, settled_at FROM token_box_settlements WHERE settled_by = ? AND is_bootstrap = 0 AND settled_at > ? LIMIT 1"
      ).bind(settled_by, fiveMinAgo).first();
      if (recentDup) {
        return new Response(JSON.stringify({success: false, error: 'You already settled recently. Wait a few minutes.'}), {headers: corsHeaders});
      }

      // Get last settlement for period_start + carry-forward
      const last = await DB.prepare('SELECT settled_at, runner_unsold_qty FROM token_box_settlements ORDER BY settled_at DESC LIMIT 1').first();
      if (!last) return new Response(JSON.stringify({success: false, error: 'No prior settlement. Bootstrap first.'}), {headers: corsHeaders});

      const periodStart = last.settled_at;
      const periodEnd = new Date().toISOString();
      const carryForward = last.runner_unsold_qty || 0;

      // Odoo beverage data
      const bev = await fetchBeverageData(periodStart, periodEnd);

      // THE FORMULA: expected = carry_forward + odoo_total - current_unsold
      const currentUnsold = unsold_tokens || 0;
      const expected = carryForward + bev.total - currentUnsold;
      const discrepancy = tokenCount - expected;

      // Build notes: include per-runner unsold detail + mode
      let fullNotes = '';
      if (useManual) fullNotes = `Mode: manual count (${tokenCount})`;
      if (unsold_detail && Object.keys(unsold_detail).length) {
        const parts = Object.entries(unsold_detail).filter(([, v]) => v > 0).map(([name, qty]) => `${name}=${qty}`);
        if (parts.length) fullNotes = (fullNotes ? fullNotes + ' | ' : '') + 'Unsold: ' + parts.join(', ');
      }
      if (notes) fullNotes = fullNotes ? fullNotes + ' | ' + notes : notes;

      await DB.prepare(`
        INSERT INTO token_box_settlements (
          settled_at, settled_by, period_start, period_end,
          gross_weight_kg, box_tare_kg, token_weight_kg, token_count,
          odoo_total_beverages, odoo_chai, odoo_coffee, odoo_lemon_tea,
          token_issue_qty, runner_unsold_qty, carry_forward_qty,
          expected_tokens, discrepancy, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        periodEnd, settled_by, periodStart, periodEnd,
        net_weight_g, BOX_TARE_G, TOKEN_WEIGHT_G, tokenCount,
        bev.total, bev.chai, bev.coffee, bev.lemon_tea,
        bev.tokenIssueQty, currentUnsold, carryForward,
        expected, discrepancy, fullNotes
      ).run();

      return new Response(JSON.stringify({
        success: true, message: 'Token settlement recorded',
        result: {
          periodStart, periodEnd,
          grossWeight: net_weight_g, tokenCount, countMode: useManual ? 'manual' : 'weight',
          odooTotal: bev.total, chai: bev.chai, coffee: bev.coffee, lemonTea: bev.lemon_tea,
          tokenIssueQty: bev.tokenIssueQty, compQty: bev.compQty,
          carryForward, currentUnsold, expected, discrepancy
        }
      }), {headers: corsHeaders});
    }

    // ── send-report (WhatsApp PDF) ──
    if (action === 'send-report' && context.request.method === 'POST') {
      const WA_TOKEN = context.env.WA_ACCESS_TOKEN;
      const WA_PHONE_ID = '970365416152029'; // NCH
      if (!WA_TOKEN) return new Response(JSON.stringify({success: false, error: 'WhatsApp not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {pdf_base64, file_name, caption, phones} = body;
      if (!pdf_base64 || !phones?.length) return new Response(JSON.stringify({success: false, error: 'pdf_base64 and phones required'}), {headers: corsHeaders});

      // Upload PDF to WhatsApp Media API
      const pdfBytes = Uint8Array.from(atob(pdf_base64), c => c.charCodeAt(0));
      const blob = new Blob([pdfBytes], {type: 'application/pdf'});
      const formData = new FormData();
      formData.append('file', blob, file_name || 'report.pdf');
      formData.append('type', 'application/pdf');
      formData.append('messaging_product', 'whatsapp');

      const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/media`, {
        method: 'POST', headers: {'Authorization': `Bearer ${WA_TOKEN}`}, body: formData
      });
      const uploadData = await uploadRes.json();
      if (!uploadData.id) return new Response(JSON.stringify({success: false, error: 'Media upload failed', detail: uploadData}), {headers: corsHeaders});

      // Send document to each phone number
      const results = [];
      for (const phone of phones) {
        const sendRes = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
          method: 'POST',
          headers: {'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: phone, type: 'document',
            document: {id: uploadData.id, filename: file_name || 'report.pdf', caption: caption || ''}
          })
        });
        const sendData = await sendRes.json();
        results.push({phone, ok: !!sendData.messages});
      }

      return new Response(JSON.stringify({success: true, results}), {headers: corsHeaders});
    }

    // ── get-calibration (token weight drift analysis from historical weight-mode settlements) ──
    if (action === 'get-calibration') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      const rows = await DB.prepare(
        "SELECT gross_weight_kg, token_count, notes FROM token_box_settlements WHERE is_bootstrap = 0 AND token_count > 0 AND gross_weight_kg > 0 AND (notes IS NULL OR notes NOT LIKE 'Mode: manual%') ORDER BY settled_at DESC LIMIT 20"
      ).all();
      const samples = (rows.results || []).filter(r => r.gross_weight_kg > 0 && r.token_count > 0);
      if (!samples.length) return new Response(JSON.stringify({success: true, sampleCount: 0, avgWeightG: TOKEN_WEIGHT_G, baselineG: TOKEN_WEIGHT_G, driftG: 0, suggestRecalibrate: false}), {headers: corsHeaders});
      // gross_weight_kg column stores NET weight in GRAMS (naming is a legacy artefact)
      const weights = samples.map(r => r.gross_weight_kg / r.token_count);
      const avg = weights.reduce((a, b) => a + b, 0) / weights.length;
      const drift = Math.abs(avg - TOKEN_WEIGHT_G);
      return new Response(JSON.stringify({
        success: true,
        sampleCount: samples.length,
        avgWeightG: Math.round(avg * 1000) / 1000,
        baselineG: TOKEN_WEIGHT_G,
        driftG: Math.round(drift * 1000) / 1000,
        suggestRecalibrate: drift > 0.05
      }), {headers: corsHeaders});
    }

    // ── history ──
    if (action === 'history') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      const limit = url.searchParams.get('limit') || 20;
      const results = await DB.prepare('SELECT * FROM token_box_settlements WHERE is_bootstrap = 0 ORDER BY settled_at DESC LIMIT ?').bind(limit).all();
      return new Response(JSON.stringify({success: true, settlements: results.results}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), {status: 500, headers: corsHeaders});
  }
}
