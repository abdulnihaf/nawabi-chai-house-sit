// NCH Cron Worker — fires every 5 minutes.
// Drives three Pages-API endpoints (all logic lives in the Pages Functions):
//   1. wa-alerts?action=cron-tick        — every run (5 min)   — WhatsApp alert checks
//   2. validator?action=scan-recent      — every run (5 min)   — POS tuple validation (idempotent: INSERT OR IGNORE)
//   3. validator?action=razorpay-verify  — every 15 min        — UPI reconciliation (POS UPI vs Razorpay; supersede+insert)
//
// WHY: the validator engine (15-tuple gate + UPI reconciliation) was only ever triggered
// client-side from /ops/settlement/ while a browser was open. UPI reconciliation
// (payment_discrepancies / upi_qr_snapshots) consequently froze on 2026-04-14. This cron
// makes it browser-independent and revives the settlement gate's UPI leg.
//
// Deploy: cd workers/nch-cron && wrangler deploy
// NCH-only. HE settlement is greenfield (its own phase) — not touched here.

const BASE = 'https://nawabichaihouse.com/api';

async function hit(path) {
  try {
    const r = await fetch(BASE + path, { headers: { 'x-cron': 'nch-cron' } });
    let body = null;
    try { body = await r.json(); } catch (_) { /* non-JSON */ }
    if (!r.ok || (body && body.success === false)) {
      console.error('nch-cron FAILED', path, 'status', r.status, body ? JSON.stringify(body).slice(0, 240) : '');
    }
    return { path, ok: r.ok, body };
  } catch (e) {
    console.error('nch-cron ERROR', path, e.message);
    return { path, ok: false, error: e.message };
  }
}

export default {
  async scheduled(event, env, ctx) {
    const minute = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    const tasks = [
      hit('/wa-alerts?action=cron-tick'),
      hit('/validator?action=scan-recent'),
    ];
    // razorpay-verify is heavier (Razorpay REST API, paginated, all QRs) — run every 15 min.
    // Cron fires at minutes 0/5/10/15/...; minute % 15 === 0 → :00 :15 :30 :45.
    if (minute % 15 === 0) {
      tasks.push(hit('/validator?action=razorpay-verify&source=cron_auto'));
    }
    ctx.waitUntil(Promise.all(tasks));
  }
};
