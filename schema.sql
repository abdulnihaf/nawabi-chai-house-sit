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
