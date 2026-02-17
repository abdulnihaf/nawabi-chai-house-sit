// NCH Purchase Order API - Cloudflare Worker
// Handles: PO creation, vendor/product lists, last prices, seed POs

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;

  // PIN verification — only Zoya and Nihaf can create POs
  const PO_PINS = {'0305': 'Nihaf', '2026': 'Zoya'};

  try {
    // ─── VERIFY PIN ──────────────────────────────────────────────
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PO_PINS[pin]) {
        return new Response(JSON.stringify({success: true, user: PO_PINS[pin]}), {headers: corsHeaders});
      }
      return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
    }

    // ─── VENDORS ─────────────────────────────────────────────────
    // Fetch active suppliers for NCH
    if (action === 'vendors') {
      const vendors = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'res.partner', 'search_read',
        [[['supplier_rank', '>', 0], ['company_id', 'in', [10, false]]]],
        {fields: ['id', 'name', 'phone', 'mobile'], order: 'name asc'}
      );
      const list = vendors.map(v => ({id: v.id, name: v.name, phone: v.phone || v.mobile || ''}));
      return new Response(JSON.stringify({success: true, vendors: list}), {headers: corsHeaders});
    }

    // ─── PRODUCTS ────────────────────────────────────────────────
    // Fetch NCH raw materials (RM-* coded products)
    if (action === 'products') {
      const products = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'product.product', 'search_read',
        [[['default_code', 'like', 'RM-'], ['company_id', 'in', [10, false]]]],
        {fields: ['id', 'name', 'default_code', 'uom_id'], order: 'name asc'}
      );
      const list = products.map(p => ({
        id: p.id, name: p.name, code: p.default_code || '',
        uom: p.uom_id ? p.uom_id[1] : 'Units',
      }));
      return new Response(JSON.stringify({success: true, products: list}), {headers: corsHeaders});
    }

    // ─── LAST PRICES ─────────────────────────────────────────────
    // Get last PO prices for a vendor's products
    if (action === 'last-prices') {
      const vendorId = parseInt(url.searchParams.get('vendor_id'));
      if (!vendorId) return new Response(JSON.stringify({success: false, error: 'Missing vendor_id'}), {headers: corsHeaders});

      const poLines = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'purchase.order.line', 'search_read',
        [[['partner_id', '=', vendorId], ['state', 'in', ['purchase', 'done']], ['company_id', '=', 10]]],
        {fields: ['product_id', 'price_unit', 'date_order'], order: 'date_order desc', limit: 100}
      );

      // Build map: product_id -> most recent price
      const prices = {};
      for (const line of poLines) {
        const pid = line.product_id[0];
        if (!prices[pid]) prices[pid] = line.price_unit;
      }
      return new Response(JSON.stringify({success: true, prices}), {headers: corsHeaders});
    }

    // ─── CREATE PO ───────────────────────────────────────────────
    if (action === 'create-po' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {pin, vendor_id, lines} = body;
      // lines: [{product_id, qty, price_unit, name}]

      const createdBy = PO_PINS[pin];
      if (!createdBy) return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
      if (!vendor_id || !lines || !Array.isArray(lines) || lines.length === 0) {
        return new Response(JSON.stringify({success: false, error: 'Missing vendor_id or lines'}), {headers: corsHeaders});
      }

      // Fetch product UOMs
      const productIds = lines.map(l => l.product_id);
      const productData = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'product.product', 'search_read',
        [[['id', 'in', productIds]]],
        {fields: ['id', 'name', 'uom_id']});
      const uomMap = Object.fromEntries(productData.map(p => [p.id, p.uom_id[0]]));

      const datePlanned = new Date().toISOString().slice(0, 19).replace('T', ' ');

      // Build order lines in Odoo format: [(0, 0, {vals})]
      const orderLines = lines.map(l => [0, 0, {
        product_id: l.product_id,
        product_qty: l.qty,
        price_unit: l.price_unit,
        name: l.name || 'Purchase',
        product_uom_id: uomMap[l.product_id] || 1,
        date_planned: datePlanned,
      }]);

      // Create PO
      const poId = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'purchase.order', 'create',
        [{partner_id: vendor_id, company_id: 10, order_line: orderLines}]
      );

      // Confirm PO (auto-creates stock.picking)
      await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'purchase.order', 'button_confirm', [[poId]]
      );

      // Read back PO name
      const po = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'purchase.order', 'read', [[poId]], {fields: ['name']}
      );
      const poName = po[0] ? po[0].name : `PO#${poId}`;

      return new Response(JSON.stringify({
        success: true, po_id: poId, po_name: poName, created_by: createdBy,
      }), {headers: corsHeaders});
    }

    // ─── RECENT POS ──────────────────────────────────────────────
    if (action === 'recent-pos') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const pos = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'purchase.order', 'search_read',
        [[['company_id', '=', 10]]],
        {fields: ['id', 'name', 'partner_id', 'date_order', 'state', 'amount_total'], order: 'date_order desc', limit}
      );
      const list = pos.map(p => ({
        id: p.id, name: p.name,
        vendor: p.partner_id ? p.partner_id[1] : 'Unknown',
        date: p.date_order, state: p.state, total: p.amount_total,
      }));
      return new Response(JSON.stringify({success: true, orders: list}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});

  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }
}

// ─── ODOO JSON-RPC HELPER ──────────────────────────────────────
async function odooCall(url, db, uid, apiKey, model, method, positionalArgs, kwargs) {
  const payload = {
    jsonrpc: '2.0', method: 'call',
    params: {
      service: 'object', method: 'execute_kw',
      args: [db, uid, apiKey, model, method, positionalArgs, kwargs || {}],
    },
    id: Date.now(),
  };
  const response = await fetch(url, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (data.error) {
    const msg = data.error.data?.message || data.error.message || JSON.stringify(data.error);
    throw new Error(`Odoo ${model}.${method}: ${msg}`);
  }
  return data.result;
}
