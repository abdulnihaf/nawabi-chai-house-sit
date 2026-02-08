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
  notes TEXT DEFAULT ''
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
