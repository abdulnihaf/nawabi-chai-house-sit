// Rectify API — fix validation errors, record counter expenses, check settlement readiness

const STAFF_SLOTS = {
  'CASH001': { role: 'cashier', person: 'Kismat', pin: '7115' },
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
  'ADMIN003':{ role: 'admin', person: 'Yashwant', pin: '3697' }
};

const STAFF_BY_PIN = {};
for (const [slot, info] of Object.entries(STAFF_SLOTS)) {
  STAFF_BY_PIN[info.pin] = { name: info.person, role: info.role, slot, partner_id: info.partner_id || null };
}

const CAN_FIX_ERRORS = new Set(['cashier', 'admin', 'gm']);
const CAN_RECORD_EXPENSE = new Set(['cashier', 'admin', 'gm']);
const VALID_FIX_ACTIONS = new Set(['assign_runner', 'change_method', 'dismiss']);

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
      default: return json({success: false, error: `Unknown action: ${action}`}, cors, 400);
    }
  } catch (e) {
    return json({success: false, error: e.message}, cors, 500);
  }
}

async function fixError(context, DB, cors) {
  const body = await context.request.json();
  const {pin, error_id, fix_action, fix_data} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CAN_FIX_ERRORS.has(staff.role)) return json({success: false, error: 'Only cashier or admin can fix errors'}, cors, 403);
  if (!VALID_FIX_ACTIONS.has(fix_action)) return json({success: false, error: `Invalid fix_action: ${fix_action}`}, cors, 400);

  const err = await DB.prepare('SELECT * FROM validation_errors WHERE id = ?').bind(error_id).first();
  if (!err) return json({success: false, error: 'Error not found'}, cors, 404);
  if (err.status !== 'pending') return json({success: false, error: `Error already ${err.status}`}, cors, 400);

  const now = new Date().toISOString();
  const beforeState = err.status;
  let impactDesc = '';

  if (fix_action === 'assign_runner') {
    const data = typeof fix_data === 'string' ? JSON.parse(fix_data) : fix_data;
    const runnerSlot = data?.runner_slot;
    if (!runnerSlot || !STAFF_SLOTS[runnerSlot] || STAFF_SLOTS[runnerSlot].role !== 'runner') {
      return json({success: false, error: 'Invalid runner_slot'}, cors, 400);
    }
    impactDesc = `Assigned to ${runnerSlot} (${STAFF_SLOTS[runnerSlot].person})`;
  } else if (fix_action === 'change_method') {
    const data = typeof fix_data === 'string' ? JSON.parse(fix_data) : fix_data;
    impactDesc = `Changed payment method: ${JSON.stringify(data)}`;
  } else if (fix_action === 'dismiss') {
    const data = typeof fix_data === 'string' ? JSON.parse(fix_data) : (fix_data || {});
    impactDesc = `Dismissed: ${data.reason || 'no reason provided'}`;
  }

  await DB.batch([
    DB.prepare(`UPDATE validation_errors SET status = 'rectified', rectified_by = ?, rectified_at = ?, rectification_action = ? WHERE id = ?`)
      .bind(staff.slot, now, fix_action, error_id),
    DB.prepare(`INSERT INTO rectification_log (ref_type, ref_id, action_type, before_state, after_state, impact_description, performed_by, performed_by_name, pin_verified, performed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind('validation_error', error_id, fix_action, beforeState, 'rectified', impactDesc, staff.slot, staff.name, now)
  ]);

  const updated = await DB.prepare('SELECT * FROM validation_errors WHERE id = ?').bind(error_id).first();
  return json({success: true, error: updated}, cors);
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
const CAN_FUND_PETTY = new Set(['admin', 'gm', 'manager']); // Only these can add funds

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

  // Check balance
  const bal = await DB.prepare('SELECT current_balance FROM petty_cash_balance WHERE id = 1').first();
  if (bal && amt > bal.current_balance) {
    return json({success: false, error: `Insufficient petty cash. Balance: ₹${bal.current_balance}`}, cors, 400);
  }

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
  return json({success: true, amount: amt, category: category.name, balance: newBal?.current_balance || 0}, cors);
}

async function pettyFund(context, DB, cors) {
  const body = await context.request.json();
  const {pin, amount, description} = body;

  const staff = verifyPin(pin);
  if (!staff) return json({success: false, error: 'Invalid PIN'}, cors, 401);
  if (!CAN_FUND_PETTY.has(staff.role)) {
    return json({success: false, error: 'Only GM/Manager/Admin can fund petty cash'}, cors, 403);
  }

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return json({success: false, error: 'Invalid amount'}, cors, 400);

  const now = new Date().toISOString();
  await DB.batch([
    DB.prepare(
      `INSERT INTO petty_cash (transaction_type, amount, description, recorded_by, recorded_by_name, pin_verified, recorded_at)
       VALUES ('fund_add', ?, ?, ?, ?, 1, ?)`
    ).bind(amt, description || 'Petty cash funded', staff.slot, staff.name, now),
    DB.prepare(
      `UPDATE petty_cash_balance SET current_balance = current_balance + ?, last_funded_at = ?, last_funded_by = ?, last_funded_amount = ? WHERE id = 1`
    ).bind(amt, now, staff.name, amt)
  ]);

  const newBal = await DB.prepare('SELECT current_balance FROM petty_cash_balance WHERE id = 1').first();
  return json({success: true, amount: amt, balance: newBal?.current_balance || 0}, cors);
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

  return json({
    success: true,
    balance: bal?.current_balance || 0,
    last_funded_by: bal?.last_funded_by,
    last_funded_amount: bal?.last_funded_amount,
    transactions: txns.results,
    today_expenses: todayTotal
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
