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
  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen', '8241': 'Nafees'};
  // Users who can collect cash from counter (owner/manager level)
  const COLLECTORS = ['Naveen', 'Nihaf'];
  const RUNNERS = {
    'counter': {id: 'counter', name: 'Cash Counter', barcode: 'POS-27'},
    64: {id: 64, name: 'FAROOQ', barcode: 'RUN001'},
    65: {id: 65, name: 'AMIN', barcode: 'RUN002'},
    66: {id: 66, name: 'NCH Runner 03', barcode: 'RUN003'},
    67: {id: 67, name: 'NCH Runner 04', barcode: 'RUN004'},
    68: {id: 68, name: 'NCH Runner 05', barcode: 'RUN005'}
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
      const {runner_id, runner_name, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, unsold_tokens, notes} = body;

      const runner = RUNNERS[runner_id];
      if (!runner) return new Response(JSON.stringify({success: false, error: 'Invalid runner'}), {headers: corsHeaders});

      // Duplicate prevention: same person + same runner within 5 minutes
      const recentDup = await DB.prepare(
        `SELECT id, settled_at, settled_by FROM settlements WHERE runner_id = ? AND settled_by = ? AND settled_at > datetime('now', '-5 minutes') ORDER BY settled_at DESC LIMIT 1`
      ).bind(String(runner_id), settled_by).first();

      if (recentDup) {
        const timeStr = recentDup.settled_at.slice(11, 16);
        return new Response(JSON.stringify({
          success: false,
          error: 'You already settled this ' + (runner_id === 'counter' ? 'counter' : 'runner') + ' at ' + timeStr + '. Wait a few minutes if you need to re-settle.'
        }), {headers: corsHeaders});
      }

      const settledAt = new Date().toISOString();
      await DB.prepare(`
        INSERT INTO settlements (runner_id, runner_name, settled_at, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, unsold_tokens, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(runner_id), runner_name || runner.name, settledAt, settled_by,
        period_start, period_end, tokens_amount || 0, sales_amount || 0, upi_amount || 0, cash_settled, unsold_tokens || 0, notes || ''
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

      // Get all expenses since last collection
      const expensesResult = await DB.prepare(
        'SELECT * FROM counter_expenses WHERE recorded_at > ? ORDER BY recorded_at ASC'
      ).bind(sinceTime).all();

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

      // Get all expenses in this period (already recorded by cashiers)
      const expensesResult = await DB.prepare(
        'SELECT amount FROM counter_expenses WHERE recorded_at > ? ORDER BY recorded_at ASC'
      ).bind(periodStart).all();
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

      // Duplicate prevention
      const recentDup = await DB.prepare(
        "SELECT id FROM cash_collections WHERE collected_by = ? AND collected_at > datetime('now', '-5 minutes') LIMIT 1"
      ).bind(collected_by).first();
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
      const {settled_by, period_start, period_end, counter, runner_checkpoints, reconciliation, counter_balance, drawer_cash_entered, upi_verification} = body;

      // 1. Validate settled_by
      const validUsers = Object.values(PINS);
      if (!settled_by || !validUsers.includes(settled_by)) {
        return new Response(JSON.stringify({success: false, error: 'Invalid user'}), {headers: corsHeaders});
      }

      // 2. Duplicate prevention: same cashier within 5 minutes
      const recentShift = await DB.prepare(
        "SELECT id, settled_at FROM cashier_shifts WHERE cashier_name = ? AND settled_at > datetime('now', '-5 minutes') ORDER BY settled_at DESC LIMIT 1"
      ).bind(settled_by).first();
      if (recentShift) {
        return new Response(JSON.stringify({success: false, error: 'You already ended your shift recently. Wait a few minutes if you need to re-submit.'}), {headers: corsHeaders});
      }

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
          discrepancy_resolutions, runner_count, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        (runner_checkpoints || []).length, ''
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
        if (rc.status === 'present') {
          const notesParts = [`Shift wizard: calc=${rc.cash_calculated}, collected=${rc.cash_collected}`];
          if (rc.unsold_tokens > 0) notesParts.push(`unsold=${rc.unsold_tokens}`);
          if (rc.cross_payment_credit > 0) notesParts.push(`crossCredit=${rc.cross_payment_credit}`);
          if (rc.cash_variance !== 0) notesParts.push(`variance=${rc.cash_variance}`);

          await DB.prepare(`
            INSERT INTO settlements (
              runner_id, runner_name, settled_at, settled_by,
              period_start, period_end,
              tokens_amount, sales_amount, upi_amount,
              cash_settled, unsold_tokens, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            String(rc.runner_id), rc.runner_name,
            settledAt, settled_by,
            period_start, period_end,
            rc.tokens_amount || 0, rc.sales_amount || 0, rc.upi_amount || 0,
            rc.cash_collected || 0, rc.unsold_tokens || 0,
            notesParts.join('; ')
          ).run();
        }
      }

      // 5. Legacy counter settlement record
      await DB.prepare(`
        INSERT INTO settlements (
          runner_id, runner_name, settled_at, settled_by,
          period_start, period_end,
          tokens_amount, sales_amount, upi_amount,
          cash_settled, unsold_tokens, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        'counter', 'Cash Counter',
        settledAt, settled_by,
        period_start, period_end,
        0, (counter.cash_expected || 0) + (counter.upi || 0) + (counter.card || 0),
        (counter.upi || 0) + (counter.card || 0),
        counter.unsettled_counter_cash || counter.cash_expected || 0, 0,
        `Shift wizard v3: drawer_entered=${drawer_cash_entered || counter.cash_entered}, expected_drawer=${cb.expected_drawer || counter.cash_expected}, unsettled_counter=${counter.unsettled_counter_cash || 0}, variance=${reconciliation.variance_unresolved || 0}`
      ).run();

      // 6. WhatsApp alert if significant unresolved variance
      if (WA_TOKEN && Math.abs(reconciliation.variance_unresolved || 0) > 50) {
        const dir = reconciliation.variance_unresolved > 0 ? 'extra' : 'short';
        const runnerSummary = checkpoints
          .filter(r => r.status === 'present')
          .map(r => `${r.runner_name}: ₹${r.cash_collected}${r.cash_variance !== 0 ? ` (${r.cash_variance > 0 ? '+' : ''}${r.cash_variance})` : ''}`)
          .join('\n');
        const absentRunners = checkpoints.filter(r => r.status === 'absent').map(r => r.runner_name).join(', ');

        const msg = `🏁 *NCH Shift Settlement*\n\n⚠️ Unresolved Variance: ₹${Math.abs(reconciliation.variance_unresolved).toFixed(0)} ${dir}\n\nCashier: ${settled_by}\nCounter cash: ₹${counter.cash_entered} (expected ₹${counter.cash_expected})\n${runnerSummary ? 'Runners:\n' + runnerSummary : 'No runners'}${absentRunners ? '\nAbsent: ' + absentRunners : ''}\n\nTotal physical: ₹${reconciliation.total_physical_cash}\nExpected: ₹${reconciliation.expected_cash}\nResolved: ₹${reconciliation.variance_resolved || 0}`;
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

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), {status: 500, headers: corsHeaders});
  }
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
