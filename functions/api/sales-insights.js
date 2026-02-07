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

  // TIMEZONE HANDLING (same as nch-data.js):
  // - Input params are IST (local time strings)
  // - Cloudflare Workers run in UTC
  // - Odoo stores dates in UTC
  
  let fromUTC, toUTC;
  
  if (fromParam) {
    // Input is IST time string, convert to UTC
    const fromParsed = new Date(fromParam);
    fromUTC = new Date(fromParsed.getTime() - (5.5 * 60 * 60 * 1000));
  } else {
    // Default: 24 hours ago
    fromUTC = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }
  
  if (toParam) {
    // Input is IST time string, convert to UTC
    const toParsed = new Date(toParam);
    toUTC = new Date(toParsed.getTime() - (5.5 * 60 * 60 * 1000));
  } else {
    // Default: NOW - already UTC, no conversion!
    toUTC = new Date();
  }

  const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');
  const toOdoo = toUTC.toISOString().slice(0, 19).replace('T', ' ');
  
  // For display purposes
  const fromIST = new Date(fromUTC.getTime() + (5.5 * 60 * 60 * 1000));
  const toIST = new Date(toUTC.getTime() + (5.5 * 60 * 60 * 1000));

  try {
    const [orders, orderLines] = await Promise.all([
      fetchOrders(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
      fetchOrderLines(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo)
    ]);
    const insights = processInsights(orders, orderLines);
    return new Response(JSON.stringify({success: true, timestamp: new Date().toISOString(), query: {from: fromIST.toISOString(), to: toIST.toISOString(), fromUTC: fromUTC.toISOString(), toUTC: toUTC.toISOString()}, data: insights}), { headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), { status: 500, headers: corsHeaders });
  }
}

async function fetchOrders(url, db, uid, apiKey, since, until) {
  const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.order', 'search_read', [[['config_id', 'in', [27, 28]], ['date_order', '>=', since], ['date_order', '<=', until], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]], {fields: ['id', 'name', 'date_order', 'amount_total', 'partner_id', 'config_id']}]}, id: 1};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  return data.result || [];
}

async function fetchOrderLines(url, db, uid, apiKey, since, until) {
  const orderPayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.order', 'search', [[['config_id', 'in', [27, 28]], ['date_order', '>=', since], ['date_order', '<=', until], ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]]]}, id: 2};
  const orderResponse = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(orderPayload)});
  const orderData = await orderResponse.json();
  const orderIds = orderData.result || [];
  if (orderIds.length === 0) return [];
  const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [db, uid, apiKey, 'pos.order.line', 'search_read', [[['order_id', 'in', orderIds]]], {fields: ['id', 'order_id', 'product_id', 'qty', 'price_subtotal_incl']}]}, id: 3};
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  return data.result || [];
}

function categorizeProduct(name) {
  // Categorize products based on name keywords — matches POS categories (Chai=48, Snacks=47)
  const lower = name.toLowerCase();
  if (lower.includes('chai') || lower.includes('coffee') || lower.includes('tea')) return 'Chai';
  return 'Snacks';
}

function processInsights(orders, orderLines) {
  const RUNNERS = {64: 'FAROOQ', 65: 'AMIN', 66: 'NCH Runner 03', 67: 'NCH Runner 04', 68: 'NCH Runner 05'};
  const products = {};
  const hourlyData = {};
  const channelSales = {cashCounter: {amount: 0, orders: 0}, runners: {amount: 0, orders: 0}};
  const runnerSales = {};
  const categoryTotals = {}; // Dynamic category aggregation
  let totalRevenue = 0, totalQty = 0;

  // Build order lookup map for O(1) access (fixes O(n²) runner product breakdown)
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

    // Category-level aggregation
    if (!categoryTotals[category]) categoryTotals[category] = {name: category, amount: 0, qty: 0, products: 0};
    categoryTotals[category].amount += line.price_subtotal_incl;
    categoryTotals[category].qty += line.qty;
  });

  orders.forEach(order => {
    totalRevenue += order.amount_total;
    const partnerId = order.partner_id ? order.partner_id[0] : null;
    const configId = order.config_id ? order.config_id[0] : null;
    // Convert UTC date_order to IST hour using proper Date math (+5:30)
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
      // Initialize runner sales entry BEFORE processing order lines
      if (!runnerSales[partnerId]) runnerSales[partnerId] = {id: partnerId, name: RUNNERS[partnerId], amount: 0, orders: 0, products: {}};
      runnerSales[partnerId].amount += order.amount_total;
      runnerSales[partnerId].orders++;
    } else {
      channelSales.cashCounter.amount += order.amount_total;
      channelSales.cashCounter.orders++;
    }
  });

  // Second pass for runner product breakdown — needed because runnerSales entries
  // are created in the orders loop above, but orderLines loop needs them to exist
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
    }
  });

  // Count unique products per category
  Object.values(products).forEach(p => {
    if (categoryTotals[p.category]) categoryTotals[p.category].products++;
  });

  const productList = Object.values(products).sort((a, b) => b.amount - a.amount);

  // Dynamic top products: top 5 by revenue (auto-adapts as menu grows)
  const topProducts = productList.slice(0, 5).map(p => ({
    id: p.id, name: p.name, qty: p.qty, amount: p.amount, category: p.category
  }));

  const runnerList = Object.values(runnerSales).sort((a, b) => b.amount - a.amount);
  // Full 24-hour window (NCH is a 24-hour cafe): 12 AM → 11 PM IST
  const hourlyArray = [];
  for (let h = 0; h <= 23; h++) { const key = h.toString().padStart(2, '0'); hourlyArray.push({hour: h, label: h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? (h-12)+' PM' : h+' AM', orders: hourlyData[key]?.orders || 0, amount: hourlyData[key]?.amount || 0}); }

  const totalOrders = channelSales.cashCounter.orders + channelSales.runners.orders;
  return {
    summary: {totalRevenue, totalOrders, totalQty, avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0},
    topProducts,
    categories: Object.values(categoryTotals).sort((a, b) => b.amount - a.amount),
    products: productList,
    channels: {cashCounter: {...channelSales.cashCounter, percentage: totalRevenue > 0 ? Math.round((channelSales.cashCounter.amount / totalRevenue) * 100) : 0}, runners: {...channelSales.runners, percentage: totalRevenue > 0 ? Math.round((channelSales.runners.amount / totalRevenue) * 100) : 0}},
    runners: runnerList,
    hourly: hourlyArray
  };
}
