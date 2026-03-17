// Validator API — Layer 1 (tuple validation) + Layer 2 (Razorpay verification)
// Polls Odoo for orders, validates (P,M,W,R,C), checks UPI against Razorpay
// All data from production ops.hamzahotel.com

const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB = 'main';
const ODOO_UID = 2;
const NCH_COMPANY_ID = 10;

// Runner partner_id → slot mapping
const RUNNER_SLOTS = {
  64: 'RUN001', 65: 'RUN002', 66: 'RUN003', 67: 'RUN004', 68: 'RUN005'
};
const VALID_RUNNER_IDS = new Set([64, 65, 66, 67, 68]);

// Razorpay QR codes — maps entity to QR ID
const RUNNER_QRS = [
  {qr_id: 'qr_SBdtZG1AMDwSmJ', label: 'RUN001', partner_id: 64, name: 'FAROOQ'},
  {qr_id: 'qr_SBdte3aRvGpRMY', label: 'RUN002', partner_id: 65, name: 'AMIN'},
  {qr_id: 'qr_SBgTo2a39kYmET', label: 'RUN003', partner_id: 66, name: 'NCH Runner 03'},
  {qr_id: 'qr_SBgTtFrfddY4AW', label: 'RUN004', partner_id: 67, name: 'NCH Runner 04'},
  {qr_id: 'qr_SBgTyFKUsdwLe1', label: 'RUN005', partner_id: 68, name: 'NCH Runner 05'}
];
const COUNTER_QR = {qr_id: 'qr_SBdtUCLSHVfRtT', label: 'COUNTER'};
const RUNNER_COUNTER_QR = {qr_id: 'qr_SBuDBQDKrC8Bch', label: 'RUNNER_COUNTER'};

// Partner aliases — duplicate Odoo contacts that map to known runners.
// These are auto-fixable: invalid_partner errors with known alias → auto-correct in Odoo.
const PARTNER_ALIASES = {90: 64, 37: 64};

// Payment method IDs
const PM = { CASH: 37, UPI: 38, CARD: 39, RUNNER_LEDGER: 40, TOKEN_ISSUE: 48, COMP: 49 };

// POS config IDs
const POS = { CASH_COUNTER: 27, RUNNER_COUNTER: 28 };

// Staff slots — slot is the constant, person rotates
// Maps slot_code → current assignment. Update here when staff changes.
const STAFF_SLOTS = {
  // Cashiers
  'CASH001': { role: 'cashier', person: 'Kesmat',   phone: '918637895699', pin: '7115' },
  'CASH002': { role: 'cashier', person: 'Nafees',   phone: '919019627629', pin: '8241' },
  // Runners
  'RUN001':  { role: 'runner',  person: 'Farzaib',  phone: null,           pin: '3678', partner_id: 64 },
  'RUN002':  { role: 'runner',  person: 'Ritiqu',   phone: '919181204403', pin: '4421', partner_id: 65 },
  'RUN003':  { role: 'runner',  person: 'Anshu',    phone: '919181204403', pin: '5503', partner_id: 66 },
  'RUN004':  { role: 'runner',  person: 'Shabeer',  phone: null,           pin: '6604', partner_id: 67 },
  'RUN005':  { role: 'runner',  person: 'Dhanush',  phone: null,           pin: '7705', partner_id: 68 },
  // GM / Supervisor / Manager
  'GM001':   { role: 'gm',         person: 'Basheer',  phone: '919061906916', pin: '8523' },
  'SUP001':  { role: 'supervisor', person: 'Waseem',   phone: '919108414951', pin: '1234' },
  'MGR001':  { role: 'manager',    person: 'Tanveer',  phone: '919916399474', pin: '6890' },
  // Admin
  'ADMIN001':{ role: 'admin',   person: 'Nihaf',    phone: null, pin: '0305' },
  'ADMIN002':{ role: 'admin',   person: 'Naveen',   phone: null, pin: '3754' },
  'ADMIN003':{ role: 'admin',   person: 'Yashwant', phone: null, pin: '3697' }
};

// Derived lookups — built from STAFF_SLOTS so everything stays in sync
const STAFF_BY_PIN = {};
const STAFF_BY_RUNNER_SLOT = {};
for (const [slot, info] of Object.entries(STAFF_SLOTS)) {
  STAFF_BY_PIN[info.pin] = { name: info.person, role: info.role, slot, phone: info.phone, partner_id: info.partner_id || null };
  if (info.role === 'runner') {
    STAFF_BY_RUNNER_SLOT[slot] = { name: info.person, phone: info.phone, partner_id: info.partner_id };
  }
}

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;
  const RZP_KEY = context.env.RAZORPAY_KEY;
  const RZP_SECRET = context.env.RAZORPAY_SECRET;

  try {
    // ── Auth check for staff-facing actions ──
    if (['get-my-errors', 'get-overview', 'get-runner-status', 'login'].includes(action)) {
      const pin = url.searchParams.get('pin');
      const staff = STAFF_BY_PIN[pin];
      if (!staff) return json({ success: false, error: 'Invalid PIN' }, cors);
    }

    // ── LOGIN — first login captures phone, returns role + slot ──
    if (action === 'login') {
      const pin = url.searchParams.get('pin');
      const phone = url.searchParams.get('phone');
      const staff = STAFF_BY_PIN[pin];

      // If phone provided and not yet stored, save it
      if (phone && !staff.phone) {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.length >= 10) {
          await DB.prepare(
            'UPDATE v_staff_slots SET phone = ?, updated_at = datetime(\'now\') WHERE slot_code = ?'
          ).bind(cleanPhone, staff.slot).run();
          // Update in-memory too
          staff.phone = cleanPhone;
          STAFF_SLOTS[staff.slot].phone = cleanPhone;
        }
      }

      return json({
        success: true,
        slot: staff.slot,
        name: staff.name,
        role: staff.role,
        phone: staff.phone,
        phone_required: !staff.phone
      }, cors);
    }

    // ── VALIDATE ORDERS — polls Odoo, checks tuples, writes errors ──
    if (action === 'validate') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from) return json({ success: false, error: 'from parameter required' }, cors);

      // Fetch orders from Odoo
      const orders = await fetchOdooOrders(ODOO_API_KEY, from, to);

      const errors = [];
      for (const order of orders) {
        const orderErrors = validateOrder(order);
        errors.push(...orderErrors);
      }

      // Write errors to D1 — batch all inserts
      let written = 0;
      if (errors.length > 0) {
        const stmts = errors.map(err =>
          DB.prepare(`
            INSERT OR IGNORE INTO validation_errors
            (order_id, order_ref, error_code, description, pos_config_id, pos_config_name,
             payment_method_id, payment_method_name, odoo_payment_id, runner_partner_id, runner_slot,
             product_ids, product_names, cashier_uid, cashier_name, order_amount, order_time,
             assigned_to, assigned_role)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            err.order_id, err.order_ref, err.error_code, err.description,
            err.pos_config_id, err.pos_config_name,
            err.payment_method_id, err.payment_method_name, err.odoo_payment_id,
            err.runner_partner_id, err.runner_slot,
            JSON.stringify(err.product_ids), JSON.stringify(err.product_names),
            err.cashier_uid, err.cashier_name, err.order_amount, err.order_time,
            err.assigned_to, err.assigned_role
          )
        );
        const results = await DB.batch(stmts);
        written = results.filter(r => r.meta?.changes > 0).length;
      }

      return json({
        success: true,
        orders_checked: orders.length,
        errors_found: errors.length,
        errors_written: written,
        errors: errors.map(e => ({
          order_id: e.order_id,
          order_ref: e.order_ref,
          error_code: e.error_code,
          description: e.description
        }))
      }, cors);
    }

    // ── GET MY ERRORS — for a specific employee ──
    if (action === 'get-my-errors') {
      const pin = url.searchParams.get('pin');
      const staff = STAFF_BY_PIN[pin];

      let errors, discrepancies;

      if (staff.role === 'runner') {
        // Runner sees errors assigned to their slot
        errors = await DB.prepare(`
          SELECT * FROM validation_errors
          WHERE runner_slot = ? AND status = 'pending'
          ORDER BY detected_at DESC
        `).bind(staff.slot).all();

        discrepancies = await DB.prepare(`
          SELECT * FROM payment_discrepancies
          WHERE assigned_to = ? AND status = 'pending'
          ORDER BY detected_at DESC
        `).bind(staff.slot).all();
      } else if (staff.role === 'cashier') {
        // Cashier sees errors from their orders
        errors = await DB.prepare(`
          SELECT * FROM validation_errors
          WHERE cashier_name = ? AND status = 'pending'
          ORDER BY detected_at DESC
        `).bind(staff.name).all();

        discrepancies = await DB.prepare(`
          SELECT * FROM payment_discrepancies
          WHERE assigned_role = 'cashier' AND status = 'pending'
          ORDER BY detected_at DESC
        `).bind().all();
      }

      return json({
        success: true,
        staff: { name: staff.name, role: staff.role, slot: staff.slot },
        errors: errors?.results || [],
        discrepancies: discrepancies?.results || []
      }, cors);
    }

    // ── GET OVERVIEW — for GM/admin: all runners, all errors, settlement readiness ──
    if (action === 'get-overview') {
      const pin = url.searchParams.get('pin');
      const staff = STAFF_BY_PIN[pin];
      if (!['admin', 'gm', 'supervisor', 'manager'].includes(staff.role)) {
        return json({ success: false, error: 'Not authorized' }, cors);
      }

      // All pending errors
      const pendingErrors = await DB.prepare(`
        SELECT * FROM validation_errors WHERE status = 'pending' ORDER BY detected_at DESC
      `).all();

      const pendingDisc = await DB.prepare(`
        SELECT * FROM payment_discrepancies WHERE status = 'pending' ORDER BY detected_at DESC
      `).all();

      // Error counts by runner
      const runnerErrors = await DB.prepare(`
        SELECT runner_slot, COUNT(*) as count FROM validation_errors
        WHERE status = 'pending' AND runner_slot IS NOT NULL
        GROUP BY runner_slot
      `).all();

      // Error counts by cashier
      const cashierErrors = await DB.prepare(`
        SELECT cashier_name, COUNT(*) as count FROM validation_errors
        WHERE status = 'pending' AND cashier_name IS NOT NULL
        GROUP BY cashier_name
      `).all();

      // Today's resolved count
      const resolvedToday = await DB.prepare(`
        SELECT COUNT(*) as count FROM validation_errors
        WHERE status = 'rectified' AND date(rectified_at) = date('now')
      `).first();

      // Today's total checked (from validator_state or count all today's errors)
      const totalToday = await DB.prepare(`
        SELECT COUNT(*) as count FROM validation_errors
        WHERE date(detected_at) = date('now')
      `).first();

      return json({
        success: true,
        staff: { name: staff.name, role: staff.role },
        pending: {
          errors: pendingErrors?.results || [],
          discrepancies: pendingDisc?.results || []
        },
        summary: {
          total_errors_today: totalToday?.count || 0,
          resolved_today: resolvedToday?.count || 0,
          pending_count: (pendingErrors?.results?.length || 0) + (pendingDisc?.results?.length || 0),
          runner_error_counts: runnerErrors?.results || [],
          cashier_error_counts: cashierErrors?.results || []
        },
        runner_slots: Object.entries(STAFF_BY_RUNNER_SLOT).map(([slot, info]) => ({
          slot,
          person: info.name,
          pending_errors: (runnerErrors?.results || []).find(r => r.runner_slot === slot)?.count || 0
        }))
      }, cors);
    }

    // ── VALIDATE SINGLE ORDER (for testing) ──
    if (action === 'check') {
      const orderId = parseInt(url.searchParams.get('order_id'));
      if (!orderId) return json({ success: false, error: 'order_id required' }, cors);

      const orders = await fetchOdooOrderById(ODOO_API_KEY, orderId);
      if (!orders.length) return json({ success: false, error: 'Order not found' }, cors);

      const errors = validateOrder(orders[0]);
      return json({
        success: true,
        order: orders[0],
        valid: errors.length === 0,
        errors
      }, cors);
    }

    // ── SCAN PERIOD — validate all orders in a time range ──
    if (action === 'scan') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from) return json({ success: false, error: 'from required (YYYY-MM-DD HH:MM:SS)' }, cors);

      const orders = await fetchOdooOrders(ODOO_API_KEY, from, to);

      let validCount = 0;
      let invalidCount = 0;
      const allErrors = [];

      for (const order of orders) {
        const errs = validateOrder(order);
        if (errs.length === 0) {
          validCount++;
        } else {
          invalidCount++;
          allErrors.push(...errs);
        }
      }

      // Write to D1 — batch all inserts in one call
      let written = 0;
      if (allErrors.length > 0) {
        const stmts = allErrors.map(err =>
          DB.prepare(`
            INSERT OR IGNORE INTO validation_errors
            (order_id, order_ref, error_code, description, pos_config_id, pos_config_name,
             payment_method_id, payment_method_name, odoo_payment_id, runner_partner_id, runner_slot,
             product_ids, product_names, cashier_uid, cashier_name, order_amount, order_time,
             assigned_to, assigned_role)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            err.order_id, err.order_ref, err.error_code, err.description,
            err.pos_config_id, err.pos_config_name,
            err.payment_method_id, err.payment_method_name, err.odoo_payment_id,
            err.runner_partner_id, err.runner_slot,
            JSON.stringify(err.product_ids), JSON.stringify(err.product_names),
            err.cashier_uid, err.cashier_name, err.order_amount, err.order_time,
            err.assigned_to, err.assigned_role
          )
        );
        const results = await DB.batch(stmts);
        written = results.filter(r => r.meta?.changes > 0).length;
      }

      return json({
        success: true,
        period: { from, to: to || 'now' },
        orders_checked: orders.length,
        valid: validCount,
        invalid: invalidCount,
        error_rate: orders.length > 0 ? ((invalidCount / orders.length) * 100).toFixed(1) + '%' : '0%',
        errors_written: written,
        errors: allErrors.map(e => ({
          order_id: e.order_id,
          ref: e.order_ref,
          type: e.error_code,
          desc: e.description,
          time: e.order_time,
          cashier: e.cashier_name,
          runner: e.runner_slot,
          amount: e.order_amount
        }))
      }, cors);
    }

    // ── SCAN-RECENT — cursor-based incremental scan (called by cashier page on load + every 60s) ──
    if (action === 'scan-recent') {
      // Read last scan cursor
      let lastScan = null;
      try {
        const row = await DB.prepare(`SELECT value FROM validator_state WHERE key = 'last_scan_time'`).first();
        lastScan = row?.value || null;
      } catch (e) { /* table may not exist yet */ }

      // Default to start of today IST if no cursor (covers early-morning orders)
      if (!lastScan) {
        const now = new Date();
        const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        const startOfDayIST = `${istNow.toISOString().slice(0, 10)} 00:00:00`;
        lastScan = startOfDayIST;
      } else {
        // Lookback buffer: subtract 5 minutes from cursor to catch late-syncing orders.
        // INSERT OR IGNORE on validation_errors handles duplicates, so overlap is safe.
        const cursorDate = new Date(lastScan.replace(' ', 'T') + '+05:30');
        const lookback = new Date(cursorDate.getTime() - 5 * 60 * 1000);
        lastScan = toIST(lookback);
      }
      const nowIST = toIST(new Date());

      const orders = await fetchOdooOrders(ODOO_API_KEY, lastScan, nowIST);

      let validCount = 0, invalidCount = 0;
      const allErrors = [];
      for (const order of orders) {
        const errs = validateOrder(order);
        if (errs.length === 0) validCount++;
        else { invalidCount++; allErrors.push(...errs); }
      }

      // Write errors to D1 — same batched INSERT OR IGNORE pattern
      let written = 0;
      if (allErrors.length > 0) {
        const stmts = allErrors.map(err =>
          DB.prepare(`
            INSERT OR IGNORE INTO validation_errors
            (order_id, order_ref, error_code, description, pos_config_id, pos_config_name,
             payment_method_id, payment_method_name, odoo_payment_id, runner_partner_id, runner_slot,
             product_ids, product_names, cashier_uid, cashier_name, order_amount, order_time,
             assigned_to, assigned_role)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            err.order_id, err.order_ref, err.error_code, err.description,
            err.pos_config_id, err.pos_config_name,
            err.payment_method_id, err.payment_method_name, err.odoo_payment_id,
            err.runner_partner_id, err.runner_slot,
            JSON.stringify(err.product_ids), JSON.stringify(err.product_names),
            err.cashier_uid, err.cashier_name, err.order_amount, err.order_time,
            err.assigned_to, err.assigned_role
          )
        );
        const results = await DB.batch(stmts);
        written = results.filter(r => r.meta?.changes > 0).length;
      }

      // ── Auto-fix: known partner aliases (e.g., partner 90 → runner 64) ──
      // When an order has invalid_partner and the partner is a known alias, auto-correct in Odoo.
      let autoFixed = 0;
      try {
        const aliasErrors = await DB.prepare(
          `SELECT id, order_id, runner_partner_id, payment_method_id, pos_config_id, order_ref
           FROM validation_errors WHERE status = 'pending' AND error_code = 'invalid_partner' LIMIT 50`
        ).all();

        const autoFixStmts = [];
        for (const err of (aliasErrors?.results || [])) {
          const correctId = PARTNER_ALIASES[err.runner_partner_id];
          if (!correctId) continue; // Not a known alias — needs manual fix

          // Verify the fix would produce a valid tuple
          const expectedMWR = `${err.payment_method_id}:${err.pos_config_id}:${correctId}`;
          if (!VALID_MWR.has(expectedMWR)) continue; // Fix wouldn't be valid — skip

          // Write to Odoo: change partner_id to the correct runner
          try {
            const writeRes = await fetch(ODOO_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', method: 'call',
                params: {
                  service: 'object', method: 'execute_kw',
                  args: [ODOO_DB, ODOO_UID, context.env.ODOO_API_KEY, 'pos.order', 'write', [[err.order_id], { partner_id: correctId }]]
                },
                id: Date.now()
              })
            });
            const writeData = await writeRes.json();
            if (writeData.result === true) {
              // Odoo updated — mark as auto-fixed in D1
              autoFixStmts.push(
                DB.prepare(
                  `UPDATE validation_errors SET status = 'rectified', rectified_by = 'SYSTEM', rectified_at = datetime('now'), rectification_action = 'auto-fix-alias' WHERE id = ?`
                ).bind(err.id)
              );
              autoFixed++;
            }
          } catch (e) { /* Odoo write failed — leave for manual fix */ }
        }
        if (autoFixStmts.length > 0) await DB.batch(autoFixStmts);
      } catch (e) { /* Auto-fix non-critical */ }

      // ── Auto-reconciliation: re-check existing pending errors against current Odoo state ──
      // If someone fixed an order directly in Odoo, the D1 error stays 'pending' forever.
      // This re-validates those orders and auto-resolves errors that no longer apply.
      let reconciled = 0;
      try {
        const pendingRows = await DB.prepare(
          `SELECT DISTINCT order_id FROM validation_errors WHERE status = 'pending' LIMIT 100`
        ).all();
        const pendingOrderIds = (pendingRows?.results || []).map(r => r.order_id);

        if (pendingOrderIds.length > 0) {
          // Fetch these specific orders from Odoo by ID
          const reconOrders = await fetchOdooOrdersByIds(ODOO_API_KEY, pendingOrderIds);
          const reconOrderMap = {};
          for (const o of reconOrders) reconOrderMap[o.id] = o;

          // For each pending order, re-validate. If no errors match, resolve them.
          const resolveStmts = [];
          for (const orderId of pendingOrderIds) {
            const order = reconOrderMap[orderId];
            if (!order) continue; // order not found in Odoo — leave pending
            const currentErrors = validateOrder(order);
            const currentCodes = new Set(currentErrors.map(e => e.error_code));

            // Get all pending error codes for this order
            const dbErrors = await DB.prepare(
              `SELECT id, error_code FROM validation_errors WHERE order_id = ? AND status = 'pending'`
            ).bind(orderId).all();

            for (const dbErr of (dbErrors?.results || [])) {
              if (!currentCodes.has(dbErr.error_code)) {
                // This specific error no longer applies — auto-resolve
                resolveStmts.push(
                  DB.prepare(
                    `UPDATE validation_errors SET status = 'rectified', rectified_at = datetime('now'), rectification_action = 'auto-reconciled' WHERE id = ?`
                  ).bind(dbErr.id)
                );
              }
            }
          }

          if (resolveStmts.length > 0) {
            await DB.batch(resolveStmts);
            reconciled = resolveStmts.length;
          }
        }
      } catch (e) { /* reconciliation non-critical — don't break scan */ }

      // Update cursor
      try {
        await DB.prepare(
          `INSERT OR REPLACE INTO validator_state (key, value, updated_at) VALUES ('last_scan_time', ?, datetime('now'))`
        ).bind(nowIST).run();
      } catch (e) { /* cursor update non-critical */ }

      return json({
        success: true,
        scan_from: lastScan,
        scan_to: nowIST,
        orders_checked: orders.length,
        valid: validCount,
        invalid: invalidCount,
        errors_written: written,
        errors_auto_fixed: autoFixed,
        errors_reconciled: reconciled
      }, cors);
    }

    // ── RAZORPAY-VERIFY — cross-check UPI amounts against actual Razorpay payments ──
    // Compares Odoo UPI totals per QR entity against Razorpay actuals.
    // Writes snapshots to upi_qr_snapshots and discrepancies to payment_discrepancies.
    // Called less frequently (every 5 min or before settlement) to avoid rate limits.
    if (action === 'razorpay-verify') {
      if (!RZP_KEY || !RZP_SECRET) return json({ success: false, error: 'Razorpay keys not configured' }, cors);

      // GAP 1 FIX: Use actual shift period (last counter settlement), not start-of-day
      const now = new Date();
      const nowISTStr = toIST(now);
      let shiftFromIST;
      try {
        const lastSettle = await DB.prepare(
          `SELECT settled_at FROM settlements WHERE runner_id = 'counter' ORDER BY settled_at DESC LIMIT 1`
        ).first();
        if (lastSettle?.settled_at) {
          // Convert stored ISO to IST string
          shiftFromIST = toIST(new Date(lastSettle.settled_at));
        }
      } catch (e) { /* table may not exist */ }
      // Fallback to start of today IST if no counter settlement found
      if (!shiftFromIST) {
        const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        shiftFromIST = `${istNow.toISOString().slice(0, 10)} 00:00:00`;
      }

      // Convert to unix timestamps for Razorpay API
      const fromUnix = Math.floor(new Date(shiftFromIST.replace(' ', 'T') + '+05:30').getTime() / 1000);
      const toUnix = Math.floor(now.getTime() / 1000);

      const auth = btoa(RZP_KEY + ':' + RZP_SECRET);

      // 1. Fetch Razorpay payments from all QR codes in parallel
      const [counterRzp, runnerCounterRzp, ...runnerRzpResults] = await Promise.all([
        fetchQrPayments(auth, COUNTER_QR.qr_id, fromUnix, toUnix),
        fetchQrPayments(auth, RUNNER_COUNTER_QR.qr_id, fromUnix, toUnix),
        ...RUNNER_QRS.map(r => fetchQrPayments(auth, r.qr_id, fromUnix, toUnix))
      ]);

      // 2. Fetch Odoo orders for the same period to get POS UPI totals
      const orders = await fetchOdooOrders(ODOO_API_KEY, shiftFromIST, nowISTStr);

      // 3. Calculate POS UPI totals per entity
      const posUPI = { COUNTER: 0, RUNNER_COUNTER: 0 };
      for (const rq of RUNNER_QRS) posUPI[rq.label] = 0;

      for (const order of orders) {
        const posId = order.config_id;
        const partnerId = order.partner_id || 0;
        const isRunner = VALID_RUNNER_IDS.has(partnerId);

        for (const payment of (order.payments || [])) {
          if (payment.method_id !== PM.UPI) continue;
          const amt = payment.amount || 0;

          if (posId === POS.CASH_COUNTER && !isRunner) {
            posUPI.COUNTER += amt;
          } else if (posId === POS.RUNNER_COUNTER && !isRunner) {
            posUPI.RUNNER_COUNTER += amt;
          }
          // Note: Runner UPI is collected via their personal QR codes,
          // not tracked as UPI payment method in Odoo. Runner QR verification
          // compares Razorpay runner QR total against nch-data's runner UPI.
        }
      }

      // 4. Calculate Razorpay totals per entity
      const rzpTotals = {};
      const rzpCounts = {};

      rzpTotals.COUNTER = counterRzp.reduce((s, p) => s + (p.amount / 100), 0); // Razorpay amounts in paise
      rzpCounts.COUNTER = counterRzp.length;
      rzpTotals.RUNNER_COUNTER = runnerCounterRzp.reduce((s, p) => s + (p.amount / 100), 0);
      rzpCounts.RUNNER_COUNTER = runnerCounterRzp.length;

      RUNNER_QRS.forEach((rq, i) => {
        const payments = runnerRzpResults[i] || [];
        rzpTotals[rq.label] = payments.reduce((s, p) => s + (p.amount / 100), 0);
        rzpCounts[rq.label] = payments.length;
      });

      // 5. Build snapshots and detect discrepancies
      // NOTE: Only COUNTER and RUNNER_COUNTER QRs have meaningful POS UPI comparison.
      // Runner personal QRs have NO POS UPI equivalent — runner UPI reduces their cash
      // obligation (cashInHand = tokens + sales - upiTotal). So runner QR amounts are
      // informational only, not discrepancies.
      const snapshotTime = nowISTStr;
      const counterEntities = ['COUNTER', 'RUNNER_COUNTER'];
      const runnerLabels = RUNNER_QRS.map(r => r.label);
      const allEntities = [...counterEntities, ...runnerLabels];
      const snapshots = [];
      const discrepancies = [];
      const TOLERANCE = 1; // ₹1 tolerance for rounding

      for (const entity of allEntities) {
        const rzpTotal = Math.round((rzpTotals[entity] || 0) * 100) / 100;
        const isRunnerQR = runnerLabels.includes(entity);
        // Runner QRs have no POS UPI equivalent — always 0, not a discrepancy
        const posTotal = isRunnerQR ? 0 : Math.round((posUPI[entity] || 0) * 100) / 100;
        const excess = Math.round((rzpTotal - posTotal) * 100) / 100;
        const deficit = Math.round((posTotal - rzpTotal) * 100) / 100;

        snapshots.push({
          entity, snapshotTime, rzpTotal, posTotal,
          excess: excess > 0 ? excess : 0,
          deficit: deficit > 0 ? deficit : 0,
          rzpCount: rzpCounts[entity] || 0,
          isRunnerQR
        });

        // Only check discrepancies for counter QRs — runner QRs are handled by settlement formula
        if (!isRunnerQR) {
          if (deficit > TOLERANCE) {
            discrepancies.push({
              entity, type: 'deficit', amount: deficit,
              desc: `${entity}: POS UPI ₹${posTotal} but Razorpay only received ₹${rzpTotal}. Deficit: ₹${deficit}. Possible: order marked UPI but paid cash, or payment went to different QR.`
            });
          }
          if (excess > TOLERANCE) {
            discrepancies.push({
              entity, type: 'excess', amount: excess,
              desc: `${entity}: Razorpay received ₹${rzpTotal} but POS UPI only ₹${posTotal}. Excess: ₹${excess}. Possible: customer paid to wrong QR, or order marked Cash but paid UPI.`
            });
          }
        }
      }

      // 6. Write snapshots to D1
      let snapshotsWritten = 0;
      try {
        const stmts = snapshots.map(s =>
          DB.prepare(`INSERT OR REPLACE INTO upi_qr_snapshots (qr_entity_code, snapshot_time, razorpay_total, pos_upi_total, excess, deficit, razorpay_count, order_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(s.entity, s.snapshotTime, s.rzpTotal, s.posTotal, s.excess, s.deficit, s.rzpCount, 0)
        );
        await DB.batch(stmts);
        snapshotsWritten = stmts.length;
      } catch (e) { /* snapshots table may not exist */ }

      // 7. GAP 3 FIX: Replace stale discrepancies instead of accumulating.
      // Delete ALL pending counter discrepancies, then insert only current ones.
      // This ensures each verify run gives a clean, accurate slate.
      let discWritten = 0;
      let autoResolved = 0;
      try {
        const stmts = [];
        // Clear all pending counter discrepancies (runner QRs never create discrepancies)
        stmts.push(
          DB.prepare(`UPDATE payment_discrepancies SET status = 'superseded', resolved_at = datetime('now'), resolution_action = 'superseded by new verify run' WHERE status = 'pending'`)
        );
        // Insert only current discrepancies
        for (const d of discrepancies) {
          stmts.push(
            DB.prepare(`INSERT INTO payment_discrepancies (disc_type, amount, expected_entity, actual_entity, detected_at, status, assigned_role, order_ref) VALUES (?, ?, ?, ?, datetime('now'), 'pending', 'cashier', ?)`)
              .bind(d.type, d.amount, d.entity, d.entity, d.desc)
          );
        }
        const results = await DB.batch(stmts);
        // First result is the UPDATE (count of superseded), rest are INSERTs
        autoResolved = results[0]?.meta?.changes || 0;
        discWritten = discrepancies.length;
      } catch (e) { /* table may not exist */ }

      return json({
        success: true,
        period: { from: shiftFromIST, to: nowISTStr },
        snapshots: snapshots.map(s => ({
          entity: s.entity,
          razorpay: s.rzpTotal,
          pos_upi: s.posTotal,
          excess: s.excess,
          deficit: s.deficit,
          rzp_count: s.rzpCount,
          is_runner_qr: !!s.isRunnerQR
        })),
        discrepancies,
        snapshots_written: snapshotsWritten,
        discrepancies_written: discWritten,
        auto_resolved: autoResolved
      }, cors);
    }

    // ── GET-DISCREPANCIES — return all pending UPI discrepancies ──
    if (action === 'get-discrepancies') {
      try {
        const pending = await DB.prepare(
          `SELECT * FROM payment_discrepancies WHERE status = 'pending' ORDER BY detected_at DESC`
        ).all();
        return json({ success: true, discrepancies: pending?.results || [] }, cors);
      } catch (e) {
        return json({ success: true, discrepancies: [] }, cors);
      }
    }

    // ── GET-COUNTER-ERRORS — return pending validation errors for counter (no runner) ──
    if (action === 'get-counter-errors') {
      try {
        // GAP 4: Exclude unknown_product_warning — those are non-blocking
        const pending = await DB.prepare(
          `SELECT COUNT(*) as cnt FROM validation_errors WHERE status = 'pending' AND error_code != 'unknown_product_warning' AND (runner_slot IS NULL OR runner_slot = '') AND pos_config_id = 27`
        ).first();
        return json({ success: true, counter_errors: pending?.cnt || 0 }, cors);
      } catch (e) {
        return json({ success: true, counter_errors: 0 }, cors);
      }
    }

    return json({ success: false, error: 'Unknown action. Use: validate, scan, scan-recent, check, razorpay-verify, get-discrepancies, get-counter-errors, get-my-errors, get-overview' }, cors);

  } catch (e) {
    return json({ success: false, error: e.message, stack: e.stack }, cors, 500);
  }
}

// ============================================================
// VALIDATION ENGINE — EXHAUSTIVE LOOKUP TABLES
// Pure set membership. If not in the set, it's invalid. No inference.
// ============================================================

// ── ALL 15 VALID (M, W, R) TUPLES ──
// Key format: "methodId:posConfigId:runnerPartnerId" (0 = no runner)
// T01-T04: Counter sales (no runner, Cash Counter)
// T05-T09: Token Issue × 5 runners (Cash Counter)
// T10-T14: Runner Ledger × 5 runners (Runner Counter)
// T15: UPI on Runner Counter without runner
const VALID_MWR = new Set([
  // T01: Cash + Cash Counter + No Runner
  '37:27:0',
  // T02: UPI + Cash Counter + No Runner
  '38:27:0',
  // T03: Card + Cash Counter + No Runner
  '39:27:0',
  // T04: Comp + Cash Counter + No Runner
  '49:27:0',
  // T05-T09: Token Issue + Cash Counter + Runner
  '48:27:64', '48:27:65', '48:27:66', '48:27:67', '48:27:68',
  // T10-T14: Runner Ledger + Runner Counter + Runner
  '40:28:64', '40:28:65', '40:28:66', '40:28:67', '40:28:68',
  // T15: UPI + Runner Counter + No Runner
  '38:28:0'
]);

// ── ALL VALID (P, M) PAIRS ──
// Key format: "productId:methodId"
// Cash(37), UPI(38), Card(39), Comp(49) = ALL products
// Token Issue(48) = BEV + HLM only (3 BEV + 5 HLM = 8 products)
// Runner Ledger(40) = SNK + WTR + PKG only (9 SNK + 1 WTR + 5 PKG = 15 products)
const VALID_PM = new Set([
  // ── Cash(37): all 23 products ──
  '1028:37','1102:37','1103:37',                                              // BEV
  '1395:37','1396:37','1397:37','1398:37','1400:37',                          // HLM
  '1029:37','1030:37','1031:37','1033:37','1115:37','1117:37','1118:37','1392:37','1394:37', // SNK
  '1094:37',                                                                   // WTR
  '1111:37','1401:37','1402:37','1403:37','1423:37',                          // PKG
  // ── UPI(38): all 23 products ──
  '1028:38','1102:38','1103:38',
  '1395:38','1396:38','1397:38','1398:38','1400:38',
  '1029:38','1030:38','1031:38','1033:38','1115:38','1117:38','1118:38','1392:38','1394:38',
  '1094:38',
  '1111:38','1401:38','1402:38','1403:38','1423:38',
  // ── Card(39): all 23 products ──
  '1028:39','1102:39','1103:39',
  '1395:39','1396:39','1397:39','1398:39','1400:39',
  '1029:39','1030:39','1031:39','1033:39','1115:39','1117:39','1118:39','1392:39','1394:39',
  '1094:39',
  '1111:39','1401:39','1402:39','1403:39','1423:39',
  // ── Comp(49): all 23 products ──
  '1028:49','1102:49','1103:49',
  '1395:49','1396:49','1397:49','1398:49','1400:49',
  '1029:49','1030:49','1031:49','1033:49','1115:49','1117:49','1118:49','1392:49','1394:49',
  '1094:49',
  '1111:49','1401:49','1402:49','1403:49','1423:49',
  // ── Token Issue(48): BEV + HLM only (8 products) ──
  '1028:48','1102:48','1103:48',                                              // BEV
  '1395:48','1396:48','1397:48','1398:48','1400:48',                          // HLM
  // ── Runner Ledger(40): SNK + WTR + PKG only (15 products) ──
  '1029:40','1030:40','1031:40','1033:40','1115:40','1117:40','1118:40','1392:40','1394:40', // SNK
  '1094:40',                                                                   // WTR
  '1111:40','1401:40','1402:40','1403:40','1423:40'                           // PKG
]);

// Human-readable names for error descriptions
const METHOD_NAMES = { 37: 'Cash', 38: 'UPI', 39: 'Card', 40: 'Runner Ledger', 48: 'Token Issue', 49: 'Comp' };
const POS_NAMES = { 27: 'Cash Counter', 28: 'Runner Counter' };

// ── TUPLE DESCRIPTION for each valid combo (for debugging/display) ──
const TUPLE_LABELS = {
  '37:27:0': 'T01: Cash + Cash Counter + No Runner',
  '38:27:0': 'T02: UPI + Cash Counter + No Runner',
  '39:27:0': 'T03: Card + Cash Counter + No Runner',
  '49:27:0': 'T04: Comp + Cash Counter + No Runner',
  '48:27:64': 'T05: Token Issue + Cash Counter + RUN001',
  '48:27:65': 'T06: Token Issue + Cash Counter + RUN002',
  '48:27:66': 'T07: Token Issue + Cash Counter + RUN003',
  '48:27:67': 'T08: Token Issue + Cash Counter + RUN004',
  '48:27:68': 'T09: Token Issue + Cash Counter + RUN005',
  '40:28:64': 'T10: Runner Ledger + Runner Counter + RUN001',
  '40:28:65': 'T11: Runner Ledger + Runner Counter + RUN002',
  '40:28:66': 'T12: Runner Ledger + Runner Counter + RUN003',
  '40:28:67': 'T13: Runner Ledger + Runner Counter + RUN004',
  '40:28:68': 'T14: Runner Ledger + Runner Counter + RUN005',
  '38:28:0': 'T15: UPI + Runner Counter + No Runner'
};

function validateOrder(order) {
  const errors = [];
  const posId = order.config_id;
  const posName = POS_NAMES[posId] || `POS ${posId}`;
  const partnerId = order.partner_id || 0;
  const isKnownRunner = VALID_RUNNER_IDS.has(partnerId);
  const runnerKey = isKnownRunner ? partnerId : 0;
  const runnerSlot = isKnownRunner ? RUNNER_SLOTS[partnerId] : null;

  for (const payment of (order.payments || [])) {
    const methodId = payment.method_id;
    const methodName = payment.method_name || METHOD_NAMES[methodId] || `Method ${methodId}`;

    // ── CHECK 1: (M, W, R) tuple must be in the valid set of 15 ──
    const mwrKey = `${methodId}:${posId}:${runnerKey}`;

    if (!VALID_MWR.has(mwrKey)) {
      // Invalid partner check (not a runner but partner mapped)
      const isInvalidPartner = partnerId && partnerId !== 0 && !isKnownRunner;
      const errorType = isInvalidPartner ? 'invalid_partner' : 'invalid_tuple';

      let description;
      if (isInvalidPartner) {
        description = `Partner ID ${partnerId} is not a valid runner (only RUN001-005 = IDs 64-68). Order: ${methodName} on ${posName}.`;
      } else {
        // Build specific description of what's wrong
        const runnerDesc = runnerSlot ? `Runner ${runnerSlot}` : 'No Runner';
        description = `Invalid combination: ${methodName} + ${posName} + ${runnerDesc}. `;
        // Add what was expected
        if (isKnownRunner) {
          description += `When runner is mapped: only Token Issue on Cash Counter or Runner Ledger on Runner Counter.`;
        } else if (posId === POS.RUNNER_COUNTER) {
          description += `Runner Counter without runner: only UPI allowed.`;
        } else {
          description += `Cash Counter without runner: only Cash, UPI, Card, or Comp allowed.`;
        }
      }

      errors.push({
        order_id: order.id,
        order_ref: order.name || order.pos_reference,
        error_code: errorType,
        description,
        pos_config_id: posId,
        pos_config_name: posName,
        payment_method_id: methodId,
        payment_method_name: methodName,
        odoo_payment_id: payment.id || null,
        runner_partner_id: partnerId || null,
        runner_slot: runnerSlot,
        product_ids: (order.lines || []).map(l => l.product_id),
        product_names: (order.lines || []).map(l => l.product_name),
        cashier_uid: order.user_id,
        cashier_name: order.cashier_name || `User ${order.user_id}`,
        order_amount: payment.amount || order.amount_total,
        order_time: order.date_order,
        assigned_to: (order.cashier_name || `User ${order.user_id}`).toLowerCase(),
        assigned_role: 'cashier'
      });
      continue; // MWR already invalid, skip P×M check for this payment
    }

    // ── CHECK 2: Every (P, M) pair must be in the valid set ──
    for (const line of (order.lines || [])) {
      const pmKey = `${line.product_id}:${methodId}`;

      if (!VALID_PM.has(pmKey)) {
        const cat = PRODUCT_CATEGORIES[line.product_id] || 'UNKNOWN';
        const isUnknownProduct = !PRODUCT_CATEGORIES[line.product_id];
        const isUniversalMethod = [PM.CASH, PM.UPI, PM.CARD, PM.COMP].includes(methodId);

        // GAP 4 FIX: Unknown product on a universal method (Cash/UPI/Card/Comp)
        // is a warning, not blocking — the financial flow is correct, just product
        // not in registry. Only block for Token Issue / Runner Ledger mismatches.
        if (isUnknownProduct && isUniversalMethod) {
          // Still log it but as a non-blocking warning
          errors.push({
            order_id: order.id,
            order_ref: order.name || order.pos_reference,
            error_code: 'unknown_product_warning',
            description: `Unknown product ID ${line.product_id} ("${line.product_name}") not in registry. Financial flow is OK (${methodName}). Add to v_products for full tracking.`,
            pos_config_id: posId, pos_config_name: posName,
            payment_method_id: methodId, payment_method_name: methodName,
            odoo_payment_id: payment.id || null,
            runner_partner_id: partnerId || null, runner_slot: runnerSlot,
            product_ids: [line.product_id], product_names: [line.product_name],
            cashier_uid: order.user_id,
            cashier_name: order.cashier_name || `User ${order.user_id}`,
            order_amount: order.amount_total, order_time: order.date_order,
            assigned_to: (order.cashier_name || `User ${order.user_id}`).toLowerCase(),
            assigned_role: 'cashier'
          });
          continue;
        }

        let description;
        if (methodId === PM.TOKEN_ISSUE) {
          description = `"${line.product_name}" (${cat}) with Token Issue. Only BEV/HLM products allowed with Token Issue.`;
        } else if (methodId === PM.RUNNER_LEDGER) {
          description = `"${line.product_name}" (${cat}) with Runner Ledger. Only SNK/WTR/PKG products allowed with Runner Ledger.`;
        } else if (isUnknownProduct) {
          description = `Unknown product ID ${line.product_id} ("${line.product_name}") with ${methodName}. Add to v_products.`;
        } else {
          description = `"${line.product_name}" (${cat}) with ${methodName} — not a defined valid combination.`;
        }

        errors.push({
          order_id: order.id,
          order_ref: order.name || order.pos_reference,
          error_code: 'invalid_product_method',
          description,
          pos_config_id: posId,
          pos_config_name: posName,
          payment_method_id: methodId,
          payment_method_name: methodName,
          odoo_payment_id: payment.id || null,
          runner_partner_id: partnerId || null,
          runner_slot: runnerSlot,
          product_ids: [line.product_id],
          product_names: [line.product_name],
          cashier_uid: order.user_id,
          cashier_name: order.cashier_name || `User ${order.user_id}`,
          order_amount: order.amount_total,
          order_time: order.date_order,
          assigned_to: (order.cashier_name || `User ${order.user_id}`).toLowerCase(),
          assigned_role: 'cashier'
        });
      }
    }
  }

  return errors;
}

// ============================================================
// PRODUCT CATEGORY LOOKUP
// ============================================================

const PRODUCT_CATEGORIES = {
  1028: 'BEV', 1102: 'BEV', 1103: 'BEV',  // Chai, Coffee, Lemon Tea
  1395: 'HLM', 1396: 'HLM', 1397: 'HLM', 1398: 'HLM', 1400: 'HLM',  // Haleem
  1029: 'SNK', 1030: 'SNK', 1031: 'SNK', 1033: 'SNK', 1115: 'SNK',  // Snacks
  1117: 'SNK', 1118: 'SNK', 1392: 'SNK', 1394: 'SNK',
  1094: 'WTR',  // Water
  1111: 'PKG', 1401: 'PKG', 1402: 'PKG', 1403: 'PKG', 1423: 'PKG'  // Packaged
};

// ============================================================
// ODOO API
// ============================================================

async function odooRpc(apiKey, model, method, domain, fields, limit = 500) {
  const res = await fetch(ODOO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: {
        service: 'object', method: 'execute_kw',
        args: [ODOO_DB, ODOO_UID, apiKey, model, method, [domain], { fields, limit }]
      }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message);
  return data.result;
}

async function fetchOdooOrders(apiKey, from, to) {
  // Convert IST input to UTC for Odoo
  const fromUtc = istToUtc(from);
  const toUtc = to ? istToUtc(to) : null;

  const domain = [
    ['config_id', 'in', [POS.CASH_COUNTER, POS.RUNNER_COUNTER]],
    ['date_order', '>=', fromUtc],
    ['state', 'in', ['paid', 'done', 'invoiced']]
  ];
  if (toUtc) domain.push(['date_order', '<=', toUtc]);

  // 1. Fetch all orders (1 call)
  const orders = await odooRpc(apiKey, 'pos.order', 'search_read', domain, [
    'id', 'name', 'pos_reference', 'date_order', 'amount_total',
    'config_id', 'partner_id', 'user_id', 'session_id',
    'payment_ids', 'lines'
  ]);

  if (!orders.length) return [];

  // 2. Collect ALL payment IDs and line IDs across all orders
  const allPaymentIds = [];
  const allLineIds = [];
  for (const order of orders) {
    if (order.payment_ids?.length) allPaymentIds.push(...order.payment_ids);
    if (order.lines?.length) allLineIds.push(...order.lines);
  }

  // 3. Batch fetch all payments in ONE call
  const paymentMap = {};
  if (allPaymentIds.length > 0) {
    const paymentData = await odooRpc(apiKey, 'pos.payment', 'search_read',
      [['id', 'in', allPaymentIds]],
      ['id', 'amount', 'payment_method_id'],
      allPaymentIds.length
    );
    for (const p of paymentData) {
      paymentMap[p.id] = {
        id: p.id,
        amount: p.amount,
        method_id: p.payment_method_id?.[0] || p.payment_method_id,
        method_name: p.payment_method_id?.[1] || null
      };
    }
  }

  // 4. Batch fetch all lines in ONE call
  const lineMap = {};
  if (allLineIds.length > 0) {
    const lineData = await odooRpc(apiKey, 'pos.order.line', 'search_read',
      [['id', 'in', allLineIds]],
      ['id', 'product_id', 'qty', 'price_subtotal_incl', 'full_product_name'],
      allLineIds.length
    );
    for (const l of lineData) {
      lineMap[l.id] = {
        id: l.id,
        product_id: l.product_id?.[0] || l.product_id,
        product_name: l.full_product_name || l.product_id?.[1] || null,
        qty: l.qty,
        amount: l.price_subtotal_incl
      };
    }
  }

  // 5. Assemble enriched orders from maps (0 additional calls)
  return orders.map(order => ({
    id: order.id,
    name: order.name,
    pos_reference: order.pos_reference,
    date_order: order.date_order,
    amount_total: order.amount_total,
    config_id: order.config_id?.[0] || order.config_id,
    partner_id: order.partner_id?.[0] || order.partner_id || null,
    user_id: order.user_id?.[0] || order.user_id,
    cashier_name: order.user_id?.[1] || null,
    payments: (order.payment_ids || []).map(id => paymentMap[id]).filter(Boolean),
    lines: (order.lines || []).map(id => lineMap[id]).filter(Boolean)
  }));
}

async function fetchOdooOrderById(apiKey, orderId) {
  // Fetch just this one order directly by ID
  const orders = await odooRpc(apiKey, 'pos.order', 'search_read',
    [['id', '=', orderId]],
    ['id', 'name', 'pos_reference', 'date_order', 'amount_total',
     'config_id', 'partner_id', 'user_id', 'session_id',
     'payment_ids', 'lines'],
    1
  );
  if (!orders.length) return [];

  const order = orders[0];
  const allPaymentIds = order.payment_ids || [];
  const allLineIds = order.lines || [];

  let payments = [];
  if (allPaymentIds.length) {
    const pd = await odooRpc(apiKey, 'pos.payment', 'search_read',
      [['id', 'in', allPaymentIds]], ['id', 'amount', 'payment_method_id'], allPaymentIds.length);
    payments = pd.map(p => ({ id: p.id, amount: p.amount, method_id: p.payment_method_id?.[0] || p.payment_method_id, method_name: p.payment_method_id?.[1] || null }));
  }

  let lines = [];
  if (allLineIds.length) {
    const ld = await odooRpc(apiKey, 'pos.order.line', 'search_read',
      [['id', 'in', allLineIds]], ['id', 'product_id', 'qty', 'price_subtotal_incl', 'full_product_name'], allLineIds.length);
    lines = ld.map(l => ({ id: l.id, product_id: l.product_id?.[0] || l.product_id, product_name: l.full_product_name || l.product_id?.[1] || null, qty: l.qty, amount: l.price_subtotal_incl }));
  }

  return [{
    id: order.id, name: order.name, pos_reference: order.pos_reference,
    date_order: order.date_order, amount_total: order.amount_total,
    config_id: order.config_id?.[0] || order.config_id,
    partner_id: order.partner_id?.[0] || order.partner_id || null,
    user_id: order.user_id?.[0] || order.user_id,
    cashier_name: order.user_id?.[1] || null,
    payments, lines
  }];
}

async function fetchOdooOrdersByIds(apiKey, orderIds) {
  if (!orderIds.length) return [];
  const orders = await odooRpc(apiKey, 'pos.order', 'search_read',
    [['id', 'in', orderIds]],
    ['id', 'name', 'pos_reference', 'date_order', 'amount_total',
     'config_id', 'partner_id', 'user_id', 'session_id',
     'payment_ids', 'lines'],
    orderIds.length
  );
  if (!orders.length) return [];

  const allPaymentIds = [], allLineIds = [];
  for (const o of orders) {
    if (o.payment_ids?.length) allPaymentIds.push(...o.payment_ids);
    if (o.lines?.length) allLineIds.push(...o.lines);
  }

  const paymentMap = {};
  if (allPaymentIds.length) {
    const pd = await odooRpc(apiKey, 'pos.payment', 'search_read',
      [['id', 'in', allPaymentIds]], ['id', 'amount', 'payment_method_id'], allPaymentIds.length);
    for (const p of pd) paymentMap[p.id] = { id: p.id, amount: p.amount, method_id: p.payment_method_id?.[0] || p.payment_method_id, method_name: p.payment_method_id?.[1] || null };
  }

  const lineMap = {};
  if (allLineIds.length) {
    const ld = await odooRpc(apiKey, 'pos.order.line', 'search_read',
      [['id', 'in', allLineIds]], ['id', 'product_id', 'qty', 'price_subtotal_incl', 'full_product_name'], allLineIds.length);
    for (const l of ld) lineMap[l.id] = { id: l.id, product_id: l.product_id?.[0] || l.product_id, product_name: l.full_product_name || l.product_id?.[1] || null, qty: l.qty, amount: l.price_subtotal_incl };
  }

  return orders.map(order => ({
    id: order.id, name: order.name, pos_reference: order.pos_reference,
    date_order: order.date_order, amount_total: order.amount_total,
    config_id: order.config_id?.[0] || order.config_id,
    partner_id: order.partner_id?.[0] || order.partner_id || null,
    user_id: order.user_id?.[0] || order.user_id,
    cashier_name: order.user_id?.[1] || null,
    payments: (order.payment_ids || []).map(id => paymentMap[id]).filter(Boolean),
    lines: (order.lines || []).map(id => lineMap[id]).filter(Boolean)
  }));
}

// ============================================================
// HELPERS
// ============================================================

function istToUtc(istDateStr) {
  // Input: "YYYY-MM-DD HH:MM:SS" in IST → subtract 5:30 for UTC
  const d = new Date(istDateStr.replace(' ', 'T') + '+05:30');
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function toIST(date) {
  // Convert any date to IST string "YYYY-MM-DD HH:MM:SS"
  const d = new Date(date);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

// ============================================================
// RAZORPAY API
// ============================================================

async function fetchQrPayments(auth, qrId, fromUnix, toUnix) {
  // GAP 7 FIX: Increased from 10 to 50 pages (5000 payments max per QR per shift)
  const allItems = [];
  let skip = 0;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const res = await fetch(
        `https://api.razorpay.com/v1/payments/qr_codes/${qrId}/payments?count=${PAGE_SIZE}&skip=${skip}&from=${fromUnix}&to=${toUnix}`,
        { headers: { 'Authorization': 'Basic ' + auth } }
      );
      const data = await res.json();
      if (data.error || !data.items || data.items.length === 0) break;

      const captured = data.items.filter(p => p.status === 'captured');
      allItems.push(...captured);

      if (data.items.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    } catch (e) {
      break;
    }
  }
  return allItems;
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: cors });
}
