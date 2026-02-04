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

  let fromIST, toIST;
  if (fromParam) { fromIST = new Date(fromParam); } 
  else { fromIST = new Date(); fromIST.setTime(fromIST.getTime() - 24 * 60 * 60 * 1000); }
  toIST = toParam ? new Date(toParam) : new Date();

  const fromUTC = new Date(fromIST.getTime() - (5.5 * 60 * 60 * 1000));
  const toUTC = new Date(toIST.getTime() - (5.5 * 60 * 60 * 1000));
  const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');
  const toOdoo = toUTC.toISOString().slice(0, 19).replace('T', ' ');

  try {
    const [orders, orderLines] = await Promise.all([
      fetchOrders(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
      fetchOrderLines(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo)
    ]);
    const insights = processInsights(orders, orderLines);
    return new Response(JSON.stringify({success: true, timestamp: new Date().toISOString(), query: {from: fromIST.toISOString(), to: toIST.toISOString()}, data: insights}), { headers: corsHeaders });
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

function processInsights(orders, orderLines) {
  const RUNNERS = {64: 'FAROOQ', 65: 'AMIN', 66: 'NCH Runner 03', 67: 'NCH Runner 04', 68: 'NCH Runner 05'};
  const RUNNER_BARCODES = {64: 'RUN001', 65: 'RUN002', 66: 'RUN003', 67: 'RUN004', 68: 'RUN005'};
  const POS = {CASH_COUNTER: 27, RUNNER_COUNTER: 28};

  const orderLookup = {};
  orders.forEach(o => { orderLookup[o.id] = {partnerId: o.partner_id ? o.partner_id[0] : null, configId: o.config_id ? o.config_id[0] : null, date: o.date_order, amount: o.amount_total}; });

  const productSales = {};
  const keyProducts = {
    'Irani Chai': {name: 'Irani Chai', qty: 0, amount: 0, icon: '☕'},
    'Bun Maska': {name: 'Bun Maska', qty: 0, amount: 0, icon: '🥖'},
    'Osmania Biscuit': {name: 'Osmania Biscuit', qty: 0, amount: 0, icon: '🍪'},
    'Chicken Cutlet': {name: 'Chicken Cutlet', qty: 0, amount: 0, icon: '🍗'}
  };
  
  const channelSales = {cashCounter: {orders: 0, amount: 0}, runners: {orders: 0, amount: 0}};
  const runnerSales = {};
  const hourlyData = {};
  let totalRevenue = 0, totalQty = 0;

  orderLines.forEach(line => {
    const order = orderLookup[line.order_id ? line.order_id[0] : null];
    if (!order) return;
    const productName = line.product_id ? line.product_id[1] : 'Unknown';
    const qty = line.qty || 0;
    const amount = line.price_subtotal_incl || 0;
    const isChai = productName.toLowerCase().includes('chai');
    const category = isChai ? 'Chai' : 'Snacks';
    const isRunner = order.partnerId && RUNNERS[order.partnerId];

    if (!productSales[productName]) productSales[productName] = {name: productName, qty: 0, amount: 0, category};
    productSales[productName].qty += qty;
    productSales[productName].amount += amount;

    const pLower = productName.toLowerCase();
    if (pLower.includes('irani') || (pLower.includes('chai') && !pLower.includes('pack'))) { keyProducts['Irani Chai'].qty += qty; keyProducts['Irani Chai'].amount += amount; }
    if (pLower.includes('bun') && pLower.includes('maska')) { keyProducts['Bun Maska'].qty += qty; keyProducts['Bun Maska'].amount += amount; }
    if (pLower.includes('osmania') && !pLower.includes('pack')) { keyProducts['Osmania Biscuit'].qty += qty; keyProducts['Osmania Biscuit'].amount += amount; }
    if (pLower.includes('chicken') && pLower.includes('cutlet')) { keyProducts['Chicken Cutlet'].qty += qty; keyProducts['Chicken Cutlet'].amount += amount; }

    totalRevenue += amount;
    totalQty += qty;

    if (isRunner) {
      const runnerId = order.partnerId;
      if (!runnerSales[runnerId]) runnerSales[runnerId] = {id: runnerId, name: RUNNERS[runnerId], barcode: RUNNER_BARCODES[runnerId], qty: 0, amount: 0, products: {}};
      runnerSales[runnerId].qty += qty;
      runnerSales[runnerId].amount += amount;
      if (!runnerSales[runnerId].products[productName]) runnerSales[runnerId].products[productName] = {name: productName, qty: 0, amount: 0};
      runnerSales[runnerId].products[productName].qty += qty;
      runnerSales[runnerId].products[productName].amount += amount;
    }
  });

  const processedOrders = new Set();
  orders.forEach(o => {
    if (processedOrders.has(o.id)) return;
    processedOrders.add(o.id);
    const partnerId = o.partner_id ? o.partner_id[0] : null;
    const isRunner = partnerId && RUNNERS[partnerId];
    if (o.config_id[0] === POS.CASH_COUNTER && !isRunner) { channelSales.cashCounter.orders++; channelSales.cashCounter.amount += o.amount_total; }
    else { channelSales.runners.orders++; channelSales.runners.amount += o.amount_total; }
    const hour = (new Date(o.date_order).getUTCHours() + 5) % 24;
    const hourKey = hour.toString().padStart(2, '0');
    if (!hourlyData[hourKey]) hourlyData[hourKey] = {orders: 0, amount: 0};
    hourlyData[hourKey].orders++;
    hourlyData[hourKey].amount += o.amount_total;
  });

  const productList = Object.values(productSales).filter(p => p.qty > 0).sort((a, b) => b.amount - a.amount);
  const runnerList = Object.values(runnerSales).map(r => ({...r, products: Object.values(r.products).sort((a, b) => b.amount - a.amount)})).sort((a, b) => b.amount - a.amount);
  const hourlyArray = [];
  for (let h = 6; h <= 23; h++) { const key = h.toString().padStart(2, '0'); hourlyArray.push({hour: h, label: h > 12 ? (h-12)+' PM' : h === 12 ? '12 PM' : h+' AM', orders: hourlyData[key]?.orders || 0, amount: hourlyData[key]?.amount || 0}); }

  const totalOrders = channelSales.cashCounter.orders + channelSales.runners.orders;
  return {
    summary: {totalRevenue, totalOrders, totalQty, avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0},
    keyProducts,
    products: productList,
    channels: {cashCounter: {...channelSales.cashCounter, percentage: totalRevenue > 0 ? Math.round((channelSales.cashCounter.amount / totalRevenue) * 100) : 0}, runners: {...channelSales.runners, percentage: totalRevenue > 0 ? Math.round((channelSales.runners.amount / totalRevenue) * 100) : 0}},
    runners: runnerList,
    hourly: hourlyArray
  };
}
