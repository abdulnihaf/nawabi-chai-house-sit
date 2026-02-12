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
  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '3678': 'Farooq', '9991': 'Mujib', '4759': 'Jahangir', '1002': 'Rarup', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen', '8241': 'Nafees'};

  // Raw materials reference (matches daily-settlement.js)
  const RAW_MATERIALS = {
    1095: {name: 'Buffalo Milk', code: 'RM-BFM', uom: 'L'},
    1096: {name: 'Skimmed Milk Powder', code: 'RM-SMP', uom: 'kg'},
    1097: {name: 'Sugar', code: 'RM-SUG', uom: 'kg'},
    1098: {name: 'Tea Powder', code: 'RM-TEA', uom: 'kg'},
    1101: {name: 'Filter Water', code: 'RM-WTR', uom: 'L'},
    1104: {name: 'Buns', code: 'RM-BUN', uom: 'Units'},
    1105: {name: 'Osmania Biscuit (Loose)', code: 'RM-OSMG', uom: 'Units'},
    1106: {name: 'Chicken Cutlet (Unfried)', code: 'RM-CCT', uom: 'Units'},
    1107: {name: 'Bottled Water', code: 'RM-BWR', uom: 'Units'},
    1110: {name: 'Osmania Biscuit Box', code: 'RM-OSMN', uom: 'Units'},
    1112: {name: 'Condensed Milk', code: 'RM-CM', uom: 'kg'},
    1113: {name: 'Samosa Raw', code: 'RM-SAM', uom: 'Units'},
    1114: {name: 'Oil', code: 'RM-OIL', uom: 'L'},
    1116: {name: 'Cheese Balls Raw', code: 'RM-CHB', uom: 'Units'},
    1119: {name: 'Butter', code: 'RM-BTR', uom: 'kg'},
    1120: {name: 'Coffee Powder', code: 'RM-COF', uom: 'kg'},
    1121: {name: 'Lemon', code: 'RM-LMN', uom: 'Units'},
    1123: {name: 'Honey', code: 'RM-HNY', uom: 'kg'},
  };

  // Fallback unit costs (matches daily-settlement.js)
  const FALLBACK_COSTS = {
    1095: 80, 1096: 310, 1097: 44, 1098: 500, 1101: 1.5, 1104: 8,
    1105: 6.65, 1106: 15, 1107: 6.7, 1110: 173, 1112: 326, 1113: 8,
    1114: 120, 1116: 10, 1119: 500, 1120: 1200, 1121: 5, 1123: 400,
  };

  const DB = context.env.DB;

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
            productName: product.name || move.product_id[1],
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

      // PIN is required — must know who confirmed the receipt
      const confirmedBy = PINS[pin];
      if (!confirmedBy) {
        return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
      }

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

        // Mark move as picked + set destination (do NOT write quantity — let Odoo compute from move lines)
        if (item.moveId) {
          await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.move', 'write',
            [[item.moveId], {picked: true, location_dest_id: item.destinationId || LOC.MAIN_STORAGE}]
          );
        }
      }

      // Check if this is a partial receipt (any item received < expected)
      const isPartial = items.some(item => item.receivedQty < item.expectedQty);

      // Validate the picking (button_validate)
      let validateResult;
      try {
        validateResult = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'stock.picking', 'button_validate',
          [[pickingId]]
        );
      } catch (valErr) {
        // If validation fails, return meaningful error
        return new Response(JSON.stringify({
          success: false, error: `Validation failed: ${valErr.message}`,
          confirmedBy: confirmedBy,
        }), {headers: corsHeaders});
      }

      // Handle wizard responses (partial receipt → backorder, or immediate transfer)
      let backorderCreated = false;
      let wizardError = null;
      const wizardContext = {context: {button_validate_picking_ids: [pickingId], skip_backorder: false}};

      if (validateResult && typeof validateResult === 'object' && validateResult.res_model) {
        if (validateResult.res_model === 'stock.backorder.confirmation') {
          // Partial receipt detected — create backorder for remaining items
          const wizardId = validateResult.res_id;
          try {
            await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
              'stock.backorder.confirmation', 'process',
              [[wizardId]], wizardContext
            );
            backorderCreated = true;
          } catch (e) {
            // Retry: create a fresh wizard with pick_ids explicitly set
            try {
              const freshWizardId = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
                'stock.backorder.confirmation', 'create',
                [{pick_ids: [[4, pickingId, false]]}]
              );
              await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
                'stock.backorder.confirmation', 'process',
                [[freshWizardId]], wizardContext
              );
              backorderCreated = true;
            } catch (e2) {
              // Do NOT fall through to process_cancel_backorder — that discards remaining qty
              wizardError = `Backorder creation failed: ${e2.message}`;
            }
          }
        } else if (validateResult.res_model === 'stock.immediate.transfer') {
          // Immediate transfer wizard — process to complete
          try {
            await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
              'stock.immediate.transfer', 'process',
              [[validateResult.res_id]], wizardContext
            );
          } catch (e) {
            wizardError = `Immediate transfer failed: ${e.message}`;
          }
        }
      }

      // Verify picking state and backorder creation
      const finalState = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'read',
        [[pickingId]],
        {fields: ['state', 'name', 'origin', 'partner_id', 'backorder_ids']}
      );

      const picking = finalState[0] || {};
      const hasDiscrepancy = items.some(item => item.receivedQty !== item.expectedQty);

      // Check backorder_ids from Odoo (most reliable indicator)
      if (picking.backorder_ids && picking.backorder_ids.length > 0) {
        backorderCreated = true;
      }

      // Persist receipt confirmation to D1
      if (DB) {
        try {
          await DB.prepare(
            'INSERT INTO receipt_confirmations (picking_id, picking_name, po_name, vendor_name, confirmed_by, confirmed_at) VALUES (?,?,?,?,?,?)'
          ).bind(
            pickingId,
            picking.name || '',
            picking.origin || '',
            picking.partner_id ? picking.partner_id[1] : '',
            confirmedBy,
            new Date().toISOString()
          ).run();
        } catch (dbErr) {
          // D1 write failed — non-fatal, continue
        }
      }

      // Build response
      const response = {
        success: true,
        message: 'Receipt confirmed',
        confirmedBy: confirmedBy,
        pickingState: picking.state,
        pickingName: picking.name,
        backorderCreated: backorderCreated,
        hasDiscrepancy: hasDiscrepancy,
        items: items.map(i => ({product: i.productName, expected: i.expectedQty, received: i.receivedQty})),
      };

      // If wizard failed and picking is NOT done, report error
      if (wizardError && picking.state !== 'done') {
        response.success = false;
        response.error = wizardError;
      }

      // If partial but no backorder and picking IS done, add warning
      if (hasDiscrepancy && !backorderCreated && picking.state === 'done') {
        response.warning = 'Picking completed but no backorder was created for remaining items';
      }

      return new Response(JSON.stringify(response), {headers: corsHeaders});
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

    // ─── LIVE INVENTORY STATUS ─────────────────────────────────────
    // Returns current stock (last settlement closing + received since)
    // with vendor-level delivery breakdown and receipt confirmations
    if (action === 'live-status') {
      // 1. Get latest settlement from D1
      let lastSettlement = null;
      let closingStock = {};
      if (DB) {
        try {
          lastSettlement = await DB.prepare(
            "SELECT id, settlement_date, settled_at, settled_by, inventory_closing FROM daily_settlements WHERE status IN ('completed','bootstrap') ORDER BY settled_at DESC LIMIT 1"
          ).first();
          if (lastSettlement) {
            closingStock = JSON.parse(lastSettlement.inventory_closing || '{}');
          }
        } catch (e) { /* table may not exist */ }
      }

      // 2. Query Odoo for incoming pickings since settlement
      const sinceUTC = lastSettlement
        ? new Date(lastSettlement.settled_at).toISOString().slice(0, 19).replace('T', ' ')
        : new Date(Date.now() - 24 * 3600000).toISOString().slice(0, 19).replace('T', ' ');

      const pickings = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
        'stock.picking', 'search_read',
        [[['state', '=', 'done'], ['picking_type_id.code', '=', 'incoming'],
          ['date_done', '>=', sinceUTC], ['company_id', '=', 10]]],
        {fields: ['id', 'name', 'origin', 'partner_id', 'date_done', 'move_ids'],
         order: 'date_done desc', limit: 50});

      // 3. Get all moves + move lines for accurate done quantities
      const allMoveIds = pickings.flatMap(p => p.move_ids || []);
      let moves = [];
      if (allMoveIds.length > 0) {
        const rawMoves = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'stock.move', 'read', [allMoveIds],
          {fields: ['id', 'product_id', 'quantity', 'picking_id', 'move_line_ids']});

        // Read move lines for authoritative received quantities
        const allMoveLineIds = rawMoves.flatMap(m => m.move_line_ids || []);
        const moveLineQtys = {};
        if (allMoveLineIds.length > 0) {
          const moveLines = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
            'stock.move.line', 'read', [allMoveLineIds],
            {fields: ['id', 'move_id', 'quantity']});
          for (const ml of moveLines) {
            const moveId = ml.move_id[0];
            moveLineQtys[moveId] = (moveLineQtys[moveId] || 0) + (ml.quantity || 0);
          }
        }

        // Use move line sum as authoritative qty, fallback to move.quantity
        moves = rawMoves.map(m => ({
          ...m,
          quantity: moveLineQtys[m.id] !== undefined ? moveLineQtys[m.id] : m.quantity,
        }));
      }

      // 4. Get PO line costs
      const poNames = [...new Set(pickings.map(p => p.origin).filter(Boolean))];
      const poLineCosts = {};
      if (poNames.length > 0) {
        const poLines = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
          'purchase.order.line', 'search_read',
          [[['order_id.name', 'in', poNames]]],
          {fields: ['product_id', 'price_unit', 'order_id']});
        for (const pl of poLines) {
          const key = `${pl.order_id[1]}_${pl.product_id[0]}`;
          poLineCosts[key] = pl.price_unit;
        }
      }

      // 5. Get receipt confirmations from D1
      const confirmations = {};
      if (DB && pickings.length > 0) {
        try {
          const pickingIds = pickings.map(p => p.id);
          const placeholders = pickingIds.map(() => '?').join(',');
          const rows = await DB.prepare(
            `SELECT picking_id, confirmed_by, confirmed_at FROM receipt_confirmations WHERE picking_id IN (${placeholders})`
          ).bind(...pickingIds).all();
          for (const r of (rows.results || [])) {
            confirmations[r.picking_id] = {confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at};
          }
        } catch (e) { /* table may not exist yet */ }
      }

      // 6. Build per-picking delivery detail + aggregate received totals
      const received = {};
      const deliveries = pickings.map(p => {
        const pickingMoves = moves.filter(m => m.picking_id && m.picking_id[0] === p.id);
        const items = pickingMoves.map(m => {
          const matId = m.product_id[0];
          const qty = m.quantity || 0;
          const costKey = `${p.origin}_${matId}`;
          const unitCost = poLineCosts[costKey] || FALLBACK_COSTS[matId] || 0;
          if (!received[matId]) received[matId] = 0;
          received[matId] += qty;
          return {
            materialId: matId,
            name: RAW_MATERIALS[matId]?.name || m.product_id[1],
            qty, uom: RAW_MATERIALS[matId]?.uom || '',
            unitCost,
          };
        });
        const conf = confirmations[p.id] || {};
        return {
          pickingId: p.id, pickingName: p.name, poName: p.origin || '',
          vendorName: p.partner_id ? p.partner_id[1] : 'Unknown',
          dateDone: p.date_done,
          confirmedBy: conf.confirmedBy || null,
          confirmedAt: conf.confirmedAt || null,
          items,
        };
      });

      // 7. Build current stock map
      const currentStock = {};
      const allMatIds = new Set([...Object.keys(closingStock), ...Object.keys(received)]);
      for (const matId of allMatIds) {
        const mat = RAW_MATERIALS[matId];
        if (!mat) continue; // Skip non-tracked materials
        const opening = closingStock[matId] || 0;
        const rec = received[matId] || 0;
        currentStock[matId] = {
          name: mat.name, code: mat.code, uom: mat.uom,
          opening: Math.round(opening * 10000) / 10000,
          received: Math.round(rec * 10000) / 10000,
          current: Math.round((opening + rec) * 10000) / 10000,
        };
      }

      return new Response(JSON.stringify({
        success: true,
        lastSettlement: lastSettlement ? {
          id: lastSettlement.id,
          settlementDate: lastSettlement.settlement_date,
          settledAt: lastSettlement.settled_at,
          settledBy: lastSettlement.settled_by,
        } : null,
        deliveries,
        currentStock,
        rawMaterials: RAW_MATERIALS,
      }), {headers: corsHeaders});
    }

    // ─── SETTLEMENT TRAIL ─────────────────────────────────────────
    // Returns past settlement periods with inventory data for audit trail
    if (action === 'settlement-trail') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'DB not configured'}), {headers: corsHeaders});

      const limit = parseInt(url.searchParams.get('limit') || '20');
      try {
        const results = await DB.prepare(
          "SELECT id, settlement_date, period_start, period_end, settled_by, settled_at, status, inventory_opening, inventory_purchases, inventory_closing, inventory_consumption FROM daily_settlements WHERE status IN ('completed','bootstrap') ORDER BY settled_at DESC LIMIT ?"
        ).bind(limit).all();

        const settlements = (results.results || []).map(s => {
          const periodStart = new Date(s.period_start);
          const periodEnd = new Date(s.period_end);
          const durationHrs = Math.round((periodEnd - periodStart) / 36000) / 100;
          return {
            id: s.id,
            settlementDate: s.settlement_date,
            periodStart: s.period_start,
            periodEnd: s.period_end,
            settledBy: s.settled_by,
            settledAt: s.settled_at,
            status: s.status,
            duration: durationHrs,
            opening: JSON.parse(s.inventory_opening || '{}'),
            purchases: JSON.parse(s.inventory_purchases || '{}'),
            closing: JSON.parse(s.inventory_closing || '{}'),
            consumption: JSON.parse(s.inventory_consumption || '{}'),
          };
        });

        return new Response(JSON.stringify({
          success: true,
          settlements,
          rawMaterials: RAW_MATERIALS,
        }), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({success: false, error: e.message}), {headers: corsHeaders});
      }
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});

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
