// /api/counter-recent?qr=qr_xxx&limit=30 — returns last N payments + today's total for a QR.
// Reads from razorpay_live_events D1 table (populated by /api/razorpay-webhook).
// Used by ops/counter-live/ for bootstrap totals + recent list.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const qr = url.searchParams.get('qr');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 200);
  if (!qr) return json({ success: false, error: 'qr param required' }, 400);

  const DB = env.DB;
  if (!DB) return json({ success: false, error: 'DB not configured' }, 500);

  // Self-heal table (harmless if already exists)
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS razorpay_live_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT UNIQUE NOT NULL,
      qr_id TEXT NOT NULL,
      amount REAL NOT NULL,
      vpa TEXT,
      captured_at TEXT,
      received_at TEXT DEFAULT (datetime('now')),
      event_type TEXT
    )`
  ).run().catch(() => {});

  // Today bounds in IST (00:00 IST = previous day 18:30 UTC)
  const todayIstStart = (() => {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 3600000);
    const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
    return new Date(istMidnight.getTime() - 5.5 * 3600000).toISOString();
  })();

  try {
    // Recent N payments for this QR
    const recent = await DB.prepare(
      `SELECT id, payment_id, qr_id, amount, vpa, captured_at, received_at
         FROM razorpay_live_events
        WHERE qr_id = ?
        ORDER BY id DESC
        LIMIT ?`
    ).bind(qr, limit).all();

    // Today totals (since IST midnight)
    const totals = await DB.prepare(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS sum_amt
         FROM razorpay_live_events
        WHERE qr_id = ?
          AND COALESCE(captured_at, received_at) >= ?`
    ).bind(qr, todayIstStart).first();

    return json({
      success: true,
      qr_id: qr,
      total_amount: totals?.sum_amt || 0,
      total_count: totals?.cnt || 0,
      payments: (recent.results || []).map(r => ({
        id: r.payment_id,
        amount: r.amount,
        vpa: r.vpa,
        time: r.captured_at || r.received_at,
      })),
    });
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
