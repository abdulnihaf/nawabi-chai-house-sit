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
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  runner_cash REAL DEFAULT 0,
  counter_cash REAL DEFAULT 0,
  settlement_ids TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE INDEX idx_collected_at ON cash_collections(collected_at);
