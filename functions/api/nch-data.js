// NCH Operations Dashboard - Cloudflare Function (v10 - Full UPI cross-verification, Runner Counter UPI tracking)

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
  const PM = {CASH: 37, UPI: 38, CARD: 39, RUNNER_LEDGER: 40, TOKEN_ISSUE: 48, COMPLIMENTARY: 49};
  const POS = {CASH_COUNTER: 27, RUNNER_COUNTER: 28};

  const paymentsByOrder = {};
  payments.forEach(p => {
    const oid = p.pos_order_id ? p.pos_order_id[0] : null;
    if (oid) { if (!paymentsByOrder[oid]) paymentsByOrder[oid] = []; paymentsByOrder[oid].push(p); }
  });

  const mainCounter = {total: 0, cash: 0, upi: 0, card: 0, complimentary: 0, tokenIssue: 0, orderCount: 0};
  // Runner counter now tracks UPI separately (direct walk-in UPI sales, nothing to do with runners)
  const runnerCounter = {total: 0, upi: 0, runnerLedger: 0, orderCount: 0};

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
    } else if (configId === POS.RUNNER_COUNTER) {
      if (partnerId && runners[partnerId]) {
        // Runner-attributed sale at Runner Counter
        // Check payment method to distinguish Runner Ledger vs UPI
        let isUpiSale = false;
        orderPayments.forEach(p => {
          const mid = p.payment_method_id ? p.payment_method_id[0] : null;
          if (mid === PM.UPI) {
            // This order was WRONGLY recorded as UPI instead of Runner Ledger
            // OR the runner counter person took a direct UPI sale but attributed it to the runner
            // Either way, this needs to be tracked
            isUpiSale = true;
          }
        });

        if (isUpiSale) {
          // This sale is attributed to a runner BUT paid via UPI (PM 38)
          // The runner should NOT be responsible for this cash
          // Track it as runner counter UPI, not runner sales
          runnerCounter.orderCount++;
          runnerCounter.total += order.amount_total;
          runnerCounter.upi += order.amount_total;
        } else {
          // Normal: Runner Ledger (PM 40) — runner collected the money
          runners[partnerId].sales += order.amount_total;
          runnerCounter.runnerLedger += order.amount_total;
        }
      } else {
        // Direct walk-in sale at runner counter (no runner attribution)
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

  // Runner settlements
  const runnerSettlements = Object.values(runners).map(r => {
    const totalRevenue = r.tokens + r.sales;
    const cashToCollect = totalRevenue - r.upi;
    return {...r, totalRevenue, cashToCollect, status: totalRevenue === 0 ? 'inactive' : (cashToCollect <= 0 ? 'settled' : 'pending')};
  }).filter(r => r.tokens > 0 || r.sales > 0 || r.upi > 0);

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
    summary: {
      totalOrders: orders.length,
      activeRunners: runnerSettlements.filter(r => r.status !== 'inactive').length
    }
  };
}
