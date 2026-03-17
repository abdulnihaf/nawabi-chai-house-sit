// Rectify API — fix validation errors, record counter expenses, check settlement readiness

const STAFF_SLOTS = {
  'CASH001': { role: 'cashier', person: 'Kesmat', pin: '7115' },
  'CASH002': { role: 'cashier', person: 'Nafees', pin: '8241' },
  'RUN001':  { role: 'runner',  person: 'Farzaib', pin: '3678', partner_id: 64 },
  'RUN002':  { role: 'runner',  person: 'Ritiqu',  pin: '4421', partner_id: 65 },
  'RUN003':  { role: 'runner',  person: 'Anshu',   pin: '5503', partner_id: 66 },
  'RUN004':  { role: 'runner',  person: 'Shabeer', pin: '6604', partner_id: 67 },
  'RUN005':  { role: 'runner',  person: 'Dhanush', pin: '7705', partner_id: 68 },
  'GM001':   { role: 'gm',         person: 'Basheer', pin: '8523' },
  'SUP001':  { role: 'supervisor', person: 'Waseem',  pin: '1234' },
  'MGR001':  { role: 'manager',    person: 'Tanveer', pin: '6890' },
  'ADMIN001':{ role: 'admin', person: 'Nihaf',    pin: '0305' },
  'ADMIN002':{ role: 'admin', person: 'Naveen',   pin: '3754' },
  'ADMIN003':{ role: 'admin', person: 'Yashwant', pin: '3697' },
  // Accountant
  'ACCT001': { role: 'accountant', person: 'Zoya', pin: '2026' }
};

const STAFF_BY_PIN = {};
for (const [slot, info] of Object.entries(STAFF_SLOTS)) {
  STAFF_BY_PIN[info.pin] = { name: info.person, role: info.role, slot, partner_id: info.partner_id || null };
}

const CAN_FIX_ERRORS = new Set(['cashier', 'admin', 'gm']);
const CAN_RECORD_EXPENSE = new Set(['cashier', 'admin', 'gm']);
const VALID_FIX_ACTIONS = new Set(['remove_runner', 'assign_runner', 'change_method']);

// Odoo connection (same as validator.js)
const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB = 'main';
const ODOO_UID = 2;

// Payment method IDs + POS config IDs (mirrored from validator)
const PM = { CASH: 37, UPI: 38, CARD: 39, RUNNER_LEDGER: 40, TOKEN_ISSUE: 48, COMP: 49 };
const POS = { CASH_COUNTER: 27, RUNNER_COUNTER: 28 };
const VALID_RUNNER_IDS = new Set([64, 65, 66, 67, 68]);

// The 15 valid (M, W, R) tuples — SAME as validator.js
const VALID_MWR = new Set([
  '37:27:0', '38:27:0', '39:27:0', '49:27:0',           // Counter, no runner
  '48:27:64', '48:27:65', '48:27:66', '48:27:67', '48:27:68', // Token Issue + runner
  '40:28:64', '40:28:65', '40:28:66', '40:28:67', '40:28:68', // Runner Ledger + runner
  '38:28:0'                                                // UPI on Runner Counter, no runner
]);

const PM_NAMES = { 37: 'Cash', 38: 'UPI', 39: 'Card', 40: 'Runner Ledger', 48: 'Token Issue', 49: 'Comp' };

// Cash collection: only these people can take cash from counter
// Naveen = final destination. Others collect "in transit" until Naveen confirms.
const CASH_COLLECTORS = new Set(['ADMIN001', 'ADMIN002', 'GM001', 'MGR001']); // Nihaf, Naveen, Basheer, Tanveer
const CASH_FINAL_DEST = 'ADMIN002'; // Naveen — all cash must reach him

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: cors});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  if (!DB) return json({success: false, error: 'Database not configured'}, cors);

  try {
    switch (action) {
      case 'fix-error': return await fixError(context, DB, cors);
      case 'get-runner-errors': return await getRunnerErrors(url, DB, cors);
      case 'get-all-errors': return await getAllErrors(url, DB, cors);
      case 'record-expense': return await recordExpense(context, DB, cors);
      case 'get-expenses': return await getExpenses(url, DB, cors);
      case 'check-settlement-ready': return await checkSettlementReady(url, DB, cors);
      case 'acknowledge-error': return await acknowledgeError(context, DB, cors);
      case 'dispute-error': return await disputeError(context, DB, cors);
      case 'collect-cash': return await collectCash(context, DB, cors);
      case 'confirm-received': return await confirmReceived(context, DB, cors);
      case 'get-collections': return await getCollections(url, DB, cors);
      case 'petty-expense': return await pettyExpense(context, DB, cors);
      case 'petty-fund': return await pettyFund(context, DB, cors);
      case 'get-petty': return await getPetty(url, DB, cors);
      case 'resolve-discrepancy': return await resolveDiscrepancy(context, DB, cors);
      case 'create-cross-qr-tag': return await createCrossQrTag(context, DB, cors);
      default: return json({success: false, error: `Unknown action: ${action}`}, cors, 400);
    }
  } catch (e) {
    return json({success: false, error: e.message}, cors, 500);
  }
}

async function fixError(context, DB, cors) {
  const body = await context.request.json();
  const {pin, error_id, fix_action, fix_data} = body;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;

  // 1. Auth
  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CAN_FIX_ERRORS.has(staff.role)) return json({success: false, error: 'Only cashier/admin/GM can fix errors'}, cors, 403);
  if (!VALID_FIX_ACTIONS.has(fix_action)) return json({success: false, error: `Invalid action. Use: remove_runner, assign_runner, change_method`}, cors, 400);

  // 2. Error must exist and be pending
  const err = await DB.prepare('SELECT * FROM validation_errors WHERE id = ?').bind(error_id).first();
  if (!err) return json({success: false, error: 'Error not found'}, cors, 404);
  if (err.status !== 'pending') return json({success: false, error: `Error already ${err.status}`}, cors, 400);

  const data = typeof fix_data === 'string' ? JSON.parse(fix_data) : (fix_data || {});
  let odooWrite = null;   // What to write to Odoo
  let impactDesc = '';     // Audit trail description
  let expectedMWR = null;  // What the tuple SHOULD become after fix

  // 3. Determine fix and PRE-VALIDATE it produces a valid tuple
  if (fix_action === 'remove_runner') {
    // Removing runner → partner_id becomes false (0)
    // New tuple: method:pos:0 — must be in VALID_MWR
    expectedMWR = `${err.payment_method_id}:${err.pos_config_id}:0`;
    if (!VALID_MWR.has(expectedMWR)) {
      return json({
        success: false,
        error: `Removing runner would create invalid combo: ${PM_NAMES[err.payment_method_id] || err.payment_method_id} + POS ${err.pos_config_id} + No Runner. Not allowed.`
      }, cors, 400);
    }
    odooWrite = { model: 'pos.order', id: err.order_id, values: { partner_id: false } };
    impactDesc = `Removed runner (was ${err.runner_slot || 'partner ' + err.runner_partner_id}). Order ${err.order_ref}`;
  }

  else if (fix_action === 'assign_runner') {
    // Assigning a runner → partner_id becomes runner's partner_id
    const runnerSlot = data.runner_slot;
    if (!runnerSlot || !STAFF_SLOTS[runnerSlot] || STAFF_SLOTS[runnerSlot].role !== 'runner') {
      return json({success: false, error: 'Invalid runner_slot. Use RUN001-RUN005.'}, cors, 400);
    }
    const runnerId = STAFF_SLOTS[runnerSlot].partner_id;
    expectedMWR = `${err.payment_method_id}:${err.pos_config_id}:${runnerId}`;
    if (!VALID_MWR.has(expectedMWR)) {
      return json({
        success: false,
        error: `Assigning ${runnerSlot} would create invalid combo: ${PM_NAMES[err.payment_method_id] || err.payment_method_id} + POS ${err.pos_config_id} + ${runnerSlot}. Not allowed.`
      }, cors, 400);
    }
    odooWrite = { model: 'pos.order', id: err.order_id, values: { partner_id: runnerId } };
    impactDesc = `Assigned to ${runnerSlot} (${STAFF_SLOTS[runnerSlot].person}, partner_id=${runnerId}). Order ${err.order_ref}`;
  }

  else if (fix_action === 'change_method') {
    // Changing payment method → must result in valid MWR tuple
    const newMethodId = parseInt(data.payment_method_id);
    if (!PM_NAMES[newMethodId]) {
      return json({success: false, error: `Invalid payment method ID: ${data.payment_method_id}. Valid: ${Object.entries(PM_NAMES).map(([k,v]) => k+'='+v).join(', ')}`}, cors, 400);
    }
    // Use the Odoo payment record ID stored during validation scan
    const paymentId = err.odoo_payment_id;
    if (!paymentId) {
      return json({success: false, error: 'No Odoo payment ID stored for this error. Re-run validator scan to populate odoo_payment_id.'}, cors, 400);
    }
    const runnerKey = VALID_RUNNER_IDS.has(err.runner_partner_id) ? err.runner_partner_id : 0;
    expectedMWR = `${newMethodId}:${err.pos_config_id}:${runnerKey}`;
    if (!VALID_MWR.has(expectedMWR)) {
      return json({
        success: false,
        error: `Changing to ${PM_NAMES[newMethodId]} would create invalid combo: ${PM_NAMES[newMethodId]} + POS ${err.pos_config_id} + ${runnerKey ? 'Runner ' + runnerKey : 'No Runner'}. Not allowed.`
      }, cors, 400);
    }
    odooWrite = { model: 'pos.payment', id: paymentId, values: { payment_method_id: newMethodId } };
    impactDesc = `Changed payment ${PM_NAMES[err.payment_method_id] || err.payment_method_id} → ${PM_NAMES[newMethodId]}. Order ${err.order_ref}`;
  }

  // 4. Write to Odoo — this is the actual fix at the source
  if (!ODOO_API_KEY) return json({success: false, error: 'ODOO_API_KEY not configured'}, cors, 500);

  try {
    const writeRes = await fetch(ODOO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: {
          service: 'object', method: 'execute_kw',
          args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, odooWrite.model, 'write', [[odooWrite.id], odooWrite.values]]
        },
        id: Date.now()
      })
    });
    const writeData = await writeRes.json();
    if (writeData.error) {
      return json({
        success: false,
        error: `Odoo write failed: ${writeData.error.data?.message || writeData.error.message}`,
        odoo_error: writeData.error
      }, cors, 500);
    }
    if (writeData.result !== true) {
      return json({success: false, error: 'Odoo write returned unexpected result', result: writeData.result}, cors, 500);
    }
  } catch (e) {
    return json({success: false, error: `Odoo connection failed: ${e.message}`}, cors, 500);
  }

  // 5. Odoo write succeeded → mark resolved in D1 + audit log
  const now = new Date().toISOString();
  await DB.batch([
    DB.prepare(`UPDATE validation_errors SET status = 'rectified', rectified_by = ?, rectified_at = ?, rectification_action = ? WHERE id = ?`)
      .bind(staff.slot, now, fix_action, error_id),
    DB.prepare(`INSERT INTO rectification_log (ref_type, ref_id, action_type, before_state, after_state, impact_description, performed_by, performed_by_name, pin_verified, performed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind('validation_error', error_id, fix_action, 'pending', 'rectified', impactDesc + ` | Odoo ${odooWrite.model}#${odooWrite.id} updated | Expected tuple: ${expectedMWR}`, staff.slot, staff.name, now)
  ]);

  const updated = await DB.prepare('SELECT * FROM validation_errors WHERE id = ?').bind(error_id).first();
  return json({
    success: true,
    fixed: true,
    odoo_updated: true,
    expected_tuple: expectedMWR,
    tuple_valid: VALID_MWR.has(expectedMWR),
    error: updated
  }, cors);
}

async function getRunnerErrors(url, DB, cors) {
  const runnerSlot = url.searchParams.get('runner_slot');
  if (!runnerSlot) return json({success: false, error: 'runner_slot required'}, cors, 400);

  const rows = await DB.prepare(
    `SELECT * FROM validation_errors WHERE runner_slot = ? AND status = 'pending' ORDER BY detected_at DESC`
  ).bind(runnerSlot).all();

  return json({success: true, errors: rows.results}, cors);
}

async function getAllErrors(url, DB, cors) {
  const pin = url.searchParams.get('pin');
  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);

  const rows = await DB.prepare(
    `SELECT * FROM validation_errors WHERE status = 'pending' ORDER BY runner_slot, detected_at DESC`
  ).all();

  const grouped = {};
  for (const row of rows.results) {
    const key = row.runner_slot || 'unassigned';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }

  return json({success: true, grouped, total: rows.results.length}, cors);
}

async function recordExpense(context, DB, cors) {
  const body = await context.request.json();
  const {pin, category_code, amount, description} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CAN_RECORD_EXPENSE.has(staff.role)) return json({success: false, error: 'Only cashier or admin can record expenses'}, cors, 403);

  const category = await DB.prepare(
    `SELECT * FROM v_expense_categories WHERE code = ? AND pool = 'counter' AND active = 1`
  ).bind(category_code).first();
  if (!category) return json({success: false, error: `Invalid counter expense category: ${category_code}`}, cors, 400);

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return json({success: false, error: 'Invalid amount'}, cors, 400);
  if (category.max_amount && amt > category.max_amount) {
    return json({success: false, error: `Amount exceeds max ${category.max_amount} for ${category.name}`}, cors, 400);
  }

  const now = new Date().toISOString();
  const result = await DB.prepare(
    `INSERT INTO counter_expenses_v2 (category_code, amount, description, recorded_by, recorded_by_name, pin_verified, recorded_at) VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).bind(category_code, amt, description || null, staff.slot, staff.name, now).run();

  return json({success: true, id: result.meta.last_row_id, category: category.name, amount: amt}, cors);
}

async function getExpenses(url, DB, cors) {
  const pin = url.searchParams.get('pin');
  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);

  const todayIST = getTodayIST();
  const rows = await DB.prepare(
    `SELECT ce.*, vc.name as category_name FROM counter_expenses_v2 ce LEFT JOIN v_expense_categories vc ON ce.category_code = vc.code WHERE ce.recorded_at >= ? ORDER BY ce.recorded_at DESC`
  ).bind(todayIST).all();

  const total = rows.results.reduce((sum, r) => sum + (r.amount || 0), 0);
  return json({success: true, expenses: rows.results, total}, cors);
}

async function checkSettlementReady(url, DB, cors) {
  const runnerSlot = url.searchParams.get('runner_slot');
  if (!runnerSlot) return json({success: false, error: 'runner_slot required'}, cors, 400);

  const pending = await DB.prepare(
    `SELECT COUNT(*) as count FROM validation_errors WHERE runner_slot = ? AND status = 'pending'`
  ).bind(runnerSlot).first();

  const reasons = [];
  if (pending.count > 0) reasons.push(`${pending.count} pending validation error(s)`);

  return json({
    success: true,
    runner_slot: runnerSlot,
    ready: pending.count === 0,
    pending_errors: pending.count,
    reasons
  }, cors);
}

async function acknowledgeError(context, DB, cors) {
  const body = await context.request.json();
  const {pin, error_id} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (staff.role !== 'runner') return json({success: false, error: 'Only runners can acknowledge errors'}, cors, 403);

  const err = await DB.prepare('SELECT * FROM validation_errors WHERE id = ?').bind(error_id).first();
  if (!err) return json({success: false, error: 'Error not found'}, cors, 404);
  if (err.runner_slot !== staff.slot) return json({success: false, error: 'This error is not assigned to you'}, cors, 403);

  const now = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO rectification_log (ref_type, ref_id, action_type, before_state, after_state, impact_description, performed_by, performed_by_name, pin_verified, performed_at) VALUES (?, ?, 'acknowledge', ?, ?, 'Runner acknowledged error', ?, ?, 1, ?)`
  ).bind('validation_error', error_id, err.status, err.status, staff.slot, staff.name, now).run();

  return json({success: true, message: 'Error acknowledged'}, cors);
}

async function disputeError(context, DB, cors) {
  const body = await context.request.json();
  const {pin, error_id, reason} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (staff.role !== 'runner') return json({success: false, error: 'Only runners can dispute errors'}, cors, 403);

  const err = await DB.prepare('SELECT * FROM validation_errors WHERE id = ?').bind(error_id).first();
  if (!err) return json({success: false, error: 'Error not found'}, cors, 404);
  if (err.runner_slot !== staff.slot) return json({success: false, error: 'This error is not assigned to you'}, cors, 403);
  if (!reason || !reason.trim()) return json({success: false, error: 'Dispute reason required'}, cors, 400);

  const now = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO rectification_log (ref_type, ref_id, action_type, before_state, after_state, impact_description, performed_by, performed_by_name, pin_verified, performed_at) VALUES (?, ?, 'dispute', ?, ?, ?, ?, ?, 1, ?)`
  ).bind('validation_error', error_id, err.status, err.status, `Disputed: ${reason.trim()}`, staff.slot, staff.name, now).run();

  return json({success: true, message: 'Dispute recorded'}, cors);
}

// ── PETTY CASH ── (separate fund held by cashiers/Tanveer/Basheer, NOT mixed with counter cash)
// Petty cash holders: Cashiers + Tanveer + Basheer
const PETTY_CASH_HOLDERS = new Set(['CASH001', 'CASH002', 'GM001', 'MGR001']);
const CAN_FUND_PETTY = new Set(['admin']); // Only Naveen (admin) reimburses petty cash

async function pettyExpense(context, DB, cors) {
  const body = await context.request.json();
  const {pin, category_code, amount, description, receipt_photo} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!PETTY_CASH_HOLDERS.has(staff.slot)) {
    return json({success: false, error: 'Not authorized for petty cash'}, cors, 403);
  }

  const category = await DB.prepare(
    `SELECT * FROM v_expense_categories WHERE code = ? AND pool = 'petty' AND active = 1`
  ).bind(category_code).first();
  if (!category) return json({success: false, error: `Invalid petty cash category: ${category_code}`}, cors, 400);

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return json({success: false, error: 'Invalid amount'}, cors, 400);
  if (category.max_amount && amt > category.max_amount) {
    return json({success: false, error: `Amount exceeds max ₹${category.max_amount} for ${category.name}`}, cors, 400);
  }

  // Check balance — warn but allow negative (Naveen reimburses)
  const bal = await DB.prepare('SELECT current_balance FROM petty_cash_balance WHERE id = 1').first();
  const willGoNegative = bal && amt > bal.current_balance;

  const now = new Date().toISOString();
  // Truncate photo to max 500KB base64 if provided
  const photo = receipt_photo && receipt_photo.length < 700000 ? receipt_photo : null;

  await DB.batch([
    DB.prepare(
      `INSERT INTO petty_cash (transaction_type, amount, category_code, description, recorded_by, recorded_by_name, pin_verified, recorded_at, receipt_photo)
       VALUES ('expense', ?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(amt, category_code, description || category.name, staff.slot, staff.name, now, photo),
    DB.prepare(
      `UPDATE petty_cash_balance SET current_balance = current_balance - ? WHERE id = 1`
    ).bind(amt)
  ]);

  const newBal = await DB.prepare('SELECT current_balance FROM petty_cash_balance WHERE id = 1').first();
  const result = {success: true, amount: amt, category: category.name, balance: newBal?.current_balance || 0};
  if (willGoNegative) {
    result.warning = `Petty cash is now negative (₹${newBal?.current_balance}). Naveen needs to reimburse.`;
    // Fire P1 alert — petty cash went negative (non-blocking)
    context.waitUntil(
      fetch('https://nawabichaihouse.com/api/wa-alerts?action=send-alert', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          alert: 'P1',
          data: {balance: newBal?.current_balance || 0, last_expense_by: staff.name}
        })
      }).catch(() => {})
    );
  }
  return json(result, cors);
}

async function pettyFund(context, DB, cors) {
  const body = await context.request.json();
  const {pin, amount, description, given_to} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CAN_FUND_PETTY.has(staff.role)) {
    return json({success: false, error: 'Only admin can fund petty cash'}, cors, 403);
  }

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return json({success: false, error: 'Invalid amount'}, cors, 400);

  // Validate given_to if provided — must be a petty cash holder
  let givenToSlot = null, givenToName = null;
  if (given_to) {
    if (!PETTY_CASH_HOLDERS.has(given_to)) {
      return json({success: false, error: 'Invalid recipient. Must be CASH001, CASH002, GM001, or MGR001'}, cors, 400);
    }
    // Resolve slot to name from STAFF_BY_PIN
    const recipient = Object.values(STAFF_BY_PIN).find(s => s.slot === given_to);
    givenToSlot = given_to;
    givenToName = recipient?.name || given_to;
  }

  const now = new Date().toISOString();
  const desc = givenToName
    ? `Cash given to ${givenToName}`
    : (description || 'Petty cash funded');

  await DB.batch([
    DB.prepare(
      `INSERT INTO petty_cash (transaction_type, amount, description, recorded_by, recorded_by_name, pin_verified, recorded_at, given_to, given_to_name)
       VALUES ('fund_add', ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(amt, desc, staff.slot, staff.name, now, givenToSlot, givenToName),
    DB.prepare(
      `UPDATE petty_cash_balance SET current_balance = current_balance + ?, last_funded_at = ?, last_funded_by = ?, last_funded_amount = ? WHERE id = 1`
    ).bind(amt, now, staff.name, amt)
  ]);

  const newBal = await DB.prepare('SELECT current_balance FROM petty_cash_balance WHERE id = 1').first();
  return json({success: true, amount: amt, given_to: givenToName, balance: newBal?.current_balance || 0}, cors);
}

async function getPetty(url, DB, cors) {
  const pin = url.searchParams.get('pin');
  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);

  const bal = await DB.prepare('SELECT * FROM petty_cash_balance WHERE id = 1').first();
  const todayIST = getTodayIST();
  const txns = await DB.prepare(
    `SELECT pc.*, vc.name as category_name FROM petty_cash pc LEFT JOIN v_expense_categories vc ON pc.category_code = vc.code WHERE pc.recorded_at >= ? ORDER BY pc.recorded_at DESC`
  ).bind(todayIST).all();

  const todayExpenses = txns.results.filter(t => t.transaction_type === 'expense');
  const todayTotal = todayExpenses.reduce((sum, t) => sum + t.amount, 0);

  // Per-person breakdown: given vs spent vs holding
  const personBreakdown = {};
  for (const slot of PETTY_CASH_HOLDERS) {
    const r = Object.values(STAFF_BY_PIN).find(s => s.slot === slot);
    personBreakdown[slot] = {name: r?.name || slot, given: 0, spent: 0, holding: 0};
  }
  for (const t of txns.results) {
    if (t.transaction_type === 'fund_add' && t.given_to && personBreakdown[t.given_to]) {
      personBreakdown[t.given_to].given += t.amount;
    } else if (t.transaction_type === 'expense' && personBreakdown[t.recorded_by]) {
      personBreakdown[t.recorded_by].spent += t.amount;
    }
  }
  for (const slot of Object.keys(personBreakdown)) {
    personBreakdown[slot].holding = personBreakdown[slot].given - personBreakdown[slot].spent;
  }

  return json({
    success: true,
    balance: bal?.current_balance || 0,
    last_funded_by: bal?.last_funded_by,
    last_funded_amount: bal?.last_funded_amount,
    transactions: txns.results,
    today_expenses: todayTotal,
    per_person: Object.values(personBreakdown)
  }, cors);
}

// ── CASH COLLECTION ──
// Flow: Collector takes cash from counter → if Naveen, it's "collected". Otherwise "in_transit" until Naveen confirms.
async function collectCash(context, DB, cors) {
  const body = await context.request.json();
  const {pin, amount, notes} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CASH_COLLECTORS.has(staff.slot)) {
    return json({success: false, error: 'Not authorized to collect cash. Only Naveen, Nihaf, Basheer, or Tanveer can collect.'}, cors, 403);
  }

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return json({success: false, error: 'Invalid amount'}, cors, 400);

  const now = new Date().toISOString();
  const isFinalDest = staff.slot === CASH_FINAL_DEST; // Naveen
  const status = isFinalDest ? 'collected' : 'in_transit';

  const result = await DB.prepare(
    `INSERT INTO cash_collections (amount, collected_by, collected_by_name, collected_at, pin_verified, status, received_by, received_by_name, received_at, notes)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).bind(
    amt, staff.slot, staff.name, now, status,
    isFinalDest ? staff.slot : null,
    isFinalDest ? staff.name : null,
    isFinalDest ? now : null,
    notes || null
  ).run();

  // Fire C1 alert if in_transit (non-blocking)
  if (!isFinalDest) {
    context.waitUntil(
      fetch('https://nawabichaihouse.com/api/wa-alerts?action=send-alert', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          alert: 'C1',
          data: {amount: amt, collector_name: staff.name, collector_slot: staff.slot, collection_id: result.meta.last_row_id}
        })
      }).catch(() => {})
    );
  }

  return json({
    success: true,
    id: result.meta.last_row_id,
    amount: amt,
    collected_by: staff.name,
    status,
    message: isFinalDest
      ? `₹${amt} collected by ${staff.name} — final.`
      : `₹${amt} collected by ${staff.name} — in transit to Naveen.`
  }, cors);
}

async function confirmReceived(context, DB, cors) {
  const body = await context.request.json();
  const {pin, collection_id} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (staff.slot !== CASH_FINAL_DEST) {
    return json({success: false, error: 'Only Naveen can confirm cash received'}, cors, 403);
  }

  const collection = await DB.prepare('SELECT * FROM cash_collections WHERE id = ?').bind(collection_id).first();
  if (!collection) return json({success: false, error: 'Collection not found'}, cors, 404);
  if (collection.status === 'collected') return json({success: false, error: 'Already confirmed'}, cors, 400);

  const now = new Date().toISOString();
  await DB.prepare(
    `UPDATE cash_collections SET status = 'collected', received_by = ?, received_by_name = ?, received_at = ? WHERE id = ?`
  ).bind(staff.slot, staff.name, now, collection_id).run();

  // Fire C2 alert — notify collector that Naveen confirmed (non-blocking)
  context.waitUntil(
    fetch('https://nawabichaihouse.com/api/wa-alerts?action=send-alert', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        alert: 'C2',
        data: {amount: collection.amount, collector_slot: collection.collected_by, collector_name: collection.collected_by_name, collection_id}
      })
    }).catch(() => {})
  );

  return json({
    success: true,
    message: `₹${collection.amount} from ${collection.collected_by_name} confirmed received by Naveen`
  }, cors);
}

async function getCollections(url, DB, cors) {
  const pin = url.searchParams.get('pin');
  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);

  const todayIST = getTodayIST();
  const rows = await DB.prepare(
    `SELECT * FROM cash_collections WHERE collected_at >= ? ORDER BY collected_at DESC`
  ).bind(todayIST).all();

  const inTransit = rows.results.filter(r => r.status === 'in_transit');
  const collected = rows.results.filter(r => r.status === 'collected');
  const totalCollected = collected.reduce((sum, r) => sum + r.amount, 0);
  const totalInTransit = inTransit.reduce((sum, r) => sum + r.amount, 0);

  return json({
    success: true,
    collections: rows.results,
    in_transit: inTransit,
    total_collected: totalCollected,
    total_in_transit: totalInTransit
  }, cors);
}

// GAP 2 FIX: Resolve UPI discrepancies from the UI
async function resolveDiscrepancy(context, DB, cors) {
  const body = await context.request.json();
  const {pin, discrepancy_id, resolution} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CAN_FIX_ERRORS.has(staff.role)) return json({success: false, error: 'Only cashier/admin/GM can resolve discrepancies'}, cors, 403);

  if (!discrepancy_id) return json({success: false, error: 'discrepancy_id required'}, cors, 400);
  if (!resolution) return json({success: false, error: 'resolution required (investigated, cross_qr, false_alarm, adjusted)'}, cors, 400);

  const disc = await DB.prepare('SELECT * FROM payment_discrepancies WHERE id = ?').bind(discrepancy_id).first();
  if (!disc) return json({success: false, error: 'Discrepancy not found'}, cors, 404);
  if (disc.status !== 'pending') return json({success: false, error: `Already ${disc.status}`}, cors, 400);

  const validResolutions = new Set(['investigated', 'cross_qr', 'false_alarm', 'adjusted']);
  if (!validResolutions.has(resolution)) return json({success: false, error: 'Invalid resolution type'}, cors, 400);

  const note = body.note || '';
  await DB.batch([
    DB.prepare(`UPDATE payment_discrepancies SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now'), resolution_action = ? WHERE id = ?`)
      .bind(staff.slot, `${resolution}: ${note}`, discrepancy_id),
    DB.prepare(`INSERT INTO rectification_log (ref_type, ref_id, action_type, before_state, after_state, impact_description, performed_by, performed_by_name, pin_verified, performed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`)
      .bind('payment_discrepancy', discrepancy_id, 'resolve_discrepancy', 'pending', 'resolved',
        `${disc.expected_entity} ${disc.disc_type} ₹${disc.amount} resolved as ${resolution}. ${note}`,
        staff.slot, staff.name)
  ]);

  return json({success: true, resolution, discrepancy_id}, cors);
}

// GAP 5 FIX: Create cross-QR tags when customer pays wrong QR
async function createCrossQrTag(context, DB, cors) {
  const body = await context.request.json();
  const {pin, amount, source_entity, dest_entity, note} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CAN_FIX_ERRORS.has(staff.role)) return json({success: false, error: 'Only cashier/admin/GM can create cross-QR tags'}, cors, 403);

  if (!amount || amount <= 0) return json({success: false, error: 'amount required (positive number)'}, cors, 400);
  if (!source_entity) return json({success: false, error: 'source_entity required (COUNTER, RUNNER_COUNTER, RUN001-RUN005)'}, cors, 400);
  if (!dest_entity) return json({success: false, error: 'dest_entity required (COUNTER, RUNNER_COUNTER, RUN001-RUN005)'}, cors, 400);
  if (source_entity === dest_entity) return json({success: false, error: 'source and dest cannot be the same'}, cors, 400);

  const validEntities = new Set(['COUNTER', 'RUNNER_COUNTER', 'RUN001', 'RUN002', 'RUN003', 'RUN004', 'RUN005']);
  if (!validEntities.has(source_entity)) return json({success: false, error: `Invalid source_entity: ${source_entity}`}, cors, 400);
  if (!validEntities.has(dest_entity)) return json({success: false, error: `Invalid dest_entity: ${dest_entity}`}, cors, 400);

  // Determine dest runner slot (if applicable)
  const destRunnerSlot = dest_entity.startsWith('RUN') ? dest_entity : null;

  // Verify source QR has excess (from latest snapshot)
  try {
    const snap = await DB.prepare(
      `SELECT razorpay_total, pos_upi_total, excess FROM upi_qr_snapshots WHERE qr_entity_code = ? ORDER BY snapshot_time DESC LIMIT 1`
    ).bind(source_entity).first();

    if (snap && snap.excess < amount) {
      return json({
        success: false,
        error: `Source ${source_entity} only has ₹${Math.round(snap.excess)} excess. Cannot tag ₹${amount}.`,
        available_excess: snap.excess
      }, cors, 400);
    }
  } catch (e) { /* snapshot table may not exist — proceed without verification */ }

  // Create the tag
  const impactDesc = `₹${amount} from ${source_entity} QR → ${dest_entity}. ${destRunnerSlot ? destRunnerSlot + ' cashToCollect ↓ ₹' + amount : 'Counter excess ↓ ₹' + amount}`;

  await DB.batch([
    DB.prepare(`INSERT INTO cross_qr_tags (amount, source_qr, source_entity, dest_entity, dest_runner_slot, source_excess_at_tag, tagged_by, tagged_by_name, pin_verified, impact, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending')`)
      .bind(amount, source_entity, source_entity, dest_entity, destRunnerSlot, amount, staff.slot, staff.name, impactDesc),
    DB.prepare(`INSERT INTO rectification_log (ref_type, ref_id, action_type, before_state, after_state, impact_description, performed_by, performed_by_name, pin_verified, performed_at) VALUES ('cross_qr_tag', 0, 'tag_cross_qr', 'none', 'pending', ?, ?, ?, 1, datetime('now'))`)
      .bind(impactDesc, staff.slot, staff.name)
  ]);

  // If there's a matching pending discrepancy on the source, resolve it
  try {
    await DB.prepare(
      `UPDATE payment_discrepancies SET status = 'tagged', resolved_by = ?, resolved_at = datetime('now'), resolution_action = ? WHERE status = 'pending' AND expected_entity = ? AND disc_type = 'excess' AND amount <= ?`
    ).bind(staff.slot, `cross-qr-tag to ${dest_entity}: ₹${amount}. ${note || ''}`, source_entity, amount * 1.5).run();
  } catch (e) { /* non-critical */ }

  return json({success: true, tag: {amount, source_entity, dest_entity, impact: impactDesc}}, cors);
}

function verifyPin(pin) {
  if (!pin || !STAFF_BY_PIN[pin]) return null;
  return STAFF_BY_PIN[pin];
}

function getTodayIST() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10) + 'T00:00:00';
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: cors});
}
