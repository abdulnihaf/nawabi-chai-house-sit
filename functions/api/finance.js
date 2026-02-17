// NCH Finance Operations API
// Read from existing D1 tables (daily_settlements, cash_collections, counter_expenses)
// Write to new tables (business_expenses, bank_transactions)

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  const PINS = {'5882': 'Nihaf', '3754': 'Naveen'};

  try {
    if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

    // ═══════════════════════════════════════════════════════
    // VERIFY PIN
    // ═══════════════════════════════════════════════════════
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PINS[pin]) return new Response(JSON.stringify({success: true, user: PINS[pin]}), {headers: corsHeaders});
      return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
    }

    // ═══════════════════════════════════════════════════════
    // OVERVIEW — KPIs for date range + all-time cash in hand
    // ═══════════════════════════════════════════════════════
    if (action === 'overview') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return new Response(JSON.stringify({success: false, error: 'from and to required'}), {headers: corsHeaders});

      const fromISO = from + 'T00:00:00';
      const toISO = to + 'T23:59:59';

      // P&L from daily_settlements
      const pnl = await DB.prepare(`
        SELECT COALESCE(SUM(revenue_total),0) as revenue,
               COALESCE(SUM(cogs_actual),0) as cogs,
               COALESCE(SUM(gross_profit),0) as gross_profit,
               COALESCE(SUM(opex_total),0) as opex,
               COALESCE(SUM(opex_salaries),0) as opex_salaries,
               COALESCE(SUM(opex_counter_expenses),0) as opex_counter_expenses,
               COALESCE(SUM(opex_non_consumable),0) as opex_non_consumable,
               COALESCE(SUM(net_profit),0) as net_profit,
               COALESCE(SUM(adjusted_net_profit),0) as adjusted_net_profit,
               COALESCE(SUM(discrepancy_value),0) as discrepancy,
               COALESCE(SUM(wastage_total_value),0) as wastage
        FROM daily_settlements WHERE settlement_date BETWEEN ? AND ? AND status = 'completed'
      `).bind(from, to).first();

      // Counter expenses (period)
      const counterExp = await DB.prepare(`
        SELECT COALESCE(SUM(amount),0) as total FROM counter_expenses WHERE recorded_at BETWEEN ? AND ?
      `).bind(fromISO, toISO).first();

      // Cash collections (period)
      const collections = await DB.prepare(`
        SELECT COALESCE(SUM(amount),0) as total, COALESCE(SUM(expenses),0) as expenses,
               COALESCE(SUM(discrepancy),0) as discrepancy, COUNT(*) as count
        FROM cash_collections WHERE collected_at BETWEEN ? AND ?
      `).bind(fromISO, toISO).first();

      // Business expenses (period) by payment_mode
      const bizExp = await DB.prepare(`
        SELECT payment_mode, COALESCE(SUM(amount),0) as total
        FROM business_expenses WHERE recorded_at BETWEEN ? AND ? GROUP BY payment_mode
      `).bind(fromISO, toISO).all();
      const bizCash = bizExp.results.find(r => r.payment_mode === 'cash')?.total || 0;
      const bizBank = bizExp.results.find(r => r.payment_mode === 'bank')?.total || 0;

      // Business expenses by category (period)
      const bizByCat = await DB.prepare(`
        SELECT category, COALESCE(SUM(amount),0) as total
        FROM business_expenses WHERE recorded_at BETWEEN ? AND ? GROUP BY category ORDER BY total DESC
      `).bind(fromISO, toISO).all();

      // Bank transactions (period)
      const bankTxn = await DB.prepare(`
        SELECT type, COALESCE(SUM(amount),0) as total
        FROM bank_transactions WHERE recorded_at BETWEEN ? AND ? GROUP BY type
      `).bind(fromISO, toISO).all();
      const bankDeposits = bankTxn.results.find(r => r.type === 'deposit')?.total || 0;
      const bankWithdrawals = bankTxn.results.find(r => r.type === 'withdrawal')?.total || 0;

      // Cash in hand: ALL TIME running balance
      const cashInHand = await computeCashInHand(DB);

      return new Response(JSON.stringify({
        success: true,
        pnl,
        counterExpenses: counterExp.total,
        collections: {total: collections.total, expenses: collections.expenses, discrepancy: collections.discrepancy, count: collections.count},
        businessExpenses: {cash: bizCash, bank: bizBank, total: bizCash + bizBank, byCategory: bizByCat.results},
        bankTransactions: {deposits: bankDeposits, withdrawals: bankWithdrawals},
        cashInHand
      }), {headers: corsHeaders});
    }

    // ═══════════════════════════════════════════════════════
    // CASH FLOW — waterfall data
    // ═══════════════════════════════════════════════════════
    if (action === 'cash-flow') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return new Response(JSON.stringify({success: false, error: 'from and to required'}), {headers: corsHeaders});

      const fromISO = from + 'T00:00:00';
      const toISO = to + 'T23:59:59';

      // Opening balance (all time)
      const openingBal = await DB.prepare(`
        SELECT COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE type = 'opening_balance'
      `).first();

      // Collections in period
      const colls = await DB.prepare(`
        SELECT id, collected_by, collected_at, amount, notes FROM cash_collections
        WHERE collected_at BETWEEN ? AND ? ORDER BY collected_at DESC
      `).bind(fromISO, toISO).all();

      // Bank deposits in period
      const deps = await DB.prepare(`
        SELECT id, recorded_by, recorded_at, amount, description, method FROM bank_transactions
        WHERE type = 'deposit' AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
      `).bind(fromISO, toISO).all();

      // Bank withdrawals in period
      const withs = await DB.prepare(`
        SELECT id, recorded_by, recorded_at, amount, description, method FROM bank_transactions
        WHERE type = 'withdrawal' AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
      `).bind(fromISO, toISO).all();

      // Cash business expenses in period
      const cashExps = await DB.prepare(`
        SELECT id, recorded_by, recorded_at, amount, description, category FROM business_expenses
        WHERE payment_mode = 'cash' AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
      `).bind(fromISO, toISO).all();

      // Bank business expenses in period
      const bankExps = await DB.prepare(`
        SELECT id, recorded_by, recorded_at, amount, description, category FROM business_expenses
        WHERE payment_mode = 'bank' AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
      `).bind(fromISO, toISO).all();

      const cashInHand = await computeCashInHand(DB);

      // Period totals
      const collTotal = colls.results.reduce((s, r) => s + r.amount, 0);
      const depTotal = deps.results.reduce((s, r) => s + r.amount, 0);
      const withTotal = withs.results.reduce((s, r) => s + r.amount, 0);
      const cashExpTotal = cashExps.results.reduce((s, r) => s + r.amount, 0);
      const bankExpTotal = bankExps.results.reduce((s, r) => s + r.amount, 0);

      return new Response(JSON.stringify({
        success: true,
        openingBalance: openingBal.total,
        collections: {total: collTotal, entries: colls.results},
        bankDeposits: {total: depTotal, entries: deps.results},
        bankWithdrawals: {total: withTotal, entries: withs.results},
        cashExpenses: {total: cashExpTotal, entries: cashExps.results},
        bankExpenses: {total: bankExpTotal, entries: bankExps.results},
        cashInHand
      }), {headers: corsHeaders});
    }

    // ═══════════════════════════════════════════════════════
    // P&L — from daily_settlements
    // ═══════════════════════════════════════════════════════
    if (action === 'pnl') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return new Response(JSON.stringify({success: false, error: 'from and to required'}), {headers: corsHeaders});

      // Aggregate P&L
      const pnl = await DB.prepare(`
        SELECT COALESCE(SUM(revenue_total),0) as revenue_total,
               COALESCE(SUM(revenue_cash_counter),0) as revenue_cash_counter,
               COALESCE(SUM(revenue_runner_counter),0) as revenue_runner_counter,
               COALESCE(SUM(revenue_whatsapp),0) as revenue_whatsapp,
               COALESCE(SUM(cogs_actual),0) as cogs_actual,
               COALESCE(SUM(cogs_expected),0) as cogs_expected,
               COALESCE(SUM(gross_profit),0) as gross_profit,
               COALESCE(SUM(opex_salaries),0) as opex_salaries,
               COALESCE(SUM(opex_counter_expenses),0) as opex_counter_expenses,
               COALESCE(SUM(opex_non_consumable),0) as opex_non_consumable,
               COALESCE(SUM(opex_total),0) as opex_total,
               COALESCE(SUM(net_profit),0) as net_profit,
               COALESCE(SUM(wastage_total_value),0) as wastage_total_value,
               COALESCE(SUM(discrepancy_value),0) as discrepancy_value,
               COALESCE(SUM(adjusted_net_profit),0) as adjusted_net_profit,
               COUNT(*) as settlement_count
        FROM daily_settlements WHERE settlement_date BETWEEN ? AND ? AND status = 'completed'
      `).bind(from, to).first();

      // Individual settlement periods for breakdown
      const periods = await DB.prepare(`
        SELECT id, settlement_date, period_start, period_end, settled_by,
               revenue_total, cogs_actual, gross_profit, opex_total, net_profit,
               wastage_total_value, discrepancy_value, adjusted_net_profit
        FROM daily_settlements WHERE settlement_date BETWEEN ? AND ? AND status = 'completed'
        ORDER BY settled_at DESC
      `).bind(from, to).all();

      // Business expenses for the period (these are outside P&L but show alongside)
      const bizExp = await DB.prepare(`
        SELECT COALESCE(SUM(amount),0) as total FROM business_expenses
        WHERE recorded_at BETWEEN ? AND ?
      `).bind(from + 'T00:00:00', to + 'T23:59:59').first();

      return new Response(JSON.stringify({
        success: true,
        pnl,
        periods: periods.results,
        businessExpenses: bizExp.total
      }), {headers: corsHeaders});
    }

    // ═══════════════════════════════════════════════════════
    // LEDGER — union of all financial tables
    // ═══════════════════════════════════════════════════════
    if (action === 'ledger') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const type = url.searchParams.get('type'); // optional filter
      if (!from || !to) return new Response(JSON.stringify({success: false, error: 'from and to required'}), {headers: corsHeaders});

      const fromISO = from + 'T00:00:00';
      const toISO = to + 'T23:59:59';

      let entries = [];

      // Cash collections
      if (!type || type === 'collection') {
        const colls = await DB.prepare(`
          SELECT id, 'collection' as type, collected_at as timestamp, amount,
                 'Cash collected from counter' as description, collected_by as recorded_by,
                 'cash_collections' as source_table, notes
          FROM cash_collections WHERE collected_at BETWEEN ? AND ? ORDER BY collected_at DESC
        `).bind(fromISO, toISO).all();
        entries.push(...colls.results);
      }

      // Counter expenses
      if (!type || type === 'counter_expense') {
        const cexp = await DB.prepare(`
          SELECT id, 'counter_expense' as type, recorded_at as timestamp, amount,
                 reason as description, recorded_by, 'counter_expenses' as source_table, notes
          FROM counter_expenses WHERE recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
        `).bind(fromISO, toISO).all();
        entries.push(...cexp.results);
      }

      // Business expenses
      if (!type || type === 'business_expense') {
        const bexp = await DB.prepare(`
          SELECT id, 'business_expense' as type, recorded_at as timestamp, amount,
                 description, recorded_by, 'business_expenses' as source_table, notes,
                 category, payment_mode
          FROM business_expenses WHERE recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
        `).bind(fromISO, toISO).all();
        entries.push(...bexp.results);
      }

      // Bank deposits
      if (!type || type === 'bank_deposit') {
        const deps = await DB.prepare(`
          SELECT id, 'bank_deposit' as type, recorded_at as timestamp, amount,
                 description, recorded_by, 'bank_transactions' as source_table, notes, method
          FROM bank_transactions WHERE type = 'deposit' AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
        `).bind(fromISO, toISO).all();
        entries.push(...deps.results);
      }

      // Bank withdrawals
      if (!type || type === 'bank_withdrawal') {
        const withs = await DB.prepare(`
          SELECT id, 'bank_withdrawal' as type, recorded_at as timestamp, amount,
                 description, recorded_by, 'bank_transactions' as source_table, notes, method
          FROM bank_transactions WHERE type = 'withdrawal' AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC
        `).bind(fromISO, toISO).all();
        entries.push(...withs.results);
      }

      // Sort all by timestamp DESC
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      return new Response(JSON.stringify({success: true, entries}), {headers: corsHeaders});
    }

    // ═══════════════════════════════════════════════════════
    // WRITE ACTIONS (POST)
    // ═══════════════════════════════════════════════════════
    if (context.request.method === 'POST') {
      const body = await context.request.json();
      const user = PINS[body.pin];
      if (!user) return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});

      // --- Record Business Expense ---
      if (action === 'record-expense') {
        const {amount, description, category, payment_mode, notes} = body;
        if (!amount || amount <= 0) return new Response(JSON.stringify({success: false, error: 'Valid amount required'}), {headers: corsHeaders});
        if (!description || !description.trim()) return new Response(JSON.stringify({success: false, error: 'Description required'}), {headers: corsHeaders});
        if (!category) return new Response(JSON.stringify({success: false, error: 'Category required'}), {headers: corsHeaders});
        if (!payment_mode || !['cash', 'bank'].includes(payment_mode)) return new Response(JSON.stringify({success: false, error: 'Payment mode must be cash or bank'}), {headers: corsHeaders});

        await DB.prepare(
          'INSERT INTO business_expenses (recorded_by, recorded_at, amount, description, category, payment_mode, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(user, new Date().toISOString(), amount, description.trim(), category, payment_mode, notes || '').run();

        return new Response(JSON.stringify({success: true, message: `Expense recorded: ₹${amount} (${payment_mode})`}), {headers: corsHeaders});
      }

      // --- Record Bank Transaction ---
      if (action === 'record-bank-txn') {
        const {type, amount, description, method, notes} = body;
        if (!amount || amount <= 0) return new Response(JSON.stringify({success: false, error: 'Valid amount required'}), {headers: corsHeaders});
        if (!description || !description.trim()) return new Response(JSON.stringify({success: false, error: 'Description required'}), {headers: corsHeaders});
        if (!type || !['deposit', 'withdrawal', 'opening_balance'].includes(type)) return new Response(JSON.stringify({success: false, error: 'Type must be deposit, withdrawal, or opening_balance'}), {headers: corsHeaders});

        await DB.prepare(
          'INSERT INTO bank_transactions (recorded_by, recorded_at, type, amount, description, method, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(user, new Date().toISOString(), type, amount, description.trim(), method || '', notes || '').run();

        const labels = {deposit: 'Bank deposit', withdrawal: 'Bank withdrawal', opening_balance: 'Opening balance'};
        return new Response(JSON.stringify({success: true, message: `${labels[type]} recorded: ₹${amount}`}), {headers: corsHeaders});
      }

      // --- Delete Entry ---
      if (action === 'delete-entry') {
        if (user !== 'Nihaf') return new Response(JSON.stringify({success: false, error: 'Only Nihaf can delete entries'}), {headers: corsHeaders});

        const {table, id} = body;
        if (!['business_expenses', 'bank_transactions'].includes(table)) return new Response(JSON.stringify({success: false, error: 'Invalid table'}), {headers: corsHeaders});
        if (!id) return new Response(JSON.stringify({success: false, error: 'ID required'}), {headers: corsHeaders});

        const result = await DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
        if (result.meta?.changes === 0) return new Response(JSON.stringify({success: false, error: 'Entry not found'}), {headers: corsHeaders});

        return new Response(JSON.stringify({success: true, message: 'Entry deleted'}), {headers: corsHeaders});
      }

      return new Response(JSON.stringify({success: false, error: 'Invalid POST action'}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), {status: 500, headers: corsHeaders});
  }
}

// ═══════════════════════════════════════════════════════
// Cash in Hand: all-time running balance
// = opening_balance + collections + withdrawals - deposits - cash_expenses
// ═══════════════════════════════════════════════════════
async function computeCashInHand(DB) {
  const opening = await DB.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE type = 'opening_balance'
  `).first();

  const collections = await DB.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM cash_collections
  `).first();

  const withdrawals = await DB.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE type = 'withdrawal'
  `).first();

  const deposits = await DB.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE type = 'deposit'
  `).first();

  const cashExpenses = await DB.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM business_expenses WHERE payment_mode = 'cash'
  `).first();

  return opening.total + collections.total + withdrawals.total - deposits.total - cashExpenses.total;
}
