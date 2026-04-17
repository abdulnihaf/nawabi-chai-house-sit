export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;
  const WA_TOKEN = context.env.WA_ACCESS_TOKEN;
  const WA_PHONE_ID = context.env.WA_PHONE_ID || '970365416152029';
  const ALERT_RECIPIENTS = ['917010426808', '918073476051']; // Nihaf, Naveen

  // Odoo constants for rectification API
  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;

  // PIN verification — matches Odoo POS employee PINs
  const PINS = {'6890': 'Tanveer', '7115': 'CASH001', '3946': 'Jafar', '3678': 'RUN001', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen', '8241': 'CASH002', '8523': 'Basheer', '4421': 'RUN002', '5503': 'RUN003', '6604': 'RUN004', '7705': 'RUN005', '2847': 'CASH003', '5190': 'CASH004'};
  // Users who can collect cash from counter (owner/manager level)
  const COLLECTORS = ['Naveen', 'Nihaf', 'Tanveer', 'Basheer'];
  const RUNNERS = {
    'counter': {id: 'counter', name: 'Cash Counter', barcode: 'POS-27'},
    64: {id: 64, name: 'RUN001', barcode: 'RUN001'},
    65: {id: 65, name: 'RUN002', barcode: 'RUN002'},
    66: {id: 66, name: 'RUN003', barcode: 'RUN003'},
    67: {id: 67, name: 'RUN004', barcode: 'RUN004'},
    68: {id: 68, name: 'RUN005', barcode: 'RUN005'}
  };

  // Runner-specific PINs for Runner Live Dashboard (maps PIN → specific runner)
  const RUNNER_PINS = {
    '3678': {runner_id: 64, name: 'RUN001', barcode: 'RUN001'},
    '4421': {runner_id: 65, name: 'RUN002', barcode: 'RUN002'},
    '5503': {runner_id: 66, name: 'RUN003', barcode: 'RUN003'},
    '6604': {runner_id: 67, name: 'RUN004', barcode: 'RUN004'},
    '7705': {runner_id: 68, name: 'RUN005', barcode: 'RUN005'}
  };

  // Runner QR codes for live UPI tracking (new QR IDs for RUN001/RUN002)
  const RUNNER_QR_MAP = {
    'RUN001': 'qr_SPTqwgC6ssVDDb',
    'RUN002': 'qr_SPTrTvvh9AKsW0',
    'RUN003': 'qr_SBgTo2a39kYmET',
    'RUN004': 'qr_SBgTtFrfddY4AW',
    'RUN005': 'qr_SBgTyFKUsdwLe1'
  };

  // Partner aliases — duplicate Odoo contacts that map to known runners
  const PARTNER_ALIASES = {90: 64, 37: 64};

  // Runner partner_id → slot code (for validation error gate)
  const RUNNER_SLOT_MAP = {64:'RUN001', 65:'RUN002', 66:'RUN003', 67:'RUN004', 68:'RUN005'};

  // Token product name mapping (shared by runner-live and runner-performance)
  const TOKEN_PRODUCT_NAMES = {
    1028: 'Irani Chai', 1102: 'Coffee', 1103: 'Lemon Tea',
    1395: 'Haleem Qtr', 1396: 'Haleem Half', 1397: 'Haleem Full', 1400: 'Haleem Mutton'
  };

  try {
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PINS[pin]) {
        const isCollector = COLLECTORS.includes(PINS[pin]);
        return new Response(JSON.stringify({success: true, user: PINS[pin], isCollector}), {headers: corsHeaders});
      }
      return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
    }

    if (action === 'get-last-settlement') {
      const runnerId = url.searchParams.get('runner_id');
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const result = await DB.prepare(`
        SELECT * FROM settlements WHERE runner_id = ? ORDER BY settled_at DESC LIMIT 1
      `).bind(runnerId).first();

      const lastCollection = await DB.prepare(
        'SELECT collected_at FROM cash_collections ORDER BY collected_at DESC LIMIT 1'
      ).first();

      const baseline = '2026-02-04T17:00:00+05:30';
      const lastSettledAt = result ? result.settled_at : baseline;
      const lastCollectedAt = lastCollection ? lastCollection.collected_at : baseline;

      // Runner vs Counter — fundamentally different period logic:
      //
      // RUNNERS: Period ALWAYS starts from their last individual settlement.
      //   Runner settlement = runner hands cash to counter. Cash collection from
      //   counter is a separate event — it takes cash already settled TO the counter.
      //   Unsettled runner cash is still with the runner, not at the counter.
      //   So cash collection never clears a runner's slate.
      //
      // COUNTER: Period starts from MAX(lastCounterSettlement, lastCollection).
      //   Cash collection empties the counter drawer, so the counter's next
      //   settlement period starts fresh from that point.
      const isRunner = runnerId !== 'counter';
      let periodStart, periodReason;

      if (isRunner) {
        periodStart = lastSettledAt;
        periodReason = 'last_settlement';
      } else {
        periodStart = new Date(lastSettledAt) > new Date(lastCollectedAt) ? lastSettledAt : lastCollectedAt;
        periodReason = new Date(lastSettledAt) > new Date(lastCollectedAt) ? 'last_settlement' : 'last_collection';
      }

      return new Response(JSON.stringify({
        success: true,
        lastSettlement: result || null,
        lastCollection: lastCollection || null,
        periodStart,
        periodReason
      }), {headers: corsHeaders});
    }

    if (action === 'settle' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {runner_id, runner_name, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, unsold_tokens, notes, handover_to} = body;

      const runner = RUNNERS[runner_id];
      if (!runner) return new Response(JSON.stringify({success: false, error: 'Invalid runner'}), {headers: corsHeaders});

      // Duplicate prevention: same person + same runner within 5 minutes
      // Use ISO timestamp (not SQLite datetime) to match stored format
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const recentDup = await DB.prepare(
        `SELECT id, settled_at, settled_by FROM settlements WHERE runner_id = ? AND settled_by = ? AND settled_at > ? ORDER BY settled_at DESC LIMIT 1`
      ).bind(String(runner_id), settled_by, fiveMinAgo).first();

      if (recentDup) {
        const timeStr = recentDup.settled_at.slice(11, 16);
        return new Response(JSON.stringify({
          success: false,
          error: 'You already settled this ' + (runner_id === 'counter' ? 'counter' : 'runner') + ' at ' + timeStr + '. Wait a few minutes if you need to re-settle.'
        }), {headers: corsHeaders});
      }

      // Validation error gate — block settlement if pending errors exist FOR THIS SHIFT
      // GAP 6 FIX: Only check errors with order_time >= period_start (current shift only).
      // Errors from previous shifts don't block the current shift's settlement.
      // Wrapped in try/catch: if validation_errors table doesn't exist, settlement proceeds.
      try {
        const slot = RUNNER_SLOT_MAP[parseInt(runner_id)] || RUNNER_SLOT_MAP[runner_id];
        // Get current shift start time for filtering
        const shiftStart = period_start || '2026-02-04T17:00:00Z';

        if (slot) {
          // Runner settlement: check errors assigned to this runner's slot within this shift
          const pending = await DB.prepare(
            `SELECT COUNT(*) as cnt FROM validation_errors WHERE runner_slot = ? AND status = 'pending' AND error_code != 'unknown_product_warning' AND order_time >= ?`
          ).bind(slot, shiftStart).first();
          if (pending && pending.cnt > 0) {
            return new Response(JSON.stringify({
              success: false,
              error: `Cannot settle: ${pending.cnt} validation error(s) pending for ${slot}. Fix all errors before settling.`,
              pending_errors: pending.cnt
            }), {headers: corsHeaders});
          }
        } else if (String(runner_id) === 'counter') {
          // Counter settlement: check errors with no runner (counter-side errors) within this shift
          const pending = await DB.prepare(
            `SELECT COUNT(*) as cnt FROM validation_errors WHERE status = 'pending' AND error_code != 'unknown_product_warning' AND (runner_slot IS NULL OR runner_slot = '') AND pos_config_id = 27 AND order_time >= ?`
          ).bind(shiftStart).first();
          if (pending && pending.cnt > 0) {
            return new Response(JSON.stringify({
              success: false,
              error: `Cannot settle counter: ${pending.cnt} validation error(s) pending on Cash Counter. Fix all errors before settling.`,
              pending_errors: pending.cnt
            }), {headers: corsHeaders});
          }
          // Also check UPI discrepancies (these are always current-shift since GAP 3 fix clears stale ones)
          try {
            const discPending = await DB.prepare(
              `SELECT COUNT(*) as cnt FROM payment_discrepancies WHERE status = 'pending' AND (expected_entity = 'COUNTER' OR expected_entity = 'RUNNER_COUNTER')`
            ).first();
            if (discPending && discPending.cnt > 0) {
              return new Response(JSON.stringify({
                success: false,
                error: `Cannot settle counter: ${discPending.cnt} UPI discrepancy(ies) pending. Run Razorpay verification and resolve before settling.`,
                pending_discrepancies: discPending.cnt
              }), {headers: corsHeaders});
            }
          } catch (e) { /* payment_discrepancies table may not exist */ }
        }
      } catch (e) {
        // Table doesn't exist or query fails — proceed with settlement (backward compat)
      }

      const settledAt = new Date().toISOString();
      await DB.prepare(`
        INSERT INTO settlements (runner_id, runner_name, settled_at, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, unsold_tokens, notes, handover_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(runner_id), runner_name || runner.name, settledAt, settled_by,
        period_start, period_end, tokens_amount || 0, sales_amount || 0, upi_amount || 0, cash_settled, unsold_tokens || 0, notes || '',
        handover_to || ''
      ).run();

      // Trigger background audit — runs async, user gets immediate response
      if (WA_TOKEN) {
        const auditUrl = new URL(context.request.url);
        auditUrl.pathname = '/api/audit';
        auditUrl.search = `?action=run-audit&from=${encodeURIComponent(period_start)}&to=${encodeURIComponent(period_end)}`;
        context.waitUntil(fetch(auditUrl.toString()).catch(e => console.error('Audit trigger error:', e.message)));
      }

      return new Response(JSON.stringify({success: true, message: 'Settlement recorded'}), {headers: corsHeaders});
    }

    if (action === 'history') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const runnerId = url.searchParams.get('runner_id');
      const limit = url.searchParams.get('limit') || 50;

      let query = 'SELECT * FROM settlements';
      let params = [];
      if (runnerId) {
        query += ' WHERE runner_id = ?';
        params.push(runnerId);
      }
      query += ' ORDER BY settled_at DESC LIMIT ?';
      params.push(limit);

      const results = await DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({success: true, settlements: results.results}), {headers: corsHeaders});
    }

    // === EXPENSE HISTORY (read-only) ===
    if (action === 'expense-history') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      const limit = url.searchParams.get('limit') || 200;
      const results = await DB.prepare(
        `SELECT id, amount, recorded_at, recorded_by, reason as category_name FROM counter_expenses
         UNION ALL
         SELECT ce.id, ce.amount, ce.recorded_at, ce.recorded_by_name as recorded_by, vc.name as category_name
         FROM counter_expenses_v2 ce LEFT JOIN v_expense_categories vc ON ce.category_code = vc.code
         ORDER BY recorded_at DESC LIMIT ?`
      ).bind(parseInt(limit)).all();
      return new Response(JSON.stringify({success: true, expenses: results.results}), {headers: corsHeaders});
    }

    // === EXPENSE RECORDING (by cashier, at the time of expense) ===

    if (action === 'record-expense' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {recorded_by, amount, reason, attributed_to, notes} = body;

      if (!recorded_by || !amount || amount <= 0) {
        return new Response(JSON.stringify({success: false, error: 'Amount and reason required'}), {headers: corsHeaders});
      }
      if (!reason || reason.trim().length === 0) {
        return new Response(JSON.stringify({success: false, error: 'Please enter a reason for the expense'}), {headers: corsHeaders});
      }

      // If collector is recording on behalf of a cashier, validate the cashier name
      const isCollectorRecording = COLLECTORS.includes(recorded_by) && attributed_to;
      if (isCollectorRecording) {
        const validCashiers = Object.values(PINS);
        if (!validCashiers.includes(attributed_to)) {
          return new Response(JSON.stringify({success: false, error: 'Invalid cashier name'}), {headers: corsHeaders});
        }
      }

      await DB.prepare(
        'INSERT INTO counter_expenses (recorded_by, recorded_at, amount, reason, attributed_to, notes) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(recorded_by, new Date().toISOString(), amount, reason.trim(), attributed_to || '', notes || '').run();

      const attrMsg = attributed_to ? ' (attributed to ' + attributed_to + ')' : '';
      return new Response(JSON.stringify({success: true, message: 'Expense recorded: ₹' + amount + ' for ' + reason + attrMsg}), {headers: corsHeaders});
    }

    // === CASH COLLECTION TIER (Naveen collects from counter) ===

    if (action === 'counter-balance') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      // Get last collection timestamp — everything after this is "uncollected cash"
      const lastCollection = await DB.prepare(
        'SELECT * FROM cash_collections ORDER BY collected_at DESC LIMIT 1'
      ).first();

      const baseline = '2026-02-04T17:00:00';
      const sinceTime = lastCollection ? lastCollection.collected_at : baseline;

      // Get all settlements since last collection
      const settlements = await DB.prepare(
        'SELECT * FROM settlements WHERE settled_at > ? ORDER BY settled_at ASC'
      ).bind(sinceTime).all();

      let runnerCash = 0;
      let counterCash = 0;
      const settlementList = [];

      for (const s of settlements.results) {
        if (s.runner_id === 'counter') {
          counterCash += s.cash_settled;
        } else {
          runnerCash += s.cash_settled;
        }
        settlementList.push({
          id: s.id, runner_id: s.runner_id, runner_name: s.runner_name,
          cash_settled: s.cash_settled, settled_by: s.settled_by, settled_at: s.settled_at
        });
      }

      // Get all expenses since last collection (from both old and new tables)
      const expensesResult = await DB.prepare(
        `SELECT amount, recorded_at, reason as category_name FROM counter_expenses WHERE recorded_at > ?
         UNION ALL
         SELECT ce.amount, ce.recorded_at, vc.name as category_name FROM counter_expenses_v2 ce LEFT JOIN v_expense_categories vc ON ce.category_code = vc.code WHERE ce.recorded_at > ?
         ORDER BY recorded_at ASC`
      ).bind(sinceTime, sinceTime).all();

      let totalExpenses = 0;
      const expenseList = [];
      for (const e of expensesResult.results) {
        totalExpenses += e.amount;
        expenseList.push({
          id: e.id, amount: e.amount, reason: e.reason,
          recorded_by: e.recorded_by, recorded_at: e.recorded_at,
          attributed_to: e.attributed_to || ''
        });
      }

      const totalSettled = runnerCash + counterCash;
      const pettyCash = lastCollection ? (lastCollection.petty_cash || 0) : 0;
      // Total at counter = petty cash + settlements - expenses
      const totalAtCounter = pettyCash + totalSettled - totalExpenses;

      return new Response(JSON.stringify({
        success: true,
        balance: {
          total: totalAtCounter,
          totalSettled,
          pettyCash,
          runnerCash,
          counterCash,
          totalExpenses,
          expenses: expenseList,
          settlementCount: settlementList.length,
          since: sinceTime,
          settlements: settlementList
        },
        lastCollection: lastCollection || null
      }), {headers: corsHeaders});
    }

    if (action === 'collect' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {collected_by, amount, petty_cash, live_counter_cash, notes} = body;

      if (!COLLECTORS.includes(collected_by)) {
        return new Response(JSON.stringify({success: false, error: 'Not authorized to collect cash'}), {headers: corsHeaders});
      }

      // Get last collection for period_start and previous petty cash
      const lastCollection = await DB.prepare(
        'SELECT collected_at, petty_cash FROM cash_collections ORDER BY collected_at DESC LIMIT 1'
      ).first();
      const baseline = '2026-02-04T17:00:00';
      const periodStart = lastCollection ? lastCollection.collected_at : baseline;
      const prevPettyCash = lastCollection ? (lastCollection.petty_cash || 0) : 0;
      const periodEnd = new Date().toISOString();

      // Get all settlements in this period
      const settlements = await DB.prepare(
        'SELECT id, runner_id, cash_settled FROM settlements WHERE settled_at > ? ORDER BY settled_at ASC'
      ).bind(periodStart).all();

      let runnerCash = 0;
      let counterCash = 0;
      const ids = [];
      for (const s of settlements.results) {
        if (s.runner_id === 'counter') counterCash += s.cash_settled;
        else runnerCash += s.cash_settled;
        ids.push(s.id);
      }

      // Get all expenses in this period (from both old and new tables)
      const expensesResult = await DB.prepare(
        `SELECT amount FROM counter_expenses WHERE recorded_at > ?
         UNION ALL
         SELECT amount FROM counter_expenses_v2 WHERE recorded_at > ?
         ORDER BY 1`
      ).bind(periodStart, periodStart).all();
      let totalExpenses = 0;
      for (const e of expensesResult.results) totalExpenses += e.amount;

      // Expected = prev petty + settlements + unsettled live counter cash - expenses
      // live_counter_cash is passed from UI (fetched from Odoo at collection time)
      const liveCounter = live_counter_cash || 0;
      const expected = prevPettyCash + runnerCash + counterCash + liveCounter - totalExpenses;
      // Accounted = what Naveen takes + what he leaves as petty
      const accounted = amount + (petty_cash || 0);
      // Discrepancy = expected - accounted (positive = cash missing)
      const discrepancy = expected - accounted;

      // Duplicate prevention — use ISO timestamp (not SQLite datetime) to match stored format
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const recentDup = await DB.prepare(
        "SELECT id FROM cash_collections WHERE collected_by = ? AND collected_at > ? LIMIT 1"
      ).bind(collected_by, fiveMinAgo).first();
      if (recentDup) {
        return new Response(JSON.stringify({success: false, error: 'You already collected cash recently. Wait a few minutes.'}), {headers: corsHeaders});
      }

      await DB.prepare(
        'INSERT INTO cash_collections (collected_by, collected_at, amount, petty_cash, expenses, expected, discrepancy, period_start, period_end, runner_cash, counter_cash, prev_petty_cash, settlement_ids, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        collected_by, periodEnd, amount, petty_cash || 0, totalExpenses,
        expected, discrepancy, periodStart, periodEnd, runnerCash, counterCash + liveCounter,
        prevPettyCash, ids.join(','), notes || ''
      ).run();

      // Immediate WhatsApp alert if discrepancy > ₹50
      if (WA_TOKEN && Math.abs(discrepancy) > 50) {
        const direction = discrepancy > 0 ? 'short (cash missing)' : 'over (extra cash)';
        const alertMsg = `🔍 *NCH Audit Alert*\n\n🚨 Cash Collection Discrepancy\nExpected at counter: ₹${expected}\n(Settlements: ₹${runnerCash + counterCash} | Counter cash: ₹${liveCounter} | Petty: ₹${prevPettyCash} | Expenses: -₹${totalExpenses})\nCollected: ₹${amount} + Petty left: ₹${petty_cash || 0}\nDiscrepancy: ₹${Math.abs(discrepancy).toFixed(0)} ${direction}\nCollected by: ${collected_by}\nSettlements covered: ${ids.length}`;
        context.waitUntil(Promise.all(ALERT_RECIPIENTS.map(to =>
          sendWhatsAppAlert(WA_PHONE_ID, WA_TOKEN, to, alertMsg)
        )).catch(e => console.error('Collection alert error:', e.message)));
      }

      // Also trigger full audit in background
      if (WA_TOKEN) {
        const auditUrl = new URL(context.request.url);
        auditUrl.pathname = '/api/audit';
        auditUrl.search = `?action=run-audit`;
        context.waitUntil(fetch(auditUrl.toString()).catch(e => console.error('Audit trigger error:', e.message)));
      }

      return new Response(JSON.stringify({
        success: true, message: 'Cash collection recorded',
        collected: amount, petty_cash: petty_cash || 0, expenses: totalExpenses,
        expected, discrepancy, settlements_covered: ids.length
      }), {headers: corsHeaders});
    }

    if (action === 'collection-history') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const limit = url.searchParams.get('limit') || 20;
      const results = await DB.prepare(
        'SELECT * FROM cash_collections ORDER BY collected_at DESC LIMIT ?'
      ).bind(limit).all();

      return new Response(JSON.stringify({success: true, collections: results.results}), {headers: corsHeaders});
    }

    // === DISCREPANCY RECTIFICATION (fix wrong/missing runner in Odoo) ===
    if (action === 'rectify-discrepancy' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {pin, order_id, order_name, correct_partner_id, original_partner_id} = body;

      // 1. Verify PIN
      if (!pin || !PINS[pin]) {
        return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
      }
      const rectifiedBy = PINS[pin];

      // 2. Validate target runner
      if (!correct_partner_id || !RUNNERS[correct_partner_id]) {
        return new Response(JSON.stringify({success: false, error: 'Invalid runner selected'}), {headers: corsHeaders});
      }

      // 3. Duplicate check — don't rectify same order twice
      const existing = await DB.prepare(
        "SELECT id FROM audit_logs WHERE check_type = 'rectification' AND details LIKE ?"
      ).bind(`%"order_id":${order_id}%`).first();
      if (existing) {
        return new Response(JSON.stringify({success: false, error: 'This order was already rectified'}), {headers: corsHeaders});
      }

      // 4. Call Odoo to update partner_id on the POS order
      let odooSuccess = false;
      let odooError = null;
      try {
        const odooPayload = {
          jsonrpc: '2.0', method: 'call',
          params: {
            service: 'object', method: 'execute_kw',
            args: [ODOO_DB, ODOO_UID, context.env.ODOO_API_KEY,
              'pos.order', 'write', [[order_id], {partner_id: correct_partner_id}]]
          }, id: Date.now()
        };
        const odooRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(odooPayload)});
        const odooData = await odooRes.json();
        odooSuccess = !odooData.error;
        if (odooData.error) odooError = JSON.stringify(odooData.error);
      } catch (e) {
        odooError = e.message;
      }

      // 5. Log to audit_logs
      const details = JSON.stringify({
        order_id, order_name,
        original_partner_id: original_partner_id || null,
        correct_partner_id,
        correct_runner_name: RUNNERS[correct_partner_id].name,
        rectified_by: rectifiedBy,
        odoo_success: odooSuccess,
        odoo_error: odooError
      });
      await DB.prepare(
        'INSERT INTO audit_logs (check_type, severity, message, details, alerted_to, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        'rectification',
        odooSuccess ? 'info' : 'warning',
        `${order_name}: partner ${original_partner_id || 'none'}→${correct_partner_id} (${RUNNERS[correct_partner_id].name}) by ${rectifiedBy}`,
        details,
        'nihaf,naveen',
        new Date().toISOString()
      ).run();

      // 6. WhatsApp alert
      if (WA_TOKEN) {
        const statusEmoji = odooSuccess ? '✅' : '⚠️';
        const msg = `🔧 *NCH Rectification*\n\n${statusEmoji} ${order_name}\nPartner: ${original_partner_id || 'none'} → ${correct_partner_id} (${RUNNERS[correct_partner_id].name})\nBy: ${rectifiedBy}\nOdoo: ${odooSuccess ? 'Updated' : 'Failed — ' + (odooError || 'unknown')}`;
        context.waitUntil(Promise.all(ALERT_RECIPIENTS.map(to =>
          sendWhatsAppAlert(WA_PHONE_ID, WA_TOKEN, to, msg)
        )).catch(e => console.error('Rectification alert error:', e.message)));
      }

      return new Response(JSON.stringify({
        success: true,
        rectified: true,
        odoo_success: odooSuccess,
        odoo_error: odooError,
        message: odooSuccess
          ? `${order_name} rectified to ${RUNNERS[correct_partner_id].name}`
          : `Logged rectification but Odoo update failed: ${odooError}. Settlement math is still correct via auto-resolution.`
      }), {headers: corsHeaders});
    }

    // === CASHIER SHIFT SETTLE (End My Shift wizard — atomic shift settlement) ===
    if (action === 'cashier-shift-settle' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {settled_by, period_start, period_end, counter, runner_checkpoints, reconciliation, counter_balance, drawer_cash_entered, upi_verification, handover_to} = body;

      // 1. Validate settled_by
      const validUsers = Object.values(PINS);
      if (!settled_by || !validUsers.includes(settled_by)) {
        return new Response(JSON.stringify({success: false, error: 'Invalid user'}), {headers: corsHeaders});
      }

      // 2. No time-based duplicate prevention — same cashier can settle multiple times
      // for different time windows. Frontend button-disabling prevents accidental double-clicks.
      const settledAt = new Date().toISOString();

      // 3. Insert parent cashier_shifts record (v3: includes drawer formula columns)
      const cb = counter_balance || {};
      const uv = upi_verification || {};
      const shiftResult = await DB.prepare(`
        INSERT INTO cashier_shifts (
          cashier_name, settled_at, period_start, period_end,
          petty_cash_start, counter_cash_settled, unsettled_counter_cash,
          runner_cash_settled, expenses_total, expected_drawer,
          drawer_cash_entered, drawer_variance,
          counter_cash_expected, counter_cash_entered, counter_cash_variance,
          counter_upi, counter_card, counter_token_issue, counter_complimentary,
          counter_qr_odoo, counter_qr_razorpay, counter_qr_variance,
          runner_counter_qr_odoo, runner_counter_qr_razorpay, runner_counter_qr_variance,
          total_cash_physical, total_cash_expected, final_variance,
          variance_resolved, variance_unresolved,
          discrepancy_resolutions, runner_count, notes, handover_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        settled_by, settledAt, period_start, period_end,
        cb.petty_cash_start || 0, cb.counter_cash_settled || 0, cb.unsettled_counter_cash || 0,
        cb.runner_cash_settled || 0, cb.expenses_total || 0, cb.expected_drawer || 0,
        drawer_cash_entered || 0, (drawer_cash_entered || 0) - (cb.expected_drawer || 0),
        counter.cash_expected || 0, counter.cash_entered || 0, (counter.cash_entered || 0) - (counter.cash_expected || 0),
        counter.upi || 0, counter.card || 0, counter.token_issue || 0, counter.complimentary || 0,
        uv.counter_qr?.odoo || counter.upi_discrepancy?.counter_qr?.odoo || 0,
        uv.counter_qr?.razorpay || counter.upi_discrepancy?.counter_qr?.razorpay || 0,
        uv.counter_qr?.variance || counter.upi_discrepancy?.counter_qr?.variance || 0,
        uv.runner_counter_qr?.odoo || counter.upi_discrepancy?.runner_counter_qr?.odoo || 0,
        uv.runner_counter_qr?.razorpay || counter.upi_discrepancy?.runner_counter_qr?.razorpay || 0,
        uv.runner_counter_qr?.variance || counter.upi_discrepancy?.runner_counter_qr?.variance || 0,
        reconciliation.total_physical_cash || 0, reconciliation.expected_cash || 0, reconciliation.raw_variance || 0,
        reconciliation.variance_resolved || 0, reconciliation.variance_unresolved || 0,
        JSON.stringify(reconciliation.discrepancy_resolutions || []),
        (runner_checkpoints || []).length, '', handover_to || ''
      ).run();

      const shiftId = shiftResult.meta?.last_row_id;

      // 4. Insert runner checkpoints + legacy settlement records
      const checkpoints = runner_checkpoints || [];
      for (const rc of checkpoints) {
        // New table: shift_runner_checkpoints
        await DB.prepare(`
          INSERT INTO shift_runner_checkpoints (
            shift_id, runner_id, runner_name,
            tokens_amount, sales_amount, upi_amount, cross_payment_credit,
            unsold_tokens, cash_calculated, cash_collected, cash_variance,
            excess_mapped_to, excess_mapped_amount, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          shiftId, rc.runner_id, rc.runner_name,
          rc.tokens_amount || 0, rc.sales_amount || 0, rc.upi_amount || 0, rc.cross_payment_credit || 0,
          rc.unsold_tokens || 0, rc.cash_calculated || 0, rc.cash_collected || 0, rc.cash_variance || 0,
          rc.excess_mapped_to || '', rc.excess_mapped_amount || 0, rc.status || 'present'
        ).run();

        // Legacy settlements table: for period continuity (get-last-settlement)
        // Guard: skip if runner was already settled mid-shift (e.g. staff blind entry)
        // to prevent duplicate settlement records inflating cash totals
        if (rc.status === 'present') {
          const existingMidShift = await DB.prepare(
            'SELECT id FROM settlements WHERE runner_id = ? AND settled_at > ? AND settled_at < ? LIMIT 1'
          ).bind(String(rc.runner_id), period_start, settledAt).first();

          if (!existingMidShift) {
            const notesParts = [`Shift wizard: calc=${rc.cash_calculated}, collected=${rc.cash_collected}`];
            if (rc.unsold_tokens > 0) notesParts.push(`unsold=${rc.unsold_tokens}`);
            if (rc.cross_payment_credit > 0) notesParts.push(`crossCredit=${rc.cross_payment_credit}`);
            if (rc.cash_variance !== 0) notesParts.push(`variance=${rc.cash_variance}`);

            await DB.prepare(`
              INSERT INTO settlements (
                runner_id, runner_name, settled_at, settled_by,
                period_start, period_end,
                tokens_amount, sales_amount, upi_amount,
                cash_settled, unsold_tokens, notes, handover_to
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              String(rc.runner_id), rc.runner_name,
              settledAt, settled_by,
              period_start, period_end,
              rc.tokens_amount || 0, rc.sales_amount || 0, rc.upi_amount || 0,
              rc.cash_collected || 0, rc.unsold_tokens || 0,
              notesParts.join('; '), handover_to || ''
            ).run();
          }
          // If existingMidShift found, skip — runner was already settled during this shift
        }
      }

      // 5. Legacy counter settlement record
      await DB.prepare(`
        INSERT INTO settlements (
          runner_id, runner_name, settled_at, settled_by,
          period_start, period_end,
          tokens_amount, sales_amount, upi_amount,
          cash_settled, unsold_tokens, notes, handover_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        'counter', 'Cash Counter',
        settledAt, settled_by,
        period_start, period_end,
        0, (counter.cash_expected || 0) + (counter.upi || 0) + (counter.card || 0),
        (counter.upi || 0) + (counter.card || 0),
        counter.cash_expected || 0, 0,
        `Shift wizard v3: counter_cash=${counter.cash_expected || 0}, drawer=${drawer_cash_entered || 0}, expected_drawer=${cb.expected_drawer || 0}, variance=${reconciliation.variance_unresolved || 0}`,
        handover_to || ''
      ).run();

      // 6. WhatsApp alert if significant unresolved variance
      if (WA_TOKEN && Math.abs(reconciliation.variance_unresolved || 0) > 50) {
        const dir = reconciliation.variance_unresolved > 0 ? 'extra' : 'short';
        const runnerSummary = checkpoints
          .filter(r => r.status === 'present')
          .map(r => `${r.runner_name}: ₹${r.cash_collected}${r.cash_variance !== 0 ? ` (${r.cash_variance > 0 ? '+' : ''}${r.cash_variance})` : ''}`)
          .join('\n');
        const absentRunners = checkpoints.filter(r => r.status === 'absent').map(r => r.runner_name).join(', ');

        const msg = `🏁 *NCH Shift Settlement*\n\n⚠️ Unresolved Variance: ₹${Math.abs(reconciliation.variance_unresolved).toFixed(0)} ${dir}\n\nCashier: ${settled_by}${handover_to ? '\nHandover to: ' + handover_to : ''}\nCounter cash: ₹${counter.cash_entered} (expected ₹${counter.cash_expected})\n${runnerSummary ? 'Runners:\n' + runnerSummary : 'No runners'}${absentRunners ? '\nAbsent: ' + absentRunners : ''}\n\nTotal physical: ₹${reconciliation.total_physical_cash}\nExpected: ₹${reconciliation.expected_cash}\nResolved: ₹${reconciliation.variance_resolved || 0}`;
        context.waitUntil(Promise.all(ALERT_RECIPIENTS.map(to =>
          sendWhatsAppAlert(WA_PHONE_ID, WA_TOKEN, to, msg)
        )).catch(e => console.error('Shift alert error:', e.message)));
      }

      return new Response(JSON.stringify({
        success: true, shift_id: shiftId,
        message: 'Shift settled successfully'
      }), {headers: corsHeaders});
    }

    // === SHIFT HISTORY V2 (cashier shift records with nested checkpoints) ===
    if (action === 'shift-history-v2') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const limit = url.searchParams.get('limit') || 20;
      const shifts = await DB.prepare(
        'SELECT * FROM cashier_shifts ORDER BY settled_at DESC LIMIT ?'
      ).bind(limit).all();

      // Load checkpoints for each shift
      const results = [];
      for (const shift of shifts.results) {
        const checkpoints = await DB.prepare(
          'SELECT * FROM shift_runner_checkpoints WHERE shift_id = ? ORDER BY runner_id'
        ).bind(shift.id).all();
        results.push({...shift, checkpoints: checkpoints.results});
      }

      return new Response(JSON.stringify({success: true, shifts: results}), {headers: corsHeaders});
    }

    // === RAZORPAYX BALANCE (real-time business account balance) ===
    if (action === 'razorpayx-balance') {
      const RAZORPAY_KEY = context.env.RAZORPAY_KEY;
      const RAZORPAY_SECRET = context.env.RAZORPAY_SECRET;
      if (!RAZORPAY_KEY || !RAZORPAY_SECRET) {
        return new Response(JSON.stringify({success: false, error: 'Razorpay credentials not configured'}), {headers: corsHeaders});
      }

      try {
        const auth = btoa(RAZORPAY_KEY + ':' + RAZORPAY_SECRET);
        const balRes = await fetch('https://api.razorpay.com/v1/balance', {
          headers: {'Authorization': 'Basic ' + auth}
        });
        const balData = await balRes.json();
        // Balance is in paisa, convert to rupees
        const balanceRupees = (balData.balance || 0) / 100;
        return new Response(JSON.stringify({
          success: true,
          balance: balanceRupees,
          currency: balData.currency || 'INR'
        }), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({success: false, error: 'Failed to fetch balance: ' + e.message}), {headers: corsHeaders});
      }
    }

    // === RUNNER LIVE DASHBOARD — PIN verification (maps PIN to specific runner) ===
    if (action === 'runner-verify-pin') {
      const pin = url.searchParams.get('pin');
      if (RUNNER_PINS[pin]) {
        const r = RUNNER_PINS[pin];
        return new Response(JSON.stringify({success: true, runner_id: r.runner_id, name: r.name, barcode: r.barcode}), {headers: corsHeaders});
      }
      return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
    }

    // === RUNNER LIVE DASHBOARD — live sales + UPI data for a single runner ===
    if (action === 'runner-live') {
      const runnerId = parseInt(url.searchParams.get('runner_id'));
      const runner = RUNNERS[runnerId];
      if (!runner) return new Response(JSON.stringify({success: false, error: 'Invalid runner'}), {headers: corsHeaders});

      const ODOO_API_KEY = context.env.ODOO_API_KEY;
      const RAZORPAY_KEY = context.env.RAZORPAY_KEY;
      const RAZORPAY_SECRET = context.env.RAZORPAY_SECRET;

      // 1. Get period start from last settlement
      const baseline = '2026-02-04T17:00:00Z';
      let periodStart = baseline;
      let lastSettlement = null;
      if (DB) {
        const result = await DB.prepare(
          'SELECT * FROM settlements WHERE runner_id = ? ORDER BY settled_at DESC LIMIT 1'
        ).bind(String(runnerId)).first();
        if (result) {
          periodStart = result.settled_at;
          lastSettlement = result;
        }
      }

      // 2. Convert period start to formats needed by Odoo (UTC) and Razorpay (Unix)
      const periodDate = new Date(periodStart);
      const fromOdoo = periodStart.replace('T', ' ').slice(0, 19);
      const fromUnix = Math.floor(periodDate.getTime() / 1000);
      const toUnix = Math.floor(Date.now() / 1000);

      // Build partner ID list including aliases
      const partnerIds = [runnerId];
      for (const [alias, target] of Object.entries(PARTNER_ALIASES)) {
        if (target === runnerId) partnerIds.push(parseInt(alias));
      }

      // 3. Fetch Odoo orders + Razorpay QR payments in parallel
      const qrId = RUNNER_QR_MAP[runner.barcode];
      const auth = RAZORPAY_KEY && RAZORPAY_SECRET ? btoa(RAZORPAY_KEY + ':' + RAZORPAY_SECRET) : null;

      const [ordersData, razorpayPayments] = await Promise.all([
        // Odoo: fetch orders for this runner since period start
        (async () => {
          if (!ODOO_API_KEY) return [];
          try {
            const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw',
              args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.order', 'search_read',
                [[['config_id', 'in', [27, 28]], ['date_order', '>=', fromOdoo],
                  ['state', 'in', ['paid', 'done', 'invoiced', 'posted']],
                  ['partner_id', 'in', partnerIds]]],
                {fields: ['id', 'name', 'date_order', 'amount_total', 'config_id', 'payment_ids', 'lines'], order: 'date_order desc'}]}, id: Date.now()};
            const res = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
            const data = await res.json();
            return data.result || [];
          } catch (e) { console.error('Runner-live Odoo orders error:', e.message); return []; }
        })(),
        // Razorpay: fetch this runner's QR payments
        (async () => {
          if (!auth || !qrId) return [];
          try {
            return await fetchRunnerQrPayments(auth, qrId, runner.barcode, fromUnix, toUnix);
          } catch (e) { console.error('Runner-live Razorpay error:', e.message); return []; }
        })()
      ]);

      // 4. Fetch payment methods for runner counter orders (POS 28) to detect cross-payments
      let crossPaymentCredit = 0;
      const pos28Orders = ordersData.filter(o => o.config_id && o.config_id[0] === 28);
      if (pos28Orders.length > 0 && ODOO_API_KEY) {
        try {
          const paymentIds = pos28Orders.flatMap(o => o.payment_ids || []);
          if (paymentIds.length > 0) {
            const pmPayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw',
              args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.payment', 'search_read',
                [[['id', 'in', paymentIds]]],
                {fields: ['id', 'amount', 'payment_method_id']}]}, id: Date.now()};
            const pmRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(pmPayload)});
            const pmData = await pmRes.json();
            const payments = pmData.result || [];
            // PM 38 = UPI — these are cross-payments (paid at counter, not by runner)
            crossPaymentCredit = payments.filter(p => p.payment_method_id && p.payment_method_id[0] === 38).reduce((sum, p) => sum + p.amount, 0);
          }
        } catch (e) { console.error('Runner-live cross-payment error:', e.message); }
      }

      // 5. Fetch token order line items for product breakdown (Chai/Coffee/Haleem)
      let tokenBreakdown = [];
      const pos27Orders = ordersData.filter(o => o.config_id && o.config_id[0] === 27);
      if (pos27Orders.length > 0 && ODOO_API_KEY) {
        try {
          const tokenOrderIds = pos27Orders.map(o => o.id);
          const linePayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw',
            args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.order.line', 'search_read',
              [[['order_id', 'in', tokenOrderIds]]],
              {fields: ['order_id', 'product_id', 'qty', 'price_subtotal_incl']}]}, id: Date.now()};
          const lineRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(linePayload)});
          const lineData = await lineRes.json();
          const lines = lineData.result || [];

          // Group by product_id
          const productAgg = {};
          for (const line of lines) {
            const pid = line.product_id[0];
            const pname = TOKEN_PRODUCT_NAMES[pid] || line.product_id[1] || `Product ${pid}`;
            if (!productAgg[pid]) productAgg[pid] = {product_id: pid, name: pname, qty: 0, amount: 0};
            productAgg[pid].qty += Math.round(line.qty);
            productAgg[pid].amount += line.price_subtotal_incl;
          }
          tokenBreakdown = Object.values(productAgg).filter(p => p.qty > 0).sort((a, b) => b.amount - a.amount);
        } catch (e) { console.error('Runner-live token lines error:', e.message); }
      }

      // 6. Build direct sales detail with product breakdown per order (POS 28)
      // pos28Orders already declared in step 4
      let salesDetails = [];
      if (pos28Orders.length > 0 && ODOO_API_KEY) {
        try {
          const salesOrderIds = pos28Orders.map(o => o.id);
          const slPayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw',
            args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.order.line', 'search_read',
              [[['order_id', 'in', salesOrderIds]]],
              {fields: ['order_id', 'product_id', 'qty', 'price_subtotal_incl']}]}, id: Date.now()};
          const slRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(slPayload)});
          const slData = await slRes.json();
          const salesLines = slData.result || [];

          // Group lines by order_id
          const linesByOrder = {};
          for (const line of salesLines) {
            const oid = line.order_id[0];
            if (!linesByOrder[oid]) linesByOrder[oid] = [];
            linesByOrder[oid].push({name: line.product_id[1] || 'Item', qty: Math.round(line.qty), amount: line.price_subtotal_incl});
          }

          salesDetails = pos28Orders.map(o => ({
            id: o.id,
            name: o.name,
            amount: o.amount_total,
            time: o.date_order,
            items: linesByOrder[o.id] || []
          })).sort((a, b) => new Date(b.time) - new Date(a.time));
        } catch (e) { console.error('Runner-live sales lines error:', e.message); }
      }

      // 7. Calculate totals (reuse pos27Orders from step 5)
      const tokens = pos27Orders.reduce((sum, o) => sum + o.amount_total, 0);
      const sales = pos28Orders.reduce((sum, o) => sum + o.amount_total, 0);
      const upiTotal = razorpayPayments.reduce((sum, p) => sum + (p.amount / 100), 0); // paisa → rupees
      const cashInHand = tokens + sales - upiTotal - crossPaymentCredit;

      // 7. Format UPI payments for display
      const upiPayments = razorpayPayments.map(p => ({
        id: p.id,
        amount: p.amount / 100,
        time: new Date(p.created_at * 1000).toISOString(),
        vpa: p.vpa || p.email || '',
        method: p.method || 'upi'
      })).sort((a, b) => new Date(b.time) - new Date(a.time));

      // 8. Format period start as IST for display
      const periodIST = new Date(periodDate.getTime() + 5.5 * 60 * 60 * 1000);
      const periodFormatted = periodIST.toLocaleString('en-IN', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC'});

      // 9. Fetch pending validation errors for this runner from D1
      let pendingErrors = [];
      try {
        const slot = RUNNER_SLOT_MAP[runnerId];
        if (slot && DB) {
          const errResults = await DB.prepare(
            `SELECT id, order_id, order_ref, error_code, description, payment_method_name,
             order_amount, detected_at, odoo_payment_id, runner_slot, runner_partner_id,
             pos_config_name, product_names, cashier_name, order_time
             FROM validation_errors WHERE runner_slot = ? AND status = 'pending'
             ORDER BY detected_at DESC`
          ).bind(slot).all();
          pendingErrors = errResults.results || [];
        }
      } catch (e) {
        // validation_errors table may not exist yet — return empty
      }

      return new Response(JSON.stringify({
        success: true,
        runner: {id: runnerId, name: runner.name, barcode: runner.barcode},
        period: {start: periodStart, startFormatted: periodFormatted, now: new Date().toISOString()},
        tokens, sales, crossPaymentCredit, tokenBreakdown, salesDetails,
        tokenOrders: pos27Orders.length,
        salesOrders: pos28Orders.length,
        upi: {total: upiTotal, count: upiPayments.length, payments: upiPayments},
        cashInHand,
        lastSettlement,
        // Aliases for cashier UI compatibility
        tokens_amount: tokens,
        sales_amount: sales,
        upi_amount: upiTotal,
        cash_to_collect: cashInHand,
        period_start: periodStart,
        pending_errors: pendingErrors
      }), {headers: corsHeaders});
    }

    // === RUNNER INTELLIGENCE — owner-only performance overview ===
    if (action === 'runner-performance') {
      const pin = url.searchParams.get('pin');
      // Allow admins, managers, accountant, cashiers
      const INTEL_PINS = ['0305','3697','8523','6890','3754','2026','7115','8241'];
      if (!INTEL_PINS.includes(pin)) {
        return new Response(JSON.stringify({success: false, error: 'Not authorized'}), {headers: corsHeaders});
      }

      const fromIST = url.searchParams.get('from');
      const toIST = url.searchParams.get('to');
      if (!fromIST || !toIST) {
        return new Response(JSON.stringify({success: false, error: 'from and to required'}), {headers: corsHeaders});
      }

      const ODOO_API_KEY = context.env.ODOO_API_KEY;
      const RAZORPAY_KEY = context.env.RAZORPAY_KEY;
      const RAZORPAY_SECRET = context.env.RAZORPAY_SECRET;
      const auth = RAZORPAY_KEY && RAZORPAY_SECRET ? btoa(RAZORPAY_KEY + ':' + RAZORPAY_SECRET) : null;

      // IST→UTC for Odoo: subtract 5.5 hours
      const fromDate = new Date(fromIST);
      const toDate = new Date(toIST);
      const fromUTC = new Date(fromDate.getTime() - 5.5 * 60 * 60 * 1000);
      const toUTC = new Date(toDate.getTime() - 5.5 * 60 * 60 * 1000);
      const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');
      const toOdoo = toUTC.toISOString().slice(0, 19).replace('T', ' ');
      const fromUnix = Math.floor(fromUTC.getTime() / 1000);
      const toUnix = Math.floor(toUTC.getTime() / 1000);

      // All runner partner IDs (including aliases)
      const runnerPartnerIds = [64, 65, 66, 67, 68, 90, 37];

      // 1. Fetch Odoo orders + Razorpay QR payments + D1 data in parallel
      const [ordersData, ...qrResults] = await Promise.all([
        // Odoo POS orders for all runners
        (async () => {
          if (!ODOO_API_KEY) return [];
          try {
            const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw',
              args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.order', 'search_read',
                [[['config_id', 'in', [27, 28]], ['date_order', '>=', fromOdoo], ['date_order', '<=', toOdoo],
                  ['state', 'in', ['paid', 'done', 'invoiced', 'posted']],
                  ['partner_id', 'in', runnerPartnerIds]]],
                {fields: ['id', 'name', 'date_order', 'amount_total', 'config_id', 'partner_id', 'payment_ids'], order: 'date_order asc'}]}, id: Date.now()};
            const res = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
            const data = await res.json();
            return data.result || [];
          } catch (e) { console.error('Runner-perf orders error:', e.message); return []; }
        })(),
        // Razorpay QR payments per runner
        ...Object.entries(RUNNER_QR_MAP).map(([barcode, qrId]) =>
          auth ? fetchRunnerQrPayments(auth, qrId, barcode, fromUnix, toUnix).catch(() => []) : Promise.resolve([])
        )
      ]);

      // 2. Fetch order lines for product breakdown
      const orderIds = ordersData.map(o => o.id);
      let orderLines = [];
      if (orderIds.length > 0 && ODOO_API_KEY) {
        try {
          const linePayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw',
            args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.order.line', 'search_read',
              [[['order_id', 'in', orderIds]]],
              {fields: ['order_id', 'product_id', 'qty', 'price_subtotal_incl']}]}, id: Date.now()};
          const lineRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(linePayload)});
          const lineData = await lineRes.json();
          orderLines = lineData.result || [];
        } catch (e) { console.error('Runner-perf lines error:', e.message); }
      }

      // 3. Fetch cross-payments (PM 38) for POS 28 orders
      const pos28Orders = ordersData.filter(o => o.config_id && o.config_id[0] === 28);
      const crossPaymentsByOrder = {};
      if (pos28Orders.length > 0 && ODOO_API_KEY) {
        try {
          const paymentIds = pos28Orders.flatMap(o => o.payment_ids || []);
          if (paymentIds.length > 0) {
            const pmPayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw',
              args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.payment', 'search_read',
                [[['id', 'in', paymentIds]]],
                {fields: ['id', 'amount', 'payment_method_id', 'pos_order_id']}]}, id: Date.now()};
            const pmRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(pmPayload)});
            const pmData = await pmRes.json();
            for (const p of (pmData.result || [])) {
              if (p.payment_method_id && p.payment_method_id[0] === 38) {
                const oid = p.pos_order_id ? p.pos_order_id[0] : 0;
                crossPaymentsByOrder[oid] = (crossPaymentsByOrder[oid] || 0) + p.amount;
              }
            }
          }
        } catch (e) { console.error('Runner-perf cross-payments error:', e.message); }
      }

      // 4. D1: settlements + shift_runner_checkpoints
      let d1Settlements = [], d1Checkpoints = [];
      if (DB) {
        try {
          const [stlRes, chkRes] = await Promise.all([
            DB.prepare('SELECT * FROM settlements WHERE runner_id IN (?,?,?,?,?) AND settled_at >= ? AND settled_at <= ?')
              .bind('64', '65', '66', '67', '68', fromIST, toIST).all(),
            DB.prepare(`SELECT src.* FROM shift_runner_checkpoints src JOIN cashier_shifts cs ON src.shift_id = cs.id WHERE cs.settled_at >= ? AND cs.settled_at <= ?`)
              .bind(fromIST, toIST).all()
          ]);
          d1Settlements = stlRes.results || [];
          d1Checkpoints = chkRes.results || [];
        } catch (e) { console.error('Runner-perf D1 error:', e.message); }
      }

      // 5. Build QR payments map by barcode
      const barcodes = Object.keys(RUNNER_QR_MAP);
      const qrPaymentsByBarcode = {};
      barcodes.forEach((barcode, i) => {
        qrPaymentsByBarcode[barcode] = qrResults[i] || [];
      });

      // 6. Aggregate per runner
      const runnerIds = [64, 65, 66, 67, 68];
      const runnerData = runnerIds.map(rid => {
        const runner = RUNNERS[rid];
        // Resolve aliases → canonical runner ID
        const myPartnerIds = [rid];
        for (const [alias, target] of Object.entries(PARTNER_ALIASES)) {
          if (target === rid) myPartnerIds.push(parseInt(alias));
        }

        // Orders for this runner
        const myOrders = ordersData.filter(o => o.partner_id && myPartnerIds.includes(o.partner_id[0]));
        const myPos27 = myOrders.filter(o => o.config_id && o.config_id[0] === 27);
        const myPos28 = myOrders.filter(o => o.config_id && o.config_id[0] === 28);

        const tokens = myPos27.reduce((s, o) => s + o.amount_total, 0);
        const sales = myPos28.reduce((s, o) => s + o.amount_total, 0);
        const revenue = tokens + sales;

        // Cross-payment credit for this runner's POS 28 orders
        const crossCredit = myPos28.reduce((s, o) => s + (crossPaymentsByOrder[o.id] || 0), 0);

        // UPI from Razorpay QR
        const myQrPayments = qrPaymentsByBarcode[runner.barcode] || [];
        const upi = myQrPayments.reduce((s, p) => s + (p.amount / 100), 0);
        const upiPercent = revenue > 0 ? Math.round((upi / revenue) * 100) : 0;

        const cashInHand = revenue - upi - crossCredit;

        // Products
        const myOrderIds = new Set(myOrders.map(o => o.id));
        const productAgg = {};
        for (const line of orderLines) {
          if (!myOrderIds.has(line.order_id[0])) continue;
          const pid = line.product_id[0];
          const pname = (TOKEN_PRODUCT_NAMES[pid] || line.product_id[1] || 'Product ' + pid).replace(/^\[.*?\]\s*/, '');
          if (!productAgg[pid]) productAgg[pid] = {name: pname, qty: 0, amount: 0};
          productAgg[pid].qty += Math.round(line.qty);
          productAgg[pid].amount += line.price_subtotal_incl;
        }
        const products = Object.values(productAgg).filter(p => p.qty > 0).sort((a, b) => b.amount - a.amount);

        // Activity window
        let firstOrder = null, lastOrder = null, activeHours = 0;
        if (myOrders.length > 0) {
          const dates = myOrders.map(o => new Date(o.date_order.replace(' ', 'T') + 'Z'));
          const minDate = new Date(Math.min(...dates));
          const maxDate = new Date(Math.max(...dates));
          // Convert to IST for display
          const toISTTime = d => {
            const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
            const h = ist.getUTCHours();
            const m = ist.getUTCMinutes().toString().padStart(2, '0');
            const ampm = h >= 12 ? 'PM' : 'AM';
            return ((h % 12) || 12) + ':' + m + ' ' + ampm;
          };
          firstOrder = toISTTime(minDate);
          lastOrder = toISTTime(maxDate);
          activeHours = Math.round(((maxDate - minDate) / (1000 * 60 * 60)) * 10) / 10;
        }

        // Settlement data from D1
        const mySettlements = d1Settlements.filter(s => String(s.runner_id) === String(rid));
        const myCheckpoints = d1Checkpoints.filter(c => c.runner_id === rid);
        const settlementCount = mySettlements.length + myCheckpoints.length;
        const totalVariance = myCheckpoints.reduce((s, c) => s + (c.cash_variance || 0), 0) +
          mySettlements.reduce((s, st) => {
            // Legacy settlements don't have explicit variance, skip
            return s;
          }, 0);
        const avgVariance = settlementCount > 0 ? Math.round(totalVariance / settlementCount) : 0;

        // Recent settlements for detail view
        const recentSettlements = mySettlements.slice(0, 5).map(s => ({
          settled_at: s.settled_at,
          cash_settled: s.cash_settled,
          tokens_amount: s.tokens_amount || 0,
          sales_amount: s.sales_amount || 0,
          upi_amount: s.upi_amount || 0,
          settled_by: s.settled_by,
          variance: 0
        }));
        // Add checkpoint-based settlements
        for (const c of myCheckpoints.slice(0, 5)) {
          recentSettlements.push({
            settled_at: c.created_at || '',
            cash_settled: c.cash_collected || 0,
            tokens_amount: c.tokens_amount || 0,
            sales_amount: c.sales_amount || 0,
            upi_amount: c.upi_amount || 0,
            settled_by: 'Shift Wizard',
            variance: c.cash_variance || 0
          });
        }
        recentSettlements.sort((a, b) => (b.settled_at || '').localeCompare(a.settled_at || ''));

        return {
          id: rid, name: runner.name, barcode: runner.barcode,
          tokens: Math.round(tokens), sales: Math.round(sales), revenue: Math.round(revenue),
          tokenOrders: myPos27.length, salesOrders: myPos28.length, totalOrders: myOrders.length,
          avgOrderValue: myOrders.length > 0 ? Math.round(revenue / myOrders.length) : 0,
          upi: Math.round(upi), upiPercent, crossPaymentCredit: Math.round(crossCredit),
          cashInHand: Math.round(cashInHand),
          firstOrder, lastOrder, activeHours,
          products: products.slice(0, 10),
          settlementCount, totalVariance: Math.round(totalVariance), avgVariance,
          recentSettlements: recentSettlements.slice(0, 5)
        };
      });

      // Sort by revenue desc and assign rank
      runnerData.sort((a, b) => b.revenue - a.revenue);
      runnerData.forEach((r, i) => r.rank = i + 1);

      // Filter out runners with zero activity
      const activeRunners = runnerData.filter(r => r.totalOrders > 0);

      // Summary
      const totalRevenue = runnerData.reduce((s, r) => s + r.revenue, 0);
      const totalOrders = runnerData.reduce((s, r) => s + r.totalOrders, 0);
      const totalUpi = runnerData.reduce((s, r) => s + r.upi, 0);
      const netVariance = runnerData.reduce((s, r) => s + r.totalVariance, 0);

      return new Response(JSON.stringify({
        success: true,
        summary: {
          totalRevenue, totalOrders,
          avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
          totalUpi,
          overallUpiPercent: totalRevenue > 0 ? Math.round((totalUpi / totalRevenue) * 100) : 0,
          netVariance,
          activeRunners: activeRunners.length
        },
        runners: runnerData
      }), {headers: corsHeaders});
    }

    // === BOOTSTRAP DRAWER — one-time opening balance at system go-live ===
    if (action === 'bootstrap-drawer' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'DB not configured'}), {headers: corsHeaders});
      const body = await context.request.json();
      const {code, amount, notes, set_by} = body;
      if (!code || amount == null) return new Response(JSON.stringify({success: false, error: 'code and amount required'}), {headers: corsHeaders});
      const now = new Date().toISOString();
      const autoNotes = notes || `Bootstrap: ${code} on shift — set by ${set_by || 'manager'} at go-live`;
      await DB.prepare(`
        INSERT INTO cashier_shifts (
          cashier_name, settled_at, period_start, period_end,
          petty_cash_start, runner_cash_settled, expenses_total,
          expected_drawer, drawer_cash_entered, drawer_variance,
          counter_cash_settled, unsettled_counter_cash,
          counter_cash_expected, counter_cash_entered, counter_cash_variance,
          counter_upi, counter_card, counter_token_issue, counter_complimentary,
          counter_qr_odoo, counter_qr_razorpay, counter_qr_variance,
          runner_counter_qr_odoo, runner_counter_qr_razorpay, runner_counter_qr_variance,
          total_cash_physical, total_cash_expected, final_variance,
          variance_resolved, variance_unresolved,
          discrepancy_resolutions, runner_count, notes, handover_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        code, now, now, now,
        amount, 0, 0,
        amount, amount, 0,
        0, 0,
        0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0,
        0, 0, 0,
        amount, amount, 0,
        0, 0,
        '[]', 0,
        autoNotes,
        ''
      ).run();
      return new Response(JSON.stringify({success: true, bootstrap_amount: amount, cashier: code, set_by: set_by || null, recorded_at: now}), {headers: corsHeaders});
    }

    // === SHIFT PREVIEW — compute expected drawer before handover ===
    if (action === 'shift-preview') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'DB not configured'}), {headers: corsHeaders});
      const ODOO_API_KEY = context.env.ODOO_API_KEY;

      // Period start = settled_at of last cashier_shifts row (or 48h ago as floor)
      const lastShift = await DB.prepare(
        'SELECT settled_at, drawer_cash_entered FROM cashier_shifts ORDER BY settled_at DESC LIMIT 1'
      ).first();
      const floorIST = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const periodStart = lastShift?.settled_at || floorIST;
      const pettyFloatStart = lastShift?.drawer_cash_entered || 0;

      // IST→UTC for Odoo
      const fromDate = new Date(periodStart);
      const fromUTC = new Date(fromDate.getTime() - 5.5 * 3600 * 1000);
      const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');

      // 1. Runner cash settled to counter since period_start (D1)
      const runnerCashRow = await DB.prepare(
        "SELECT COALESCE(SUM(cash_settled),0) as total FROM settlements WHERE runner_id != 'counter' AND settled_at > ?"
      ).bind(periodStart).first();
      const runnerCashReceived = Math.round(runnerCashRow?.total || 0);

      // 2. PM37 walk-in cash from POS 27 since period_start (Odoo)
      let pm37WalkIn = 0;
      if (ODOO_API_KEY) {
        try {
          const ordersPayload = {jsonrpc:'2.0', method:'call', params:{service:'object', method:'execute_kw',
            args:[ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.order', 'search_read',
              [[['config_id','=',27],['date_order','>=',fromOdoo],['state','in',['paid','done','invoiced','posted']]]],
              {fields:['id','payment_ids']}]}, id: Date.now()};
          const ordersRes = await fetch(ODOO_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(ordersPayload)});
          const ordersData = await ordersRes.json();
          const orders = ordersData.result || [];
          const paymentIds = orders.flatMap(o => o.payment_ids || []);
          if (paymentIds.length > 0) {
            const pmPayload = {jsonrpc:'2.0', method:'call', params:{service:'object', method:'execute_kw',
              args:[ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.payment', 'search_read',
                [[['id','in',paymentIds],['payment_method_id','=',37]]],
                {fields:['amount']}]}, id: Date.now()};
            const pmRes = await fetch(ODOO_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(pmPayload)});
            const pmData = await pmRes.json();
            pm37WalkIn = Math.round((pmData.result || []).reduce((s, p) => s + (p.amount || 0), 0));
          }
        } catch (e) { console.error('shift-preview pm37 error:', e.message); }
      }

      // 3. Expenses (counter + petty) since period_start
      // counter_expenses_v2 uses 'recorded_at', petty_cash uses 'recorded_at'
      const counterExpRow = await DB.prepare(
        'SELECT COALESCE(SUM(amount),0) as total FROM counter_expenses_v2 WHERE recorded_at > ?'
      ).bind(periodStart).first();
      const pettyExpRow = await DB.prepare(
        "SELECT COALESCE(SUM(amount),0) as total FROM petty_cash WHERE transaction_type='expense' AND recorded_at > ?"
      ).bind(periodStart).first();
      const expensesTotal = Math.round((counterExpRow?.total || 0) + (pettyExpRow?.total || 0));

      // 4. Cash already collected (taken out of drawer) since period_start
      const collectRow = await DB.prepare(
        "SELECT COALESCE(SUM(amount),0) as total FROM cash_collections WHERE collected_at > ?"
      ).bind(periodStart).first();
      const cashCollections = Math.round(collectRow?.total || 0);

      // Expected = float_start + runner_cash + walk_in_cash - expenses - collections
      const expectedDrawer = pettyFloatStart + runnerCashReceived + pm37WalkIn - expensesTotal - cashCollections;

      return new Response(JSON.stringify({
        success: true,
        period_start: periodStart,
        petty_float_start: pettyFloatStart,
        runner_cash_received: runnerCashReceived,
        pm37_walk_in: pm37WalkIn,
        expenses_total: expensesTotal,
        cash_collections: cashCollections,
        expected_drawer: Math.round(expectedDrawer)
      }), {headers: corsHeaders});
    }

    // === RECORD SHIFT HANDOVER — simple insert into cashier_shifts ===
    if (action === 'record-shift-handover' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'DB not configured'}), {headers: corsHeaders});
      const WA_TOKEN = context.env.WA_ACCESS_TOKEN;
      const WA_PHONE_ID_VAL = context.env.WA_PHONE_ID || '987158291152067';

      const body = await context.request.json();
      const {
        cashier_code, cashier_person,
        period_start, period_end,
        petty_float_start, runner_cash_received, pm37_walk_in,
        expenses_total, cash_collections, expected_drawer,
        drawer_cash_entered, drawer_variance,
        handover_to, notes
      } = body;

      if (!cashier_code || !drawer_cash_entered && drawer_cash_entered !== 0) {
        return new Response(JSON.stringify({success: false, error: 'cashier_code and drawer_cash_entered required'}), {headers: corsHeaders});
      }

      const settledAt = new Date().toISOString();

      await DB.prepare(`
        INSERT INTO cashier_shifts (
          cashier_name, settled_at, period_start, period_end,
          petty_cash_start, runner_cash_settled, expenses_total,
          expected_drawer, drawer_cash_entered, drawer_variance,
          counter_cash_settled, unsettled_counter_cash,
          counter_cash_expected, counter_cash_entered, counter_cash_variance,
          counter_upi, counter_card, counter_token_issue, counter_complimentary,
          counter_qr_odoo, counter_qr_razorpay, counter_qr_variance,
          runner_counter_qr_odoo, runner_counter_qr_razorpay, runner_counter_qr_variance,
          total_cash_physical, total_cash_expected, final_variance,
          variance_resolved, variance_unresolved,
          discrepancy_resolutions, runner_count, notes, handover_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        cashier_person || cashier_code, settledAt,
        period_start || settledAt, period_end || settledAt,
        petty_float_start || 0, runner_cash_received || 0, expenses_total || 0,
        expected_drawer || 0, drawer_cash_entered || 0, drawer_variance || 0,
        0, 0, // counter_cash_settled, unsettled_counter_cash
        pm37_walk_in || 0, drawer_cash_entered || 0, drawer_variance || 0,
        0, 0, 0, 0, // counter_upi, card, token_issue, complimentary
        0, 0, 0,   // counter_qr_odoo/razorpay/variance
        0, 0, 0,   // runner_counter_qr_odoo/razorpay/variance
        drawer_cash_entered || 0, expected_drawer || 0, drawer_variance || 0,
        0, Math.abs(drawer_variance || 0),
        '[]', 0,
        notes || '', handover_to || ''
      ).run();

      // WABA alert if variance > ₹50
      const absVariance = Math.abs(drawer_variance || 0);
      if (absVariance > 50 && WA_TOKEN) {
        const sign = (drawer_variance || 0) < 0 ? 'SHORT' : 'OVER';
        const msg = `🔄 *NCH Shift Handover*\n${cashier_person || cashier_code} → ${handover_to || 'next shift'}\n\nExpected drawer: ₹${expected_drawer || 0}\nActual count: ₹${drawer_cash_entered}\nVariance: ${sign} ₹${absVariance}\n\nNeeds attention.`;
        await sendWhatsAppAlert(WA_PHONE_ID_VAL, WA_TOKEN, '917010426808', msg).catch(() => {});
      }

      return new Response(JSON.stringify({success: true, settled_at: settledAt}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), {status: 500, headers: corsHeaders});
  }
}

// ─── RAZORPAY QR PAYMENT FETCH (for runner live dashboard) ──
async function fetchRunnerQrPayments(auth, qrId, label, since, until) {
  const allItems = [];
  let skip = 0;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const response = await fetch(
        `https://api.razorpay.com/v1/payments/qr_codes/${qrId}/payments?count=${PAGE_SIZE}&skip=${skip}&from=${since}&to=${until}`,
        {headers: {'Authorization': 'Basic ' + auth}}
      );
      const data = await response.json();
      if (data.error || !data.items || data.items.length === 0) break;
      const captured = data.items.filter(p => p.status === 'captured').map(p => ({...p, qr_label: label}));
      allItems.push(...captured);
      if (data.items.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    } catch (e) { break; }
  }
  return allItems;
}

// ─── WHATSAPP ALERT HELPER ──────────────────────────────────
async function sendWhatsAppAlert(phoneId, token, to, message) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({messaging_product: 'whatsapp', to, type: 'text', text: {body: message}})
    });
  } catch (e) {
    console.error('WA alert error:', e.message);
  }
}
