export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  // PIN verification — matches Odoo POS employee PINs
  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen'};
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

      const baseline = '2026-02-04T17:00:00+05:30';
      return new Response(JSON.stringify({
        success: true,
        lastSettlement: result || null,
        periodStart: result ? result.settled_at : baseline
      }), {headers: corsHeaders});
    }

    if (action === 'settle' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const body = await context.request.json();
      const {runner_id, runner_name, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, notes} = body;

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

      await DB.prepare(`
        INSERT INTO settlements (runner_id, runner_name, settled_at, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(runner_id), runner_name || runner.name, new Date().toISOString(), settled_by,
        period_start, period_end, tokens_amount || 0, sales_amount || 0, upi_amount || 0, cash_settled, notes || ''
      ).run();

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

      // Duplicate prevention: same person within 2 minutes
      const recentDup = await DB.prepare(
        "SELECT id FROM counter_expenses WHERE recorded_by = ? AND recorded_at > datetime('now', '-2 minutes') ORDER BY recorded_at DESC LIMIT 1"
      ).bind(recorded_by).first();
      if (recentDup) {
        return new Response(JSON.stringify({success: false, error: 'You just recorded an expense. Wait 2 minutes.'}), {headers: corsHeaders});
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
      const {collected_by, amount, petty_cash, notes} = body;

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

      // Expected = prev petty + settlements - expenses already recorded
      const expected = prevPettyCash + runnerCash + counterCash - totalExpenses;
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
        expected, discrepancy, periodStart, periodEnd, runnerCash, counterCash,
        prevPettyCash, ids.join(','), notes || ''
      ).run();

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

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), {status: 500, headers: corsHeaders});
  }
}
