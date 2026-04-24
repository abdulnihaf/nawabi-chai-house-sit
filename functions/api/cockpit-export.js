// NCH cockpit-export — read-only feed for HN Money Cockpit aggregator.
//
// Called server-to-server from hnhotels.in/api/money. Auth via shared
// COCKPIT_TOKEN env var (set with: wrangler pages secret put COCKPIT_TOKEN).
//
// Surfaces every counter_expenses_v2 row in an IST date window with the
// fields the cockpit needs to:
//   - merge against business_expenses (HN central mirror)
//   - flag rows whose Odoo dual-write almost-certainly failed (orphans)
//   - run dup-detection across sources
//
// IMPORTANT: read-only. No writes. CORS off (server-to-server only).

const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB = 'main';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// IST midnight of a YYYY-MM-DD date, returned as the equivalent UTC ISO
// timestamp string (so it compares correctly against recorded_at which is
// stored as `new Date().toISOString()` — UTC with Z suffix).
//   istDayStartUTC('2026-04-24') → '2026-04-23T18:30:00.000Z'
function istDayStartUTC(ymd) {
  const utcMid = Date.parse(`${ymd}T00:00:00.000Z`);
  return new Date(utcMid - 5.5 * 3600 * 1000).toISOString();
}

function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

export async function onRequest(context) {
  const { request, env } = context;

  // Auth
  const expected = env.COCKPIT_TOKEN;
  if (!expected) return json({ success: false, error: 'COCKPIT_TOKEN not set on NCH' }, 500);
  const got = request.headers.get('x-cockpit-token') || '';
  if (got !== expected) return json({ success: false, error: 'Unauthorized' }, 401);

  if (!env.DB) return json({ success: false, error: 'DB not configured' }, 500);

  const url = new URL(request.url);
  const from = url.searchParams.get('from') || todayIST();
  const to = url.searchParams.get('to') || todayIST();

  // Validate dates
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ success: false, error: 'from/to must be YYYY-MM-DD' }, 400);
  }

  // Filter against IST day window — IST midnight start of `from` (inclusive)
  // through IST midnight start of (to + 1 day) (exclusive).
  const startUTC = istDayStartUTC(from);
  const toPlus1 = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86400000)
    .toISOString().slice(0, 10);
  const endUTC = istDayStartUTC(toPlus1);

  try {
    const rows = await env.DB.prepare(
      `SELECT id, category_code, amount, description, recorded_by, recorded_by_name,
              pin_verified, recorded_at, shift_id
         FROM counter_expenses_v2
        WHERE recorded_at >= ? AND recorded_at < ?
        ORDER BY recorded_at DESC`
    ).bind(startUTC, endUTC).all();

    // Normalize to the shape the cockpit aggregator expects.
    const normalized = (rows.results || []).map((r) => ({
      source: 'NCH-Outlet',
      brand: 'NCH',
      kind: 'Expense',
      state: 'paid',                       // Outlet entries are always cash from till
      payment_method: 'cash',
      source_id: r.id,                     // counter_expenses_v2.id
      odoo_id: null,                       // No client-side capture; HN side will fuzzy-match
      recorded_at: r.recorded_at,          // UTC ISO
      ist_date: istDateOf(r.recorded_at),  // YYYY-MM-DD in IST
      amount: r.amount,
      category_code: r.category_code,
      vendor_id: null,
      vendor_name: null,
      item: null,                          // Outlet entries don't pick a product
      description: r.description || '',
      recorded_by_pin: null,               // Not stored; recorded_by is staff slot
      recorded_by_name: r.recorded_by_name || null,
      shift_id: r.shift_id || null,
    }));

    // ── Phase 3: optional cash_summary for /ops/money/ Cash Position card ──
    // Trigger with ?include=cash_summary. Aggregates today's expense outflow,
    // today's cash collections (in transit + with collector), and petty cash
    // balance. PURE READ — no schema changes.
    let cash_summary = null;
    if ((url.searchParams.get('include') || '').includes('cash_summary')) {
      try {
        // Today's expenses out (already filtered above for the date range — but for
        // cash_summary we want strictly TODAY in IST regardless of from/to params)
        const todayStartUTC = istDayStartUTC(istTodayDate());
        const expRow = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n
             FROM counter_expenses_v2
            WHERE recorded_at >= ?`
        ).bind(todayStartUTC).first().catch(() => ({ total: 0, n: 0 }));

        // In-transit collections (collected from drawer, not yet handed to final dest)
        const inTransitRow = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n,
                  GROUP_CONCAT(collector_name || ': ' || amount, ', ') AS breakdown
             FROM cash_collections
            WHERE status = 'in_transit'`
        ).first().catch(() => ({ total: 0, n: 0, breakdown: null }));

        // Petty cash balance (single-row table)
        const pettyRow = await env.DB.prepare(
          `SELECT current_balance, last_funded_at FROM petty_cash_balance WHERE id = 1`
        ).first().catch(() => null);

        cash_summary = {
          today_expenses_out: expRow.total || 0,
          today_expenses_count: expRow.n || 0,
          in_transit_total: inTransitRow.total || 0,
          in_transit_count: inTransitRow.n || 0,
          in_transit_breakdown: inTransitRow.breakdown || '',
          petty_balance: pettyRow?.current_balance || 0,
          petty_last_funded: pettyRow?.last_funded_at || null,
        };
      } catch (e) {
        cash_summary = { error: e.message };
      }
    }

    return json({
      success: true,
      brand: 'NCH',
      from, to,
      count: normalized.length,
      total: normalized.reduce((s, r) => s + (r.amount || 0), 0),
      rows: normalized,
      cash_summary,
    });
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

// IST today date (YYYY-MM-DD)
function istTodayDate() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function istDateOf(utcIso) {
  const t = Date.parse(utcIso);
  if (Number.isNaN(t)) return null;
  return new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
