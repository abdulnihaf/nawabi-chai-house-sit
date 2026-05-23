// /api/payment-stream — Server-Sent Events stream of new Razorpay payments per QR.
//
// Browser opens: new EventSource('/api/payment-stream?qr=qr_SBdtUCLSHVfRtT&since=N')
// We poll the razorpay_live_events table every 500ms and stream any rows with
// id > last_seen. Heartbeat every 15 sec keeps the connection alive.
//
// End-to-end latency from webhook receipt to browser event: typically <600ms.
// (Webhook insert is instant; poll cycle catches it within 500ms; SSE push is
// instant.)
//
// Connection lifetime capped at ~25 sec to stay inside Cloudflare Pages timeout.
// EventSource auto-reconnects with the last received id, so the cashier never
// sees a gap — just a brief reconnect that delivers any missed events.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const qrId = url.searchParams.get('qr');
  let since = parseInt(url.searchParams.get('since') || '0', 10);
  if (!qrId) {
    return new Response('qr param required', { status: 400 });
  }
  const DB = env.DB;
  if (!DB) return new Response('DB not configured', { status: 500 });

  // Self-heal table (safe if webhook hasn't been called yet)
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

  // If `since=0`, the browser is starting fresh — bootstrap with the latest event id
  // so we don't dump all of today's history through SSE. This matches the
  // counter-live page's "skip old, only notify for new" behavior.
  if (since === 0) {
    const r = await DB.prepare(
      `SELECT MAX(id) AS max_id FROM razorpay_live_events WHERE qr_id = ?`
    ).bind(qrId).first();
    since = r?.max_id || 0;
  }

  const POLL_INTERVAL_MS = 500;
  const MAX_LIFETIME_MS = 25_000;
  const HEARTBEAT_EVERY_MS = 15_000;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const startTime = Date.now();
      let lastHeartbeat = startTime;
      let lastSeenId = since;

      // Send initial hello so browser knows the connection is open
      controller.enqueue(enc.encode(`event: hello\ndata: ${JSON.stringify({ since: lastSeenId, qr_id: qrId, ts: new Date().toISOString() })}\n\n`));

      const ticker = async () => {
        while (Date.now() - startTime < MAX_LIFETIME_MS) {
          try {
            const r = await DB.prepare(
              `SELECT id, payment_id, qr_id, amount, vpa, captured_at, received_at
                 FROM razorpay_live_events
                WHERE qr_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT 50`
            ).bind(qrId, lastSeenId).all();
            const rows = r.results || [];
            for (const row of rows) {
              controller.enqueue(enc.encode(`event: payment\ndata: ${JSON.stringify(row)}\n\n`));
              lastSeenId = row.id;
            }
          } catch (e) {
            controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`));
          }
          // Heartbeat
          if (Date.now() - lastHeartbeat >= HEARTBEAT_EVERY_MS) {
            controller.enqueue(enc.encode(`event: heartbeat\ndata: ${JSON.stringify({ since: lastSeenId, ts: new Date().toISOString() })}\n\n`));
            lastHeartbeat = Date.now();
          }
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }
        // Lifetime expired — tell client to reconnect with the new `since` cursor
        controller.enqueue(enc.encode(`event: reconnect\ndata: ${JSON.stringify({ since: lastSeenId, reason: 'lifetime_exceeded' })}\n\n`));
        controller.close();
      };
      ticker().catch((e) => {
        try { controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`)); } catch (_) {}
        try { controller.close(); } catch (_) {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
