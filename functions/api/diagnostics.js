// Temporary diagnostics endpoint — comprehensive system audit
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

  async function odooQuery(model, domain, fields, extra = {}) {
    const payload = {jsonrpc: '2.0', method: 'call', params: {service: 'object', method: 'execute_kw', args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, model, 'search_read', [domain], {fields, ...extra}]}, id: 1};
    const res = await fetch(ODOO_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    const data = await res.json();
    return data.result || data.error;
  }

  try {
    const results = {};

    // === NCH Partners (runners, customers mapped to POS) ===
    if (check === 'partners') {
      results.partners = await odooQuery('res.partner', [['company_id', '=', 10]], ['id', 'name', 'barcode', 'email', 'phone', 'category_id'], {order: 'id asc'});
    }

    // === POS Sessions (active and recent) ===
    if (check === 'sessions') {
      results.sessions = await odooQuery('pos.session', [['config_id', 'in', [27, 28, 29]]], ['id', 'name', 'config_id', 'state', 'start_at', 'stop_at', 'user_id', 'cash_register_balance_start', 'cash_register_balance_end', 'cash_register_balance_end_real'], {order: 'id desc', limit: 20});
    }

    // === Products available in NCH POS ===
    if (check === 'products') {
      results.products = await odooQuery('product.product', [['available_in_pos', '=', true], ['company_id', '=', 10]], ['id', 'name', 'lst_price', 'pos_categ_ids', 'barcode', 'type'], {order: 'name asc'});
    }

    // === Journals used for NCH ===
    if (check === 'journals') {
      results.journals = await odooQuery('account.journal', [['company_id', '=', 10]], ['id', 'name', 'type', 'code'], {order: 'id asc'});
    }

    // === Today's orders with FULL details (POS 27, 28 only) ===
    if (check === 'todays-orders') {
      const fromOdoo = new Date(Date.now() - (5.5 * 60 * 60 * 1000));
      fromOdoo.setUTCHours(0, 0, 0, 0);
      // IST midnight = UTC 18:30 previous day
      const istMidnight = new Date();
      istMidnight.setHours(0, 0, 0, 0);
      const utcFrom = new Date(istMidnight.getTime() - (5.5 * 60 * 60 * 1000));
      const fromStr = utcFrom.toISOString().slice(0, 19).replace('T', ' ');
      const toStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

      results.orders = await odooQuery('pos.order', [['config_id', 'in', [27, 28]], ['date_order', '>=', fromStr], ['date_order', '<=', toStr]], ['id', 'name', 'date_order', 'amount_total', 'amount_paid', 'partner_id', 'config_id', 'payment_ids', 'state', 'lines'], {order: 'date_order desc'});

      // Group orders by: POS config x has partner x payment method
      const summary = {
        pos27: {total: 0, withPartner: 0, withoutPartner: 0, byPartner: {}, byPaymentMethod: {}},
        pos28: {total: 0, withPartner: 0, withoutPartner: 0, byPartner: {}, byPaymentMethod: {}}
      };

      // Get payments for these orders
      const orderIds = (results.orders || []).map(o => o.id);
      let allPayments = [];
      if (orderIds.length > 0) {
        allPayments = await odooQuery('pos.payment', [['pos_order_id', 'in', orderIds]], ['id', 'amount', 'payment_method_id', 'pos_order_id', 'session_id']);
      }

      const paymentsByOrder = {};
      (allPayments || []).forEach(p => {
        const oid = p.pos_order_id ? p.pos_order_id[0] : null;
        if (oid) { if (!paymentsByOrder[oid]) paymentsByOrder[oid] = []; paymentsByOrder[oid].push(p); }
      });

      (results.orders || []).forEach(o => {
        const configId = o.config_id ? o.config_id[0] : null;
        const partnerId = o.partner_id ? o.partner_id[0] : null;
        const partnerName = o.partner_id ? o.partner_id[1] : 'No Partner';
        const bucket = configId === 27 ? summary.pos27 : configId === 28 ? summary.pos28 : null;
        if (!bucket) return;

        bucket.total++;
        if (partnerId) {
          bucket.withPartner++;
          if (!bucket.byPartner[partnerName]) bucket.byPartner[partnerName] = {count: 0, amount: 0};
          bucket.byPartner[partnerName].count++;
          bucket.byPartner[partnerName].amount += o.amount_total;
        } else {
          bucket.withoutPartner++;
        }

        const oPayments = paymentsByOrder[o.id] || [];
        oPayments.forEach(p => {
          const pmName = p.payment_method_id ? p.payment_method_id[1] : 'Unknown';
          if (!bucket.byPaymentMethod[pmName]) bucket.byPaymentMethod[pmName] = {count: 0, amount: 0};
          bucket.byPaymentMethod[pmName].count++;
          bucket.byPaymentMethod[pmName].amount += p.amount;
        });
      });

      results.orderSummary = summary;
      // Don't return raw orders (too large), just the summary
      results.orderCount = (results.orders || []).length;
      delete results.orders;
    }

    // === POS 28 deep dive: every order with partner + payment method ===
    if (check === 'pos28-detail') {
      const istMidnight = new Date();
      istMidnight.setHours(0, 0, 0, 0);
      const utcFrom = new Date(istMidnight.getTime() - (5.5 * 60 * 60 * 1000));
      const fromStr = utcFrom.toISOString().slice(0, 19).replace('T', ' ');
      const toStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

      const orders = await odooQuery('pos.order', [['config_id', '=', 28], ['date_order', '>=', fromStr], ['date_order', '<=', toStr]], ['id', 'name', 'date_order', 'amount_total', 'partner_id', 'state'], {order: 'date_order desc'});

      const orderIds = (orders || []).map(o => o.id);
      let allPayments = [];
      if (orderIds.length > 0) {
        allPayments = await odooQuery('pos.payment', [['pos_order_id', 'in', orderIds]], ['id', 'amount', 'payment_method_id', 'pos_order_id']);
      }

      const paymentsByOrder = {};
      (allPayments || []).forEach(p => {
        const oid = p.pos_order_id ? p.pos_order_id[0] : null;
        if (oid) { if (!paymentsByOrder[oid]) paymentsByOrder[oid] = []; paymentsByOrder[oid].push(p); }
      });

      results.pos28Orders = (orders || []).map(o => ({
        id: o.id,
        name: o.name,
        date: o.date_order,
        amount: o.amount_total,
        partner: o.partner_id ? o.partner_id[1] : null,
        partnerId: o.partner_id ? o.partner_id[0] : null,
        payments: (paymentsByOrder[o.id] || []).map(p => ({
          method: p.payment_method_id ? p.payment_method_id[1] : 'Unknown',
          methodId: p.payment_method_id ? p.payment_method_id[0] : null,
          amount: p.amount
        }))
      }));
    }

    // === Razorpay complete: all QR codes + today's payments per QR ===
    if (check === 'razorpay-full') {
      const auth = btoa(RAZORPAY_KEY + ':' + RAZORPAY_SECRET);

      // All QR codes
      const qrRes = await fetch('https://api.razorpay.com/v1/payments/qr_codes?count=100', {
        headers: {'Authorization': 'Basic ' + auth}
      });
      const qrData = await qrRes.json();
      results.qrCodes = (qrData.items || []).map(q => ({
        id: q.id, name: q.name, description: q.description,
        status: q.status, usage: q.usage,
        lifetime_amount: q.payments_amount_received / 100,
        lifetime_count: q.payments_count_received
      }));

      // Today's payments per QR
      const istMidnight = new Date();
      istMidnight.setHours(0, 0, 0, 0);
      const fromUnix = Math.floor((istMidnight.getTime() - (5.5 * 60 * 60 * 1000)) / 1000);
      const toUnix = Math.floor(Date.now() / 1000);

      const qrIds = [
        {id: 'qr_SBdtUCLSHVfRtT', name: 'NCH-COUNTER'},
        {id: 'qr_SBuDBQDKrC8Bch', name: 'NCH-RUNNER-COUNTER'},
        {id: 'qr_SBdtZG1AMDwSmJ', name: 'RUN001-FAROOQ'},
        {id: 'qr_SBdte3aRvGpRMY', name: 'RUN002-AMIN'},
        {id: 'qr_SBgTo2a39kYmET', name: 'RUN003'},
        {id: 'qr_SBgTtFrfddY4AW', name: 'RUN004'},
        {id: 'qr_SBgTyFKUsdwLe1', name: 'RUN005'}
      ];

      const qrPayments = {};
      for (const qr of qrIds) {
        const res = await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qr.id}/payments?count=100&from=${fromUnix}&to=${toUnix}`, {
          headers: {'Authorization': 'Basic ' + auth}
        });
        const data = await res.json();
        const captured = (data.items || []).filter(p => p.status === 'captured');
        qrPayments[qr.name] = {
          count: captured.length,
          amount: captured.reduce((s, p) => s + p.amount / 100, 0)
        };
      }
      results.todaysQRPayments = qrPayments;
    }

    // === Payment methods (keep from original) ===
    if (check === 'payment-methods') {
      results.paymentMethods = await odooQuery('pos.payment.method', [['company_id', '=', 10]], ['id', 'name', 'type', 'is_cash_count', 'journal_id'], {order: 'id asc'});
    }

    // === POS configs (keep from original) ===
    if (check === 'pos-configs') {
      results.posConfigs = await odooQuery('pos.config', [['id', 'in', [27, 28, 29]]], ['id', 'name', 'payment_method_ids', 'current_session_id', 'pricelist_id'], {order: 'id asc'});
    }

    return new Response(JSON.stringify({success: true, data: results}, null, 2), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }
}
