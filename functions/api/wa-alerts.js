// WhatsApp Alerts API — Shift reports + discrepancy escalation to Naveen
// Uses WABA 8008002049 (Phone ID: 970365416152029)
// All business-initiated messages use plain text (within 24hr window or template)

const WA_PHONE_ID = '970365416152029';

// Alert recipients
const NAVEEN = '918073476051';
const BASHEER = '919061906916';
const TANVEER = '919916399474';
const NIHAF = '917010426808';

// Escalation config (minutes)
const L1_DELAY = 0;    // Immediate — notify responsible person
const L2_DELAY = 30;   // 30 min — escalate to managers
const L3_DELAY = 60;   // 60 min — escalate to Naveen

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: cors});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const env = context.env;

  if (!env.WA_ACCESS_TOKEN) {
    return json({success: false, error: 'WA_ACCESS_TOKEN not configured'}, cors, 500);
  }

  try {
    switch (action) {
      case 'shift-report': return await sendShiftReport(env, cors);
      case 'check-escalations': return await checkEscalations(env, cors);
      case 'test': return await sendTestMessage(env, cors);
      default: return json({success: false, error: `Unknown action: ${action}`}, cors, 400);
    }
  } catch (e) {
    return json({success: false, error: e.message, stack: e.stack}, cors, 500);
  }
}

// ── SHIFT REPORT ──
// Pulls nch-data + sales-insights, formats a summary, sends to Naveen
async function sendShiftReport(env, cors) {
  const baseUrl = 'https://nawabichaihouse.com';

  // Fetch both APIs in parallel (no from param = rolling 24h)
  const [nchRes, salesRes] = await Promise.all([
    fetch(`${baseUrl}/api/nch-data`),
    fetch(`${baseUrl}/api/sales-insights?from=${todayMidnightIST()}`)
  ]);

  const nch = await nchRes.json();
  const sales = await salesRes.json();

  if (!nch.success) return json({success: false, error: 'nch-data failed: ' + nch.error}, cors, 500);

  const d = nch.data;
  const recon = d.shiftReconciliation;
  const bc = recon.balanceCheck;
  const gt = d.grandTotal;

  // Runner token/sales breakdown
  const runners = recon.cashBreakdown.runnerCashObligations || [];
  let runnerLines = '';
  for (const r of runners) {
    const status = r.cashToCollect <= 0 ? '✅' : r.cashToCollect > 1500 ? '🔴' : '🟡';
    runnerLines += `${status} ${r.name}: Tokens ₹${fmt(r.tokens)} | Sales ₹${fmt(r.sales)} | UPI ₹${fmt(r.upi)} | *Cash ₹${fmt(r.cashToCollect)}*\n`;
  }
  if (!runnerLines) runnerLines = 'No active runners\n';

  // Hourly snacks breakdown (from sales-insights)
  let snackLines = '';
  if (sales.success && sales.data) {
    const sd = sales.data;
    // Get snack products
    const snackProducts = (sd.products || []).filter(p => p.category === 'Snacks');
    if (snackProducts.length > 0) {
      snackLines = snackProducts.map(p => `  ${p.name}: ${p.qty} sold (₹${fmt(p.amount)})`).join('\n');
    }

    // Hourly breakdown (last 6 active hours)
    const activeHours = (sd.hourly || []).filter(h => h.orders > 0);
    const recentHours = activeHours.slice(-6);
    if (recentHours.length > 0) {
      snackLines += '\n\n*Hourly Orders:*\n';
      snackLines += recentHours.map(h => `  ${h.label}: ${h.orders} orders (₹${fmt(h.amount)})`).join('\n');
    }
  }
  if (!snackLines) snackLines = 'No snack data available';

  // UPI verification
  const verify = recon.upiVerification;
  const counterVar = verify.cashCounter.variance;
  const rcVar = verify.runnerCounter.variance;
  const upiStatus = (Math.abs(counterVar) <= 1 && Math.abs(rcVar) <= 1)
    ? '✅ UPI Matched'
    : `⚠️ Counter: ₹${fmt(Math.abs(counterVar))} var | Runner Counter: ₹${fmt(Math.abs(rcVar))} var`;

  // Build message
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const timeStr = now.toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit', hour12: true});
  const dateStr = now.toLocaleDateString('en-IN', {day: '2-digit', month: 'short'});

  const msg = `*NCH Shift Report — ${dateStr} ${timeStr}*

📊 *Sales Summary*
Total Sales: *₹${fmt(gt.allSales)}* (${nch.counts.orders} orders)
Counter: ₹${fmt(d.mainCounter.total)} (${d.mainCounter.orderCount} orders)
Runner Counter: ₹${fmt(d.runnerCounter.total)} (${d.runnerCounter.orderCount} orders)
Token Issue: ₹${fmt(gt.tokenIssue)}

💰 *Cash & UPI*
Expected Cash: *₹${fmt(recon.expectedTotalCash)}*
Accounted Cash: ₹${fmt(bc.accountedCash)}
Verified UPI (Razorpay): ₹${fmt(recon.verifiedUPI.total)}
Card: ₹${fmt(recon.card)}
Complimentary: ₹${fmt(recon.complimentary)}

${bc.isBalanced ? '✅ *Shift Balanced*' : `🔴 *Variance: ₹${fmt(Math.abs(bc.variance))}* (${bc.variance > 0 ? 'cash short' : 'cash excess'})`}

${upiStatus}

🏃 *Runner Breakdown*
${runnerLines}
${recon.crossPayments?.length > 0 ? `↔️ ${recon.crossPayments.length} cross-payment(s)\n` : ''}${d.discrepancies?.length > 0 ? `⚠️ ${d.discrepancies.length} discrepancy/ies\n` : ''}
🍽️ *Snacks*
${snackLines}`;

  // Send to Naveen
  const result = await sendWA(env.WA_ACCESS_TOKEN, NAVEEN, msg);

  return json({
    success: true,
    sent_to: 'Naveen',
    message_length: msg.length,
    send_result: result
  }, cors);
}

// ── DISCREPANCY ESCALATION ──
// Checks validation_errors table for unresolved errors and escalates
async function checkEscalations(env, cors) {
  const DB = env.DB;
  if (!DB) return json({success: false, error: 'DB not configured'}, cors, 500);

  // Get all pending errors with age
  const rows = await DB.prepare(`
    SELECT ve.*,
      ROUND((julianday('now') - julianday(ve.detected_at)) * 24 * 60) as age_minutes
    FROM validation_errors ve
    WHERE ve.status = 'pending'
    ORDER BY ve.detected_at ASC
  `).all();

  const errors = rows.results || [];
  if (errors.length === 0) {
    return json({success: true, message: 'No pending errors', escalations: 0}, cors);
  }

  // Check what we've already notified (prevent spam)
  const notified = await DB.prepare(`
    SELECT error_id, MAX(level) as max_level
    FROM wa_escalation_log
    WHERE notified_at >= datetime('now', '-4 hours')
    GROUP BY error_id
  `).all().catch(() => ({results: []}));

  const notifiedMap = {};
  for (const n of (notified.results || [])) {
    notifiedMap[n.error_id] = n.max_level;
  }

  const escalations = [];

  // Group by escalation level
  const l1Errors = []; // < 30 min, not yet notified
  const l2Errors = []; // 30-60 min, L1 sent but not L2
  const l3Errors = []; // > 60 min, L2 sent but not L3

  for (const err of errors) {
    const age = err.age_minutes || 0;
    const prevLevel = notifiedMap[err.id] || 0;

    if (age < L2_DELAY && prevLevel < 1) {
      l1Errors.push(err);
    } else if (age >= L2_DELAY && age < L3_DELAY && prevLevel < 2) {
      l2Errors.push(err);
    } else if (age >= L3_DELAY && prevLevel < 3) {
      l3Errors.push(err);
    }
  }

  // L1: Notify Naveen about new errors (responsible person gets push via existing system)
  if (l1Errors.length > 0) {
    const lines = l1Errors.map(e =>
      `• ${e.order_ref || 'Order #' + e.order_id}: ${e.error_type_label || e.error_type} — ₹${fmt(e.amount)}`
    ).join('\n');

    const msg = `⚠️ *NCH — ${l1Errors.length} New Error${l1Errors.length > 1 ? 's' : ''}*\n\n${lines}\n\nFix: nawabichaihouse.com/ops/settlement/`;
    await sendWA(env.WA_ACCESS_TOKEN, NAVEEN, msg);
    await logEscalations(DB, l1Errors, 1, 'naveen');
    escalations.push({level: 1, count: l1Errors.length, sent_to: 'Naveen'});
  }

  // L2: Escalate to managers (Basheer + Tanveer)
  if (l2Errors.length > 0) {
    const totalAmt = l2Errors.reduce((s, e) => s + (e.amount || 0), 0);
    const msg = `🔴 *NCH — ${l2Errors.length} Unresolved Error${l2Errors.length > 1 ? 's' : ''} (30+ min)*\n\nTotal: ₹${fmt(totalAmt)}\n\n` +
      l2Errors.map(e => `• ${e.order_ref || '#' + e.order_id}: ${e.error_type_label || e.error_type} — ₹${fmt(e.amount)} (${Math.round(e.age_minutes)}min ago)`).join('\n') +
      `\n\nFix: nawabichaihouse.com/ops/settlement/`;

    await Promise.all([
      sendWA(env.WA_ACCESS_TOKEN, BASHEER, msg),
      sendWA(env.WA_ACCESS_TOKEN, TANVEER, msg),
    ]);
    await logEscalations(DB, l2Errors, 2, 'basheer,tanveer');
    escalations.push({level: 2, count: l2Errors.length, sent_to: 'Basheer, Tanveer'});
  }

  // L3: Final escalation to Naveen
  if (l3Errors.length > 0) {
    const totalAmt = l3Errors.reduce((s, e) => s + (e.amount || 0), 0);
    const msg = `🚨 *NCH ESCALATION — ${l3Errors.length} Error${l3Errors.length > 1 ? 's' : ''} Pending 1hr+*\n\nTotal unaccounted: *₹${fmt(totalAmt)}*\n\n` +
      l3Errors.map(e => `• ${e.order_ref || '#' + e.order_id}: ${e.error_type_label || e.error_type} — ₹${fmt(e.amount)} (${Math.round(e.age_minutes)}min)`).join('\n') +
      `\n\nBasheer & Tanveer were notified 30min ago.\n\nFix: nawabichaihouse.com/ops/settlement/`;

    await sendWA(env.WA_ACCESS_TOKEN, NAVEEN, msg);
    await logEscalations(DB, l3Errors, 3, 'naveen_escalation');
    escalations.push({level: 3, count: l3Errors.length, sent_to: 'Naveen (escalation)'});
  }

  return json({
    success: true,
    total_pending: errors.length,
    escalations,
    summary: {
      l1_new: l1Errors.length,
      l2_unresolved: l2Errors.length,
      l3_critical: l3Errors.length
    }
  }, cors);
}

// ── Test message ──
async function sendTestMessage(env, cors) {
  const msg = `✅ *NCH WhatsApp Alerts — Test*\n\nIf you see this, shift reports and escalation alerts are working.\n\nTime: ${new Date(Date.now() + 5.5 * 60 * 60 * 1000).toLocaleString('en-IN')}`;
  const result = await sendWA(env.WA_ACCESS_TOKEN, NAVEEN, msg);
  return json({success: true, sent_to: 'Naveen', result}, cors);
}

// ── Helpers ──

async function sendWA(token, to, text) {
  const url = `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: {body: text}
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('WA send error:', res.status, JSON.stringify(data));
      return {ok: false, status: res.status, error: data};
    }
    return {ok: true, message_id: data.messages?.[0]?.id};
  } catch (e) {
    console.error('WA send exception:', e.message);
    return {ok: false, error: e.message};
  }
}

async function logEscalations(DB, errors, level, sentTo) {
  try {
    // Create table if not exists (first run)
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS wa_escalation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        error_id INTEGER NOT NULL,
        level INTEGER NOT NULL,
        sent_to TEXT,
        notified_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    for (const err of errors) {
      await DB.prepare(
        'INSERT INTO wa_escalation_log (error_id, level, sent_to) VALUES (?, ?, ?)'
      ).bind(err.id, level, sentTo).run();
    }
  } catch (e) {
    console.error('Escalation log error:', e.message);
  }
}

function todayMidnightIST() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10) + 'T00:00:00';
}

function fmt(n) {
  return n != null ? Math.round(n).toLocaleString('en-IN') : '0';
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: cors});
}
