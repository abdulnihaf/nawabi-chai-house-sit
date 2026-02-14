// NCH Token Box Settlement — Cloudflare Worker
// Weighs physical beverage tokens against Odoo POS sales to detect discrepancies

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

  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen', '8241': 'Nafees'};

  const BOX_TARE_KG = 0.338;
  const TOKEN_WEIGHT_KG = 0.00110;
  const BEVERAGE_IDS = [1028, 1102, 1103]; // Irani Chai, Coffee, Lemon Tea
  const BEVERAGE_NAMES = {1028: 'chai', 1102: 'coffee', 1103: 'lemon_tea'};
  const PM = {CASH: 37, UPI: 38, CARD: 39, RUNNER_LEDGER: 40, TOKEN_ISSUE: 48, COMP: 49};
  const POS = {CASH_COUNTER: 27, RUNNER_COUNTER: 28};

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

  // ── Fetch beverage breakdown for a period ──
  async function fetchBeverageBreakdown(periodStart, periodEnd) {
    // Convert IST to UTC for Odoo
    const fromUTC = new Date(new Date(periodStart).getTime() - 5.5 * 60 * 60 * 1000);
    const toUTC = new Date(new Date(periodEnd).getTime() - 5.5 * 60 * 60 * 1000);
    const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');
    const toOdoo = toUTC.toISOString().slice(0, 19).replace('T', ' ');

    // 1. Fetch all POS orders in period (both counters)
    const orders = await odooCall('pos.order', 'search_read',
      [['config_id', 'in', [POS.CASH_COUNTER, POS.RUNNER_COUNTER]], ['date_order', '>=', fromOdoo], ['date_order', '<=', toOdoo], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]],
      ['id', 'name', 'config_id', 'payment_ids']
    );

    if (!orders.length) {
      return {counter: {chai: 0, coffee: 0, lemon_tea: 0, total: 0}, runner: {chai: 0, coffee: 0, lemon_tea: 0, total: 0}, tokenIssue: {chai: 0, coffee: 0, lemon_tea: 0, total: 0}, expected: 0, runnerUnsold: 0};
    }

    const orderIds = orders.map(o => o.id);
    const orderMap = {};
    for (const o of orders) {
      orderMap[o.id] = {configId: o.config_id[0], paymentIds: o.payment_ids, hasTokenIssue: false};
    }

    // 2. Fetch payments for these orders — identify Token Issue orders
    const allPaymentIds = orders.flatMap(o => o.payment_ids);
    if (allPaymentIds.length) {
      const payments = await odooCall('pos.payment', 'search_read',
        [['id', 'in', allPaymentIds]],
        ['id', 'pos_order_id', 'payment_method_id']
      );
      for (const p of payments) {
        const orderId = p.pos_order_id[0];
        if (p.payment_method_id[0] === PM.TOKEN_ISSUE && orderMap[orderId]) {
          orderMap[orderId].hasTokenIssue = true;
        }
      }
    }

    // 3. Fetch beverage order lines
    const lines = await odooCall('pos.order.line', 'search_read',
      [['order_id', 'in', orderIds], ['product_id', 'in', BEVERAGE_IDS]],
      ['order_id', 'product_id', 'qty']
    );

    // Categorize
    const counter = {chai: 0, coffee: 0, lemon_tea: 0, total: 0};
    const runner = {chai: 0, coffee: 0, lemon_tea: 0, total: 0};
    const tokenIssue = {chai: 0, coffee: 0, lemon_tea: 0, total: 0};

    for (const line of lines) {
      const orderId = line.order_id[0];
      const productKey = BEVERAGE_NAMES[line.product_id[0]];
      const qty = Math.round(line.qty);
      const order = orderMap[orderId];
      if (!order || !productKey) continue;

      if (order.configId === POS.CASH_COUNTER && order.hasTokenIssue) {
        tokenIssue[productKey] += qty;
        tokenIssue.total += qty;
      } else if (order.configId === POS.CASH_COUNTER) {
        counter[productKey] += qty;
        counter.total += qty;
      } else if (order.configId === POS.RUNNER_COUNTER) {
        runner[productKey] += qty;
        runner.total += qty;
      }
    }

    // Expected tokens in box = counter + runner (excludes token issue — those are issuance, not drops)
    const expected = counter.total + runner.total;
    // Runner unsold = tokens still with runners (issued but not redeemed in this period)
    const runnerUnsold = Math.max(0, tokenIssue.total - runner.total);

    return {counter, runner, tokenIssue, expected, runnerUnsold};
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

    // ── get-beverage-data ──
    if (action === 'get-beverage-data') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return new Response(JSON.stringify({success: false, error: 'from and to required'}), {headers: corsHeaders});

      const breakdown = await fetchBeverageBreakdown(from, to);
      return new Response(JSON.stringify({success: true, ...breakdown}), {headers: corsHeaders});
    }

    // ── bootstrap ──
    if (action === 'bootstrap' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {settled_by} = body;

      // Prevent re-bootstrap
      const existing = await DB.prepare('SELECT id FROM token_box_settlements LIMIT 1').first();
      if (existing) return new Response(JSON.stringify({success: false, error: 'Already bootstrapped. Use settle action.'}), {headers: corsHeaders});

      const now = new Date().toISOString();
      await DB.prepare(`
        INSERT INTO token_box_settlements (settled_at, settled_by, period_start, period_end, is_bootstrap, notes)
        VALUES (?, ?, ?, ?, 1, 'Bootstrap — token tracking started')
      `).bind(now, settled_by, now, now).run();

      return new Response(JSON.stringify({success: true, message: 'Token tracking started', settled_at: now}), {headers: corsHeaders});
    }

    // ── settle ──
    if (action === 'settle' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {settled_by, gross_weight_kg, notes} = body;

      if (!settled_by) return new Response(JSON.stringify({success: false, error: 'settled_by required'}), {headers: corsHeaders});
      if (gross_weight_kg === undefined || gross_weight_kg === null) return new Response(JSON.stringify({success: false, error: 'Weight required'}), {headers: corsHeaders});
      if (gross_weight_kg < BOX_TARE_KG) return new Response(JSON.stringify({success: false, error: `Weight ${gross_weight_kg} kg is less than empty box (${BOX_TARE_KG} kg)`}), {headers: corsHeaders});

      // Duplicate prevention (5 min window)
      const recentDup = await DB.prepare(
        "SELECT id, settled_at FROM token_box_settlements WHERE settled_by = ? AND is_bootstrap = 0 AND settled_at > datetime('now', '-5 minutes') LIMIT 1"
      ).bind(settled_by).first();
      if (recentDup) {
        return new Response(JSON.stringify({success: false, error: 'You already settled recently. Wait a few minutes.'}), {headers: corsHeaders});
      }

      // Get last settlement for period_start
      const last = await DB.prepare('SELECT settled_at FROM token_box_settlements ORDER BY settled_at DESC LIMIT 1').first();
      if (!last) return new Response(JSON.stringify({success: false, error: 'No prior settlement. Bootstrap first.'}), {headers: corsHeaders});

      const periodStart = last.settled_at;
      const periodEnd = new Date().toISOString();

      // Calculate token count from weight
      const tokenCount = Math.round((gross_weight_kg - BOX_TARE_KG) / TOKEN_WEIGHT_KG);

      // Fetch Odoo beverage data
      const breakdown = await fetchBeverageBreakdown(periodStart, periodEnd);
      const discrepancy = tokenCount - breakdown.expected;

      await DB.prepare(`
        INSERT INTO token_box_settlements (
          settled_at, settled_by, period_start, period_end,
          gross_weight_kg, box_tare_kg, token_weight_kg, token_count,
          odoo_total_beverages, odoo_chai, odoo_coffee, odoo_lemon_tea,
          token_issue_qty, runner_delivered_qty, runner_unsold_qty,
          expected_tokens, discrepancy, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        periodEnd, settled_by, periodStart, periodEnd,
        gross_weight_kg, BOX_TARE_KG, TOKEN_WEIGHT_KG, tokenCount,
        breakdown.expected, breakdown.counter.chai + breakdown.runner.chai, breakdown.counter.coffee + breakdown.runner.coffee, breakdown.counter.lemon_tea + breakdown.runner.lemon_tea,
        breakdown.tokenIssue.total, breakdown.runner.total, breakdown.runnerUnsold,
        breakdown.expected, discrepancy, notes || ''
      ).run();

      return new Response(JSON.stringify({
        success: true, message: 'Token settlement recorded',
        result: {
          periodStart, periodEnd,
          grossWeight: gross_weight_kg, tokenCount,
          counter: breakdown.counter, runner: breakdown.runner, tokenIssue: breakdown.tokenIssue,
          expected: breakdown.expected, runnerUnsold: breakdown.runnerUnsold,
          discrepancy
        }
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
