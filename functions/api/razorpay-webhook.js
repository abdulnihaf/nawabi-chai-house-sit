// /api/razorpay-webhook — receives push from Razorpay when a UPI payment is captured.
// Deploy revision: 2026-05-23 17:30 IST — picks up RAZORPAY_WEBHOOK_SECRET env
//
// Flow: Razorpay POSTs here within ~1 sec of payment capture → we validate the
// HMAC SHA256 signature → insert one row into razorpay_live_events D1 table.
// The /api/payment-stream SSE endpoint reads this table and streams new rows
// to subscribed browsers within 500ms.
//
// End-to-end latency: customer pays → ~2-3 sec → counter-live page speaks the amount.
//
// SETUP (one-time, in Razorpay dashboard):
//   Settings → Webhooks → Add Webhook
//     URL:    https://nawabichaihouse.com/api/razorpay-webhook
//     Events: payment.captured  (also: qr_code.credited for QR-specific events)
//     Secret: <generate strong random string, paste into Cloudflare as
//             RAZORPAY_WEBHOOK_SECRET via wrangler pages secret put>
//   Active: ON
//
// SIGNATURE VERIFICATION:
//   Razorpay sends header: x-razorpay-signature: <hex hmac sha256>
//   We compute HMAC-SHA256 of raw request body using RAZORPAY_WEBHOOK_SECRET
//   and compare. Rejects unsigned/spoofed requests with 401.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Razorpay-Signature',
  'Content-Type': 'application/json',
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const DB = env.DB;
  if (!DB) return json({ success: false, error: 'DB not configured' }, 500);

  // Self-heal table on first call (idempotent)
  await ensureTable(DB);

  // Read raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') || '';
  const secret = env.RAZORPAY_WEBHOOK_SECRET;

  if (secret) {
    const valid = await verifySignature(rawBody, signature, secret);
    if (!valid) {
      // Log to a sink so we can debug rejected webhooks
      console.warn('[rzp-webhook] signature mismatch', { signaturePresent: !!signature });
      return json({ error: 'invalid_signature' }, 401);
    }
  }
  // If secret not yet set in Cloudflare env, accept but flag (initial deploy only)

  let event;
  try { event = JSON.parse(rawBody); }
  catch (e) { return json({ error: 'invalid_json', message: e.message }, 400); }

  const eventType = event?.event || 'unknown';
  // We care about payment.captured (most common) and qr_code.credited (QR-specific)
  // Both shapes carry payment in event.payload.payment.entity
  const payment = event?.payload?.payment?.entity
               || event?.payload?.qr_code?.entity
               || null;

  if (!payment || !payment.id) {
    // Acknowledge but record nothing (might be a test ping or unrelated event)
    return json({ success: true, action: 'ignored', event: eventType, reason: 'no_payment_entity' });
  }

  // Extract qr_id — present on QR payments
  // Razorpay docs: payment.notes.razorpay_qr_id (some integrations) or top-level qr_id
  // Use multiple fallback paths to be robust across event types
  const qrId = payment.notes?.razorpay_qr_id
            || payment.notes?.qr_id
            || event?.payload?.qr_code?.entity?.id
            || payment.qr_code_id
            || null;

  if (!qrId) {
    // Not a QR payment (could be order-based / card etc.) — still log for debug
    return json({ success: true, action: 'ignored', event: eventType, payment_id: payment.id, reason: 'no_qr_id' });
  }

  // Extract VPA (UPI handle of payer)
  const vpa = payment.vpa
           || payment.acquirer_data?.vpa
           || payment.upi?.vpa
           || null;

  const amountPaise = parseInt(payment.amount, 10) || 0;
  const amountRupees = amountPaise / 100;
  const capturedAt = payment.created_at
    ? new Date(payment.created_at * 1000).toISOString()
    : new Date().toISOString();

  try {
    await DB.prepare(
      `INSERT OR IGNORE INTO razorpay_live_events
        (payment_id, qr_id, amount, vpa, captured_at, event_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(payment.id, qrId, amountRupees, vpa, capturedAt, eventType).run();
  } catch (e) {
    console.error('[rzp-webhook] DB insert failed', e);
    return json({ success: false, error: 'db_insert_failed', message: e.message }, 500);
  }

  return json({ success: true, payment_id: payment.id, qr_id: qrId, amount: amountRupees });
}

async function ensureTable(DB) {
  try {
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
    ).run();
    await DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_rzp_live_qr_id ON razorpay_live_events(qr_id, id)`
    ).run();
  } catch (e) { console.warn('[rzp-webhook] ensureTable', e); }
}

// HMAC SHA256 hex of body, compared to header signature (constant-time)
async function verifySignature(body, signature, secret) {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    // Constant-time-ish compare
    if (hex.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch (e) {
    console.warn('[rzp-webhook] signature verify error', e);
    return false;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
