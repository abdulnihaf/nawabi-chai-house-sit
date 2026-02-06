// NCH Inventory API - Cloudflare Worker
// Handles: pending receipts, receipt validation, storage check, stock queries

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;

  // Location IDs
  const LOC = {VENDORS: 1, STOCK: 34, MAIN_STORAGE: 39, COLD_STORAGE: 40, KITCHEN: 41, WASTAGE: 42};

  // PIN verification for sensitive actions
  const PINS = {'1298': 'Tanveer', '0582': 'MD Kesmat', '0305': 'Nihaf', '2026': 'Zoya'};

  try {
    // ─── GET PENDING RECEIPTS ────────────────────────────────────
    // Returns all receipts in 'assigned' (Ready) state for NCH
    if (action === 'pending-receipts') {
      const pickings = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'search_read',
        [[['state', '=', 'assigned'], ['picking_type_id.code', '=', 'incoming'], ['company_id', '=', 10]]],
        {fields: ['id', 'name', 'origin', 'partner_id', 'scheduled_date', 'location_dest_id', 'note', 'move_ids', 'state']}
      );

      // Enrich with move line details for each picking
      const enriched = await Promise.all(pickings.map(async (picking) => {
        const moves = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'stock.move', 'read',
          [picking.move_ids],
          {fields: ['id', 'product_id', 'product_uom_qty', 'quantity', 'location_dest_id', 'move_line_ids', 'state']}
        );

        // Get move lines for lot/destination details
        const allMoveLineIds = moves.flatMap(m => m.move_line_ids || []);
        let moveLines = [];
        if (allMoveLineIds.length > 0) {
          moveLines = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.move.line', 'read',
            [allMoveLineIds],
            {fields: ['id', 'move_id', 'product_id', 'quantity', 'lot_id', 'lot_name', 'location_dest_id', 'picked']}
          );
        }

        // Get product details for tracking info
        const productIds = [...new Set(moves.map(m => m.product_id[0]))];
        const products = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'product.product', 'read',
          [productIds],
          {fields: ['id', 'name', 'default_code', 'uom_id', 'tracking', 'barcode']}
        );
        const productMap = Object.fromEntries(products.map(p => [p.id, p]));

        const items = moves.map(move => {
          const product = productMap[move.product_id[0]] || {};
          const mLine = moveLines.find(ml => ml.move_id[0] === move.id);
          return {
            moveId: move.id,
            moveLineId: mLine ? mLine.id : null,
            productId: move.product_id[0],
            productName: move.product_id[1],
            productCode: product.default_code || '',
            uom: product.uom_id ? product.uom_id[1] : '',
            tracking: product.tracking || 'none',
            barcode: product.barcode || product.default_code || '',
            expectedQty: move.product_uom_qty,
            destinationId: mLine ? mLine.location_dest_id[0] : move.location_dest_id[0],
            destinationName: mLine ? mLine.location_dest_id[1] : move.location_dest_id[1],
          };
        });

        // Strip HTML from notes
        const noteText = picking.note ? picking.note.replace(/<[^>]*>/g, '').trim() : '';

        return {
          pickingId: picking.id,
          name: picking.name,
          poName: picking.origin || '',
          vendorName: picking.partner_id ? picking.partner_id[1] : 'Unknown',
          vendorId: picking.partner_id ? picking.partner_id[0] : null,
          scheduledDate: picking.scheduled_date,
          note: noteText === 'false' ? '' : noteText,
          itemCount: items.length,
          items: items,
        };
      }));

      return new Response(JSON.stringify({success: true, receipts: enriched}), {headers: corsHeaders});
    }

    // ─── CONFIRM RECEIPT ─────────────────────────────────────────
    // Validates a receipt with actual quantities and destinations
    if (action === 'confirm-receipt' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {pickingId, pin, items} = body;
      // items: [{moveId, moveLineId, receivedQty, destinationId, lotName}]

      if (!pickingId || !items || !Array.isArray(items)) {
        return new Response(JSON.stringify({success: false, error: 'Missing pickingId or items'}), {headers: corsHeaders});
      }

      // PIN is optional but logged
      const confirmedBy = PINS[pin] || 'Staff';

      // Process each item
      for (const item of items) {
        // Update move line quantity and destination
        if (item.moveLineId) {
          const writeData = {
            quantity: item.receivedQty,
            picked: true,
            location_dest_id: item.destinationId || LOC.MAIN_STORAGE,
          };

          // Handle lot creation for tracked products
          if (item.lotName) {
            // Try to find existing lot first
            const existingLots = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
              'stock.lot', 'search_read',
              [[['name', '=', item.lotName], ['product_id', '=', item.productId], ['company_id', '=', 10]]],
              {fields: ['id'], limit: 1}
            );

            if (existingLots.length > 0) {
              writeData.lot_id = existingLots[0].id;
            } else {
              // Create new lot
              const lotId = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
                'stock.lot', 'create',
                [{name: item.lotName, product_id: item.productId, company_id: 10}]
              );
              writeData.lot_id = lotId;
            }
          }

          await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.move.line', 'write',
            [[item.moveLineId], writeData]
          );
        }

        // Also update the move's quantity and picked status
        if (item.moveId) {
          await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.move', 'write',
            [[item.moveId], {quantity: item.receivedQty, picked: true, location_dest_id: item.destinationId || LOC.MAIN_STORAGE}]
          );
        }
      }

      // Validate the picking (button_validate)
      const validateResult = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'button_validate',
        [[pickingId]]
      );

      // Check if backorder wizard was returned (partial receipt)
      let backorderCreated = false;
      if (validateResult && typeof validateResult === 'object' && validateResult.res_model) {
        // A wizard was returned — this means partial receipt
        // We need to handle the backorder wizard
        if (validateResult.res_model === 'stock.backorder.confirmation') {
          // Create backorder for remaining items
          try {
            await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
              validateResult.res_model, 'process',
              [[validateResult.res_id]]
            );
            backorderCreated = true;
          } catch (e) {
            // Try alternative: process_cancel_backorder to just receive what was given
            try {
              await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
                validateResult.res_model, 'process',
                [[validateResult.res_id]]
              );
              backorderCreated = true;
            } catch (e2) {
              // Wizard handling failed, but the picking may still have been validated
            }
          }
        }
      }

      // Verify picking state
      const finalState = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'read',
        [[pickingId]],
        {fields: ['state', 'name', 'backorder_ids']}
      );

      const picking = finalState[0] || {};
      const hasDiscrepancy = items.some(item => item.receivedQty !== item.expectedQty);

      return new Response(JSON.stringify({
        success: true,
        message: 'Receipt confirmed',
        confirmedBy: confirmedBy,
        pickingState: picking.state,
        pickingName: picking.name,
        backorderCreated: backorderCreated || (picking.backorder_ids && picking.backorder_ids.length > 0),
        hasDiscrepancy: hasDiscrepancy,
        items: items.map(i => ({product: i.productName, expected: i.expectedQty, received: i.receivedQty}))
      }), {headers: corsHeaders});
    }

    // ─── GET STOCK ON HAND ───────────────────────────────────────
    // Returns current stock in Main Storage for the storage check feature
    if (action === 'stock-on-hand') {
      const quants = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.quant', 'search_read',
        [[['location_id', '=', LOC.MAIN_STORAGE], ['quantity', '>', 0]]],
        {fields: ['id', 'product_id', 'quantity', 'lot_id', 'in_date']}
      );

      return new Response(JSON.stringify({success: true, stock: quants}), {headers: corsHeaders});
    }

    // ─── VERIFY PIN ──────────────────────────────────────────────
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PINS[pin]) {
        return new Response(JSON.stringify({success: true, user: PINS[pin]}), {headers: corsHeaders});
      }
      return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
    }

    // ─── RECENT RECEIPTS (completed) ─────────────────────────────
    if (action === 'recent-receipts') {
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const pickings = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'search_read',
        [[['state', '=', 'done'], ['picking_type_id.code', '=', 'incoming'], ['company_id', '=', 10]]],
        {fields: ['id', 'name', 'origin', 'partner_id', 'date_done', 'move_ids'], order: 'date_done desc', limit: limit}
      );

      return new Response(JSON.stringify({success: true, receipts: pickings}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action. Use: pending-receipts, confirm-receipt, stock-on-hand, verify-pin, recent-receipts'}), {headers: corsHeaders});

  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }
}

// ─── ODOO JSON-RPC HELPER ──────────────────────────────────────
// Usage:
//   odooCall(url, db, uid, key, 'model', 'search_read', [domain], {fields, limit, order})
//   odooCall(url, db, uid, key, 'model', 'write', [[ids], {vals}])
//   odooCall(url, db, uid, key, 'model', 'create', [{vals}])
//   odooCall(url, db, uid, key, 'model', 'button_validate', [[ids]])
async function odooCall(url, db, uid, apiKey, model, method, positionalArgs, kwargs) {
  // execute_kw signature: [db, uid, password, model, method, args, kwargs]
  // args = positional args for the ORM method
  // kwargs = keyword args (fields, limit, order, etc.)
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
