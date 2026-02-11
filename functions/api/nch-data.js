// NCH Operations Dashboard - Cloudflare Function (v11 - Full UPI cross-verification, discrepancy detection, Razorpay D1 sync)

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*','Access-Control-Allow-Methods': 'GET, OPTIONS','Access-Control-Allow-Headers': 'Content-Type','Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const url = new URL(context.request.url);
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;
  const RAZORPAY_KEY = context.env.RAZORPAY_KEY;
  const RAZORPAY_SECRET = context.env.RAZORPAY_SECRET;
  const DB = context.env.DB;

  let fromUTC, toUTC;
  if (fromParam) {
    const fromParsed = new Date(fromParam);
    fromUTC = new Date(fromParsed.getTime() - (5.5 * 60 * 60 * 1000));
  } else {
    fromUTC = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }
  if (toParam) {
    const toParsed = new Date(toParam);
    toUTC = new Date(toParsed.getTime() - (5.5 * 60 * 60 * 1000));
  } else {
    toUTC = new Date();
  }

  const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');
  const toOdoo = toUTC.toISOString().slice(0, 19).replace('T', ' ');
  const fromUnix = Math.floor(fromUTC.getTime() / 1000);
  const toUnix = Math.floor(toUTC.getTime() / 1000);

  try {
    // Fetch Odoo data + ALL Razorpay QR payments (runners + counter + runner counter)
    const [ordersData, paymentsData, razorpayData] = await Promise.all([
      fetchOdooOrders(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
      fetchOdooPayments(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
      fetchAllRazorpayPayments(RAZORPAY_KEY, RAZORPAY_SECRET, fromUnix, toUnix)
    ]);
    const dashboard = processDashboardData(ordersData, paymentsData, razorpayData);
    const fromIST = new Date(fromUTC.getTime() + (5.5 * 60 * 60 * 1000));
    const toIST = new Date(toUTC.getTime() + (5.5 * 60 * 60 * 1000));

    // Sync Razorpay payments to D1 in background (every API call stores data locally)
    if (DB) {
      context.waitUntil(syncRazorpayToD1(DB, razorpayData).catch(e => console.error('Razorpay D1 sync error:', e.message)));
    }

    return new Response(JSON.stringify({success: true, timestamp: new Date().toISOString(), query: {fromIST: fromIST.toISOString(), toIST: toIST.toISOString(), fromUnix, toUnix}, counts: {orders: ordersData.length, payments: paymentsData.length, razorpay: razorpayData.runnerPayments.length + razorpayData.counterPayments.length + razorpayData.runnerCounterPayments.length}, data: dashboard}), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), { status: 500, headers: corsHeaders });
  }
}

async function fetchOdooOrders(url, db, uid, apiKey, since, until) {
  const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.order', 'search_read', [[['config_id', 'in', [27, 28]], ['date_order', '>=', since], ['date_order', '<=', until], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]], {fields: ['id', 'name', 'date_order', 'amount_total', 'amount_paid', 'partner_id', 'config_id', 'payment_ids', 'pricelist_id', 'state'], order: 'date_order desc'}]}, id: 1};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  if (data.error) throw new Error('Odoo orders error: ' + JSON.stringify(data.error));
  return data.result || [];
}

async function fetchOdooPayments(url, db, uid, apiKey, since, until) {
  const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.payment', 'search_read', [[['payment_date', '>=', since], ['payment_date', '<=', until]]], {fields: ['id', 'amount', 'payment_date', 'payment_method_id', 'pos_order_id', 'session_id']}]}, id: 2};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  if (data.error) throw new Error('Odoo payments error: ' + JSON.stringify(data.error));
  return data.result || [];
}

// Fetch ALL payments from a QR code with pagination (Razorpay max 100 per page)
async function fetchQrPaymentsPaginated(auth, qrId, label, since, until) {
  const allItems = [];
  let skip = 0;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const response = await fetch(
        `https://api.razorpay.com/v1/payments/qr_codes/${qrId}/payments?count=${PAGE_SIZE}&skip=${skip}&from=${since}&to=${until}`,
        {headers: {'Authorization': 'Basic ' + auth}}
      );
      const data = await response.json();
      if (data.error || !data.items || data.items.length === 0) break;

      const captured = data.items
        .filter(p => p.status === 'captured')
        .map(p => ({...p, qr_label: label}));
      allItems.push(...captured);

      if (data.items.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    } catch (e) {
      break;
    }
  }
  return allItems;
}

// Fetch payments from ALL Razorpay QR codes — runners + counter + runner counter
async function fetchAllRazorpayPayments(key, secret, since, until) {
  const auth = btoa(key + ':' + secret);

  // All QR codes in the system
  const RUNNER_QRS = [
    {qr_id: 'qr_SBdtZG1AMDwSmJ', label: 'RUN001', name: 'FAROOQ'},
    {qr_id: 'qr_SBdte3aRvGpRMY', label: 'RUN002', name: 'AMIN'},
    {qr_id: 'qr_SBgTo2a39kYmET', label: 'RUN003', name: 'NCH Runner 03'},
    {qr_id: 'qr_SBgTtFrfddY4AW', label: 'RUN004', name: 'NCH Runner 04'},
    {qr_id: 'qr_SBgTyFKUsdwLe1', label: 'RUN005', name: 'NCH Runner 05'}
  ];
  const COUNTER_QR = {qr_id: 'qr_SBdtUCLSHVfRtT', label: 'COUNTER'};
  const RUNNER_COUNTER_QR = {qr_id: 'qr_SBuDBQDKrC8Bch', label: 'RUNNER_COUNTER'};

  // Fetch all in parallel
  const [counterResults, runnerCounterResults, ...runnerResults] = await Promise.all([
    fetchQrPaymentsPaginated(auth, COUNTER_QR.qr_id, COUNTER_QR.label, since, until),
    fetchQrPaymentsPaginated(auth, RUNNER_COUNTER_QR.qr_id, RUNNER_COUNTER_QR.label, since, until),
    ...RUNNER_QRS.map(r => fetchQrPaymentsPaginated(auth, r.qr_id, r.label, since, until))
  ]);

  // Dedupe each category
  const dedupe = (items) => {
    const seen = new Set();
    return items.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  };

  // Tag runner payments with barcode/name for backward compatibility
  const runnerPayments = dedupe(runnerResults.flat()).map(p => {
    const qr = RUNNER_QRS.find(r => r.label === p.qr_label);
    return {...p, runner_barcode: p.qr_label, runner_name: qr ? qr.name : p.qr_label};
  });

  return {
    runnerPayments,
    counterPayments: dedupe(counterResults),
    runnerCounterPayments: dedupe(runnerCounterResults)
  };
}

function processDashboardData(orders, payments, razorpayData) {
  const runners = {
    64: {id: 64, name: 'FAROOQ', barcode: 'RUN001', tokens: 0, sales: 0, upi: 0},
    65: {id: 65, name: 'AMIN', barcode: 'RUN002', tokens: 0, sales: 0, upi: 0},
    66: {id: 66, name: 'NCH Runner 03', barcode: 'RUN003', tokens: 0, sales: 0, upi: 0},
    67: {id: 67, name: 'NCH Runner 04', barcode: 'RUN004', tokens: 0, sales: 0, upi: 0},
    68: {id: 68, name: 'NCH Runner 05', barcode: 'RUN005', tokens: 0, sales: 0, upi: 0}
  };
  const barcodeToPartner = {'RUN001': 64, 'RUN002': 65, 'RUN003': 66, 'RUN004': 67, 'RUN005': 68};
  const PARTNER_ALIASES = { 90: 64, 37: 64 }; // Known duplicate partners → correct runner
  const PM = {CASH: 37, UPI: 38, CARD: 39, RUNNER_LEDGER: 40, TOKEN_ISSUE: 48, COMPLIMENTARY: 49};
  const POS = {CASH_COUNTER: 27, RUNNER_COUNTER: 28};

  // Resolve partner to known runner (handles aliases/duplicates)
  function resolveRunner(partnerId) {
    if (partnerId && runners[partnerId]) return { id: partnerId, alias: false };
    if (partnerId && PARTNER_ALIASES[partnerId]) return { id: PARTNER_ALIASES[partnerId], alias: true, original: partnerId };
    return null;
  }

  const paymentsByOrder = {};
  payments.forEach(p => {
    const oid = p.pos_order_id ? p.pos_order_id[0] : null;
    if (oid) { if (!paymentsByOrder[oid]) paymentsByOrder[oid] = []; paymentsByOrder[oid].push(p); }
  });

  const mainCounter = {total: 0, cash: 0, upi: 0, card: 0, complimentary: 0, tokenIssue: 0, orderCount: 0};
  // Runner counter now tracks UPI separately (direct walk-in UPI sales, nothing to do with runners)
  const runnerCounter = {total: 0, upi: 0, runnerLedger: 0, orderCount: 0};
  // Discrepancies detected during processing
  const discrepancies = [];
  // Cross-payments: runner orders paid through a different UPI channel (NOT errors — just routing)
  const crossPaymentsList = [];
  // Orders with wrong/missing runner attribution (fixable via rectification)
  const misattributedOrders = [];

  orders.forEach(order => {
    const configId = order.config_id ? order.config_id[0] : null;
    const partnerId = order.partner_id ? order.partner_id[0] : null;
    const orderPayments = paymentsByOrder[order.id] || [];

    if (configId === POS.CASH_COUNTER) {
      if (partnerId && runners[partnerId]) {
        // Token Issue: chai issued to runner — no cash at counter, runner has the money
        runners[partnerId].tokens += order.amount_total;
        mainCounter.tokenIssue += order.amount_total;
      } else {
        // Check for alias resolution (duplicate partner → correct runner)
        const resolved = resolveRunner(partnerId);
        if (resolved && resolved.alias) {
          // Auto-resolve: treat as correct runner, flag for rectification
          runners[resolved.id].tokens += order.amount_total;
          mainCounter.tokenIssue += order.amount_total;
          misattributedOrders.push({
            order_id: order.id, order_name: order.name, amount: order.amount_total,
            date_order: order.date_order, config_id: configId,
            current_partner_id: resolved.original, current_partner_name: order.partner_id ? order.partner_id[1] : null,
            correct_partner_id: resolved.id, correct_runner_name: runners[resolved.id].name,
            payment_methods: orderPayments.map(p => p.payment_method_id ? p.payment_method_id[0] : null),
            auto_resolved: true
          });
        } else {
          // Check D5: Token Issue PM used without a runner selected
          const hasTokenIssuePM = orderPayments.some(p => (p.payment_method_id ? p.payment_method_id[0] : null) === PM.TOKEN_ISSUE);
          if (hasTokenIssuePM && !partnerId) {
            discrepancies.push({type: 'token_issue_no_runner', severity: 'critical', order: order.name, amount: order.amount_total, message: `${order.name} — ₹${order.amount_total} Token Issue without runner selected. Tokens given but no runner will be charged.`});
            misattributedOrders.push({
              order_id: order.id, order_name: order.name, amount: order.amount_total,
              date_order: order.date_order, config_id: configId,
              current_partner_id: null, current_partner_name: null,
              correct_partner_id: null, correct_runner_name: null,
              payment_methods: orderPayments.map(p => p.payment_method_id ? p.payment_method_id[0] : null),
              auto_resolved: false
            });
          }
          // Direct counter sale to customer
          mainCounter.orderCount++;
          mainCounter.total += order.amount_total;
          orderPayments.forEach(p => {
            const mid = p.payment_method_id ? p.payment_method_id[0] : null;
            if (mid === PM.CASH) mainCounter.cash += p.amount;
            else if (mid === PM.UPI) mainCounter.upi += p.amount;
            else if (mid === PM.CARD) mainCounter.card += p.amount;
            else if (mid === PM.COMPLIMENTARY) mainCounter.complimentary += p.amount;
          });
        }
      }
    } else if (configId === POS.RUNNER_COUNTER) {
      // Check for known runner OR alias resolution
      const effectiveRunner = (partnerId && runners[partnerId]) ? { id: partnerId, alias: false } : resolveRunner(partnerId);
      const isKnownRunner = effectiveRunner && (effectiveRunner.alias === false);
      const isAliasRunner = effectiveRunner && effectiveRunner.alias;

      if (isKnownRunner || isAliasRunner) {
        const runnerId = effectiveRunner.id;

        // If alias, flag for rectification
        if (isAliasRunner) {
          misattributedOrders.push({
            order_id: order.id, order_name: order.name, amount: order.amount_total,
            date_order: order.date_order, config_id: configId,
            current_partner_id: effectiveRunner.original, current_partner_name: order.partner_id ? order.partner_id[1] : null,
            correct_partner_id: runnerId, correct_runner_name: runners[runnerId].name,
            payment_methods: orderPayments.map(p => p.payment_method_id ? p.payment_method_id[0] : null),
            auto_resolved: true
          });
        }

        // Runner-attributed sale at Runner Counter
        // Process each payment line separately to handle split payments correctly
        // (e.g., ₹100 Runner Ledger + ₹50 UPI on the same order)
        let upiAmount = 0;
        let runnerLedgerAmount = 0;
        orderPayments.forEach(p => {
          const mid = p.payment_method_id ? p.payment_method_id[0] : null;
          if (mid === PM.UPI) upiAmount += p.amount;
          else if (mid === PM.RUNNER_LEDGER) runnerLedgerAmount += p.amount;
        });

        // The order IS this runner's — ALWAYS add full amount to sales
        runners[runnerId].sales += order.amount_total;
        runnerCounter.orderCount++;

        if (upiAmount > 0) {
          // UPI portion = cross-payment credit (money went to bank, not runner's cash)
          crossPaymentsList.push({
            type: 'runner_order_paid_other_channel',
            orderId: order.id, orderName: order.name,
            amount: upiAmount,
            runnerOwner: runners[runnerId].name,
            runnerOwnerId: runnerId,
            paidViaChannel: 'counter_upi',
            paidViaLabel: 'Counter/Runner Counter UPI',
          });
          // Track only the actual UPI amount for Razorpay verification
          runnerCounter.upi += upiAmount;
        }
        if (runnerLedgerAmount > 0) {
          // Runner Ledger portion = normal cash obligation (runner has this cash)
          runnerCounter.runnerLedger += runnerLedgerAmount;
        }
      } else {
        // Direct walk-in sale at runner counter (no runner attribution)
        // Check D4: Runner Ledger PM used without runner selected
        const hasRunnerLedger = orderPayments.some(p => (p.payment_method_id ? p.payment_method_id[0] : null) === PM.RUNNER_LEDGER);
        if (hasRunnerLedger) {
          discrepancies.push({type: 'runner_ledger_no_runner', severity: 'critical', order: order.name, amount: order.amount_total, message: `${order.name} — ₹${order.amount_total} Runner Ledger without runner selected. Cash is unaccounted.`});
          misattributedOrders.push({
            order_id: order.id, order_name: order.name, amount: order.amount_total,
            date_order: order.date_order, config_id: configId,
            current_partner_id: null, current_partner_name: null,
            correct_partner_id: null, correct_runner_name: null,
            payment_methods: orderPayments.map(p => p.payment_method_id ? p.payment_method_id[0] : null),
            auto_resolved: false
          });
        }
        // This is the rush-hour UPI flow: customer pays at runner counter QR
        runnerCounter.orderCount++;
        runnerCounter.total += order.amount_total;
        orderPayments.forEach(p => {
          const mid = p.payment_method_id ? p.payment_method_id[0] : null;
          if (mid === PM.UPI) runnerCounter.upi += p.amount;
        });
      }
    }
  });

  // === RAZORPAY DATA PROCESSING ===
  const {runnerPayments, counterPayments, runnerCounterPayments} = razorpayData;

  // Runner QR payments — reduce runner's cash obligation
  const razorpayRunners = {amount: 0, count: 0, payments: []};
  runnerPayments.forEach(p => {
    const barcode = p.runner_barcode;
    const partnerId = barcodeToPartner[barcode];
    const amt = p.amount / 100;
    if (partnerId && runners[partnerId]) runners[partnerId].upi += amt;
    razorpayRunners.amount += amt;
    razorpayRunners.count++;
    razorpayRunners.payments.push({id: p.id, amount: amt, runner: p.runner_name || barcode, barcode: barcode, time: new Date(p.created_at * 1000).toISOString(), vpa: p.vpa});
  });

  // Counter QR payments — for cross-verification with Odoo PM 38 at POS 27
  const razorpayCounter = {amount: 0, count: 0, payments: []};
  counterPayments.forEach(p => {
    const amt = p.amount / 100;
    razorpayCounter.amount += amt;
    razorpayCounter.count++;
    razorpayCounter.payments.push({id: p.id, amount: amt, time: new Date(p.created_at * 1000).toISOString(), vpa: p.vpa});
  });

  // Runner Counter QR payments — for cross-verification with Odoo PM 38 at POS 28
  const razorpayRunnerCounter = {amount: 0, count: 0, payments: []};
  runnerCounterPayments.forEach(p => {
    const amt = p.amount / 100;
    razorpayRunnerCounter.amount += amt;
    razorpayRunnerCounter.count++;
    razorpayRunnerCounter.payments.push({id: p.id, amount: amt, time: new Date(p.created_at * 1000).toISOString(), vpa: p.vpa});
  });

  // === CROSS-VERIFICATION: Odoo UPI vs Razorpay ===
  const verification = {
    cashCounter: {
      odooUPI: mainCounter.upi,
      razorpayUPI: razorpayCounter.amount,
      variance: Math.round((mainCounter.upi - razorpayCounter.amount) * 100) / 100,
      odooCount: payments.filter(p => {
        const mid = p.payment_method_id ? p.payment_method_id[0] : null;
        const oid = p.pos_order_id ? p.pos_order_id[0] : null;
        if (mid !== PM.UPI || !oid) return false;
        const order = orders.find(o => o.id === oid);
        if (!order) return false;
        const configId = order.config_id ? order.config_id[0] : null;
        const partnerId = order.partner_id ? order.partner_id[0] : null;
        return configId === POS.CASH_COUNTER && !(partnerId && runners[partnerId]);
      }).length,
      razorpayCount: razorpayCounter.count,
      status: 'ok'
    },
    runnerCounter: {
      odooUPI: runnerCounter.upi,
      razorpayUPI: razorpayRunnerCounter.amount,
      variance: Math.round((runnerCounter.upi - razorpayRunnerCounter.amount) * 100) / 100,
      odooCount: runnerCounter.orderCount,
      razorpayCount: razorpayRunnerCounter.count,
      status: 'ok'
    },
    runners: {
      odooTokensAndSales: Object.values(runners).reduce((s, r) => s + r.tokens + r.sales, 0),
      razorpayRunnerUPI: razorpayRunners.amount,
      status: 'ok'
    }
  };

  // Determine verification status
  const TOLERANCE = 1; // ₹1 tolerance for rounding
  if (Math.abs(verification.cashCounter.variance) > TOLERANCE) {
    verification.cashCounter.status = verification.cashCounter.variance > 0 ? 'odoo_higher' : 'razorpay_higher';
  }
  if (Math.abs(verification.runnerCounter.variance) > TOLERANCE) {
    verification.runnerCounter.status = verification.runnerCounter.variance > 0 ? 'odoo_higher' : 'razorpay_higher';
  }

  // === CROSS-PAYMENT CREDIT CALCULATION ===
  // Sum cross-payments per runner: orders that were theirs but paid via other UPI channels
  const crossPaymentCredits = {};
  for (const cp of crossPaymentsList) {
    if (!crossPaymentCredits[cp.runnerOwnerId]) crossPaymentCredits[cp.runnerOwnerId] = 0;
    crossPaymentCredits[cp.runnerOwnerId] += cp.amount;
  }

  // Runner settlements (now includes cross-payment credit)
  const runnerSettlements = Object.values(runners).map(r => {
    const totalRevenue = r.tokens + r.sales;
    const crossCredit = crossPaymentCredits[r.id] || 0;
    const cashToCollect = totalRevenue - r.upi - crossCredit;
    const runnerCrossPayments = crossPaymentsList.filter(cp => cp.runnerOwnerId === r.id);
    return {...r, totalRevenue, cashToCollect, crossPaymentCredit: crossCredit, crossPayments: runnerCrossPayments, status: totalRevenue === 0 ? 'inactive' : (cashToCollect <= 0 ? 'settled' : 'pending')};
  }).filter(r => r.tokens > 0 || r.sales > 0 || r.upi > 0);

  // === RUNNER-TO-RUNNER CROSS-QR DETECTION (heuristic) ===
  // If Runner A has UPI over-collection (cashToCollect < 0) and Runner B has positive
  // unmatched cash obligation, a customer likely paid on the wrong runner's QR.
  // These are flagged as "probable" (blue info) — NOT auto-corrected.
  const overCollectRunners = runnerSettlements.filter(r => r.cashToCollect < -1);
  const underCollectRunners = runnerSettlements.filter(r => r.cashToCollect > 1 && r.crossPaymentCredit === 0);
  if (overCollectRunners.length > 0 && underCollectRunners.length > 0) {
    for (const over of overCollectRunners) {
      const excess = Math.abs(over.cashToCollect);
      for (const under of underCollectRunners) {
        const matchAmount = Math.min(excess, under.cashToCollect);
        if (matchAmount > 1) {
          crossPaymentsList.push({
            type: 'probable_cross_qr',
            orderId: null, orderName: null,
            amount: matchAmount,
            runnerOwner: under.name,
            runnerOwnerId: under.id,
            paidViaChannel: over.barcode.toLowerCase(),
            paidViaLabel: `${over.name}'s QR (${over.barcode})`,
            isProbable: true,
          });
        }
      }
    }
  }

  // Grand totals
  const totalRunnerSales = Object.values(runners).reduce((sum, r) => sum + r.sales, 0);
  const grandTotal = {
    allSales: mainCounter.total + mainCounter.tokenIssue + totalRunnerSales + runnerCounter.total,
    tokenIssue: mainCounter.tokenIssue,
    cashToCollect: mainCounter.cash + runnerSettlements.reduce((sum, r) => sum + Math.max(0, r.cashToCollect), 0),
    upiCollected: mainCounter.upi + runnerCounter.upi + razorpayRunners.amount,
    cardCollected: mainCounter.card,
    complimentary: mainCounter.complimentary,
    avgOrderValue: 0
  };
  grandTotal.avgOrderValue = orders.length > 0 ? Math.round(grandTotal.allSales / orders.length) : 0;

  // === SHIFT RECONCILIATION: The Master Intelligence Layer ===
  // Total Sales = Cash + UPI (all 7 QRs) + Card + Complimentary
  const totalRunnerCash = runnerSettlements.reduce((sum, r) => sum + Math.max(0, r.cashToCollect), 0);
  const verifiedUPITotal = razorpayCounter.amount + razorpayRunnerCounter.amount + razorpayRunners.amount;
  const expectedTotalCash = grandTotal.allSales - verifiedUPITotal - mainCounter.card - mainCounter.complimentary;
  const accountedCash = mainCounter.cash + totalRunnerCash;
  const reconVariance = Math.round((expectedTotalCash - accountedCash) * 100) / 100;

  const shiftReconciliation = {
    // The equation: totalSales = cash + UPI + card + complimentary
    totalSales: grandTotal.allSales,

    // Verified digital (goes to bank, not cash)
    verifiedUPI: {
      total: verifiedUPITotal,
      counterQR: razorpayCounter.amount,
      runnerCounterQR: razorpayRunnerCounter.amount,
      runnerQRs: Object.fromEntries(
        runnerSettlements.map(r => [r.barcode, r.upi])
      ),
    },
    card: mainCounter.card,
    complimentary: mainCounter.complimentary,

    // Expected cash
    expectedTotalCash,
    cashBreakdown: {
      counterDrawer: mainCounter.cash,
      runnerCashObligations: runnerSettlements.map(r => ({
        id: r.id, name: r.name, barcode: r.barcode,
        tokens: r.tokens, sales: r.sales, upi: r.upi,
        crossPaymentCredit: r.crossPaymentCredit,
        cashToCollect: r.cashToCollect,
        crossPayments: r.crossPayments,
      })),
      totalRunnerCash,
    },

    // The balance check
    balanceCheck: {
      expectedCash: expectedTotalCash,
      accountedCash,
      variance: reconVariance,
      isBalanced: Math.abs(reconVariance) <= 1,
      hasCrossPayments: crossPaymentsList.length > 0,
      crossPaymentTotal: crossPaymentsList.filter(cp => !cp.isProbable).reduce((s, cp) => s + cp.amount, 0),
      explanation: Math.abs(reconVariance) <= 1 ? 'Shift balanced'
        : reconVariance > 0 ? `₹${Math.abs(reconVariance)} cash unaccounted`
        : `₹${Math.abs(reconVariance)} extra cash — likely cross-payment routing`,
    },

    // Cross-payments: orders paid through different channels (NOT errors — routing differences)
    crossPayments: crossPaymentsList.map(cp => ({
      type: cp.type,
      orderName: cp.orderName,
      amount: cp.amount,
      runner: cp.runnerOwner,
      runnerId: cp.runnerOwnerId,
      paidVia: cp.paidViaLabel,
      channel: cp.paidViaChannel,
      isProbable: cp.isProbable || false,
      description: cp.orderName
        ? `${cp.orderName}: ${cp.runnerOwner}'s order (₹${cp.amount}) paid via ${cp.paidViaLabel}`
        : `₹${cp.amount} likely paid on ${cp.paidViaLabel} for ${cp.runnerOwner}'s orders`,
      runnerCashImpact: `${cp.runnerOwner}'s cash reduced by ₹${cp.amount}`,
      shiftImpact: 'No shift impact — payment verified via Razorpay',
    })),

    // UPI verification (already computed)
    upiVerification: verification,

    // Variance source classification — tells cashier exactly WHY shift doesn't balance
    varianceSources: [
      ...(() => {
        const misattributed = misattributedOrders.filter(m => m.auto_resolved);
        const noRunner = misattributedOrders.filter(m => !m.auto_resolved);
        const sources = [];
        if (misattributed.length > 0) sources.push({ type: 'misattributed_runner', count: misattributed.length, amount: misattributed.reduce((s, m) => s + m.amount, 0), fixable: true, label: 'Wrong runner contact selected' });
        if (noRunner.length > 0) sources.push({ type: 'no_runner_selected', count: noRunner.length, amount: noRunner.reduce((s, m) => s + m.amount, 0), fixable: true, label: 'No runner on order' });
        if (Math.abs(verification.cashCounter.variance) > 1) sources.push({ type: 'upi_mismatch_counter', count: 1, amount: verification.cashCounter.variance, fixable: false, label: 'Counter UPI mismatch (Odoo vs Razorpay)' });
        if (Math.abs(verification.runnerCounter.variance) > 1) sources.push({ type: 'upi_mismatch_runner_counter', count: 1, amount: verification.runnerCounter.variance, fixable: false, label: 'Runner Counter UPI mismatch' });
        // Runner UPI over-collection: when runner collects more UPI than their obligation,
        // cashToCollect goes negative but Math.max(0) clips it — creating hidden variance
        const overCollectors = runnerSettlements.filter(r => r.cashToCollect < -1);
        if (overCollectors.length > 0) {
          const totalOverCollection = overCollectors.reduce((s, r) => s + Math.abs(r.cashToCollect), 0);
          sources.push({ type: 'runner_upi_overcollection', count: overCollectors.length, amount: -totalOverCollection, fixable: false, label: 'Runner UPI over-collection (' + overCollectors.map(r => r.name).join(', ') + ')' });
        }
        return sources;
      })()
    ],
  };

  // Backward compatible: razorpay field still has runner payments for live dashboard feed
  return {
    mainCounter,
    runnerCounter,
    runners: runnerSettlements,
    razorpay: razorpayRunners,
    razorpayCounter,
    razorpayRunnerCounter,
    verification,
    grandTotal,
    discrepancies,
    crossPayments: crossPaymentsList,
    misattributedOrders,
    shiftReconciliation,
    summary: {
      totalOrders: orders.length,
      activeRunners: runnerSettlements.filter(r => r.status !== 'inactive').length,
      discrepancyCount: discrepancies.length,
      crossPaymentCount: crossPaymentsList.length
    }
  };
}

// Sync Razorpay payments to D1 for local audit trail
async function syncRazorpayToD1(DB, razorpayData) {
  const COUNTER_QR = 'qr_SBdtUCLSHVfRtT';
  const RUNNER_COUNTER_QR = 'qr_SBuDBQDKrC8Bch';
  const RUNNER_QR_MAP = {'RUN001': 'qr_SBdtZG1AMDwSmJ', 'RUN002': 'qr_SBdte3aRvGpRMY', 'RUN003': 'qr_SBgTo2a39kYmET', 'RUN004': 'qr_SBgTtFrfddY4AW', 'RUN005': 'qr_SBgTyFKUsdwLe1'};

  const allPayments = [
    ...razorpayData.counterPayments.map(p => ({...p, qr_id: COUNTER_QR, qr_label: 'COUNTER'})),
    ...razorpayData.runnerCounterPayments.map(p => ({...p, qr_id: RUNNER_COUNTER_QR, qr_label: 'RUNNER_COUNTER'})),
    ...razorpayData.runnerPayments.map(p => ({...p, qr_id: RUNNER_QR_MAP[p.runner_barcode] || '', qr_label: p.runner_barcode || ''}))
  ];

  for (const p of allPayments) {
    try {
      await DB.prepare('INSERT OR IGNORE INTO razorpay_sync (qr_id, qr_label, payment_id, amount, vpa, status, captured_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(p.qr_id, p.qr_label, p.id, p.amount / 100, p.vpa || '', p.status || 'captured', new Date(p.created_at * 1000).toISOString(), new Date().toISOString()).run();
    } catch (e) { /* duplicate, ignore */ }
  }
}
