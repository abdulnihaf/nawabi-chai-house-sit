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
  const CONFIG_IDS = [27, 28];

  // TIMEZONE HANDLING:
  // - Input params are IST (local time strings)
  // - Cloudflare Workers run in UTC
  // - Odoo stores dates in UTC

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
  const fromIST = new Date(fromUTC.getTime() + (5.5 * 60 * 60 * 1000));
  const toIST = new Date(toUTC.getTime() + (5.5 * 60 * 60 * 1000));

  try {
    // Phase 1: Orders + payment method master list
    const [orders, paymentMethods] = await Promise.all([
      rpc(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.order', 'search_read',
        [[['config_id', 'in', CONFIG_IDS], ['date_order', '>=', fromOdoo], ['date_order', '<=', toOdoo], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]],
        {fields: ['id', 'name', 'date_order', 'amount_total', 'partner_id', 'config_id']}),
      rpc(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.payment.method', 'search_read',
        [[['config_ids', 'in', CONFIG_IDS]]], {fields: ['id', 'name', 'type']})
    ]);

    const orderIds = orders.map(o => o.id);
    if (orderIds.length === 0) {
      return new Response(JSON.stringify({
        success: true, timestamp: new Date().toISOString(),
        query: {from: fromIST.toISOString(), to: toIST.toISOString(), fromUTC: fromUTC.toISOString(), toUTC: toUTC.toISOString()},
        data: emptyData()
      }), { headers: corsHeaders });
    }

    // Phase 2: Order lines + payments (need order IDs)
    const [orderLines, payments] = await Promise.all([
      fetchOrderLines(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, orderIds),
      rpc(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.payment', 'search_read',
        [[['pos_order_id', 'in', orderIds]]],
        {fields: ['id', 'pos_order_id', 'payment_method_id', 'amount']})
    ]);

    const insights = processInsights(orders, orderLines, payments, paymentMethods);
    return new Response(JSON.stringify({
      success: true, timestamp: new Date().toISOString(),
      query: {from: fromIST.toISOString(), to: toIST.toISOString(), fromUTC: fromUTC.toISOString(), toUTC: toUTC.toISOString()},
      data: insights
    }), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), { status: 500, headers: corsHeaders });
  }
}

function emptyData() {
  return {
    summary: {totalRevenue: 0, totalOrders: 0, totalQty: 0, avgOrderValue: 0},
    topProducts: [], categories: [], products: [],
    channels: {cashCounter: {amount: 0, orders: 0, percentage: 0}, runners: {amount: 0, orders: 0, percentage: 0}},
    runners: [], payments: [], hourly: [], productHourly: {}
  };
}

async function rpc(url, db, uid, apiKey, model, method, args, kwargs = {}) {
  const payload = {
    jsonrpc: '2.0', method: 'call', id: 1,
    params: { service: 'object', method: 'execute_kw', args: [db, uid, apiKey, model, method, args, kwargs] }
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result || [];
}

async function fetchOrderLines(url, db, uid, apiKey, orderIds) {
  const payload = {jsonrpc: '2.0', method: 'call', id: 3,
    params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.order.line', 'search_read', [[['order_id', 'in', orderIds]]], {fields: ['id', 'order_id', 'product_id', 'qty', 'price_subtotal_incl']}]}};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  return data.result || [];
}

function classifyPaymentMethod(pm) {
  if (pm.type === 'cash') return 'Cash';
  if (pm.type === 'pay_later') return 'Complimentary';
  const lower = pm.name.toLowerCase();
  if (lower.includes('upi') || lower.includes('paytm') || lower.includes('phonepe') || lower.includes('gpay')) return 'UPI';
  if (lower.includes('card')) return 'Card';
  return 'Other';
}

function categorizeProduct(name) {
  const lower = name.toLowerCase();
  if (lower.includes('chai') || lower.includes('coffee') || lower.includes('tea')) return 'Chai';
  return 'Snacks';
}

function processInsights(orders, orderLines, payments, paymentMethods) {
  const RUNNERS = {64: 'FAROOQ', 65: 'AMIN', 66: 'NCH Runner 03', 67: 'NCH Runner 04', 68: 'NCH Runner 05'};

  // Payment method ID → group name
  const pmGroupMap = {};
  paymentMethods.forEach(pm => { pmGroupMap[pm.id] = classifyPaymentMethod(pm); });

  const products = {};
  const hourlyData = {};
  const channelSales = {cashCounter: {amount: 0, orders: 0}, runners: {amount: 0, orders: 0}};
  const runnerSales = {};
  const categoryTotals = {};
  let totalRevenue = 0, totalQty = 0;

  const orderMap = {};
  orders.forEach(o => { orderMap[o.id] = o; });

  orderLines.forEach(line => {
    const pid = line.product_id ? line.product_id[0] : 0;
    const pname = line.product_id ? line.product_id[1] : 'Unknown';
    const category = categorizeProduct(pname);
    if (!products[pid]) products[pid] = {id: pid, name: pname, qty: 0, amount: 0, category};
    products[pid].qty += line.qty;
    products[pid].amount += line.price_subtotal_incl;
    totalQty += line.qty;

    if (!categoryTotals[category]) categoryTotals[category] = {name: category, amount: 0, qty: 0, products: 0};
    categoryTotals[category].amount += line.price_subtotal_incl;
    categoryTotals[category].qty += line.qty;
  });

  orders.forEach(order => {
    totalRevenue += order.amount_total;
    const partnerId = order.partner_id ? order.partner_id[0] : null;
    const orderDate = order.date_order ? new Date(order.date_order.replace(' ', 'T') + 'Z') : null;
    const istTime = orderDate ? new Date(orderDate.getTime() + 5.5 * 60 * 60 * 1000) : null;
    const istHour = istTime ? istTime.getUTCHours() : 0;
    const hourKey = istHour.toString().padStart(2, '0');

    if (!hourlyData[hourKey]) hourlyData[hourKey] = {orders: 0, amount: 0};
    hourlyData[hourKey].orders++;
    hourlyData[hourKey].amount += order.amount_total;

    if (partnerId && RUNNERS[partnerId]) {
      channelSales.runners.amount += order.amount_total;
      channelSales.runners.orders++;
      if (!runnerSales[partnerId]) runnerSales[partnerId] = {id: partnerId, name: RUNNERS[partnerId], amount: 0, orders: 0, products: {}};
      runnerSales[partnerId].amount += order.amount_total;
      runnerSales[partnerId].orders++;
    } else {
      channelSales.cashCounter.amount += order.amount_total;
      channelSales.cashCounter.orders++;
    }
  });

  // Runner product breakdown + per-product hourly
  const productHourly = {};
  orderLines.forEach(line => {
    const orderId = line.order_id ? line.order_id[0] : null;
    const order = orderId ? orderMap[orderId] : null;
    if (order) {
      const partnerId = order.partner_id ? order.partner_id[0] : null;
      if (partnerId && runnerSales[partnerId]) {
        const pname = line.product_id ? line.product_id[1] : 'Unknown';
        if (!runnerSales[partnerId].products[pname]) runnerSales[partnerId].products[pname] = 0;
        runnerSales[partnerId].products[pname] += line.qty;
      }
      const pid = line.product_id ? line.product_id[0] : 0;
      const orderDate = order.date_order ? new Date(order.date_order.replace(' ', 'T') + 'Z') : null;
      const istTime = orderDate ? new Date(orderDate.getTime() + 5.5 * 60 * 60 * 1000) : null;
      const istHour = istTime ? istTime.getUTCHours() : 0;
      if (!productHourly[pid]) productHourly[pid] = {};
      if (!productHourly[pid][istHour]) productHourly[pid][istHour] = 0;
      productHourly[pid][istHour] += line.qty;
    }
  });

  // Payment aggregation + order→paymentMethod mapping
  const paymentTotals = {};
  const orderPaymentMap = {}; // orderId → payment group (for product-level breakdown)
  let complimentaryAmount = 0, complimentaryCount = 0;
  payments.forEach(p => {
    const methodId = p.payment_method_id ? p.payment_method_id[0] : 0;
    const group = pmGroupMap[methodId] || 'Other';
    if (!paymentTotals[group]) paymentTotals[group] = {name: group, amount: 0, count: 0};
    paymentTotals[group].amount += p.amount;
    paymentTotals[group].count++;
    if (group === 'Complimentary') {
      complimentaryAmount += p.amount;
      complimentaryCount++;
    }
    // Map order to its primary payment method (largest amount wins for split payments)
    const oid = p.pos_order_id ? p.pos_order_id[0] : null;
    if (oid) {
      if (!orderPaymentMap[oid] || p.amount > (orderPaymentMap[oid].amount || 0)) {
        orderPaymentMap[oid] = { group, amount: p.amount };
      }
    }
  });

  // Products broken down by payment method
  const productsByPayment = {};
  orderLines.forEach(line => {
    const oid = line.order_id ? line.order_id[0] : null;
    const pmInfo = oid ? orderPaymentMap[oid] : null;
    const pmGroup = pmInfo ? pmInfo.group : 'Unknown';
    const pname = line.product_id ? line.product_id[1] : 'Unknown';
    if (!productsByPayment[pmGroup]) productsByPayment[pmGroup] = {};
    if (!productsByPayment[pmGroup][pname]) productsByPayment[pmGroup][pname] = { qty: 0, amount: 0 };
    productsByPayment[pmGroup][pname].qty += line.qty;
    productsByPayment[pmGroup][pname].amount += line.price_subtotal_incl;
  });

  Object.values(products).forEach(p => {
    if (categoryTotals[p.category]) categoryTotals[p.category].products++;
  });

  const productList = Object.values(products).sort((a, b) => b.amount - a.amount);
  const topProducts = productList.slice(0, 5).map(p => ({id: p.id, name: p.name, qty: p.qty, amount: p.amount, category: p.category}));
  const runnerList = Object.values(runnerSales).sort((a, b) => b.amount - a.amount);

  const hourlyArray = [];
  for (let h = 0; h <= 23; h++) {
    const key = h.toString().padStart(2, '0');
    hourlyArray.push({hour: h, label: h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? (h-12)+' PM' : h+' AM', orders: hourlyData[key]?.orders || 0, amount: hourlyData[key]?.amount || 0});
  }

  const totalOrders = channelSales.cashCounter.orders + channelSales.runners.orders;

  // Payment list sorted by amount
  const paymentList = Object.values(paymentTotals).sort((a, b) => b.amount - a.amount);
  paymentList.forEach(p => { p.percentage = totalRevenue > 0 ? Math.round((p.amount / totalRevenue) * 100) : 0; });

  return {
    summary: {
      totalRevenue, totalOrders, totalQty,
      avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
      ...(complimentaryCount > 0 ? {complimentary: {amount: complimentaryAmount, count: complimentaryCount}} : {})
    },
    topProducts,
    categories: Object.values(categoryTotals).sort((a, b) => b.amount - a.amount),
    products: productList,
    channels: {
      cashCounter: {...channelSales.cashCounter, percentage: totalRevenue > 0 ? Math.round((channelSales.cashCounter.amount / totalRevenue) * 100) : 0},
      runners: {...channelSales.runners, percentage: totalRevenue > 0 ? Math.round((channelSales.runners.amount / totalRevenue) * 100) : 0}
    },
    payments: paymentList,
    productsByPayment,
    runners: runnerList,
    hourly: hourlyArray,
    productHourly
  };
}
