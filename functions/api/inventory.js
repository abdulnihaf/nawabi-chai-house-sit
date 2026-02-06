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

  // PIN verification — matches Odoo POS employee PINs
  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '3678': 'Farooq', '9991': 'Mujib', '4759': 'Jahangir', '1002': 'Rarup', '0305': 'Nihaf', '2026': 'Zoya'};

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
                validateResult.res_model, 'process_cancel_backorder',
                [[validateResult.res_id]]
              );
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

    // ─── STORAGE STOCK (for Take to Kitchen) ──────────────────────
    // Returns stock in Main Storage + Cold Storage, grouped by product with lot details
    if (action === 'storage-stock') {
      const stock = await fetchLocationStock(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        [LOC.MAIN_STORAGE, LOC.COLD_STORAGE]);
      return new Response(JSON.stringify({success: true, stock}), {headers: corsHeaders});
    }

    // ─── KITCHEN STOCK (for Return/Wastage) ───────────────────────
    // Returns stock currently in Kitchen, grouped by product with lot details
    if (action === 'kitchen-stock') {
      const stock = await fetchLocationStock(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        [LOC.KITCHEN]);
      return new Response(JSON.stringify({success: true, stock}), {headers: corsHeaders});
    }

    // ─── INTERNAL TRANSFER ────────────────────────────────────────
    // Creates and validates a stock.picking for internal moves
    if (action === 'transfer' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {pin, type, items, reason} = body;

      if (!pin || !type || !items || !Array.isArray(items) || items.length === 0) {
        return new Response(JSON.stringify({success: false, error: 'Missing pin, type, or items'}), {headers: corsHeaders});
      }

      const confirmedBy = PINS[pin];
      if (!confirmedBy) {
        return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
      }

      // Transfer type configuration
      const TRANSFER_CONFIG = {
        'take-to-kitchen':   {pickingTypeId: 20, srcLoc: LOC.MAIN_STORAGE, destLoc: LOC.KITCHEN},
        'take-from-cold':    {pickingTypeId: 21, srcLoc: LOC.COLD_STORAGE, destLoc: LOC.KITCHEN},
        'return-to-storage': {pickingTypeId: 22, srcLoc: LOC.KITCHEN,      destLoc: LOC.MAIN_STORAGE},
        'wastage':           {pickingTypeId: 23, srcLoc: LOC.KITCHEN,      destLoc: LOC.WASTAGE},
      };

      const config = TRANSFER_CONFIG[type];
      if (!config) {
        return new Response(JSON.stringify({success: false, error: 'Invalid transfer type'}), {headers: corsHeaders});
      }

      // Generate origin reference (IST = UTC + 5:30)
      const now = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
      const dateStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')}`;
      const timeStr = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
      const originRef = `Kitchen/${confirmedBy}/${dateStr} ${timeStr}`;

      // Create stock.picking
      const pickingVals = {
        picking_type_id: config.pickingTypeId,
        location_id: config.srcLoc,
        location_dest_id: config.destLoc,
        origin: originRef,
        company_id: 10,
      };
      if (reason) {
        pickingVals.note = `Wastage reason: ${reason}`;
      }

      // Fetch product data (UOM + tracking) before creating anything
      const productIds = [...new Set(items.map(i => i.productId))];
      const productData = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'product.product', 'read', [productIds], {fields: ['id', 'uom_id', 'tracking']});
      const productMap = Object.fromEntries(productData.map(p => [p.id, p]));

      // Validate all items have valid UOMs before creating anything
      for (const item of items) {
        const prod = productMap[item.productId];
        if (!prod) {
          return new Response(JSON.stringify({success: false, error: `Product ${item.productName || item.productId} not found`}), {headers: corsHeaders});
        }
        // Lot-tracked products MUST have a lotId
        if (prod.tracking === 'lot' && !item.lotId) {
          return new Response(JSON.stringify({success: false, error: `${item.productName} requires lot tracking but no lot was found. Receive stock first.`}), {headers: corsHeaders});
        }
      }

      const pickingId = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'create', [pickingVals]);

      // Wrap move creation in try/catch — cancel picking on failure
      try {
        // Create stock.move for each item
        for (const item of items) {
          const prod = productMap[item.productId];
          const moveVals = {
            picking_id: pickingId,
            product_id: item.productId,
            product_uom: prod.uom_id[0],
            product_uom_qty: item.quantity,
            location_id: config.srcLoc,
            location_dest_id: config.destLoc,
            company_id: 10,
          };

          const moveId = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.move', 'create', [moveVals]);

          // For lot-tracked products, set lot_id on the auto-created move line
          if (item.lotId) {
            const moveData = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
              'stock.move', 'read', [[moveId]], {fields: ['move_line_ids']});

            if (moveData[0] && moveData[0].move_line_ids && moveData[0].move_line_ids.length > 0) {
              await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
                'stock.move.line', 'write',
                [moveData[0].move_line_ids, {lot_id: item.lotId, quantity: item.quantity, picked: true}]);
            }
          }
        }

        // Confirm → Assign → set picked + quantity on moves → Validate
        await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'stock.picking', 'action_confirm', [[pickingId]]);

        try {
          await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.picking', 'action_assign', [[pickingId]]);
        } catch (e) {
          // action_assign may fail if stock is already reserved, continue
        }

        // After confirm/assign, read back all moves and set picked=true + done quantity
        const confirmedPicking = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'stock.picking', 'read', [[pickingId]], {fields: ['move_ids']});
        if (confirmedPicking[0] && confirmedPicking[0].move_ids.length > 0) {
          const moves = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.move', 'read', [confirmedPicking[0].move_ids], {fields: ['id', 'product_uom_qty', 'move_line_ids']});
          for (const move of moves) {
            await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
              'stock.move', 'write', [[move.id], {quantity: move.product_uom_qty, picked: true}]);
            // Also set picked on move lines
            if (move.move_line_ids && move.move_line_ids.length > 0) {
              await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
                'stock.move.line', 'write', [move.move_line_ids, {picked: true}]);
            }
          }
        }

        const validateResult = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'stock.picking', 'button_validate', [[pickingId]]);

        // Handle immediate transfer or backorder wizards
        if (validateResult && typeof validateResult === 'object' && validateResult.res_model) {
          try {
            await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
              validateResult.res_model, 'process', [[validateResult.res_id]]);
          } catch (e) {
            // Wizard processing failed, try process_cancel_backorder
            try {
              await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
                validateResult.res_model, 'process_cancel_backorder', [[validateResult.res_id]]);
            } catch (e2) {
              // Both methods failed — picking may still be validated
            }
          }
        }

      } catch (moveError) {
        // If anything failed after creating the picking, cancel it to avoid orphans
        try {
          await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.picking', 'action_cancel', [[pickingId]]);
        } catch (cancelErr) {
          // Cancel failed too — orphan will need manual cleanup
        }
        throw new Error(`Transfer failed: ${moveError.message}`);
      }

      // Read final picking state
      const finalPicking = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'read', [[pickingId]], {fields: ['state', 'name']});

      const picking = finalPicking[0] || {};

      return new Response(JSON.stringify({
        success: true,
        message: 'Transfer completed',
        pickingName: picking.name,
        pickingState: picking.state,
        confirmedBy: confirmedBy,
        type: type,
        reason: reason || null,
        items: items.map(i => ({product: i.productName, quantity: i.quantity}))
      }), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action. Use: pending-receipts, confirm-receipt, stock-on-hand, verify-pin, recent-receipts, storage-stock, kitchen-stock, transfer'}), {headers: corsHeaders});

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

// ─── FETCH STOCK BY LOCATION (shared helper) ──────────────────
// Returns stock grouped by product with lot details for given location IDs
async function fetchLocationStock(odooUrl, db, uid, apiKey, locationIds) {
  // Get all quants in the specified locations
  const quants = await odooCall(odooUrl, db, uid, apiKey,
    'stock.quant', 'search_read',
    [[['location_id', 'in', locationIds], ['quantity', '>', 0], ['company_id', '=', 10]]],
    {fields: ['id', 'product_id', 'quantity', 'lot_id', 'location_id', 'in_date']}
  );

  if (quants.length === 0) return [];

  // Get product details
  const productIds = [...new Set(quants.map(q => q.product_id[0]))];
  const products = await odooCall(odooUrl, db, uid, apiKey,
    'product.product', 'read',
    [productIds],
    {fields: ['id', 'name', 'default_code', 'uom_id', 'tracking', 'barcode']}
  );
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));

  // Group quants by product
  const grouped = {};
  for (const q of quants) {
    const pid = q.product_id[0];
    if (!grouped[pid]) {
      const p = productMap[pid] || {};
      grouped[pid] = {
        productId: pid,
        productName: p.name || q.product_id[1],
        productCode: p.default_code || '',
        barcode: p.barcode || p.default_code || '',
        uom: p.uom_id ? p.uom_id[1] : '',
        tracking: p.tracking || 'none',
        total: 0,
        lots: [],
      };
    }
    grouped[pid].total += q.quantity;
    grouped[pid].lots.push({
      lotId: q.lot_id ? q.lot_id[0] : null,
      lotName: q.lot_id ? q.lot_id[1] : null,
      qty: q.quantity,
      locationId: q.location_id[0],
      locationName: q.location_id[1],
    });
  }

  // Sort lots by date (FIFO) and return as array
  return Object.values(grouped).map(item => {
    item.total = Math.round(item.total * 100) / 100;
    return item;
  });
}
