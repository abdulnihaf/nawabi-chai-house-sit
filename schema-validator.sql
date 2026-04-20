-- Schema for NCH Validation & Rectification System
-- Run on D1: wrangler d1 execute nawabi-chai-house --file=schema-validator.sql
-- 7 staff in flow: 2 cashiers (Hafees, Kismat) + 5 runners (Farzaib, Ritiqu, Anshu, Shabeer, Dhanush)

-- ============================================================
-- REGISTRY TABLES (Layer 0 — the valid set)
-- ============================================================

-- Product registry with flow flags
CREATE TABLE IF NOT EXISTS v_products (
    odoo_id INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,           -- BEV | HLM | SNK | WTR | PKG
    token_issuable INTEGER DEFAULT 0, -- 1 = can use Token Issue (M4)
    runner_ledgerable INTEGER DEFAULT 0, -- 1 = can use Runner Ledger (M5)
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Runner slot registry (slot = permanent container, person rotates)
CREATE TABLE IF NOT EXISTS v_runner_slots (
    slot_code TEXT PRIMARY KEY,       -- RUN001, RUN002, etc.
    partner_id INTEGER NOT NULL,      -- Odoo res.partner ID
    qr_code_id TEXT,                  -- Razorpay QR ID for this runner
    barcode TEXT,
    current_person TEXT,              -- Name of person assigned this shift
    active INTEGER DEFAULT 1,         -- Active this shift
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Staff slot registry (slot = permanent container, person rotates)
-- All roles: cashier, runner, gm, supervisor, admin
-- Horizontally expandable — add CASH003, RUN006 etc. anytime
CREATE TABLE IF NOT EXISTS v_staff_slots (
    slot_code TEXT PRIMARY KEY,       -- CASH001, CASH002, RUN001-005, GM001, SUP001, MGR001, ADMIN001
    role TEXT NOT NULL,               -- cashier | runner | gm | supervisor | manager | admin
    current_person TEXT,              -- Name of person currently in this slot
    phone TEXT,                       -- WhatsApp number with country code
    pin TEXT,                         -- 4-digit PIN for app login
    odoo_uid INTEGER,                 -- Odoo user ID (for cashiers)
    partner_id INTEGER,              -- Odoo partner ID (for runners)
    qr_code_id TEXT,                 -- Razorpay QR ID (for runners)
    barcode TEXT,                    -- POS barcode (for runners)
    active INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- POS config registry
CREATE TABLE IF NOT EXISTS v_pos_configs (
    config_id INTEGER PRIMARY KEY,    -- Odoo pos.config ID
    code TEXT NOT NULL,               -- W1, W2
    name TEXT NOT NULL,
    qr_code_id TEXT,                  -- Razorpay QR ID for this counter
    active INTEGER DEFAULT 1
);

-- ============================================================
-- VALID TUPLES (Layer 0 — exhaustive truth tables)
-- ============================================================

-- All 15 valid (M, W, R) combinations. Anything not here = invalid_tuple.
CREATE TABLE IF NOT EXISTS v_valid_mwr (
    tuple_code TEXT PRIMARY KEY,      -- T01, T02, ... T15
    method_id INTEGER NOT NULL,       -- Payment method ID
    pos_config_id INTEGER NOT NULL,   -- POS config ID
    runner_partner_id INTEGER NOT NULL, -- 0 = no runner
    description TEXT NOT NULL,
    UNIQUE(method_id, pos_config_id, runner_partner_id)
);

-- All valid (P, M) combinations. Anything not here = invalid_product_method.
CREATE TABLE IF NOT EXISTS v_valid_pm (
    product_id INTEGER NOT NULL,
    method_id INTEGER NOT NULL,
    PRIMARY KEY (product_id, method_id)
);

-- ============================================================
-- ERROR TYPE REGISTRY — every possible error defined
-- ============================================================

CREATE TABLE IF NOT EXISTS v_error_types (
    code TEXT PRIMARY KEY,
    source TEXT NOT NULL,             -- cashier | customer | system
    category TEXT NOT NULL,           -- tuple | product_method | cross_qr | upi_mismatch | partner
    description TEXT NOT NULL,
    detection_method TEXT NOT NULL,   -- how system detects this
    verification TEXT,                -- what must be verified before rectification
    rectification_action TEXT NOT NULL, -- what data changes
    impact TEXT NOT NULL,             -- what settlement numbers change
    responsible_role TEXT NOT NULL,   -- who must fix: cashier | runner | both
    severity TEXT DEFAULT 'blocking'  -- blocking (must fix before settle) | warning
);

-- ============================================================
-- ERROR TRACKING (Layer 1 — tuple + P×M validation)
-- ============================================================

-- Validation errors — invalid (P,M,W,R,C) tuples detected
CREATE TABLE IF NOT EXISTS validation_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    order_ref TEXT,
    error_code TEXT NOT NULL,         -- references v_error_types.code
    description TEXT,                 -- Human-readable explanation
    pos_config_id INTEGER,
    pos_config_name TEXT,
    payment_method_id INTEGER,
    payment_method_name TEXT,
    odoo_payment_id INTEGER,        -- Odoo pos.payment record ID (needed for change_method fix)
    runner_partner_id INTEGER,
    runner_slot TEXT,
    product_ids TEXT,                 -- JSON array
    product_names TEXT,               -- JSON array
    cashier_uid INTEGER,
    cashier_name TEXT,
    order_amount REAL,
    order_time TEXT,
    detected_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'pending',    -- pending | rectified | dismissed | deducted
    assigned_to TEXT,                 -- staff_id who should fix this
    assigned_role TEXT,               -- runner | cashier
    rectified_by TEXT,
    rectified_at TEXT,
    rectification_action TEXT,        -- JSON: what was changed
    notified INTEGER DEFAULT 0,       -- 1 = notification sent
    UNIQUE(order_id, error_code)
);

-- ============================================================
-- UPI CROSS-QR TRACKING (Layer 2 — Razorpay verification)
-- ============================================================

-- QR entity registry — maps every QR to its owner
CREATE TABLE IF NOT EXISTS v_qr_entities (
    qr_code_id TEXT PRIMARY KEY,      -- Razorpay QR ID
    entity_type TEXT NOT NULL,        -- counter | runner_counter | runner
    entity_code TEXT NOT NULL,        -- W1 | W2 | RUN001 | RUN002 etc.
    entity_name TEXT NOT NULL
);

-- UPI snapshot per QR — computed at each check interval
-- razorpay_total = actual money received on this QR (from Razorpay API)
-- pos_upi_total = sum of UPI orders mapped to this entity in POS
-- excess = razorpay_total - pos_upi_total (positive = more received than expected)
CREATE TABLE IF NOT EXISTS upi_qr_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_entity_code TEXT NOT NULL,     -- W1 | W2 | RUN001 etc.
    snapshot_time TEXT NOT NULL,
    razorpay_total REAL DEFAULT 0,    -- actual UPI received on this QR
    pos_upi_total REAL DEFAULT 0,     -- POS orders mapped to UPI for this entity
    excess REAL DEFAULT 0,            -- razorpay - pos (>0 means extra payment landed here)
    deficit REAL DEFAULT 0,           -- pos - razorpay (>0 means expected payment missing)
    tagged_out REAL DEFAULT 0,        -- already tagged/transferred to other entities
    tagged_in REAL DEFAULT 0,         -- received tags from other entities
    net_excess REAL DEFAULT 0,        -- excess - tagged_out + tagged_in
    order_count INTEGER DEFAULT 0,    -- number of UPI orders in POS
    razorpay_count INTEGER DEFAULT 0, -- number of Razorpay payments
    UNIQUE(qr_entity_code, snapshot_time)
);

-- Cross-QR tags — when customer pays to wrong QR
-- Only creatable when source QR has verified excess >= amount
CREATE TABLE IF NOT EXISTS cross_qr_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_time TEXT DEFAULT (datetime('now')),
    amount REAL NOT NULL,
    -- Source: where the money actually landed
    source_qr TEXT NOT NULL,          -- QR code ID
    source_entity TEXT NOT NULL,      -- W1 | W2 | RUN001 etc.
    -- Destination: where the money should have gone
    dest_entity TEXT NOT NULL,        -- RUN001 | W1 etc.
    dest_runner_slot TEXT,            -- if dest is a runner
    -- Razorpay verification
    razorpay_payment_id TEXT,         -- specific Razorpay payment if identifiable
    source_excess_at_tag REAL NOT NULL, -- excess on source QR at time of tagging (must be >= amount)
    -- Order linkage (optional — may not know exact order)
    order_id INTEGER,
    order_ref TEXT,
    -- Who and verification
    tagged_by TEXT NOT NULL,          -- cashier staff_id
    tagged_by_name TEXT,
    pin_verified INTEGER DEFAULT 0,
    -- Status
    status TEXT DEFAULT 'pending',    -- pending | applied_to_settlement | reversed
    applied_at TEXT,
    applied_to_settlement_id INTEGER,
    -- Impact description
    impact TEXT                        -- "₹40 from Cash Counter QR → RUN003. RUN003 cashToCollect ↓ ₹40"
);

-- Payment discrepancies — UPI verification failures
CREATE TABLE IF NOT EXISTS payment_discrepancies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    order_ref TEXT,
    disc_type TEXT NOT NULL,          -- upi_not_received | cross_qr_excess | unmatched_rzp | deficit
    amount REAL,
    expected_qr TEXT,                 -- Which QR should have received it
    expected_entity TEXT,             -- W1 | W2 | RUN001 etc.
    actual_qr TEXT,                   -- Where it actually landed (if known)
    actual_entity TEXT,
    razorpay_payment_id TEXT,
    order_time TEXT,
    detected_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'pending',    -- pending | resolved | tagged | deducted
    assigned_to TEXT,                 -- staff_id
    assigned_role TEXT,               -- runner | cashier
    resolved_by TEXT,
    resolved_at TEXT,
    resolution_action TEXT,           -- JSON: what was done
    cross_qr_tag_id INTEGER,         -- links to cross_qr_tags if resolved via tagging
    notified INTEGER DEFAULT 0,
    UNIQUE(order_id, disc_type)
);

-- ============================================================
-- RECTIFICATION LOG (Layer 3 — permanent audit trail)
-- ============================================================

CREATE TABLE IF NOT EXISTS rectification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_type TEXT NOT NULL,           -- validation_error | payment_discrepancy | cross_qr_tag
    ref_id INTEGER NOT NULL,          -- ID in the source table
    action_type TEXT NOT NULL,        -- assign_runner | remove_runner | reassign_runner | change_method | tag_cross_qr | deduct | dismiss
    before_state TEXT,                -- JSON snapshot
    after_state TEXT,                 -- JSON snapshot
    impact_description TEXT,          -- "RUN003 cashToCollect ↑ ₹80 (Token Issue assigned)"
    settlement_impact TEXT,           -- JSON: { runner_slot, amount_delta, field_changed }
    performed_by TEXT NOT NULL,       -- staff_id
    performed_by_name TEXT,
    pin_verified INTEGER DEFAULT 0,
    performed_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- SETTLEMENT (Layer 4 — the final step)
-- ============================================================

-- Runner settlement records
CREATE TABLE IF NOT EXISTS runner_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runner_slot TEXT NOT NULL,         -- RUN001 etc.
    runner_name TEXT NOT NULL,
    settlement_time TEXT DEFAULT (datetime('now')),
    -- Calculated totals (after all rectifications applied)
    token_issue_total REAL DEFAULT 0, -- sum of Token Issue orders for this runner
    runner_ledger_total REAL DEFAULT 0, -- sum of Runner Ledger orders
    runner_upi_total REAL DEFAULT 0,  -- verified UPI on runner's QR
    cross_qr_in REAL DEFAULT 0,       -- tagged IN from other QRs (reduces cash to collect)
    cross_qr_out REAL DEFAULT 0,      -- tagged OUT to other entities (increases cash to collect)
    -- The formula
    cash_to_collect REAL DEFAULT 0,   -- (token + ledger) - runner_upi - cross_qr_in + cross_qr_out
    cash_collected REAL DEFAULT 0,    -- actual cash handed over
    shortage REAL DEFAULT 0,          -- cash_to_collect - cash_collected
    -- Pre-settlement checks
    errors_at_settlement INTEGER DEFAULT 0, -- must be 0 to settle
    errors_rectified INTEGER DEFAULT 0,
    razorpay_verified INTEGER DEFAULT 0, -- 1 = Razorpay totals matched
    -- Who settled
    settled_by TEXT,                   -- cashier or admin staff_id
    settled_by_name TEXT,
    pin_verified INTEGER DEFAULT 0,
    -- Shortage resolution
    shortage_status TEXT,              -- null | acknowledged | deducted
    shortage_assigned_to TEXT,         -- who pays the shortage
    shortage_deducted_from TEXT,       -- runner | cashier | split
    deduction_note TEXT
);

-- ============================================================
-- EXPENSE CONTROL (two separate cash pools)
-- ============================================================

-- Allowed expense categories from counter cash (RESTRICTED)
-- Cashier can ONLY pick from this list. No free text.
CREATE TABLE IF NOT EXISTS v_expense_categories (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pool TEXT NOT NULL,               -- counter | petty
    requires_approval INTEGER DEFAULT 0, -- 1 = needs admin/GM approval before recording
    max_amount REAL,                  -- max single expense (null = no limit)
    active INTEGER DEFAULT 1
);

-- Counter expenses — restricted to defined categories only
CREATE TABLE IF NOT EXISTS counter_expenses_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_code TEXT NOT NULL,       -- references v_expense_categories.code
    amount REAL NOT NULL,
    description TEXT,                  -- optional brief note (NOT free-text reason)
    recorded_by TEXT NOT NULL,         -- cashier staff_id
    recorded_by_name TEXT,
    pin_verified INTEGER DEFAULT 0,
    approved_by TEXT,                  -- admin/GM staff_id if approval required
    approved_at TEXT,
    recorded_at TEXT DEFAULT (datetime('now')),
    shift_id TEXT,                     -- links to which shift this belongs to
    FOREIGN KEY (category_code) REFERENCES v_expense_categories(code)
);

-- Petty cash — separate fund, separate tracking
CREATE TABLE IF NOT EXISTS petty_cash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_type TEXT NOT NULL,    -- fund_add | expense | return
    amount REAL NOT NULL,
    category_code TEXT,                -- references v_expense_categories.code (for expenses)
    description TEXT NOT NULL,
    recorded_by TEXT NOT NULL,
    recorded_by_name TEXT,
    pin_verified INTEGER DEFAULT 0,
    recorded_at TEXT DEFAULT (datetime('now')),
    receipt_photo TEXT                 -- base64 encoded photo (max ~500KB)
);

-- Petty cash balance view helper
CREATE TABLE IF NOT EXISTS petty_cash_balance (
    id INTEGER PRIMARY KEY DEFAULT 1,
    current_balance REAL DEFAULT 0,
    last_funded_at TEXT,
    last_funded_by TEXT,
    last_funded_amount REAL
);

-- ============================================================
-- RUNNER NOTIFICATIONS (WhatsApp tracking)
-- ============================================================

CREATE TABLE IF NOT EXISTS runner_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runner_slot TEXT NOT NULL,
    notification_type TEXT NOT NULL,   -- token_issued | ledger_batch | error_alert | settlement_ready
    order_id INTEGER,                 -- for token_issued
    message_content TEXT NOT NULL,     -- actual message sent
    whatsapp_message_id TEXT,         -- WABA message ID for delivery tracking
    sent_at TEXT DEFAULT (datetime('now')),
    delivered INTEGER DEFAULT 0,
    read_at TEXT
);

-- ============================================================
-- VALIDATOR STATE (tracks polling position)
-- ============================================================

CREATE TABLE IF NOT EXISTS validator_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- CASH COLLECTIONS MIGRATION (adds new columns to existing table from schema.sql)
-- ============================================================

-- Add new columns to cash_collections if they don't exist (safe to re-run)
-- These columns support the new rectify.js collect-cash flow
ALTER TABLE cash_collections ADD COLUMN collected_by_name TEXT;
ALTER TABLE cash_collections ADD COLUMN pin_verified INTEGER DEFAULT 0;
ALTER TABLE cash_collections ADD COLUMN status TEXT DEFAULT 'collected';
ALTER TABLE cash_collections ADD COLUMN received_by TEXT;
ALTER TABLE cash_collections ADD COLUMN received_by_name TEXT;
ALTER TABLE cash_collections ADD COLUMN received_at TEXT;

-- ============================================================
-- SEED DATA
-- ============================================================

-- Products (from Odoo production)
INSERT OR REPLACE INTO v_products (odoo_id, code, name, category, token_issuable, runner_ledgerable) VALUES
    (1028, 'NCH-IC', 'Irani Chai', 'BEV', 1, 0),
    (1102, 'NCH-NSC', 'Nawabi Special Coffee', 'BEV', 1, 0),
    (1103, 'NCH-LT', 'Lemon Tea', 'BEV', 1, 0),
    (1395, 'NCH-HQ', 'Haleem Quarter 250g', 'HLM', 1, 0),
    (1396, 'NCH-HH', 'Haleem Half 500g', 'HLM', 1, 0),
    (1397, 'NCH-HF', 'Haleem Full 750g', 'HLM', 1, 0),
    (1398, 'NCH-HFP', 'Haleem Family 1.5kg', 'HLM', 1, 0),
    (1400, 'NCH-HM', 'Haleem Mutton 300g', 'HLM', 1, 0),
    (1029, 'NCH-BMS', 'Bun Maska', 'SNK', 0, 1),
    (1030, 'NCH-OB', 'Osmania Biscuit', 'SNK', 0, 1),
    (1031, 'NCH-CC', 'Chicken Cutlet', 'SNK', 0, 1),
    (1033, 'NCH-OB3', 'Osmania Biscuit x3', 'SNK', 0, 1),
    (1115, 'NCH-PS', 'Pyaaz Samosa', 'SNK', 0, 1),
    (1117, 'NCH-CB', 'Cheese Balls', 'SNK', 0, 1),
    (1118, 'NCH-MB', 'Malai Bun', 'SNK', 0, 1),
    (1392, 'NCH-CMR', 'Chicken Roll', 'SNK', 0, 1),
    (1394, 'NCH-FAJ', 'Chicken Fajita', 'SNK', 0, 1),
    (1094, 'NCH-WTR', 'Water', 'WTR', 0, 1),
    (1111, 'NCH-OBBOX', 'Niloufer Osmania 500g', 'PKG', 0, 1),
    (1401, 'NCH-DCC75', 'Niloufer Chocochip 75g', 'PKG', 0, 1),
    (1402, 'NCH-FB100', 'Niloufer Fruit 100g', 'PKG', 0, 1),
    (1403, 'NCH-FB200', 'Niloufer Fruit 200g', 'PKG', 0, 1),
    (1423, 'NCH-OB100', 'Niloufer Osmania 100g', 'PKG', 0, 1);

-- Runner slots (kept for backward compatibility with v_valid_mwr partner_id references)
INSERT OR REPLACE INTO v_runner_slots (slot_code, partner_id, current_person, active) VALUES
    ('RUN001', 64, 'Farzaib', 1),
    ('RUN002', 65, 'Ritiqu', 1),
    ('RUN003', 66, 'Anshu', 1),
    ('RUN004', 67, 'Shabeer', 1),
    ('RUN005', 68, 'Dhanush', 1);

-- Staff slots — the master registry. Slot is permanent, person rotates.
-- Tomorrow if Nafees leaves, just update CASH001.current_person + phone + pin
INSERT OR REPLACE INTO v_staff_slots (slot_code, role, current_person, phone, pin, odoo_uid, partner_id, qr_code_id, barcode) VALUES
    -- Cashiers
    ('CASH001', 'cashier', 'Kesmat',   '918637895699',  '7115', NULL, NULL, NULL, NULL),
    ('CASH002', 'cashier', 'Nafees',   '919019627629',  '8241', NULL, NULL, NULL, NULL),
    -- Runners (mirror v_runner_slots but with phone + pin)
    ('RUN001',  'runner',  'Farzaib',  NULL,             '3678', NULL, 64, NULL, NULL),
    ('RUN002',  'runner',  'Ritiqu',   '919181204403',   '4421', NULL, 65, NULL, NULL),
    ('RUN003',  'runner',  'Anshu',    '919181204403',   '5503', NULL, 66, NULL, NULL),
    ('RUN004',  'runner',  'Shabeer',  NULL,             '6604', NULL, 67, NULL, NULL),
    ('RUN005',  'runner',  'Dhanush',  NULL,             '7705', NULL, 68, NULL, NULL),
    -- GM
    ('GM001',   'gm',      'Basheer',  '919061906916',  '8523', NULL, NULL, NULL, NULL),
    -- Supervisor
    ('SUP001',  'supervisor','Waseem', '919108414951',   '1234', NULL, NULL, NULL, NULL),
    -- Manager
    ('MGR001',  'manager', 'Tanveer',  '919916399474',  '6890', NULL, NULL, NULL, NULL),
    -- Admin
    ('ADMIN001','admin',   'Nihaf',    NULL,             '0305', NULL, NULL, NULL, NULL),
    ('ADMIN002','admin',   'Naveen',   NULL,             '3754', NULL, NULL, NULL, NULL),
    ('ADMIN003','admin',   'Yashwant', NULL,             '3697', NULL, NULL, NULL, NULL);

-- POS configs
INSERT OR REPLACE INTO v_pos_configs (config_id, code, name, active) VALUES
    (27, 'W1', 'Cash Counter', 1),
    (28, 'W2', 'Runner Counter', 1);

-- ============================================================
-- SEED: ALL 15 VALID (M, W, R) TUPLES
-- ============================================================

INSERT OR REPLACE INTO v_valid_mwr (tuple_code, method_id, pos_config_id, runner_partner_id, description) VALUES
    -- Counter sales: no runner, Cash Counter
    ('T01', 37, 27, 0, 'Cash + Cash Counter + No Runner'),
    ('T02', 38, 27, 0, 'UPI + Cash Counter + No Runner'),
    ('T03', 39, 27, 0, 'Card + Cash Counter + No Runner'),
    ('T04', 49, 27, 0, 'Comp + Cash Counter + No Runner'),
    -- Token Issue: Cash Counter + specific runner
    ('T05', 48, 27, 64, 'Token Issue + Cash Counter + RUN001 (Farzaib)'),
    ('T06', 48, 27, 65, 'Token Issue + Cash Counter + RUN002 (Ritiqu)'),
    ('T07', 48, 27, 66, 'Token Issue + Cash Counter + RUN003 (Anshu)'),
    ('T08', 48, 27, 67, 'Token Issue + Cash Counter + RUN004 (Shabeer)'),
    ('T09', 48, 27, 68, 'Token Issue + Cash Counter + RUN005 (Dhanush)'),
    -- Runner Ledger: Runner Counter + specific runner
    ('T10', 40, 28, 64, 'Runner Ledger + Runner Counter + RUN001 (Farzaib)'),
    ('T11', 40, 28, 65, 'Runner Ledger + Runner Counter + RUN002 (Ritiqu)'),
    ('T12', 40, 28, 66, 'Runner Ledger + Runner Counter + RUN003 (Anshu)'),
    ('T13', 40, 28, 67, 'Runner Ledger + Runner Counter + RUN004 (Shabeer)'),
    ('T14', 40, 28, 68, 'Runner Ledger + Runner Counter + RUN005 (Dhanush)'),
    -- UPI on Runner Counter without runner (non-runner UPI sale)
    ('T15', 38, 28, 0, 'UPI + Runner Counter + No Runner');

-- ============================================================
-- SEED: ALL VALID (P, M) PAIRS — 207 total
-- Cash(37), UPI(38), Card(39), Comp(49) = all 23 products each = 92
-- Token Issue(48) = 3 BEV + 5 HLM = 8
-- Runner Ledger(40) = 9 SNK + 1 WTR + 5 PKG = 15
-- Total: 92 + 8 + 15 = 115... wait let me recount
-- 23 × 4 (Cash,UPI,Card,Comp) = 92 + 8 (Token) + 15 (Ledger) = 115
-- ============================================================

-- Cash(37): all 23
INSERT OR REPLACE INTO v_valid_pm (product_id, method_id) VALUES
    (1028,37),(1102,37),(1103,37),(1395,37),(1396,37),(1397,37),(1398,37),(1400,37),
    (1029,37),(1030,37),(1031,37),(1033,37),(1115,37),(1117,37),(1118,37),(1392,37),(1394,37),
    (1094,37),(1111,37),(1401,37),(1402,37),(1403,37),(1423,37);
-- UPI(38): all 23
INSERT OR REPLACE INTO v_valid_pm (product_id, method_id) VALUES
    (1028,38),(1102,38),(1103,38),(1395,38),(1396,38),(1397,38),(1398,38),(1400,38),
    (1029,38),(1030,38),(1031,38),(1033,38),(1115,38),(1117,38),(1118,38),(1392,38),(1394,38),
    (1094,38),(1111,38),(1401,38),(1402,38),(1403,38),(1423,38);
-- Card(39): all 23
INSERT OR REPLACE INTO v_valid_pm (product_id, method_id) VALUES
    (1028,39),(1102,39),(1103,39),(1395,39),(1396,39),(1397,39),(1398,39),(1400,39),
    (1029,39),(1030,39),(1031,39),(1033,39),(1115,39),(1117,39),(1118,39),(1392,39),(1394,39),
    (1094,39),(1111,39),(1401,39),(1402,39),(1403,39),(1423,39);
-- Comp(49): all 23
INSERT OR REPLACE INTO v_valid_pm (product_id, method_id) VALUES
    (1028,49),(1102,49),(1103,49),(1395,49),(1396,49),(1397,49),(1398,49),(1400,49),
    (1029,49),(1030,49),(1031,49),(1033,49),(1115,49),(1117,49),(1118,49),(1392,49),(1394,49),
    (1094,49),(1111,49),(1401,49),(1402,49),(1403,49),(1423,49);
-- Token Issue(48): BEV + HLM only = 8
INSERT OR REPLACE INTO v_valid_pm (product_id, method_id) VALUES
    (1028,48),(1102,48),(1103,48),
    (1395,48),(1396,48),(1397,48),(1398,48),(1400,48);
-- Runner Ledger(40): SNK + WTR + PKG only = 15
INSERT OR REPLACE INTO v_valid_pm (product_id, method_id) VALUES
    (1029,40),(1030,40),(1031,40),(1033,40),(1115,40),(1117,40),(1118,40),(1392,40),(1394,40),
    (1094,40),(1111,40),(1401,40),(1402,40),(1403,40),(1423,40);

-- ============================================================
-- SEED: ALL ERROR TYPES — exhaustive registry
-- ============================================================

INSERT OR REPLACE INTO v_error_types (code, source, category, description, detection_method, verification, rectification_action, impact, responsible_role, severity) VALUES

-- ── CASHIER ERRORS: Cash Counter (W1) ──
('C1_TOKEN_NO_RUNNER',
 'cashier', 'tuple',
 'Token Issue created without selecting a runner',
 'Tuple check: 48:27:0 not in VALID_MWR',
 'Cashier confirms which runner the token was for',
 'Assign correct runner to order (update partner_id)',
 'Runner cashToCollect increases by order amount',
 'cashier', 'blocking'),

('C2_TOKEN_WRONG_RUNNER',
 'cashier', 'tuple',
 'Token Issue created with wrong runner selected',
 'Runner reports: "this token is not mine"',
 'Both runners confirm the swap',
 'Reassign runner (change partner_id from A to B)',
 'Runner A cashToCollect decreases, Runner B increases',
 'cashier', 'blocking'),

('C3_COUNTER_METHOD_WITH_RUNNER',
 'cashier', 'tuple',
 'Cash/UPI/Card/Comp used but runner is mapped to order',
 'Tuple check: e.g. 37:27:64 not in VALID_MWR',
 'Cashier confirms: was this a runner sale or counter sale?',
 'If counter: remove runner. If runner: change to Token Issue.',
 'Remove runner: runner total decreases. Change method: counter total decreases, runner total increases.',
 'cashier', 'blocking'),

('C4_WRONG_PRODUCT_TOKEN',
 'cashier', 'product_method',
 'SNK/WTR/PKG product sold via Token Issue (should be Runner Ledger)',
 'PM check: e.g. 1029:48 not in VALID_PM',
 'None — product category is definitive',
 'Change payment method to Runner Ledger, move to Runner Counter',
 'Token Issue total decreases, Runner Ledger total increases',
 'cashier', 'blocking'),

('C5_MARKED_CASH_WAS_UPI',
 'cashier', 'upi_mismatch',
 'Order marked as Cash but customer actually paid UPI (counter QR)',
 'Razorpay shows unmatched payment on counter QR',
 'Counter QR excess verified via Razorpay',
 'Change payment method from Cash to UPI',
 'Counter cash total decreases, counter UPI total increases',
 'cashier', 'blocking'),

('C6_MARKED_UPI_WAS_CASH',
 'cashier', 'upi_mismatch',
 'Order marked as UPI but no matching Razorpay payment found',
 'Counter QR has deficit (POS UPI > Razorpay total)',
 'Razorpay confirms no payment for this amount at this time',
 'Change payment method from UPI to Cash',
 'Counter UPI total decreases, counter cash total increases',
 'cashier', 'blocking'),

-- ── CASHIER ERRORS: Runner Counter (W2) ──
('C7_LEDGER_NO_RUNNER',
 'cashier', 'tuple',
 'Runner Ledger used without selecting a runner',
 'Tuple check: 40:28:0 not in VALID_MWR',
 'Cashier confirms which runner sold this',
 'Assign correct runner to order',
 'Runner cashToCollect increases',
 'cashier', 'blocking'),

('C8_LEDGER_WRONG_RUNNER',
 'cashier', 'tuple',
 'Runner Ledger created with wrong runner selected',
 'Runner reports: "I did not sell this"',
 'Both runners confirm',
 'Reassign runner (change partner_id)',
 'Runner A cashToCollect decreases, Runner B increases',
 'cashier', 'blocking'),

('C9_WRONG_PRODUCT_LEDGER',
 'cashier', 'product_method',
 'BEV/HLM product sold via Runner Ledger (should be Token Issue)',
 'PM check: e.g. 1028:40 not in VALID_PM',
 'None — product category is definitive',
 'Change to Token Issue on Cash Counter',
 'Runner Ledger total decreases, Token Issue total increases',
 'cashier', 'blocking'),

('C10_RUNNER_COUNTER_UPI_SHOULD_BE_LEDGER',
 'cashier', 'tuple',
 'UPI on Runner Counter but this was actually a runner sale (should be Runner Ledger)',
 'Runner reports: "I sold this, it should be on my ledger"',
 'Runner confirms sale was his',
 'Change method to Runner Ledger + assign runner',
 'Runner Counter UPI decreases, Runner Ledger increases, runner cashToCollect increases',
 'cashier', 'blocking'),

-- ── CASHIER ERROR: Invalid partner ──
('C11_INVALID_PARTNER',
 'cashier', 'partner',
 'Non-runner partner selected on Token Issue or Runner Ledger',
 'Partner ID not in valid runner set (64-68)',
 'None — partner registry is definitive',
 'Change partner to correct runner',
 'Correct runner cashToCollect increases',
 'cashier', 'blocking'),

-- ── CUSTOMER ERRORS: Cross-QR payments ──
('Q1_PAID_COUNTER_QR_FOR_RUNNER',
 'customer', 'cross_qr',
 'Customer paid to Cash Counter QR instead of runner QR',
 'Counter QR excess detected via Razorpay + runner reports missing UPI',
 'Counter QR excess >= claimed amount (Razorpay verified)',
 'Tag excess from counter QR to runner via cross_qr_tags',
 'Runner cashToCollect decreases (UPI already at counter). Counter excess decreases.',
 'cashier', 'blocking'),

('Q2_PAID_RUNNERCOUNTER_QR_FOR_RUNNER',
 'customer', 'cross_qr',
 'Customer paid to Runner Counter QR instead of specific runner QR',
 'Runner Counter QR excess + runner reports missing UPI',
 'Runner Counter QR excess >= claimed amount',
 'Tag excess from runner counter QR to runner',
 'Runner cashToCollect decreases. Runner Counter excess decreases.',
 'cashier', 'blocking'),

('Q3_PAID_WRONG_RUNNER_QR',
 'customer', 'cross_qr',
 'Customer paid to Runner B QR but order belongs to Runner A',
 'Runner A reports, Runner B QR has excess',
 'Runner B QR excess >= claimed amount',
 'Tag from Runner B QR to Runner A. Runners settle cash between themselves.',
 'Runner A cashToCollect decreases. Runner B cashToCollect increases.',
 'both', 'blocking'),

('Q4_WALKIN_PAID_RUNNER_QR',
 'customer', 'cross_qr',
 'Walk-in customer paid to runner QR instead of counter QR',
 'Counter QR deficit + runner QR excess',
 'Runner QR excess >= amount',
 'Tag from runner QR to counter. Runner cashToCollect increases.',
 'Counter UPI increases (effectively). Runner must surrender equivalent cash.',
 'cashier', 'blocking'),

-- ── SYSTEM: Unknown product ──
('S1_UNKNOWN_PRODUCT',
 'system', 'product_method',
 'Product ID not in registry — new product added to Odoo but not to validator',
 'Product ID not found in PRODUCT_CATEGORIES lookup',
 'None',
 'Add product to v_products and v_valid_pm tables',
 'No settlement impact until product is registered',
 'cashier', 'warning'),

-- ── RAZORPAY: UPI verification failures ──
('R1_UPI_NOT_RECEIVED',
 'system', 'upi_mismatch',
 'POS order marked UPI but no Razorpay payment found for this QR at this time',
 'Razorpay API shows no matching payment',
 'Razorpay confirms deficit on expected QR',
 'Change to Cash (customer paid cash) OR tag from another QR where it landed',
 'If changed to Cash: UPI total down, cash total up. If cross-QR: see Q1-Q4.',
 'cashier', 'blocking'),

('R2_UNMATCHED_RAZORPAY',
 'system', 'upi_mismatch',
 'Razorpay shows payment on a QR with no corresponding POS UPI order',
 'Excess detection: Razorpay total > POS UPI total for this QR',
 'Razorpay payment exists',
 'Wait for cross-QR tag claim OR investigate at settlement',
 'Excess sits on QR until tagged or settlement',
 'cashier', 'warning');

-- ============================================================
-- SEED: EXPENSE CATEGORIES
-- ============================================================

-- Counter cash expenses — unified HN cats (was: police-only before /ops/v2/ launch).
-- /api/rectify?action=record-expense accepts ALL active rows (pool filter retired).
INSERT OR REPLACE INTO v_expense_categories (code, name, pool, requires_approval, max_amount, active) VALUES
    -- Police hafta (original counter-pool rows)
    ('BEAT', 'Beat Police', 'counter', 0, 100, 1),
    ('CHETA', 'Cheta Police', 'counter', 0, 100, 1),
    ('HOYSALA', 'Hoysala', 'counter', 0, 100, 1),
    ('ASI', 'ASI', 'counter', 0, 100, 1),
    ('WEEKLY', 'Weekly Police', 'counter', 0, 100, 1),
    ('CIRCLE', 'Circle Police', 'counter', 0, 100, 1),
    ('SI', 'Sub Inspector', 'counter', 0, 500, 1),
    -- HN unified cats (mirror HN_CATS rect_codes in /ops/v2/index.html)
    ('RM',        'Raw Material',       'counter', 0, NULL, 1),
    ('ASSET',     'Capex / Equipment',  'counter', 0, NULL, 1),
    ('ADVANCE',   'Salary Advance',     'counter', 0, NULL, 1),
    ('MISC',      'Utility Bill',       'counter', 0, NULL, 1),
    ('MARKETING', 'Marketing / Ads',    'counter', 0, NULL, 1),
    ('TECH',      'Tech / SaaS / Bank', 'counter', 0, NULL, 1),
    ('LEGAL',     'Audit / Legal',      'counter', 0, NULL, 1);

-- Petty cash — completely separate fund, not linked to counter cash
-- Managed by GM/admin, funded independently
INSERT OR REPLACE INTO v_expense_categories (code, name, pool, requires_approval, max_amount, active) VALUES
    ('MILK', 'Milk Purchase', 'petty', 0, NULL, 1),
    ('GAS', 'Gas Cylinder', 'petty', 0, NULL, 1),
    ('SUPPLIES', 'Kitchen Supplies', 'petty', 0, NULL, 1),
    ('CLEANING', 'Cleaning Materials', 'petty', 0, NULL, 1),
    ('STAFF_FOOD', 'Staff Food', 'petty', 0, NULL, 1),
    ('TRANSPORT', 'Transport/Auto', 'petty', 0, 500, 1),
    ('REPAIR', 'Minor Repair/Maintenance', 'petty', 1, 2000, 1),
    ('EMERGENCY', 'Emergency (other)', 'petty', 1, NULL, 1);

-- Initialize petty cash balance
INSERT OR REPLACE INTO petty_cash_balance (id, current_balance) VALUES (1, 0);
