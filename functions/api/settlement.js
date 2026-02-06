// NCH Settlement v2 — Cash Trail & Multi-Level Handover System
// Handles: PIN auth, runner/counter/cashier handovers, expenses, manager collections

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  if (!DB) return json({success: false, error: 'Database not configured'}, corsHeaders);

  try {
    // ─── VERIFY PIN ──────────────────────────────────────────────
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (!pin) return json({success: false, error: 'PIN required'}, corsHeaders);

      const staff = await DB.prepare(
        `SELECT id, name, role, runner_odoo_id, runner_barcode FROM staff WHERE pin = ? AND is_active = 1`
      ).bind(pin).first();

      if (!staff) return json({success: false, error: 'Invalid PIN'}, corsHeaders);
      return json({success: true, staff}, corsHeaders);
    }

    // ─── GET ALL RUNNERS (for cashier grid) ──────────────────────
    if (action === 'get-runners') {
      const runners = await DB.prepare(
        `SELECT id, name, runner_odoo_id, runner_barcode FROM staff WHERE role = 'runner' AND is_active = 1 ORDER BY runner_odoo_id`
      ).all();
      return json({success: true, runners: runners.results}, corsHeaders);
    }

    // ─── GET RUNNER STATUS (last handover) ───────────────────────
    if (action === 'get-runner-status') {
      const runnerId = url.searchParams.get('runner_staff_id');
      if (!runnerId) return json({success: false, error: 'runner_staff_id required'}, corsHeaders);

      const last = await DB.prepare(
        `SELECT * FROM handovers WHERE from_staff_id = ? AND handover_type = 'runner_to_cashier' ORDER BY created_at DESC LIMIT 1`
      ).bind(runnerId).first();

      const baseline = '2026-02-04T17:00:00';
      return json({
        success: true,
        lastHandover: last || null,
        periodStart: last ? last.period_end : baseline
      }, corsHeaders);
    }

    // ─── GET COUNTER STATUS (last counter handover) ──────────────
    if (action === 'get-counter-status') {
      const last = await DB.prepare(
        `SELECT * FROM handovers WHERE from_staff_id = 'counter_pos27' AND handover_type = 'counter_to_cashier' ORDER BY created_at DESC LIMIT 1`
      ).first();

      const baseline = '2026-02-04T17:00:00';
      return json({
        success: true,
        lastHandover: last || null,
        periodStart: last ? last.period_end : baseline
      }, corsHeaders);
    }

    // ─── RUNNER HANDOVER (runner → cashier) ──────────────────────
    if (action === 'runner-handover' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {runner_staff_id, cashier_staff_id, period_start, period_end,
             expected_tokens, expected_sales, expected_upi, expected_cash,
             actual_cash, discrepancy_reason, notes} = body;

      if (!runner_staff_id || !cashier_staff_id || actual_cash === undefined) {
        return json({success: false, error: 'Missing required fields'}, corsHeaders);
      }

      // Validate cashier role
      const cashier = await DB.prepare(`SELECT id, name, role FROM staff WHERE id = ? AND is_active = 1`).bind(cashier_staff_id).first();
      if (!cashier || cashier.role !== 'cashier') {
        return json({success: false, error: 'Only cashiers can receive runner handovers'}, corsHeaders);
      }

      const discrepancy = (expected_cash || 0) - actual_cash;
      const now = new Date().toISOString();

      await DB.prepare(`
        INSERT INTO handovers (handover_type, from_staff_id, to_staff_id, period_start, period_end,
          expected_tokens, expected_sales, expected_upi, expected_cash,
          actual_cash, discrepancy, discrepancy_reason, discrepancy_attributed_to,
          created_at, created_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        'runner_to_cashier', runner_staff_id, cashier_staff_id,
        period_start, period_end || now,
        expected_tokens || 0, expected_sales || 0, expected_upi || 0, expected_cash || 0,
        actual_cash, discrepancy,
        discrepancy !== 0 ? (discrepancy_reason || 'No reason provided') : null,
        discrepancy !== 0 ? runner_staff_id : null,
        now, cashier_staff_id, notes || ''
      ).run();

      return json({success: true, message: 'Runner handover recorded', discrepancy}, corsHeaders);
    }

    // ─── COUNTER HANDOVER (counter → cashier) ────────────────────
    if (action === 'counter-handover' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {cashier_staff_id, period_start, period_end,
             expected_cash, expected_upi, expected_card,
             actual_cash, discrepancy_reason, notes} = body;

      if (!cashier_staff_id || actual_cash === undefined) {
        return json({success: false, error: 'Missing required fields'}, corsHeaders);
      }

      const cashier = await DB.prepare(`SELECT id, name, role FROM staff WHERE id = ? AND is_active = 1`).bind(cashier_staff_id).first();
      if (!cashier || cashier.role !== 'cashier') {
        return json({success: false, error: 'Only cashiers can settle the counter'}, corsHeaders);
      }

      const discrepancy = (expected_cash || 0) - actual_cash;
      const now = new Date().toISOString();

      await DB.prepare(`
        INSERT INTO handovers (handover_type, from_staff_id, to_staff_id, period_start, period_end,
          expected_tokens, expected_sales, expected_upi, expected_cash,
          actual_cash, discrepancy, discrepancy_reason, discrepancy_attributed_to,
          created_at, created_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        'counter_to_cashier', 'counter_pos27', cashier_staff_id,
        period_start, period_end || now,
        0, 0, expected_upi || 0, expected_cash || 0,
        actual_cash, discrepancy,
        discrepancy !== 0 ? (discrepancy_reason || 'No reason provided') : null,
        discrepancy !== 0 ? cashier_staff_id : null,
        now, cashier_staff_id,
        notes || `Counter: Cash=${expected_cash || 0} UPI=${expected_upi || 0} Card=${expected_card || 0}`
      ).run();

      return json({success: true, message: 'Counter handover recorded', discrepancy}, corsHeaders);
    }

    // ─── ADD EXPENSE ─────────────────────────────────────────────
    if (action === 'add-expense' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {staff_id, amount, category, description} = body;

      if (!staff_id || !amount || !category || !description) {
        return json({success: false, error: 'Missing required fields (staff_id, amount, category, description)'}, corsHeaders);
      }

      const staff = await DB.prepare(`SELECT id, name, role FROM staff WHERE id = ? AND is_active = 1`).bind(staff_id).first();
      if (!staff || staff.role !== 'cashier') {
        return json({success: false, error: 'Only cashiers can record expenses'}, corsHeaders);
      }

      const validCategories = ['police', 'supplies', 'transport', 'other'];
      if (!validCategories.includes(category)) {
        return json({success: false, error: 'Invalid category. Use: ' + validCategories.join(', ')}, corsHeaders);
      }

      const now = new Date().toISOString();
      await DB.prepare(`
        INSERT INTO expenses (staff_id, amount, category, description, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(staff_id, amount, category, description, now).run();

      return json({success: true, message: 'Expense recorded'}, corsHeaders);
    }

    // ─── GET EXPENSES (uncollected, for a cashier) ───────────────
    if (action === 'get-expenses') {
      const staffId = url.searchParams.get('staff_id');
      if (!staffId) return json({success: false, error: 'staff_id required'}, corsHeaders);

      const expenses = await DB.prepare(
        `SELECT * FROM expenses WHERE staff_id = ? AND collection_id IS NULL ORDER BY created_at DESC`
      ).bind(staffId).all();

      return json({success: true, expenses: expenses.results}, corsHeaders);
    }

    // ─── GET CASHIER SUMMARY ─────────────────────────────────────
    // Returns all uncollected handovers + expenses for a cashier
    if (action === 'get-cashier-summary') {
      const cashierId = url.searchParams.get('cashier_staff_id');
      if (!cashierId) return json({success: false, error: 'cashier_staff_id required'}, corsHeaders);

      // All uncollected runner handovers received by this cashier
      const runnerHandovers = await DB.prepare(
        `SELECT h.*, s.name as from_name FROM handovers h
         JOIN staff s ON s.id = h.from_staff_id
         WHERE h.to_staff_id = ? AND h.handover_type = 'runner_to_cashier' AND h.collection_id IS NULL
         ORDER BY h.created_at DESC`
      ).bind(cashierId).all();

      // All uncollected counter handovers
      const counterHandovers = await DB.prepare(
        `SELECT * FROM handovers
         WHERE to_staff_id = ? AND handover_type = 'counter_to_cashier' AND collection_id IS NULL
         ORDER BY created_at DESC`
      ).bind(cashierId).all();

      // All uncollected expenses
      const expenses = await DB.prepare(
        `SELECT * FROM expenses WHERE staff_id = ? AND collection_id IS NULL ORDER BY created_at DESC`
      ).bind(cashierId).all();

      // Calculate totals
      const totalRunnerCash = runnerHandovers.results.reduce((s, h) => s + h.actual_cash, 0);
      const totalCounterCash = counterHandovers.results.reduce((s, h) => s + h.actual_cash, 0);
      const totalExpenses = expenses.results.reduce((s, e) => s + e.amount, 0);
      const totalDiscrepancy = runnerHandovers.results.reduce((s, h) => s + h.discrepancy, 0)
        + counterHandovers.results.reduce((s, h) => s + h.discrepancy, 0);

      // Check if cashier already has a pending cashier_to_manager handover
      const pendingManagerHandover = await DB.prepare(
        `SELECT * FROM handovers WHERE from_staff_id = ? AND handover_type = 'cashier_to_manager' AND collection_id IS NULL ORDER BY created_at DESC LIMIT 1`
      ).bind(cashierId).first();

      return json({
        success: true,
        runnerHandovers: runnerHandovers.results,
        counterHandovers: counterHandovers.results,
        expenses: expenses.results,
        pendingManagerHandover: pendingManagerHandover || null,
        totals: {
          totalRunnerCash: round2(totalRunnerCash),
          totalCounterCash: round2(totalCounterCash),
          totalCashReceived: round2(totalRunnerCash + totalCounterCash),
          totalExpenses: round2(totalExpenses),
          totalDiscrepancy: round2(totalDiscrepancy),
          netCash: round2(totalRunnerCash + totalCounterCash - totalExpenses)
        }
      }, corsHeaders);
    }

    // ─── CASHIER TO MANAGER HANDOVER ─────────────────────────────
    if (action === 'cashier-to-manager' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {cashier_staff_id, actual_cash, notes} = body;

      if (!cashier_staff_id || actual_cash === undefined) {
        return json({success: false, error: 'Missing required fields'}, corsHeaders);
      }

      const cashier = await DB.prepare(`SELECT id, name, role FROM staff WHERE id = ? AND is_active = 1`).bind(cashier_staff_id).first();
      if (!cashier || cashier.role !== 'cashier') {
        return json({success: false, error: 'Only cashiers can hand over to manager'}, corsHeaders);
      }

      // Calculate expected from uncollected handovers and expenses
      const runnerSum = await DB.prepare(
        `SELECT COALESCE(SUM(actual_cash), 0) as total FROM handovers
         WHERE to_staff_id = ? AND handover_type = 'runner_to_cashier' AND collection_id IS NULL`
      ).bind(cashier_staff_id).first();

      const counterSum = await DB.prepare(
        `SELECT COALESCE(SUM(actual_cash), 0) as total FROM handovers
         WHERE to_staff_id = ? AND handover_type = 'counter_to_cashier' AND collection_id IS NULL`
      ).bind(cashier_staff_id).first();

      const expenseSum = await DB.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM expenses
         WHERE staff_id = ? AND collection_id IS NULL`
      ).bind(cashier_staff_id).first();

      const expectedCash = round2((runnerSum.total || 0) + (counterSum.total || 0) - (expenseSum.total || 0));
      const discrepancy = round2(expectedCash - actual_cash);
      const now = new Date().toISOString();

      // Find the earliest period_start from uncollected handovers
      const earliest = await DB.prepare(
        `SELECT MIN(period_start) as earliest FROM handovers
         WHERE to_staff_id = ? AND collection_id IS NULL`
      ).bind(cashier_staff_id).first();

      await DB.prepare(`
        INSERT INTO handovers (handover_type, from_staff_id, to_staff_id, period_start, period_end,
          expected_cash, actual_cash, discrepancy, discrepancy_reason, discrepancy_attributed_to,
          created_at, created_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        'cashier_to_manager', cashier_staff_id, 'manager',
        earliest?.earliest || now, now,
        expectedCash, actual_cash, discrepancy,
        discrepancy !== 0 ? 'Cash mismatch at cashier level' : null,
        discrepancy !== 0 ? cashier_staff_id : null,
        now, cashier_staff_id, notes || ''
      ).run();

      return json({success: true, message: 'Handover to manager recorded', expectedCash, actual_cash, discrepancy}, corsHeaders);
    }

    // ─── GET PENDING COLLECTIONS (for manager) ───────────────────
    if (action === 'get-pending-collections') {
      // Get all cashier_to_manager handovers not yet collected
      const cashierHandovers = await DB.prepare(
        `SELECT h.*, s.name as from_name FROM handovers h
         JOIN staff s ON s.id = h.from_staff_id
         WHERE h.handover_type = 'cashier_to_manager' AND h.collection_id IS NULL
         ORDER BY h.created_at ASC`
      ).all();

      // For each cashier handover, get the underlying runner/counter handovers and expenses
      const pendingByStaff = [];
      for (const ch of cashierHandovers.results) {
        // Get all uncollected runner handovers for this cashier
        const runners = await DB.prepare(
          `SELECT h.*, s.name as from_name FROM handovers h
           JOIN staff s ON s.id = h.from_staff_id
           WHERE h.to_staff_id = ? AND h.handover_type = 'runner_to_cashier' AND h.collection_id IS NULL
           ORDER BY h.created_at ASC`
        ).bind(ch.from_staff_id).all();

        // Get all uncollected counter handovers for this cashier
        const counters = await DB.prepare(
          `SELECT * FROM handovers
           WHERE to_staff_id = ? AND handover_type = 'counter_to_cashier' AND collection_id IS NULL
           ORDER BY created_at ASC`
        ).bind(ch.from_staff_id).all();

        // Get all uncollected expenses for this cashier
        const expenses = await DB.prepare(
          `SELECT * FROM expenses WHERE staff_id = ? AND collection_id IS NULL ORDER BY created_at ASC`
        ).bind(ch.from_staff_id).all();

        const totalRunnerDisc = runners.results.reduce((s, r) => s + r.discrepancy, 0);
        const totalExpenses = expenses.results.reduce((s, e) => s + e.amount, 0);

        pendingByStaff.push({
          cashier: {id: ch.from_staff_id, name: ch.from_name},
          cashierHandover: ch,
          runnerHandovers: runners.results,
          counterHandovers: counters.results,
          expenses: expenses.results,
          totals: {
            runnerCash: round2(runners.results.reduce((s, r) => s + r.actual_cash, 0)),
            counterCash: round2(counters.results.reduce((s, r) => s + r.actual_cash, 0)),
            expenses: round2(totalExpenses),
            runnerDiscrepancy: round2(totalRunnerDisc),
            cashierDiscrepancy: round2(ch.discrepancy),
            netCash: round2(ch.actual_cash)
          }
        });
      }

      // Grand totals
      const grandExpected = pendingByStaff.reduce((s, p) => s + p.cashierHandover.expected_cash, 0);
      const grandReceived = pendingByStaff.reduce((s, p) => s + p.cashierHandover.actual_cash, 0);
      const grandExpenses = pendingByStaff.reduce((s, p) => s + p.totals.expenses, 0);
      const grandDisc = pendingByStaff.reduce((s, p) => s + p.totals.runnerDiscrepancy + p.totals.cashierDiscrepancy, 0);

      // Last collection
      const lastCollection = await DB.prepare(
        `SELECT * FROM collections ORDER BY created_at DESC LIMIT 1`
      ).first();

      return json({
        success: true,
        pendingByStaff,
        grandTotals: {
          totalExpected: round2(grandExpected),
          totalReceived: round2(grandReceived),
          totalExpenses: round2(grandExpenses),
          totalDiscrepancy: round2(grandDisc),
          netCash: round2(grandReceived)
        },
        lastCollection: lastCollection || null
      }, corsHeaders);
    }

    // ─── COLLECT (manager confirms collection) ───────────────────
    if (action === 'collect' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {manager_staff_id, actual_cash_received, notes} = body;

      if (!manager_staff_id || actual_cash_received === undefined) {
        return json({success: false, error: 'Missing required fields'}, corsHeaders);
      }

      const manager = await DB.prepare(`SELECT id, name, role FROM staff WHERE id = ? AND is_active = 1`).bind(manager_staff_id).first();
      if (!manager || manager.role !== 'manager') {
        return json({success: false, error: 'Only managers can collect'}, corsHeaders);
      }

      // Get all uncollected cashier-to-manager handovers
      const pendingHandovers = await DB.prepare(
        `SELECT * FROM handovers WHERE handover_type = 'cashier_to_manager' AND collection_id IS NULL`
      ).all();

      if (pendingHandovers.results.length === 0) {
        return json({success: false, error: 'No pending handovers to collect'}, corsHeaders);
      }

      const totalExpected = pendingHandovers.results.reduce((s, h) => s + h.expected_cash, 0);
      const totalReceived = pendingHandovers.results.reduce((s, h) => s + h.actual_cash, 0);

      // Get all uncollected expenses (from all cashiers who have pending handovers)
      const cashierIds = [...new Set(pendingHandovers.results.map(h => h.from_staff_id))];
      let totalExpenses = 0;
      for (const cid of cashierIds) {
        const expSum = await DB.prepare(
          `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE staff_id = ? AND collection_id IS NULL`
        ).bind(cid).first();
        totalExpenses += expSum.total || 0;
      }

      const totalDisc = round2(totalReceived - actual_cash_received);
      const now = new Date().toISOString();

      // Create collection record
      const collectionResult = await DB.prepare(`
        INSERT INTO collections (manager_id, total_expected, total_received, total_expenses, total_discrepancy, net_cash, created_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        manager_staff_id,
        round2(totalExpected), round2(totalReceived), round2(totalExpenses), round2(totalDisc),
        round2(actual_cash_received),
        now, notes || ''
      ).run();

      const collectionId = collectionResult.meta.last_row_id;

      // Stamp collection_id on all cashier-to-manager handovers
      await DB.prepare(
        `UPDATE handovers SET collection_id = ? WHERE handover_type = 'cashier_to_manager' AND collection_id IS NULL`
      ).bind(collectionId).run();

      // Stamp collection_id on all runner/counter handovers that fed into those cashiers
      for (const cid of cashierIds) {
        await DB.prepare(
          `UPDATE handovers SET collection_id = ? WHERE to_staff_id = ? AND handover_type IN ('runner_to_cashier', 'counter_to_cashier') AND collection_id IS NULL`
        ).bind(collectionId, cid).run();

        await DB.prepare(
          `UPDATE expenses SET collection_id = ? WHERE staff_id = ? AND collection_id IS NULL`
        ).bind(collectionId, cid).run();
      }

      return json({
        success: true,
        message: 'Collection recorded',
        collectionId,
        totalReceived: round2(totalReceived),
        actualReceived: actual_cash_received,
        discrepancy: round2(totalDisc)
      }, corsHeaders);
    }

    // ─── COLLECTION HISTORY ──────────────────────────────────────
    if (action === 'collection-history') {
      const limit = parseInt(url.searchParams.get('limit') || '20');

      const collections = await DB.prepare(
        `SELECT c.*, s.name as manager_name FROM collections c
         JOIN staff s ON s.id = c.manager_id
         ORDER BY c.created_at DESC LIMIT ?`
      ).bind(limit).all();

      // Enrich each collection with its handovers and expenses
      const enriched = [];
      for (const c of collections.results) {
        const handovers = await DB.prepare(
          `SELECT h.*, s.name as from_name FROM handovers h
           JOIN staff s ON s.id = h.from_staff_id
           WHERE h.collection_id = ?
           ORDER BY h.created_at ASC`
        ).bind(c.id).all();

        const expenses = await DB.prepare(
          `SELECT * FROM expenses WHERE collection_id = ? ORDER BY created_at ASC`
        ).bind(c.id).all();

        enriched.push({
          ...c,
          handovers: handovers.results,
          expenses: expenses.results
        });
      }

      return json({success: true, collections: enriched}, corsHeaders);
    }

    // ─── DELETE EXPENSE ──────────────────────────────────────────
    if (action === 'delete-expense' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {expense_id, staff_id} = body;

      if (!expense_id || !staff_id) return json({success: false, error: 'Missing expense_id or staff_id'}, corsHeaders);

      // Only allow deleting uncollected expenses by the same cashier
      const expense = await DB.prepare(`SELECT * FROM expenses WHERE id = ? AND staff_id = ? AND collection_id IS NULL`).bind(expense_id, staff_id).first();
      if (!expense) return json({success: false, error: 'Expense not found or already collected'}, corsHeaders);

      await DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(expense_id).run();
      return json({success: true, message: 'Expense deleted'}, corsHeaders);
    }

    // ─── LEGACY COMPAT: get-last-settlement ──────────────────────
    if (action === 'get-last-settlement') {
      const runnerId = url.searchParams.get('runner_id');
      const result = await DB.prepare(
        `SELECT * FROM settlements WHERE runner_id = ? ORDER BY settled_at DESC LIMIT 1`
      ).bind(runnerId).first();
      const baseline = '2026-02-04T17:00:00+05:30';
      return json({success: true, lastSettlement: result || null, periodStart: result ? result.settled_at : baseline}, corsHeaders);
    }

    // ─── LEGACY COMPAT: history ──────────────────────────────────
    if (action === 'history') {
      const runnerId = url.searchParams.get('runner_id');
      const limit = url.searchParams.get('limit') || 50;
      let query = 'SELECT * FROM settlements';
      let params = [];
      if (runnerId) { query += ' WHERE runner_id = ?'; params.push(runnerId); }
      query += ' ORDER BY settled_at DESC LIMIT ?';
      params.push(limit);
      const results = await DB.prepare(query).bind(...params).all();
      return json({success: true, settlements: results.results}, corsHeaders);
    }

    return json({success: false, error: 'Invalid action'}, corsHeaders);

  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }
}

// ─── HELPERS ──────────────────────────────────────────────────
function json(data, headers) {
  return new Response(JSON.stringify(data), {headers});
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}
