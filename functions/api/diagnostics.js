// Temporary diagnostics endpoint — pulls payment methods from Odoo and QR codes from Razorpay
// DELETE THIS FILE after analysis is complete

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const check = url.searchParams.get('check');

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;
  const RAZORPAY_KEY = context.env.RAZORPAY_KEY;
  const RAZORPAY_SECRET = context.env.RAZORPAY_SECRET;

  try {
    const results = {};

    // 1. Get ALL payment methods from Odoo
    if (!check || check === 'all' || check === 'payment-methods') {
      const pmPayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.payment.method', 'search_read', [[]], {fields: ['id', 'name', 'type', 'is_cash_count', 'journal_id', 'company_id'], order: 'id asc'}]}, id: 1};
      const pmRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(pmPayload)});
      const pmData = await pmRes.json();
      results.paymentMethods = pmData.result || pmData.error;
    }

    // 2. Get POS configs
    if (!check || check === 'all' || check === 'pos-configs') {
      const posPayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.config', 'search_read', [[]], {fields: ['id', 'name', 'payment_method_ids', 'current_session_id'], order: 'id asc'}]}, id: 2};
      const posRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(posPayload)});
      const posData = await posRes.json();
      results.posConfigs = posData.result || posData.error;
    }

    // 3. Get ALL Razorpay QR codes
    if (!check || check === 'all' || check === 'razorpay-qr') {
      const auth = btoa(RAZORPAY_KEY + ':' + RAZORPAY_SECRET);
      const qrRes = await fetch('https://api.razorpay.com/v1/payments/qr_codes?count=100', {
        headers: {'Authorization': 'Basic ' + auth}
      });
      const qrData = await qrRes.json();
      results.razorpayQRCodes = qrData.items ? qrData.items.map(q => ({
        id: q.id, name: q.name, description: q.description,
        usage: q.usage, status: q.status,
        customer_id: q.customer_id,
        close_by: q.close_by,
        payments_amount_received: q.payments_amount_received,
        payments_count_received: q.payments_count_received,
        fixed_amount: q.fixed_amount
      })) : qrData;
    }

    // 4. Today's payments breakdown by payment method (to see Runner Counter UPI in action)
    if (!check || check === 'all' || check === 'todays-payments') {
      const now = new Date();
      const todayStart = new Date(now.getTime() - (5.5 * 60 * 60 * 1000)); // IST midnight in UTC
      todayStart.setUTCHours(todayStart.getUTCHours() - todayStart.getUTCHours() % 24, 0, 0, 0);
      // Actually, let's just get from IST 00:00 today
      const fromUTC = new Date(Date.now());
      fromUTC.setHours(0, 0, 0, 0);
      const fromOdoo = new Date(fromUTC.getTime() - (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 19).replace('T', ' ');
      const toOdoo = new Date().toISOString().slice(0, 19).replace('T', ' ');

      const payPayload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, 'pos.payment', 'search_read', [[['payment_date', '>=', fromOdoo], ['payment_date', '<=', toOdoo]]], {fields: ['id', 'amount', 'payment_date', 'payment_method_id', 'pos_order_id', 'session_id']}]}, id: 3};
      const payRes = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payPayload)});
      const payData = await payRes.json();

      // Group by payment method
      const byMethod = {};
      if (payData.result) {
        for (const p of payData.result) {
          const pmId = p.payment_method_id ? p.payment_method_id[0] : 'unknown';
          const pmName = p.payment_method_id ? p.payment_method_id[1] : 'Unknown';
          const key = pmId + ':' + pmName;
          if (!byMethod[key]) byMethod[key] = {id: pmId, name: pmName, count: 0, total: 0};
          byMethod[key].count++;
          byMethod[key].total += p.amount;
        }
      }
      results.todaysPaymentsByMethod = Object.values(byMethod).sort((a, b) => a.id - b.id);
      results.todaysPaymentsCount = payData.result ? payData.result.length : 0;
    }

    // 5. Razorpay counter payments (non-QR) — check if there's a general Razorpay flow
    if (!check || check === 'all' || check === 'razorpay-payments') {
      const auth = btoa(RAZORPAY_KEY + ':' + RAZORPAY_SECRET);
      const fromUnix = Math.floor((Date.now() - 24*60*60*1000) / 1000);
      const toUnix = Math.floor(Date.now() / 1000);
      const rpRes = await fetch(`https://api.razorpay.com/v1/payments?count=10&skip=0&from=${fromUnix}&to=${toUnix}`, {
        headers: {'Authorization': 'Basic ' + auth}
      });
      const rpData = await rpRes.json();
      results.razorpayRecentPayments = rpData.items ? rpData.items.map(p => ({
        id: p.id, amount: p.amount/100, status: p.status, method: p.method,
        description: p.description, vpa: p.vpa, email: p.email,
        notes: p.notes, created_at: new Date(p.created_at * 1000).toISOString()
      })) : rpData;
      results.razorpayRecentCount = rpData.count;
    }

    return new Response(JSON.stringify({success: true, data: results}, null, 2), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }
}
