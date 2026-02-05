// NCH Operations Dashboard - Cloudflare Function (v8 - Fetch payments per QR code)

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
    const [ordersData, paymentsData, razorpayData] = await Promise.all([
      fetchOdooOrders(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
      fetchOdooPayments(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
      fetchAllRunnerPayments(RAZORPAY_KEY, RAZORPAY_SECRET, fromUnix, toUnix)
    ]);
    const dashboard = processDashboardData(ordersData, paymentsData, razorpayData);
    const fromIST = new Date(fromUTC.getTime() + (5.5 * 60 * 60 * 1000));
    const toIST = new Date(toUTC.getTime() + (5.5 * 60 * 60 * 1000));
    return new Response(JSON.stringify({success: true, timestamp: new Date().toISOString(), query: {fromIST: fromIST.toISOString(), toIST: toIST.toISOString()}, counts: {orders: ordersData.length, payments: paymentsData.length, razorpay: razorpayData.length}, data: dashboard}), { headers: corsHeaders });
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

// Fetch payments from all runner QR codes
async function fetchAllRunnerPayments(key, secret, since, until) {
  const auth = btoa(key + ':' + secret);
  
  // QR codes for each runner
  const RUNNER_QRS = [
    {qr_id: 'qr_SBdtZG1AMDwSmJ', barcode: 'RUN001', name: 'FAROOQ'},
    {qr_id: 'qr_SBdte3aRvGpRMY', barcode: 'RUN002', name: 'AMIN'},
    {qr_id: 'qr_SBgTo2a39kYmET', barcode: 'RUN003', name: 'NCH Runner 03'},
    {qr_id: 'qr_SBgTtFrfddY4AW', barcode: 'RUN004', name: 'NCH Runner 04'},
    {qr_id: 'qr_SBgTyFKUsdwLe1', barcode: 'RUN005', name: 'NCH Runner 05'}
  ];
  
  // Fetch payments from each QR code in parallel
  const allPayments = await Promise.all(RUNNER_QRS.map(async (runner) => {
    try {
      const response = await fetch(
        `https://api.razorpay.com/v1/payments?count=100&from=${since}&to=${until}`,
        {headers: {'Authorization': 'Basic ' + auth}}
      );
      const data = await response.json();
      if (data.error) return [];
      
      // Filter payments that have this runner's barcode in notes OR came from their QR
      // Since we can't get qr_code_id from payments API, rely on notes
      return (data.items || [])
        .filter(p => p.status === 'captured' && p.notes?.runner_barcode === runner.barcode)
        .map(p => ({
          ...p,
          runner_barcode: runner.barcode,
          runner_name: p.notes?.runner_name || runner.name
        }));
    } catch (e) {
      return [];
    }
  }));
  
  // Also try fetching payments directly from QR code endpoints for those without notes
  const qrPayments = await Promise.all(RUNNER_QRS.map(async (runner) => {
    try {
      const response = await fetch(
        `https://api.razorpay.com/v1/payments/qr_codes/${runner.qr_id}/payments?count=100&from=${since}&to=${until}`,
        {headers: {'Authorization': 'Basic ' + auth}}
      );
      const data = await response.json();
      if (data.error || !data.items) return [];
      
      return data.items
        .filter(p => p.status === 'captured')
        .map(p => ({
          ...p,
          runner_barcode: runner.barcode,
          runner_name: runner.name
        }));
    } catch (e) {
      return [];
    }
  }));
  
  // Combine and dedupe by payment ID
  const combined = [...allPayments.flat(), ...qrPayments.flat()];
  const seen = new Set();
  return combined.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

function processDashboardData(orders, payments, razorpayPayments) {
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
  const runnerCounter = {total: 0, upi: 0, orderCount: 0};

  orders.forEach(order => {
    const configId = order.config_id ? order.config_id[0] : null;
    const partnerId = order.partner_id ? order.partner_id[0] : null;
    const orderPayments = paymentsByOrder[order.id] || [];
    if (configId === POS.CASH_COUNTER) {
      if (partnerId && runners[partnerId]) {
        runners[partnerId].tokens += order.amount_total;
        mainCounter.tokenIssue += order.amount_total;
      } else {
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
        runners[partnerId].sales += order.amount_total;
      } else {
        runnerCounter.orderCount++;
        runnerCounter.total += order.amount_total;
        orderPayments.forEach(p => {
          const mid = p.payment_method_id ? p.payment_method_id[0] : null;
          if (mid === PM.UPI) runnerCounter.upi += p.amount;
        });
      }
    }
  });

  const razorpayTotal = {amount: 0, count: 0, payments: []};
  razorpayPayments.forEach(p => {
    const barcode = p.runner_barcode;
    const partnerId = barcodeToPartner[barcode];
    const amt = p.amount / 100;
    if (partnerId && runners[partnerId]) runners[partnerId].upi += amt;
    razorpayTotal.amount += amt;
    razorpayTotal.count++;
    razorpayTotal.payments.push({id: p.id, amount: amt, runner: p.runner_name || barcode, barcode: barcode, time: new Date(p.created_at * 1000).toISOString(), vpa: p.vpa});
  });

  const runnerSettlements = Object.values(runners).map(r => {
    const totalRevenue = r.tokens + r.sales;
    const cashToCollect = totalRevenue - r.upi;
    return {...r, totalRevenue, cashToCollect, status: totalRevenue === 0 ? 'inactive' : (cashToCollect <= 0 ? 'settled' : 'pending')};
  }).filter(r => r.tokens > 0 || r.sales > 0 || r.upi > 0);

  const grandTotal = {
    allSales: mainCounter.total + mainCounter.tokenIssue + runnerCounter.total + Object.values(runners).reduce((sum, r) => sum + r.sales, 0),
    cashToCollect: mainCounter.cash + runnerSettlements.reduce((sum, r) => sum + Math.max(0, r.cashToCollect), 0),
    upiCollected: mainCounter.upi + runnerCounter.upi + razorpayTotal.amount,
    cardCollected: mainCounter.card,
    complimentary: mainCounter.complimentary
  };

  return {mainCounter, runnerCounter, runners: runnerSettlements, razorpay: razorpayTotal, grandTotal, summary: {totalOrders: mainCounter.orderCount + runnerCounter.orderCount, activeRunners: runnerSettlements.filter(r => r.status !== 'inactive').length}};
}
