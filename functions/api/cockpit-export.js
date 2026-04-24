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

    return json({
      success: true,
      brand: 'NCH',
      from, to,
      count: normalized.length,
      total: normalized.reduce((s, r) => s + (r.amount || 0), 0),
      rows: normalized,
    });
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

function istDateOf(utcIso) {
  const t = Date.parse(utcIso);
  if (Number.isNaN(t)) return null;
  return new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
