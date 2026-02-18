// NCH Token Box Settlement — Cloudflare Worker
// Weighs physical beverage tokens against Odoo POS sales to detect discrepancies
//
// Logic: ALL beverages sold at POS 27 (Cash Counter) only.
// Pink tokens (in box): Cash (37), UPI (38), Card (39) → dropped immediately.
//                        Token Issue (48) → runner delivers, customer drops later.
// NOT in box: Complimentary (49) → uses different colored token, excluded from count.
// Carry-forward: previous unsold tokens appear in box next period but aren't in Odoo for that period.
// Formula: expected = carry_forward + (odoo_beverages - comp_beverages) - current_unsold

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

  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '3678': 'Farooq', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen', '8241': 'Nafees'};

  const BOX_TARE_G = 339;    // grams (SF-400 scale)
  const TOKEN_WEIGHT_G = 1.1; // ~1.1 gram per token
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

  const RUNNER_IDS = [64, 65, 66, 67, 68];
  const RUNNER_NAMES = {64: 'FAROOQ', 65: 'AMIN', 66: 'Runner 03', 67: 'Runner 04', 68: 'Runner 05'};

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

    // ── get-runner-context (per-runner Token Issue data from Odoo + last settlement) ──
    if (action === 'get-runner-context') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      // 1. Get last runner settlement per runner from D1
      const lastSettlements = {};
      for (const rid of RUNNER_IDS) {
        const row = await DB.prepare('SELECT settled_at, unsold_tokens FROM settlements WHERE runner_id = ? ORDER BY settled_at DESC LIMIT 1').bind(rid).first();
        lastSettlements[rid] = row ? {settledAt: row.settled_at, unsold: Math.round(row.unsold_tokens || 0)} : null;
      }

      // 2. Find earliest settlement time across all runners
      let earliestTime = null;
      for (const rid of RUNNER_IDS) {
        if (lastSettlements[rid]) {
          if (!earliestTime || lastSettlements[rid].settledAt < earliestTime) earliestTime = lastSettlements[rid].settledAt;
        }
      }
      if (!earliestTime) earliestTime = '2026-01-01T00:00:00.000Z';

      // 3. Query Odoo: Token Issue orders at POS 27 since earliest time, with runner partner_id
      const fromOdoo = new Date(earliestTime).toISOString().slice(0, 19).replace('T', ' ');
      const orders = await odooCall('pos.order', 'search_read',
        [['config_id', '=', POS_CASH_COUNTER], ['date_order', '>=', fromOdoo], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']], ['partner_id', 'in', RUNNER_IDS]],
        ['id', 'date_order', 'partner_id', 'payment_ids']
      );

      // 4. Filter to Token Issue orders only
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

      // 5. Get beverage lines for these orders
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

      // 6. Calculate per-runner issued since their last settlement
      const runners = {};
      for (const rid of RUNNER_IDS) {
        const lastSett = lastSettlements[rid];
        const sinceOdoo = lastSett ? new Date(lastSett.settledAt).toISOString().slice(0, 19).replace('T', ' ') : fromOdoo;
        let issuedSince = 0;
        for (const line of bevLines) {
          const info = orderRunnerMap[line.order_id[0]];
          if (info && info.runnerId === rid && info.dateOrder >= sinceOdoo) issuedSince += Math.round(line.qty);
        }
        const lastUnsold = lastSett ? lastSett.unsold : 0;
        runners[rid] = {
          name: RUNNER_NAMES[rid],
          lastSettledAt: lastSett ? lastSett.settledAt : null,
          lastUnsold,
          issuedSince,
          maxUnsold: lastUnsold + issuedSince
        };
      }

      return new Response(JSON.stringify({success: true, runners}), {headers: corsHeaders});
    }

    // ── reset (delete all token box settlements for fresh start) ──
    if (action === 'reset' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      const body = await context.request.json();
      if (!body.settled_by) return new Response(JSON.stringify({success: false, error: 'settled_by required'}), {headers: corsHeaders});
      await DB.prepare('DELETE FROM token_box_settlements').run();
      return new Response(JSON.stringify({success: true, message: 'Token tracking reset. Bootstrap again to start fresh.'}), {headers: corsHeaders});
    }

    // ── bootstrap ──
    if (action === 'bootstrap' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {settled_by, unsold_tokens, unsold_detail} = body;

      const existing = await DB.prepare('SELECT id FROM token_box_settlements LIMIT 1').first();
      if (existing) return new Response(JSON.stringify({success: false, error: 'Already bootstrapped. Use reset first, then bootstrap.'}), {headers: corsHeaders});

      const runnerUnsold = unsold_tokens || 0;
      let notesStr = 'Bootstrap — token tracking started';
      if (unsold_detail && Object.keys(unsold_detail).length) {
        const parts = Object.entries(unsold_detail).filter(([, v]) => v > 0).map(([name, qty]) => `${name}=${qty}`);
        if (parts.length) notesStr += ' | Unsold: ' + parts.join(', ');
      }

      const now = new Date().toISOString();
      await DB.prepare(`
        INSERT INTO token_box_settlements (settled_at, settled_by, period_start, period_end, is_bootstrap, runner_unsold_qty, carry_forward_qty, notes)
        VALUES (?, ?, ?, ?, 1, ?, 0, ?)
      `).bind(now, settled_by, now, now, runnerUnsold, notesStr).run();

      return new Response(JSON.stringify({success: true, message: 'Token tracking started', settled_at: now, runnerUnsold}), {headers: corsHeaders});
    }

    // ── settle ──
    if (action === 'settle' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {settled_by, gross_weight_kg: rawWeight, unsold_tokens, unsold_detail, notes} = body;

      if (!settled_by) return new Response(JSON.stringify({success: false, error: 'settled_by required'}), {headers: corsHeaders});
      if (rawWeight === undefined || rawWeight === null) return new Response(JSON.stringify({success: false, error: 'Weight required'}), {headers: corsHeaders});

      // Auto-detect unit: values < 50 are kg (old frontend cache), convert to grams
      const gross_weight_kg = rawWeight < 50 ? Math.round(rawWeight * 1000) : rawWeight;
      if (gross_weight_kg < BOX_TARE_G) return new Response(JSON.stringify({success: false, error: `Weight ${gross_weight_kg}g is less than empty box (${BOX_TARE_G}g)`}), {headers: corsHeaders});

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

      // Token count from weight
      const tokenCount = Math.round((gross_weight_kg - BOX_TARE_G) / TOKEN_WEIGHT_G);

      // Odoo beverage data
      const bev = await fetchBeverageData(periodStart, periodEnd);

      // THE FORMULA: expected = carry_forward + odoo_total - current_unsold
      const currentUnsold = unsold_tokens || 0;
      const expected = carryForward + bev.total - currentUnsold;
      const discrepancy = tokenCount - expected;

      // Build notes: include per-runner unsold detail if provided
      let fullNotes = '';
      if (unsold_detail && Object.keys(unsold_detail).length) {
        const parts = Object.entries(unsold_detail).filter(([, v]) => v > 0).map(([name, qty]) => `${name}=${qty}`);
        if (parts.length) fullNotes = 'Unsold: ' + parts.join(', ');
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
        gross_weight_kg, BOX_TARE_G, TOKEN_WEIGHT_G, tokenCount,
        bev.total, bev.chai, bev.coffee, bev.lemon_tea,
        bev.tokenIssueQty, currentUnsold, carryForward,
        expected, discrepancy, fullNotes
      ).run();

      return new Response(JSON.stringify({
        success: true, message: 'Token settlement recorded',
        result: {
          periodStart, periodEnd,
          grossWeight: gross_weight_kg, tokenCount,
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
