// NCH Intelligent Auditor — Cloudflare Worker
// Runs 7 discrepancy checks across Odoo, Razorpay, and D1 settlements
// Sends WhatsApp alerts to Nihaf & Naveen on any variance
// Syncs Razorpay QR payments to D1 for local audit trail

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;
  const RAZORPAY_KEY = context.env.RAZORPAY_KEY;
  const RAZORPAY_SECRET = context.env.RAZORPAY_SECRET;
  const WA_TOKEN = context.env.WA_ACCESS_TOKEN;
  const WA_PHONE_ID = context.env.WA_PHONE_ID || '970365416152029';

  const ALERT_RECIPIENTS = ['917010426808', '918073476051']; // Nihaf, Naveen
  const PM = {CASH: 37, UPI: 38, CARD: 39, RUNNER_LEDGER: 40, TOKEN_ISSUE: 48, COMPLIMENTARY: 49};
  const POS = {CASH_COUNTER: 27, RUNNER_COUNTER: 28};
  const RUNNERS = {64: {name: 'FAROOQ', barcode: 'RUN001', qr: 'qr_SBdtZG1AMDwSmJ'}, 65: {name: 'AMIN', barcode: 'RUN002', qr: 'qr_SBdte3aRvGpRMY'}, 66: {name: 'NCH Runner 03', barcode: 'RUN003', qr: 'qr_SBgTo2a39kYmET'}, 67: {name: 'NCH Runner 04', barcode: 'RUN004', qr: 'qr_SBgTtFrfddY4AW'}, 68: {name: 'NCH Runner 05', barcode: 'RUN005', qr: 'qr_SBgTyFKUsdwLe1'}};
  const COUNTER_QR = 'qr_SBdtUCLSHVfRtT';
  const RUNNER_COUNTER_QR = 'qr_SBuDBQDKrC8Bch';

  try {
    // === RUN FULL AUDIT ===
    if (action === 'run-audit') {
      const fromParam = url.searchParams.get('from');
      const toParam = url.searchParams.get('to');

      // Default: today 6:00 AM IST to now
      let fromIST, toIST;
      if (fromParam) {
        fromIST = new Date(fromParam);
      } else {
        const now = new Date();
        const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        fromIST = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 6, 0, 0);
        // Convert back to real UTC-based Date
        fromIST = new Date(fromIST.getTime() - 5.5 * 60 * 60 * 1000 + now.getTimezoneOffset() * 60 * 1000);
        // Simpler: just set to today 00:30 UTC (= 6:00 AM IST)
        const today = now.toISOString().slice(0, 10);
        fromIST = new Date(today + 'T00:30:00Z');
      }
      toIST = toParam ? new Date(toParam) : new Date();

      const fromUTC = fromParam ? new Date(fromIST.getTime() - 5.5 * 60 * 60 * 1000) : fromIST;
      const toUTC = toParam ? new Date(toIST.getTime() - 5.5 * 60 * 60 * 1000) : toIST;
      const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');
      const toOdoo = toUTC.toISOString().slice(0, 19).replace('T', ' ');
      const fromUnix = Math.floor(fromUTC.getTime() / 1000);
      const toUnix = Math.floor(toUTC.getTime() / 1000);

      // Fetch all data in parallel
      const [orders, payments, razorpayData] = await Promise.all([
        fetchOdooOrders(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        fetchOdooPayments(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        fetchAllRazorpay(RAZORPAY_KEY, RAZORPAY_SECRET, fromUnix, toUnix)
      ]);

      // Build payment lookup
      const paymentsByOrder = {};
      payments.forEach(p => {
        const oid = p.pos_order_id ? p.pos_order_id[0] : null;
        if (oid) { if (!paymentsByOrder[oid]) paymentsByOrder[oid] = []; paymentsByOrder[oid].push(p); }
      });

      const checks = [];
      const periodLabel = formatPeriod(fromUTC, toUTC);

      // --- D1: Cash Counter UPI Mismatch ---
      let odooCounterUPI = 0;
      let odooCounterUPICount = 0;
      orders.forEach(order => {
        const configId = order.config_id ? order.config_id[0] : null;
        const partnerId = order.partner_id ? order.partner_id[0] : null;
        if (configId === POS.CASH_COUNTER && !(partnerId && RUNNERS[partnerId])) {
          (paymentsByOrder[order.id] || []).forEach(p => {
            if ((p.payment_method_id ? p.payment_method_id[0] : null) === PM.UPI) {
              odooCounterUPI += p.amount;
              odooCounterUPICount++;
            }
          });
        }
      });
      const rpCounterUPI = razorpayData.counter.reduce((s, p) => s + p.amount / 100, 0);
      const d1Variance = Math.round((odooCounterUPI - rpCounterUPI) * 100) / 100;
      if (Math.abs(d1Variance) > 10) {
        const direction = d1Variance > 0 ? 'Odoo shows more — possible UPI payment not scanned at QR' : 'Razorpay received more — customer paid QR but cashier recorded as Cash';
        checks.push({type: 'upi_mismatch_counter', severity: 'warning', message: `Cash Counter UPI Mismatch\nOdoo UPI sales: ₹${odooCounterUPI.toFixed(0)} (${odooCounterUPICount} transactions)\nRazorpay QR received: ₹${rpCounterUPI.toFixed(0)} (${razorpayData.counter.length} payments)\nVariance: ₹${Math.abs(d1Variance).toFixed(0)} (${direction})\n\nPeriod: ${periodLabel}`});
      }

      // --- D2: Runner Counter UPI Mismatch ---
      let odooRunnerCounterUPI = 0;
      let odooRunnerCounterUPICount = 0;
      orders.forEach(order => {
        const configId = order.config_id ? order.config_id[0] : null;
        const partnerId = order.partner_id ? order.partner_id[0] : null;
        if (configId === POS.RUNNER_COUNTER) {
          const ops = paymentsByOrder[order.id] || [];
          const hasUPI = ops.some(p => (p.payment_method_id ? p.payment_method_id[0] : null) === PM.UPI);
          if (hasUPI) {
            ops.forEach(p => {
              if ((p.payment_method_id ? p.payment_method_id[0] : null) === PM.UPI) {
                odooRunnerCounterUPI += p.amount;
                odooRunnerCounterUPICount++;
              }
            });
          }
        }
      });
      const rpRunnerCounterUPI = razorpayData.runnerCounter.reduce((s, p) => s + p.amount / 100, 0);
      const d2Variance = Math.round((odooRunnerCounterUPI - rpRunnerCounterUPI) * 100) / 100;
      if (Math.abs(d2Variance) > 10) {
        const direction = d2Variance > 0 ? 'Odoo shows more' : 'Razorpay received more';
        checks.push({type: 'upi_mismatch_runner_counter', severity: 'warning', message: `Runner Counter UPI Mismatch\nOdoo UPI: ₹${odooRunnerCounterUPI.toFixed(0)} (${odooRunnerCounterUPICount})\nRazorpay QR: ₹${rpRunnerCounterUPI.toFixed(0)} (${razorpayData.runnerCounter.length})\nVariance: ₹${Math.abs(d2Variance).toFixed(0)} (${direction})\n\nPeriod: ${periodLabel}`});
      }

      // --- D3: Runner-attributed order paid as UPI (should be Runner Ledger) ---
      const d3Items = [];
      orders.forEach(order => {
        const configId = order.config_id ? order.config_id[0] : null;
        const partnerId = order.partner_id ? order.partner_id[0] : null;
        if (configId === POS.RUNNER_COUNTER && partnerId && RUNNERS[partnerId]) {
          const ops = paymentsByOrder[order.id] || [];
          const hasUPI = ops.some(p => (p.payment_method_id ? p.payment_method_id[0] : null) === PM.UPI);
          if (hasUPI) {
            d3Items.push({order: order.name, runner: RUNNERS[partnerId].name, amount: order.amount_total});
          }
        }
      });
      if (d3Items.length > 0) {
        const itemList = d3Items.map(i => `• ${i.order} → ${i.runner} — ₹${i.amount} (paid UPI, should be Runner Ledger)`).join('\n');
        checks.push({type: 'runner_upi_sale', severity: 'warning', message: `Runner order(s) paid as UPI instead of Runner Ledger\n${itemList}\n\nThis happens during rush hours. Naveen: check if excess UPI covers this.\n\nPeriod: ${periodLabel}`});
      }

      // --- D4: Runner Ledger without runner ---
      const d4Items = [];
      orders.forEach(order => {
        const configId = order.config_id ? order.config_id[0] : null;
        const partnerId = order.partner_id ? order.partner_id[0] : null;
        if (configId === POS.RUNNER_COUNTER && !partnerId) {
          const ops = paymentsByOrder[order.id] || [];
          const hasRL = ops.some(p => (p.payment_method_id ? p.payment_method_id[0] : null) === PM.RUNNER_LEDGER);
          if (hasRL) {
            d4Items.push({order: order.name, amount: order.amount_total});
          }
        }
      });
      if (d4Items.length > 0) {
        const itemList = d4Items.map(i => `• ${i.order} — ₹${i.amount}`).join('\n');
        checks.push({type: 'runner_ledger_no_partner', severity: 'critical', message: `Runner Ledger used WITHOUT runner selected\n${itemList}\n\n⚠️ Cash is unaccounted — no runner will be asked to settle this amount.\n\nPeriod: ${periodLabel}`});
      }

      // --- D5: Token Issue without runner ---
      const d5Items = [];
      orders.forEach(order => {
        const configId = order.config_id ? order.config_id[0] : null;
        const partnerId = order.partner_id ? order.partner_id[0] : null;
        if (configId === POS.CASH_COUNTER && !partnerId) {
          const ops = paymentsByOrder[order.id] || [];
          const hasTI = ops.some(p => (p.payment_method_id ? p.payment_method_id[0] : null) === PM.TOKEN_ISSUE);
          if (hasTI) {
            d5Items.push({order: order.name, amount: order.amount_total});
          }
        }
      });
      if (d5Items.length > 0) {
        const itemList = d5Items.map(i => `• ${i.order} — ₹${i.amount}`).join('\n');
        checks.push({type: 'token_issue_no_partner', severity: 'critical', message: `Token Issue used WITHOUT runner selected\n${itemList}\n\n⚠️ Tokens given but no runner will be charged for them.\n\nPeriod: ${periodLabel}`});
      }

      // --- D6: Settlement variance (check last settlement against Razorpay) ---
      const lastSettlementId = url.searchParams.get('settlement_id');
      if (lastSettlementId && DB) {
        const settlement = await DB.prepare('SELECT * FROM settlements WHERE id = ?').bind(lastSettlementId).first();
        if (settlement && settlement.runner_id !== 'counter') {
          const runner = RUNNERS[settlement.runner_id];
          if (runner) {
            // Get Razorpay payments for this runner in the settlement period
            const periodStartUnix = Math.floor(new Date(settlement.period_start).getTime() / 1000);
            const periodEndUnix = Math.floor(new Date(settlement.period_end).getTime() / 1000);
            const rpPayments = razorpayData.runners.filter(p => {
              return p.qr_label === runner.barcode && p.created_at >= periodStartUnix && p.created_at <= periodEndUnix;
            });
            const rpUPI = rpPayments.reduce((s, p) => s + p.amount / 100, 0);
            const d6Variance = Math.abs(settlement.upi_amount - rpUPI);
            if (d6Variance > 10) {
              checks.push({type: 'settlement_variance', severity: 'warning', message: `Settlement UPI variance for ${runner.name}\nSettlement recorded UPI: ₹${settlement.upi_amount}\nRazorpay QR actual: ₹${rpUPI.toFixed(0)}\nVariance: ₹${d6Variance.toFixed(0)}\nSettled by: ${settlement.settled_by}\n\nPeriod: ${new Date(settlement.period_start).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})} — ${new Date(settlement.period_end).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`});
            }
          }
        }
      }

      // --- D7: Collection variance ---
      if (DB) {
        const lastCollection = await DB.prepare('SELECT * FROM cash_collections ORDER BY collected_at DESC LIMIT 1').first();
        if (lastCollection && Math.abs(lastCollection.discrepancy) > 50) {
          const direction = lastCollection.discrepancy > 0 ? 'short (cash missing)' : 'over (extra cash)';
          checks.push({type: 'collection_variance', severity: 'critical', message: `Cash Collection Discrepancy\nExpected at counter: ₹${lastCollection.expected}\nCollected: ₹${lastCollection.amount} + Petty: ₹${lastCollection.petty_cash}\nDiscrepancy: ₹${Math.abs(lastCollection.discrepancy).toFixed(0)} ${direction}\nCollected by: ${lastCollection.collected_by}\n\nPeriod: ${formatPeriod(new Date(lastCollection.period_start), new Date(lastCollection.period_end))}`});
        }
      }

      // --- Sync Razorpay payments to D1 while we have the data ---
      if (DB) {
        const allRpPayments = [...razorpayData.counter.map(p => ({...p, qr_id: COUNTER_QR, qr_label: 'COUNTER'})), ...razorpayData.runnerCounter.map(p => ({...p, qr_id: RUNNER_COUNTER_QR, qr_label: 'RUNNER_COUNTER'})), ...razorpayData.runners.map(p => ({...p, qr_id: RUNNERS[Object.keys(RUNNERS).find(k => RUNNERS[k].barcode === p.qr_label)]?.qr || '', qr_label: p.qr_label}))];
        let synced = 0;
        for (const p of allRpPayments) {
          try {
            await DB.prepare('INSERT OR IGNORE INTO razorpay_sync (qr_id, qr_label, payment_id, amount, vpa, status, captured_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(p.qr_id || '', p.qr_label, p.id, p.amount / 100, p.vpa || '', p.status || 'captured', new Date(p.created_at * 1000).toISOString(), new Date().toISOString()).run();
            synced++;
          } catch (e) { /* duplicate, ignore */ }
        }
      }

      // --- Log and alert ---
      let alertsSent = 0;
      for (const check of checks) {
        // Duplicate prevention: skip if same check alerted in last 30 minutes
        if (DB) {
          const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
          const recent = await DB.prepare("SELECT id FROM audit_logs WHERE check_type = ? AND created_at > ? LIMIT 1").bind(check.type, thirtyMinAgo).first();
          if (recent) continue;
        }

        // Log to D1
        if (DB) {
          await DB.prepare('INSERT INTO audit_logs (check_type, severity, message, details, period_from, period_to, alerted_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(check.type, check.severity, check.message, JSON.stringify(check), fromUTC.toISOString(), toUTC.toISOString(), 'nihaf,naveen', new Date().toISOString()).run();
        }

        // Send WhatsApp alerts
        if (WA_TOKEN) {
          const emoji = check.severity === 'critical' ? '🚨' : '⚠️';
          const alertMsg = `🔍 *NCH Audit Alert*\n\n${emoji} ${check.message}`;
          for (const recipient of ALERT_RECIPIENTS) {
            await sendWhatsApp(WA_PHONE_ID, WA_TOKEN, recipient, alertMsg);
          }
          alertsSent++;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        period: periodLabel,
        checksRun: 7,
        discrepanciesFound: checks.length,
        alertsSent,
        checks: checks.map(c => ({type: c.type, severity: c.severity, message: c.message}))
      }), {headers: corsHeaders});
    }

    // === SYNC RAZORPAY PAYMENTS TO D1 ===
    if (action === 'sync-razorpay') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const hoursBack = parseInt(url.searchParams.get('hours') || '24');
      const fromUnix = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
      const toUnix = Math.floor(Date.now() / 1000);

      const razorpayData = await fetchAllRazorpay(RAZORPAY_KEY, RAZORPAY_SECRET, fromUnix, toUnix);
      const allPayments = [
        ...razorpayData.counter.map(p => ({...p, qr_id: COUNTER_QR, qr_label: 'COUNTER'})),
        ...razorpayData.runnerCounter.map(p => ({...p, qr_id: RUNNER_COUNTER_QR, qr_label: 'RUNNER_COUNTER'})),
        ...razorpayData.runners.map(p => {
          const rEntry = Object.values(RUNNERS).find(r => r.barcode === p.qr_label);
          return {...p, qr_id: rEntry ? rEntry.qr : '', qr_label: p.qr_label};
        })
      ];

      let newCount = 0;
      let skipCount = 0;
      for (const p of allPayments) {
        try {
          const result = await DB.prepare('INSERT OR IGNORE INTO razorpay_sync (qr_id, qr_label, payment_id, amount, vpa, status, captured_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(p.qr_id, p.qr_label, p.id, p.amount / 100, p.vpa || '', p.status || 'captured', new Date(p.created_at * 1000).toISOString(), new Date().toISOString()).run();
          if (result.meta.changes > 0) newCount++;
          else skipCount++;
        } catch (e) { skipCount++; }
      }

      return new Response(JSON.stringify({
        success: true,
        fetched: allPayments.length,
        newlySynced: newCount,
        alreadyExisted: skipCount,
        hoursBack,
        breakdown: {
          counter: razorpayData.counter.length,
          runnerCounter: razorpayData.runnerCounter.length,
          runners: razorpayData.runners.length
        }
      }), {headers: corsHeaders});
    }

    // === GET RECENT AUDIT ALERTS ===
    if (action === 'recent-alerts') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});

      const limit = parseInt(url.searchParams.get('limit') || '20');
      const results = await DB.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return new Response(JSON.stringify({success: true, alerts: results.results}), {headers: corsHeaders});
    }

    // === CHECK ODOO CONFIGURATION ===
    if (action === 'check-odoo-config') {
      const configChecks = [];

      // Check POS configurations
      const posConfigs = await odooRPC(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.config', 'search_read', [[['id', 'in', [27, 28]]]], {fields: ['id', 'name', 'payment_method_ids']});

      for (const config of posConfigs) {
        const pmIds = config.payment_method_ids || [];
        if (config.id === 27) {
          // Cash Counter should have: Cash(37), UPI(38), Card(39), Token Issue(48), Complimentary(49)
          const expected = [37, 38, 39, 48, 49];
          const missing = expected.filter(id => !pmIds.includes(id));
          const extra = pmIds.filter(id => !expected.includes(id));
          if (missing.length > 0 || extra.length > 0) {
            configChecks.push({pos: 'Cash Counter (27)', issue: `Missing PMs: ${missing.join(',')}, Extra PMs: ${extra.join(',')}`});
          }
        }
        if (config.id === 28) {
          // Runner Counter should have: UPI(38), Runner Ledger(40)
          const expected = [38, 40];
          const missing = expected.filter(id => !pmIds.includes(id));
          const extra = pmIds.filter(id => !expected.includes(id));
          if (missing.length > 0 || extra.length > 0) {
            configChecks.push({pos: 'Runner Counter (28)', issue: `Missing PMs: ${missing.join(',')}, Extra PMs: ${extra.join(',')}`});
          }
        }
      }

      return new Response(JSON.stringify({success: true, posConfigs, configIssues: configChecks}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action. Use: run-audit, sync-razorpay, recent-alerts, check-odoo-config'}), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }
}

// ─── ODOO HELPERS ───────────────────────────────────────────
async function odooRPC(url, db, uid, apiKey, model, method, args, kwargs = {}) {
  const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, model, method, ...args], ...(Object.keys(kwargs).length > 0 ? {kwargs} : {})}, id: 1};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  if (data.error) throw new Error('Odoo error: ' + JSON.stringify(data.error));
  return data.result || [];
}

async function fetchOdooOrders(url, db, uid, apiKey, since, until) {
  const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.order', 'search_read', [[['config_id', 'in', [27, 28]], ['date_order', '>=', since], ['date_order', '<=', until], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]], {fields: ['id', 'name', 'date_order', 'amount_total', 'partner_id', 'config_id', 'payment_ids'], order: 'date_order desc'}]}, id: 1};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  if (data.error) throw new Error('Odoo orders error: ' + JSON.stringify(data.error));
  return data.result || [];
}

async function fetchOdooPayments(url, db, uid, apiKey, since, until) {
  const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.payment', 'search_read', [[['payment_date', '>=', since], ['payment_date', '<=', until]]], {fields: ['id', 'amount', 'payment_date', 'payment_method_id', 'pos_order_id']}]}, id: 2};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  if (data.error) throw new Error('Odoo payments error: ' + JSON.stringify(data.error));
  return data.result || [];
}

// ─── RAZORPAY HELPERS ───────────────────────────────────────
async function fetchQrPayments(auth, qrId, label, since, until) {
  const allItems = [];
  let skip = 0;
  for (let page = 0; page < 10; page++) {
    try {
      const response = await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrId}/payments?count=100&skip=${skip}&from=${since}&to=${until}`, {headers: {'Authorization': 'Basic ' + auth}});
      const data = await response.json();
      if (data.error || !data.items || data.items.length === 0) break;
      const captured = data.items.filter(p => p.status === 'captured').map(p => ({...p, qr_label: label}));
      allItems.push(...captured);
      if (data.items.length < 100) break;
      skip += 100;
    } catch (e) { break; }
  }
  return allItems;
}

async function fetchAllRazorpay(key, secret, since, until) {
  const auth = btoa(key + ':' + secret);
  const RUNNER_QRS = [{qr: 'qr_SBdtZG1AMDwSmJ', label: 'RUN001'}, {qr: 'qr_SBdte3aRvGpRMY', label: 'RUN002'}, {qr: 'qr_SBgTo2a39kYmET', label: 'RUN003'}, {qr: 'qr_SBgTtFrfddY4AW', label: 'RUN004'}, {qr: 'qr_SBgTyFKUsdwLe1', label: 'RUN005'}];

  const [counter, runnerCounter, ...runnerResults] = await Promise.all([
    fetchQrPayments(auth, 'qr_SBdtUCLSHVfRtT', 'COUNTER', since, until),
    fetchQrPayments(auth, 'qr_SBuDBQDKrC8Bch', 'RUNNER_COUNTER', since, until),
    ...RUNNER_QRS.map(r => fetchQrPayments(auth, r.qr, r.label, since, until))
  ]);

  const dedupe = items => { const seen = new Set(); return items.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; }); };

  return {counter: dedupe(counter), runnerCounter: dedupe(runnerCounter), runners: dedupe(runnerResults.flat())};
}

// ─── WHATSAPP HELPERS ───────────────────────────────────────
async function sendWhatsApp(phoneId, token, to, message) {
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({messaging_product: 'whatsapp', to, type: 'text', text: {body: message}})
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('WA alert error:', response.status, err);
    }
    return response;
  } catch (e) {
    console.error('WA alert send error:', e.message);
  }
}

// ─── FORMATTING HELPERS ─────────────────────────────────────
function formatPeriod(fromUTC, toUTC) {
  const fromIST = new Date(fromUTC.getTime() + 5.5 * 60 * 60 * 1000);
  const toIST = new Date(toUTC.getTime() + 5.5 * 60 * 60 * 1000);
  const fmt = d => {
    const day = d.getUTCDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[d.getUTCMonth()];
    const h = d.getUTCHours();
    const m = d.getUTCMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${day} ${mon} ${h12}:${m} ${ampm}`;
  };
  return `${fmt(fromIST)} — ${fmt(toIST)} IST`;
}
