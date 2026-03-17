// NCH Intelligent Alert System — WhatsApp + FCM Push
// Uses WABA 8008002049 (Phone ID: 970365416152029)
// FCM push via /api/hub?action=push-to-slots
//
// Alert types:
//   E1-E4: Validation error escalation
//   R1-R2: Runner cash thresholds
//   C1-C3: Cash collection lifecycle
//   P1-P2: Petty cash warnings
//   S1:    Shift reports
//   U1:    UPI mismatch

const WA_PHONE_ID = '970365416152029';
const BASE_URL = 'https://nawabichaihouse.com';

// Escalation config (minutes)
const L2_DELAY = 30;
const L3_DELAY = 60;

// Staff slot codes
const NAVEEN_SLOT = 'ADMIN002';
const BASHEER_SLOT = 'GM001';
const TANVEER_SLOT = 'MGR001';

// Runner cash thresholds
const RUNNER_CASH_WARN = 1500;   // FCM only
const RUNNER_CASH_URGENT = 2500; // FCM + WhatsApp

// Shift report hours (IST)
const SHIFT_REPORT_HOURS = [14, 22]; // 2PM and 10PM

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

  const phones = await loadPhones(env.DB);

  try {
    switch (action) {
      case 'shift-report':      return await sendShiftReport(env, phones, cors);
      case 'check-escalations': return await checkEscalations(env, phones, cors);
      case 'cron-tick':         return await cronTick(env, phones, cors);
      case 'send-alert':        return await handleSendAlert(context, env, phones, cors);
      case 'test':              return await sendTestMessage(env, phones, cors);
      default: return json({success: false, error: `Unknown action: ${action}`}, cors, 400);
    }
  } catch (e) {
    return json({success: false, error: e.message, stack: e.stack}, cors, 500);
  }
}

// ══════════════════════════════════════════════════════════════
// CRON TICK — runs every 5 minutes, checks all periodic alerts
// ══════════════════════════════════════════════════════════════

async function cronTick(env, phones, cors) {
  const DB = env.DB;
  if (!DB) return json({success: false, error: 'DB not configured'}, cors, 500);

  const results = {};

  // Fetch nch-data ONCE — shared by R1, R2, U1
  let nchData = null;
  try {
    const res = await fetch(`${BASE_URL}/api/nch-data`);
    const nch = await res.json();
    if (nch.success) nchData = nch;
  } catch (e) { results.nch_data_fetch = {error: e.message}; }

  // 1. Error escalations (E2/E3/E4)
  try {
    const escResult = await checkEscalations(env, phones, cors);
    const escData = await escResult.clone().json();
    results.escalations = escData;
  } catch (e) { results.escalations = {error: e.message}; }

  // 2. Runner cash thresholds (R1)
  try { results.runner_cash = await checkRunnerCash(env, phones, nchData); }
  catch (e) { results.runner_cash = {error: e.message}; }

  // 3. Runner settlement blocking (R2)
  try { results.runner_blocked = await checkRunnerBlocked(env, phones, nchData); }
  catch (e) { results.runner_blocked = {error: e.message}; }

  // 4. Stale in-transit cash (C3)
  try { results.stale_cash = await checkStaleCash(env, phones); }
  catch (e) { results.stale_cash = {error: e.message}; }

  // 5. Petty cash (P1 negative, P2 low)
  try { results.petty = await checkPetty(env, phones); }
  catch (e) { results.petty = {error: e.message}; }

  // 6. UPI variance (U1)
  try { results.upi = await checkUpiVariance(env, phones, nchData); }
  catch (e) { results.upi = {error: e.message}; }

  // 7. Shift report at scheduled hours (S1)
  try { results.shift_report = await checkShiftReportSchedule(env, phones); }
  catch (e) { results.shift_report = {error: e.message}; }

  return json({success: true, cron_results: results}, cors);
}

// ══════════════════════════════════════════════════════════════
// SEND-ALERT — event-driven alerts fired from other APIs
// ══════════════════════════════════════════════════════════════

async function handleSendAlert(context, env, phones, cors) {
  if (context.request.method !== 'POST') {
    return json({error: 'POST required'}, cors, 405);
  }
  const body = await context.request.json();
  const {alert, data} = body;
  if (!alert || !data) return json({error: 'alert and data required'}, cors, 400);

  const DB = env.DB;
  const token = env.WA_ACCESS_TOKEN;
  const results = [];

  switch (alert) {
    // ── E1: New validation error → FCM to assigned staff ──
    case 'E1': {
      const {error_id, runner_slot, cashier_name, order_ref, error_type_label, amount} = data;
      const slot = runner_slot || null;
      if (slot) {
        const sent = await sendFCM(env, [slot], {
          title: 'NCH: Error on your order',
          body: `${order_ref}: ${error_type_label} — ₹${fmt(amount)}. Fix in settlement page.`,
          tag: 'nch_error',
          url: `${BASE_URL}/ops/settlement/`
        });
        results.push({alert: 'E1', channel: 'fcm', slot, sent});
        await logAlert(DB, 'E1', `error:${error_id}`, 'fcm', slot);
      }
      break;
    }

    // ── C1: Cash collected in-transit → WA + FCM to Naveen ──
    case 'C1': {
      const {amount, collector_name, collector_slot, collection_id} = data;
      const now = istNow();
      const msg = `💰 *Cash Collected — In Transit*\n\n₹${fmt(amount)} collected by *${collector_name}* at ${now.time}\n\nConfirm receipt: ${BASE_URL}/ops/settlement/`;

      if (phones[NAVEEN_SLOT]) {
        await sendWA(token, phones[NAVEEN_SLOT], msg);
        results.push({alert: 'C1', channel: 'wa', to: 'Naveen'});
      }
      await sendFCM(env, [NAVEEN_SLOT], {
        title: `₹${fmt(amount)} cash in transit`,
        body: `Collected by ${collector_name}. Confirm receipt.`,
        tag: 'nch_cash_collection',
        url: `${BASE_URL}/ops/settlement/`
      });
      results.push({alert: 'C1', channel: 'fcm', to: 'Naveen'});
      await logAlert(DB, 'C1', `collection:${collection_id}`, 'both', NAVEEN_SLOT);
      break;
    }

    // ── C2: Naveen confirmed receipt → FCM to collector ──
    case 'C2': {
      const {amount, collector_slot, collector_name, collection_id} = data;
      if (collector_slot) {
        await sendFCM(env, [collector_slot], {
          title: 'Cash received confirmed',
          body: `Naveen confirmed ₹${fmt(amount)} received.`,
          tag: 'nch_cash_confirmed',
          url: `${BASE_URL}/ops/settlement/`
        });
        results.push({alert: 'C2', channel: 'fcm', to: collector_slot});
        await logAlert(DB, 'C2', `collection:${collection_id}`, 'fcm', collector_slot);
      }
      break;
    }

    // ── P1: Petty cash went negative → WA to Naveen, FCM to Basheer ──
    case 'P1': {
      const {balance, last_expense_by} = data;
      if (!await shouldAlert(DB, 'P1', 'petty_negative', 240)) break; // 4hr cooldown

      const msg = `🔴 *Petty Cash Negative: ₹${fmt(Math.abs(balance))}*\n\nLast expense by ${last_expense_by || 'staff'}.\nReimburse: ${BASE_URL}/ops/settlement/`;
      if (phones[NAVEEN_SLOT]) {
        await sendWA(token, phones[NAVEEN_SLOT], msg);
        results.push({alert: 'P1', channel: 'wa', to: 'Naveen'});
      }
      await sendFCM(env, [NAVEEN_SLOT, BASHEER_SLOT], {
        title: 'Petty cash negative!',
        body: `Balance: -₹${fmt(Math.abs(balance))}. Reimbursement needed.`,
        tag: 'nch_petty_negative',
        url: `${BASE_URL}/ops/settlement/`
      });
      results.push({alert: 'P1', channel: 'fcm', to: 'Naveen,Basheer'});
      await logAlert(DB, 'P1', 'petty_negative', 'both', NAVEEN_SLOT);
      break;
    }

    default:
      return json({error: `Unknown alert type: ${alert}`}, cors, 400);
  }

  return json({success: true, alerts_sent: results}, cors);
}

// ══════════════════════════════════════════════════════════════
// PERIODIC CHECKS (called from cronTick)
// ══════════════════════════════════════════════════════════════

// ── R1: Runner cash thresholds ──
async function checkRunnerCash(env, phones, nchData) {
  const DB = env.DB;
  const token = env.WA_ACCESS_TOKEN;
  const alerts = [];

  const nch = nchData || await fetch(`${BASE_URL}/api/nch-data`).then(r => r.json());
  if (!nch.success) return {error: 'nch-data failed'};

  const runners = nch.data?.shiftReconciliation?.cashBreakdown?.runnerCashObligations || [];

  for (const r of runners) {
    if (r.cashToCollect <= RUNNER_CASH_WARN) continue;

    const slot = r.barcode || r.slot || runnerNameToSlot(r.name);
    if (!slot) continue;

    const topicKey = `runner_cash:${slot}`;
    if (!await shouldAlert(DB, 'R1', topicKey, 30)) continue;

    // FCM always
    await sendFCM(env, [slot], {
      title: `₹${fmt(r.cashToCollect)} unsettled cash`,
      body: `${slot}: ₹${fmt(r.cashToCollect)} to settle with cashier.`,
      tag: 'nch_runner_cash',
      url: `${BASE_URL}/ops/runner/`
    });
    alerts.push({slot, amount: r.cashToCollect, channel: 'fcm'});

    // WhatsApp if urgent
    if (r.cashToCollect > RUNNER_CASH_URGENT && phones[slot]) {
      await sendWA(token, phones[slot], `🔴 *NCH — ₹${fmt(r.cashToCollect)} unsettled cash*\n\n${slot}, settle with cashier immediately.\n\nTokens: ₹${fmt(r.tokens)} | Sales: ₹${fmt(r.sales)} | UPI: ₹${fmt(r.upi)}`);
      alerts.push({slot, amount: r.cashToCollect, channel: 'wa'});
    }

    await logAlert(DB, 'R1', topicKey, r.cashToCollect > RUNNER_CASH_URGENT ? 'both' : 'fcm', slot);
  }

  return {checked: runners.length, alerts};
}

// ── R2: Runner blocked from settlement (has errors + cash) ──
async function checkRunnerBlocked(env, phones, nchData) {
  const DB = env.DB;
  const alerts = [];

  // Get runners with pending errors
  const rows = await DB.prepare(`
    SELECT runner_slot, COUNT(*) as error_count
    FROM validation_errors
    WHERE status = 'pending' AND runner_slot IS NOT NULL
    GROUP BY runner_slot
  `).all();

  const runnersWithErrors = rows.results || [];
  if (runnersWithErrors.length === 0) return {alerts: []};

  // Get runner cash from nch-data
  const nch = nchData || await fetch(`${BASE_URL}/api/nch-data`).then(r => r.json());
  if (!nch.success) return {error: 'nch-data failed'};

  const obligations = nch.data?.shiftReconciliation?.cashBreakdown?.runnerCashObligations || [];
  const cashBySlot = {};
  for (const r of obligations) {
    const slot = r.barcode || r.slot || runnerNameToSlot(r.name);
    if (slot) cashBySlot[slot] = r.cashToCollect;
  }

  for (const r of runnersWithErrors) {
    const cash = cashBySlot[r.runner_slot] || 0;
    if (cash <= 0) continue; // No cash to settle, not blocking

    const topicKey = `runner_blocked:${r.runner_slot}`;
    if (!await shouldAlert(DB, 'R2', topicKey, 30)) continue;

    // FCM to runner
    await sendFCM(env, [r.runner_slot], {
      title: `Can't settle — ${r.error_count} error${r.error_count > 1 ? 's' : ''} pending`,
      body: `Fix errors before settling ₹${fmt(cash)}. Ask cashier for help.`,
      tag: 'nch_runner_blocked',
      url: `${BASE_URL}/ops/runner/`
    });

    // FCM to cashiers
    await sendFCM(env, ['CASH001', 'CASH002'], {
      title: `${r.runner_slot} can't settle`,
      body: `${r.error_count} error${r.error_count > 1 ? 's' : ''} blocking ₹${fmt(cash)} settlement. Fix in settlement page.`,
      tag: 'nch_settlement_blocked',
      url: `${BASE_URL}/ops/settlement/`
    });

    await logAlert(DB, 'R2', topicKey, 'fcm', r.runner_slot);
    alerts.push({runner: r.runner_slot, errors: r.error_count, cash});
  }

  return {alerts};
}

// ── C3: Stale in-transit cash (>2 hours) ──
async function checkStaleCash(env, phones) {
  const DB = env.DB;
  const token = env.WA_ACCESS_TOKEN;
  const alerts = [];

  const rows = await DB.prepare(`
    SELECT *, ROUND((julianday('now') - julianday(collected_at)) * 24, 1) as hours_ago
    FROM cash_collections
    WHERE status = 'in_transit'
      AND collected_at <= datetime('now', '-2 hours')
    ORDER BY collected_at ASC
  `).all();

  for (const c of (rows.results || [])) {
    const topicKey = `stale_cash:${c.id}`;
    if (!await shouldAlert(DB, 'C3', topicKey, 60)) continue;

    // WA to Naveen
    const msg = `⏰ *Cash In Transit — ${Math.round(c.hours_ago)}hrs*\n\n₹${fmt(c.amount)} collected by *${c.collected_by_name}* ${Math.round(c.hours_ago)} hours ago.\n\nConfirm: ${BASE_URL}/ops/settlement/`;
    if (phones[NAVEEN_SLOT]) {
      await sendWA(token, phones[NAVEEN_SLOT], msg);
    }

    // FCM to collector
    const collectorSlot = c.collected_by; // slot_code
    if (collectorSlot) {
      await sendFCM(env, [collectorSlot], {
        title: `Cash handover pending`,
        body: `₹${fmt(c.amount)} collected ${Math.round(c.hours_ago)}hrs ago. Hand over to Naveen.`,
        tag: 'nch_stale_cash',
        url: `${BASE_URL}/ops/settlement/`
      });
    }

    await logAlert(DB, 'C3', topicKey, 'both', NAVEEN_SLOT);
    alerts.push({collection_id: c.id, amount: c.amount, collector: c.collected_by_name, hours: c.hours_ago});
  }

  return {alerts};
}

// ── P1/P2: Petty cash checks ──
async function checkPetty(env, phones) {
  const DB = env.DB;
  const token = env.WA_ACCESS_TOKEN;
  const result = {alerts: []};

  const bal = await DB.prepare('SELECT current_balance FROM petty_cash_balance WHERE id = 1').first();
  if (!bal) return {error: 'No petty_cash_balance row'};

  const balance = bal.current_balance;

  // P1: Negative
  if (balance < 0) {
    if (await shouldAlert(DB, 'P1', 'petty_negative', 240)) {
      const msg = `🔴 *Petty Cash Negative: ₹${fmt(Math.abs(balance))}*\n\nReimburse: ${BASE_URL}/ops/settlement/`;
      if (phones[NAVEEN_SLOT]) {
        await sendWA(token, phones[NAVEEN_SLOT], msg);
      }
      await sendFCM(env, [NAVEEN_SLOT, BASHEER_SLOT], {
        title: 'Petty cash negative!',
        body: `Balance: -₹${fmt(Math.abs(balance))}. Reimbursement needed.`,
        tag: 'nch_petty_negative',
        url: `${BASE_URL}/ops/settlement/`
      });
      await logAlert(DB, 'P1', 'petty_negative', 'both', NAVEEN_SLOT);
      result.alerts.push({type: 'P1', balance});
    }
  }
  // P2: Low (< ₹500 but not negative)
  else if (balance < 500) {
    const todayKey = `petty_low:${todayDateIST()}`;
    if (await shouldAlert(DB, 'P2', todayKey, 1440)) { // once per day
      await sendFCM(env, [NAVEEN_SLOT, BASHEER_SLOT], {
        title: 'Petty cash low',
        body: `Balance: ₹${fmt(balance)}. Consider topping up.`,
        tag: 'nch_petty_low',
        url: `${BASE_URL}/ops/settlement/`
      });
      await logAlert(DB, 'P2', todayKey, 'fcm', NAVEEN_SLOT);
      result.alerts.push({type: 'P2', balance});
    }
  }

  result.balance = balance;
  return result;
}

// ── U1: UPI variance ──
async function checkUpiVariance(env, phones, nchData) {
  const DB = env.DB;
  const token = env.WA_ACCESS_TOKEN;
  const alerts = [];

  const nch = nchData || await fetch(`${BASE_URL}/api/nch-data`).then(r => r.json());
  if (!nch.success) return {error: 'nch-data failed'};

  const verify = nch.data?.shiftReconciliation?.upiVerification;
  if (!verify) return {skipped: 'no upi verification data'};

  const counterVar = Math.abs(verify.cashCounter?.variance || 0);
  const rcVar = Math.abs(verify.runnerCounter?.variance || 0);
  const totalVar = counterVar + rcVar;

  if (totalVar <= 50) return {variance: totalVar, status: 'ok'};

  const topicKey = `upi_variance:${todayDateIST()}`;
  if (!await shouldAlert(DB, 'U1', topicKey, 60)) return {variance: totalVar, status: 'cooldown'};

  // FCM to cashiers
  await sendFCM(env, ['CASH001', 'CASH002'], {
    title: 'UPI mismatch detected',
    body: `Counter: ₹${fmt(counterVar)} | Runner Counter: ₹${fmt(rcVar)} variance. Check settlement.`,
    tag: 'nch_upi_mismatch',
    url: `${BASE_URL}/ops/settlement/`
  });
  alerts.push({channel: 'fcm', to: 'cashiers', variance: totalVar});

  // WA to Naveen if > ₹200
  if (totalVar > 200 && phones[NAVEEN_SLOT]) {
    await sendWA(token, phones[NAVEEN_SLOT],
      `⚠️ *UPI Mismatch — ₹${fmt(totalVar)} variance*\n\nCounter: ₹${fmt(counterVar)} | Runner Counter: ₹${fmt(rcVar)}\n\nCheck: ${BASE_URL}/ops/settlement/`);
    alerts.push({channel: 'wa', to: 'Naveen', variance: totalVar});
  }

  await logAlert(DB, 'U1', topicKey, totalVar > 200 ? 'both' : 'fcm', 'cashiers');
  return {variance: totalVar, alerts};
}

// ── S1: Shift report at scheduled hours ──
async function checkShiftReportSchedule(env, phones) {
  const DB = env.DB;
  const now = istNow();
  const currentHour = now.date.getUTCHours(); // already IST

  if (!SHIFT_REPORT_HOURS.includes(currentHour)) {
    return {skipped: `hour ${currentHour} not in schedule`};
  }

  // Only send once per hour slot
  const topicKey = `shift_report:${todayDateIST()}:${currentHour}`;
  if (!await shouldAlert(DB, 'S1', topicKey, 55)) {
    return {skipped: 'already sent this hour'};
  }

  // Build shift report message
  const msg = await buildShiftReportMessage();
  if (!msg) return {error: 'failed to build report'};

  const token = env.WA_ACCESS_TOKEN;
  const sent = [];

  // Send to Naveen, Basheer, Tanveer
  for (const slot of [NAVEEN_SLOT, BASHEER_SLOT, TANVEER_SLOT]) {
    if (phones[slot]) {
      const r = await sendWA(token, phones[slot], msg);
      sent.push({slot, ok: r.ok});
    }
  }

  await logAlert(DB, 'S1', topicKey, 'wa', 'naveen,basheer,tanveer');
  return {sent, hour: currentHour};
}

// ══════════════════════════════════════════════════════════════
// SHIFT REPORT (existing, kept as standalone action too)
// ══════════════════════════════════════════════════════════════

async function sendShiftReport(env, phones, cors) {
  const msg = await buildShiftReportMessage();
  if (!msg) return json({success: false, error: 'Failed to build shift report'}, cors, 500);

  const token = env.WA_ACCESS_TOKEN;
  const sent = [];

  // Send to Naveen, Basheer, Tanveer
  for (const slot of [NAVEEN_SLOT, BASHEER_SLOT, TANVEER_SLOT]) {
    if (phones[slot]) {
      const r = await sendWA(token, phones[slot], msg);
      sent.push({name: slotLabel(slot), ok: r.ok});
    }
  }

  return json({success: true, sent_to: sent, message_length: msg.length}, cors);
}

async function buildShiftReportMessage() {
  try {
    const [nchRes, salesRes] = await Promise.all([
      fetch(`${BASE_URL}/api/nch-data`),
      fetch(`${BASE_URL}/api/sales-insights?from=${todayMidnightIST()}`)
    ]);
    const nch = await nchRes.json();
    const sales = await salesRes.json();

    if (!nch.success) return null;

    const d = nch.data;
    const recon = d.shiftReconciliation;
    const bc = recon.balanceCheck;
    const gt = d.grandTotal;

    const runners = recon.cashBreakdown.runnerCashObligations || [];
    let runnerLines = '';
    for (const r of runners) {
      const status = r.cashToCollect <= 0 ? '✅' : r.cashToCollect > 1500 ? '🔴' : '🟡';
      runnerLines += `${status} ${r.name}: Tokens ₹${fmt(r.tokens)} | Sales ₹${fmt(r.sales)} | UPI ₹${fmt(r.upi)} | *Cash ₹${fmt(r.cashToCollect)}*\n`;
    }
    if (!runnerLines) runnerLines = 'No active runners\n';

    let snackLines = '';
    if (sales.success && sales.data) {
      const sd = sales.data;
      const snackProducts = (sd.products || []).filter(p => p.category === 'Snacks');
      if (snackProducts.length > 0) {
        snackLines = snackProducts.map(p => `  ${p.name}: ${p.qty} sold (₹${fmt(p.amount)})`).join('\n');
      }
      const activeHours = (sd.hourly || []).filter(h => h.orders > 0);
      const recentHours = activeHours.slice(-6);
      if (recentHours.length > 0) {
        snackLines += '\n\n*Hourly Orders:*\n';
        snackLines += recentHours.map(h => `  ${h.label}: ${h.orders} orders (₹${fmt(h.amount)})`).join('\n');
      }
    }
    if (!snackLines) snackLines = 'No snack data available';

    const verify = recon.upiVerification;
    const counterVar = verify.cashCounter.variance;
    const rcVar = verify.runnerCounter.variance;
    const upiStatus = (Math.abs(counterVar) <= 1 && Math.abs(rcVar) <= 1)
      ? '✅ UPI Matched'
      : `⚠️ Counter: ₹${fmt(Math.abs(counterVar))} var | Runner Counter: ₹${fmt(Math.abs(rcVar))} var`;

    const now = istNow();

    return `*NCH Shift Report — ${now.dateStr} ${now.timeStr}*

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
  } catch (e) {
    console.error('buildShiftReportMessage error:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// ESCALATIONS (existing, refactored)
// ══════════════════════════════════════════════════════════════

async function checkEscalations(env, phones, cors) {
  const DB = env.DB;
  if (!DB) return json({success: false, error: 'DB not configured'}, cors, 500);

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
  const l1Errors = [], l2Errors = [], l3Errors = [];

  for (const err of errors) {
    const age = err.age_minutes || 0;
    const prevLevel = notifiedMap[err.id] || 0;

    if (age < L2_DELAY && prevLevel < 1) l1Errors.push(err);
    else if (age >= L2_DELAY && age < L3_DELAY && prevLevel < 2) l2Errors.push(err);
    else if (age >= L3_DELAY && prevLevel < 3) l3Errors.push(err);
  }

  const token = env.WA_ACCESS_TOKEN;

  // L1 → Naveen (WA)
  if (l1Errors.length > 0) {
    const lines = l1Errors.map(e =>
      `• ${e.order_ref || 'Order #' + e.order_id}: ${e.description || e.error_code} — ₹${fmt(e.order_amount)}`
    ).join('\n');
    const msg = `⚠️ *NCH — ${l1Errors.length} New Error${l1Errors.length > 1 ? 's' : ''}*\n\n${lines}\n\nFix: ${BASE_URL}/ops/settlement/`;
    if (phones[NAVEEN_SLOT]) await sendWA(token, phones[NAVEEN_SLOT], msg);

    // Also FCM to assigned staff for each error
    const slotsSeen = new Set();
    for (const e of l1Errors) {
      if (e.runner_slot && !slotsSeen.has(e.runner_slot)) {
        slotsSeen.add(e.runner_slot);
        await sendFCM(env, [e.runner_slot], {
          title: 'NCH: Error on your order',
          body: `${e.order_ref}: ${e.description || e.error_code}. Fix needed.`,
          tag: 'nch_error', url: `${BASE_URL}/ops/settlement/`
        });
      }
    }

    await logEscalations(DB, l1Errors, 1, 'naveen');
    escalations.push({level: 1, count: l1Errors.length, sent_to: 'Naveen + assigned staff (FCM)'});
  }

  // L2 → Basheer + Tanveer (WA) + assigned staff (FCM reminder)
  if (l2Errors.length > 0) {
    const totalAmt = l2Errors.reduce((s, e) => s + (e.order_amount || 0), 0);
    const msg = `🔴 *NCH — ${l2Errors.length} Unresolved Error${l2Errors.length > 1 ? 's' : ''} (30+ min)*\n\nTotal: ₹${fmt(totalAmt)}\n\n` +
      l2Errors.map(e => `• ${e.order_ref || '#' + e.order_id}: ${e.description || e.error_code} — ₹${fmt(e.order_amount)} (${Math.round(e.age_minutes)}min ago)`).join('\n') +
      `\n\nFix: ${BASE_URL}/ops/settlement/`;

    const sends = [];
    if (phones[BASHEER_SLOT]) sends.push(sendWA(token, phones[BASHEER_SLOT], msg));
    if (phones[TANVEER_SLOT]) sends.push(sendWA(token, phones[TANVEER_SLOT], msg));
    await Promise.all(sends);

    // FCM reminder to assigned staff
    const slotsSeen = new Set();
    for (const e of l2Errors) {
      if (e.runner_slot && !slotsSeen.has(e.runner_slot)) {
        slotsSeen.add(e.runner_slot);
        await sendFCM(env, [e.runner_slot], {
          title: '⚠️ Error still pending 30min',
          body: `${e.order_ref}: ${e.description || e.error_code}. Managers notified.`,
          tag: 'nch_error_reminder', url: `${BASE_URL}/ops/settlement/`
        });
      }
    }

    await logEscalations(DB, l2Errors, 2, 'basheer,tanveer');
    escalations.push({level: 2, count: l2Errors.length, sent_to: 'Basheer, Tanveer + assigned (FCM)'});
  }

  // L3 → Naveen (WA) + all managers (FCM)
  if (l3Errors.length > 0) {
    const totalAmt = l3Errors.reduce((s, e) => s + (e.order_amount || 0), 0);
    const msg = `🚨 *NCH ESCALATION — ${l3Errors.length} Error${l3Errors.length > 1 ? 's' : ''} Pending 1hr+*\n\nTotal unaccounted: *₹${fmt(totalAmt)}*\n\n` +
      l3Errors.map(e => `• ${e.order_ref || '#' + e.order_id}: ${e.description || e.error_code} — ₹${fmt(e.order_amount)} (${Math.round(e.age_minutes)}min)`).join('\n') +
      `\n\nBasheer & Tanveer were notified 30min ago.\n\nFix: ${BASE_URL}/ops/settlement/`;

    if (phones[NAVEEN_SLOT]) await sendWA(token, phones[NAVEEN_SLOT], msg);

    // FCM to all managers
    await sendFCM(env, [BASHEER_SLOT, TANVEER_SLOT, NAVEEN_SLOT], {
      title: `🚨 ${l3Errors.length} errors pending 1hr+`,
      body: `Total: ₹${fmt(totalAmt)}. Critical — fix now.`,
      tag: 'nch_critical_escalation', url: `${BASE_URL}/ops/settlement/`
    });

    await logEscalations(DB, l3Errors, 3, 'naveen_escalation');
    escalations.push({level: 3, count: l3Errors.length, sent_to: 'Naveen (WA) + all managers (FCM)'});
  }

  return json({
    success: true,
    total_pending: errors.length,
    escalations,
    summary: {l1_new: l1Errors.length, l2_unresolved: l2Errors.length, l3_critical: l3Errors.length}
  }, cors);
}

// ══════════════════════════════════════════════════════════════
// TEST
// ══════════════════════════════════════════════════════════════

async function sendTestMessage(env, phones, cors) {
  const naveenPhone = phones[NAVEEN_SLOT];
  if (!naveenPhone) return json({success: false, error: 'Naveen phone not found in v_staff_slots'}, cors, 500);
  const now = istNow();
  const msg = `✅ *NCH Alert System — Test*\n\nWhatsApp + FCM push alerts are active.\n\n13 alert types configured:\nE1-E4 (errors), R1-R2 (runner cash), C1-C3 (cash collection), P1-P2 (petty), S1 (shift report), U1 (UPI)\n\nTime: ${now.dateStr} ${now.timeStr}`;
  const waResult = await sendWA(env.WA_ACCESS_TOKEN, naveenPhone, msg);

  // Also test FCM to Naveen
  const fcmResult = await sendFCM(env, [NAVEEN_SLOT], {
    title: 'NCH Alert System — Test',
    body: 'If you see this, FCM push is working!',
    tag: 'nch_test',
    url: `${BASE_URL}/ops/`
  });

  return json({success: true, sent_to: 'Naveen', wa: waResult, fcm: fcmResult}, cors);
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

// ── Phone numbers from D1 ──
async function loadPhones(DB) {
  const phones = {};
  if (!DB) return phones;
  try {
    const rows = await DB.prepare(
      `SELECT slot_code, phone FROM v_staff_slots WHERE phone IS NOT NULL AND phone != ''`
    ).all();
    for (const r of (rows.results || [])) {
      let p = r.phone.replace(/[\s\-()]/g, '');
      if (p.startsWith('+')) p = p.slice(1);
      if (p.length === 10) p = '91' + p;
      phones[r.slot_code] = p;
    }
  } catch (e) { console.error('loadPhones error:', e.message); }
  return phones;
}

// ── WhatsApp send ──
async function sendWA(token, to, text) {
  const url = `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({messaging_product: 'whatsapp', to, type: 'text', text: {body: text}})
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

// ── FCM push via hub API ──
async function sendFCM(env, slots, payload) {
  if (!slots || slots.length === 0) return {ok: true, skipped: 'no slots'};
  try {
    const res = await fetch(`${BASE_URL}/api/hub?action=push-to-slots`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({slots, ...payload})
    });
    return await res.json();
  } catch (e) {
    console.error('sendFCM error:', e.message);
    return {ok: false, error: e.message};
  }
}

// ── Cooldown check ──
async function shouldAlert(DB, alertType, topicKey, cooldownMinutes) {
  if (!DB) return true;
  try {
    const cutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
    const row = await DB.prepare(
      `SELECT id FROM alert_log WHERE alert_type = ? AND topic_key = ? AND sent_at >= ? LIMIT 1`
    ).bind(alertType, topicKey, cutoff).first();
    return !row;
  } catch (e) { return true; } // if table doesn't exist yet, allow
}

// ── Log alert (write-before-send pattern for dedup) ──
async function logAlert(DB, alertType, topicKey, channel, recipient) {
  if (!DB) return;
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS alert_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL, topic_key TEXT NOT NULL,
        channel TEXT NOT NULL, recipient TEXT NOT NULL,
        sent_at TEXT DEFAULT (datetime('now')),
        message_preview TEXT, delivery_status TEXT DEFAULT 'sent'
      )
    `).run();
    await DB.prepare(
      'INSERT INTO alert_log (alert_type, topic_key, channel, recipient) VALUES (?, ?, ?, ?)'
    ).bind(alertType, topicKey, channel, recipient).run();
  } catch (e) { console.error('logAlert error:', e.message); }
}

// ── Escalation log (existing, kept for backward compat) ──
async function logEscalations(DB, errors, level, sentTo) {
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS wa_escalation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, error_id INTEGER NOT NULL,
        level INTEGER NOT NULL, sent_to TEXT,
        notified_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    for (const err of errors) {
      await DB.prepare('INSERT INTO wa_escalation_log (error_id, level, sent_to) VALUES (?, ?, ?)')
        .bind(err.id, level, sentTo).run();
    }
  } catch (e) { console.error('Escalation log error:', e.message); }
}

// ── Runner name → slot mapping ──
const RUNNER_NAME_MAP = {
  'farzaib': 'RUN001', 'farooq': 'RUN001',
  'ritiqu': 'RUN002', 'amin': 'RUN002',
  'anshu': 'RUN003', 'nch runner 03': 'RUN003',
  'shabeer': 'RUN004', 'nch runner 04': 'RUN004',
  'dhanush': 'RUN005', 'nch runner 05': 'RUN005'
};
function runnerNameToSlot(name) {
  if (!name) return null;
  return RUNNER_NAME_MAP[name.toLowerCase()] || null;
}

// ── Slot code → display name ──
function slotLabel(slot) {
  const labels = {
    'ADMIN002': 'Naveen', 'GM001': 'Basheer', 'MGR001': 'Tanveer',
    'CASH001': 'Kesmat', 'CASH002': 'Nafees',
    'RUN001': 'Farzaib', 'RUN002': 'Ritiqu', 'RUN003': 'Anshu',
    'RUN004': 'Shabeer', 'RUN005': 'Dhanush'
  };
  return labels[slot] || slot;
}

// ── IST helpers ──
function istNow() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return {
    date: d,
    timeStr: d.toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit', hour12: true}),
    dateStr: d.toLocaleDateString('en-IN', {day: '2-digit', month: 'short'}),
    time: d.toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit', hour12: true})
  };
}

function todayMidnightIST() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10) + 'T00:00:00';
}

function todayDateIST() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function fmt(n) {
  return n != null ? Math.round(n).toLocaleString('en-IN') : '0';
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: cors});
}
