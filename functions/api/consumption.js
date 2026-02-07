// NCH Consumption Tracker API - Cloudflare Worker
// Tracks raw material consumption vs POS sales with product-to-material mapping

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;

  // ─── POS Product → Raw Material Mapping ────────────────────
  const PRODUCT_MAP = {
    1028: {name: 'Irani Chai',               code: 'NCH-IC',    materials: [1095, 1098, 1097, 1096, 1112, 1101]},
    1029: {name: 'Bun Maska',                code: 'NCH-BM',    materials: [1104]},
    1030: {name: 'Osmania Biscuit',          code: 'NCH-OB',    materials: [1105]},
    1031: {name: 'Chicken Cutlet',           code: 'NCH-CC',    materials: [1106, 1114]},
    1033: {name: 'Osmania Biscuit Pack of 3',code: 'NCH-OB3',   materials: [1105]},
    1094: {name: 'Water',                    code: 'NCH-WTR',   materials: [1107]},
    1102: {name: 'Nawabi Special Coffee',    code: 'NCH-NSC',   materials: [1095, 1097, 1112, 1101]},
    1103: {name: 'Lemon Tea',               code: 'LT',        materials: [1098, 1097, 1101]},
    1111: {name: 'Osmania Biscuit Box 500g', code: 'NCH-OBBOX', materials: [1110]},
    1115: {name: 'Pyaaz Samosa',            code: 'NCH-PS',    materials: [1113, 1114]},
  };

  const RAW_MATERIALS = {
    1095: {name: 'Buffalo Milk',            code: 'RM-BFM',  uom: 'L'},
    1096: {name: 'Skimmed Milk Powder',     code: 'RM-SMP',  uom: 'kg'},
    1097: {name: 'Sugar',                   code: 'RM-SUG',  uom: 'kg'},
    1098: {name: 'Tea Powder',              code: 'RM-TEA',  uom: 'kg'},
    1101: {name: 'Filter Water',            code: 'RM-WTR',  uom: 'L'},
    1104: {name: 'Buns',                    code: 'RM-BUN',  uom: 'Units'},
    1105: {name: 'Osmania Biscuit (Loose)', code: 'RM-OSMG', uom: 'Units'},
    1106: {name: 'Chicken Cutlet (Unfried)',code: 'RM-CCT',  uom: 'Units'},
    1107: {name: 'Bottled Water',           code: 'RM-BWR',  uom: 'Units'},
    1110: {name: 'Osmania Biscuit Box',     code: 'RM-OSMN', uom: 'Units'},
    1112: {name: 'Condensed Milk',          code: 'RM-CM',   uom: 'kg'},
    1113: {name: 'Samosa Raw',              code: 'RM-SAM',  uom: 'Units'},
    1114: {name: 'Oil',                     code: 'RM-OIL',  uom: 'L'},
  };

  // Picking type IDs
  const PICK_TO_KITCHEN = 20;
  const PICK_FROM_COLD = 21;
  const PICK_RETURN = 22;
  const PICK_WASTAGE = 23;

  // Location IDs
  const LOC_KITCHEN = 41;

  const round2 = v => Math.round(v * 100) / 100;

  try {
    // ─── GET MAPPING ───────────────────────────────────────────
    if (action === 'get-mapping') {
      return new Response(JSON.stringify({
        success: true,
        productMap: PRODUCT_MAP,
        rawMaterials: RAW_MATERIALS,
      }), {headers: corsHeaders});
    }

    // ─── SUMMARY ───────────────────────────────────────────────
    if (action === 'summary') {
      const fromParam = url.searchParams.get('from');
      const toParam = url.searchParams.get('to');

      // Timezone handling: input is IST, Odoo stores UTC
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

      // Parallel data fetches
      const [sales, transfers, kitchenStock] = await Promise.all([
        fetchPOSSales(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        fetchTransfers(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        fetchKitchenStock(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY),
      ]);

      // Build consumption array for all raw materials
      const consumption = Object.entries(RAW_MATERIALS).map(([idStr, info]) => {
        const id = parseInt(idStr);
        const sent = transfers.sentToKitchen[id] || 0;
        const ret = transfers.returned[id] || 0;
        const waste = transfers.wasted[id] || 0;
        return {
          productId: id,
          productName: info.name,
          code: info.code,
          uom: info.uom,
          sentToKitchen: round2(sent),
          returnedToStorage: round2(ret),
          wasted: round2(waste),
          netConsumed: round2(sent - ret),
        };
      });

      return new Response(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        query: {from: fromIST.toISOString(), to: toIST.toISOString()},
        data: {
          sales,
          consumption,
          kitchenStock,
          mapping: PRODUCT_MAP,
          rawMaterials: RAW_MATERIALS,
        }
      }), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action. Use: get-mapping, summary'}), {headers: corsHeaders});

  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }

  // ─── FETCH POS SALES ─────────────────────────────────────────
  async function fetchPOSSales(odooUrl, db, uid, apiKey, since, until) {
    // Get order IDs for the period
    const orderIds = await odooCall(odooUrl, db, uid, apiKey,
      'pos.order', 'search',
      [[['config_id', 'in', [27, 28]], ['date_order', '>=', since], ['date_order', '<=', until],
        ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]]);

    if (!orderIds || orderIds.length === 0) return [];

    // Get order lines with product details
    const lines = await odooCall(odooUrl, db, uid, apiKey,
      'pos.order.line', 'search_read',
      [[['order_id', 'in', orderIds]]],
      {fields: ['product_id', 'qty', 'price_subtotal_incl']});

    // Group by product
    const grouped = {};
    for (const line of lines) {
      const pid = line.product_id[0];
      const pname = line.product_id[1];
      if (!grouped[pid]) grouped[pid] = {productId: pid, productName: pname, qtySold: 0, amount: 0};
      grouped[pid].qtySold += line.qty;
      grouped[pid].amount += line.price_subtotal_incl;
    }

    return Object.values(grouped).sort((a, b) => b.amount - a.amount);
  }

  // ─── FETCH TRANSFER PICKINGS ──────────────────────────────────
  async function fetchTransfers(odooUrl, db, uid, apiKey, since, until) {
    const result = {sentToKitchen: {}, returned: {}, wasted: {}};

    // Get all completed kitchen-related pickings in the period
    const pickings = await odooCall(odooUrl, db, uid, apiKey,
      'stock.picking', 'search_read',
      [[['picking_type_id', 'in', [PICK_TO_KITCHEN, PICK_FROM_COLD, PICK_RETURN, PICK_WASTAGE]],
        ['state', '=', 'done'],
        ['date_done', '>=', since],
        ['date_done', '<=', until],
        ['company_id', '=', 10]]],
      {fields: ['id', 'picking_type_id', 'move_ids']});

    if (!pickings || pickings.length === 0) return result;

    // Collect all move IDs
    const allMoveIds = pickings.flatMap(p => p.move_ids || []);
    if (allMoveIds.length === 0) return result;

    // Batch fetch all moves
    const moves = await odooCall(odooUrl, db, uid, apiKey,
      'stock.move', 'read',
      [allMoveIds],
      {fields: ['id', 'product_id', 'quantity', 'picking_id']});

    // Build picking_id → picking_type_id lookup
    const pickTypeMap = {};
    for (const p of pickings) {
      pickTypeMap[p.id] = p.picking_type_id[0];
    }

    // Aggregate by product and direction
    for (const move of moves) {
      const pid = move.product_id[0];
      const qty = move.quantity || 0;
      const typeId = pickTypeMap[move.picking_id[0]];

      if (typeId === PICK_TO_KITCHEN || typeId === PICK_FROM_COLD) {
        result.sentToKitchen[pid] = (result.sentToKitchen[pid] || 0) + qty;
      } else if (typeId === PICK_RETURN) {
        result.returned[pid] = (result.returned[pid] || 0) + qty;
      } else if (typeId === PICK_WASTAGE) {
        result.wasted[pid] = (result.wasted[pid] || 0) + qty;
      }
    }

    return result;
  }

  // ─── FETCH KITCHEN STOCK ──────────────────────────────────────
  async function fetchKitchenStock(odooUrl, db, uid, apiKey) {
    const quants = await odooCall(odooUrl, db, uid, apiKey,
      'stock.quant', 'search_read',
      [[['location_id', '=', LOC_KITCHEN], ['quantity', '>', 0], ['company_id', '=', 10]]],
      {fields: ['product_id', 'quantity']});

    if (!quants || quants.length === 0) return [];

    // Get product details for UoM
    const productIds = [...new Set(quants.map(q => q.product_id[0]))];
    const products = await odooCall(odooUrl, db, uid, apiKey,
      'product.product', 'read',
      [productIds],
      {fields: ['id', 'name', 'uom_id']});
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    // Group by product
    const grouped = {};
    for (const q of quants) {
      const pid = q.product_id[0];
      if (!grouped[pid]) {
        const prod = productMap[pid] || {};
        grouped[pid] = {
          productId: pid,
          productName: prod.name || q.product_id[1],
          uom: prod.uom_id ? prod.uom_id[1] : '',
          qty: 0,
        };
      }
      grouped[pid].qty += q.quantity;
    }

    return Object.values(grouped).map(item => ({...item, qty: round2(item.qty)}));
  }
}

// ─── ODOO JSON-RPC HELPER ──────────────────────────────────────
async function odooCall(url, db, uid, apiKey, model, method, positionalArgs, kwargs) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [db, uid, apiKey, model, method, positionalArgs, kwargs || {}],
    },
    id: Date.now(),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (data.error) throw new Error(`Odoo ${model}.${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}
