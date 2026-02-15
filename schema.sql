DROP TABLE IF EXISTS settlements;

CREATE TABLE settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id INTEGER NOT NULL,
  runner_name TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  settled_by TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  tokens_amount REAL DEFAULT 0,
  sales_amount REAL DEFAULT 0,
  upi_amount REAL DEFAULT 0,
  cash_settled REAL NOT NULL,
  unsold_tokens REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  handover_to TEXT DEFAULT ''
);

CREATE INDEX idx_runner_id ON settlements(runner_id);
CREATE INDEX idx_settled_at ON settlements(settled_at);

-- Cash Collections: tracks when Naveen (or owner) physically collects cash from the counter
-- This is the THIRD tier: Runners → Cash Counter → Naveen
DROP TABLE IF EXISTS cash_collections;

CREATE TABLE cash_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collected_by TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  amount REAL NOT NULL,
  petty_cash REAL DEFAULT 0,
  expenses REAL DEFAULT 0,
  expected REAL DEFAULT 0,
  discrepancy REAL DEFAULT 0,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  runner_cash REAL DEFAULT 0,
  counter_cash REAL DEFAULT 0,
  prev_petty_cash REAL DEFAULT 0,
  settlement_ids TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE INDEX idx_collected_at ON cash_collections(collected_at);

-- Counter Expenses: recorded by cashier at the time cash is given out
-- Automatically deducted from cash-at-counter balance
DROP TABLE IF EXISTS counter_expenses;

CREATE TABLE counter_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  attributed_to TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE INDEX idx_expense_recorded_at ON counter_expenses(recorded_at);

-- Audit logs: every discrepancy detected by the intelligent auditor
DROP TABLE IF EXISTS audit_logs;

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  period_from TEXT,
  period_to TEXT,
  alerted_to TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_type ON audit_logs(check_type);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

-- Razorpay payment sync: local cache of all QR payments for audit trail
DROP TABLE IF EXISTS razorpay_sync;

CREATE TABLE razorpay_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qr_id TEXT NOT NULL,
  qr_label TEXT NOT NULL,
  payment_id TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  vpa TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'captured',
  captured_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE INDEX idx_rp_label ON razorpay_sync(qr_label);
CREATE INDEX idx_rp_captured ON razorpay_sync(captured_at);

-- Cashier Shifts v2: parent record for "End My Shift" wizard
-- One row per full cashier shift settlement (counter + all runner checkpoints)
DROP TABLE IF EXISTS cashier_shifts;

CREATE TABLE cashier_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cashier_name TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  -- Drawer formula components (v3)
  petty_cash_start REAL DEFAULT 0,
  counter_cash_settled REAL DEFAULT 0,
  unsettled_counter_cash REAL DEFAULT 0,
  runner_cash_settled REAL DEFAULT 0,
  expenses_total REAL DEFAULT 0,
  expected_drawer REAL DEFAULT 0,
  drawer_cash_entered REAL DEFAULT 0,
  drawer_variance REAL DEFAULT 0,
  -- Counter assessment (Step 1)
  counter_cash_expected REAL DEFAULT 0,
  counter_cash_entered REAL DEFAULT 0,
  counter_cash_variance REAL DEFAULT 0,
  counter_upi REAL DEFAULT 0,
  counter_card REAL DEFAULT 0,
  counter_token_issue REAL DEFAULT 0,
  counter_complimentary REAL DEFAULT 0,
  -- UPI discrepancy snapshot (Odoo vs Razorpay)
  counter_qr_odoo REAL DEFAULT 0,
  counter_qr_razorpay REAL DEFAULT 0,
  counter_qr_variance REAL DEFAULT 0,
  runner_counter_qr_odoo REAL DEFAULT 0,
  runner_counter_qr_razorpay REAL DEFAULT 0,
  runner_counter_qr_variance REAL DEFAULT 0,
  -- Grand reconciliation (Step 3)
  total_cash_physical REAL DEFAULT 0,
  total_cash_expected REAL DEFAULT 0,
  final_variance REAL DEFAULT 0,
  variance_resolved REAL DEFAULT 0,
  variance_unresolved REAL DEFAULT 0,
  discrepancy_resolutions TEXT DEFAULT '[]',
  -- Metadata
  runner_count INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  handover_to TEXT DEFAULT ''
);

CREATE INDEX idx_cs_settled_at ON cashier_shifts(settled_at);
CREATE INDEX idx_cs_cashier ON cashier_shifts(cashier_name);

-- Shift Runner Checkpoints: per-runner record within a cashier shift
-- Also dual-writes to legacy `settlements` table for period continuity
DROP TABLE IF EXISTS shift_runner_checkpoints;

CREATE TABLE shift_runner_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  runner_id INTEGER NOT NULL,
  runner_name TEXT NOT NULL,
  tokens_amount REAL DEFAULT 0,
  sales_amount REAL DEFAULT 0,
  upi_amount REAL DEFAULT 0,
  cross_payment_credit REAL DEFAULT 0,
  unsold_tokens REAL DEFAULT 0,
  cash_calculated REAL DEFAULT 0,
  cash_collected REAL DEFAULT 0,
  cash_variance REAL DEFAULT 0,
  excess_mapped_to TEXT DEFAULT '',
  excess_mapped_amount REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'present',
  FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id)
);

CREATE INDEX idx_src_shift ON shift_runner_checkpoints(shift_id);
CREATE INDEX idx_src_runner ON shift_runner_checkpoints(runner_id);

-- Migration SQL (run on live D1 — does NOT drop existing tables):
--
-- CREATE TABLE IF NOT EXISTS cashier_shifts ( ... );  -- copy from above
-- CREATE TABLE IF NOT EXISTS shift_runner_checkpoints ( ... );  -- copy from above
-- CREATE INDEX IF NOT EXISTS idx_cs_settled_at ON cashier_shifts(settled_at);
-- CREATE INDEX IF NOT EXISTS idx_cs_cashier ON cashier_shifts(cashier_name);
-- CREATE INDEX IF NOT EXISTS idx_src_shift ON shift_runner_checkpoints(shift_id);
-- CREATE INDEX IF NOT EXISTS idx_src_runner ON shift_runner_checkpoints(runner_id);
--
-- v3 migration (add drawer formula columns to existing cashier_shifts):
-- ALTER TABLE cashier_shifts ADD COLUMN petty_cash_start REAL DEFAULT 0;
-- ALTER TABLE cashier_shifts ADD COLUMN counter_cash_settled REAL DEFAULT 0;
-- ALTER TABLE cashier_shifts ADD COLUMN unsettled_counter_cash REAL DEFAULT 0;
-- ALTER TABLE cashier_shifts ADD COLUMN runner_cash_settled REAL DEFAULT 0;
-- ALTER TABLE cashier_shifts ADD COLUMN expenses_total REAL DEFAULT 0;
-- ALTER TABLE cashier_shifts ADD COLUMN expected_drawer REAL DEFAULT 0;
-- ALTER TABLE cashier_shifts ADD COLUMN drawer_cash_entered REAL DEFAULT 0;
-- ALTER TABLE cashier_shifts ADD COLUMN drawer_variance REAL DEFAULT 0;
