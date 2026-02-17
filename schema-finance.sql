-- Finance Operations Schema
-- Run: wrangler d1 execute nch-settlements --file=schema-finance.sql

-- Business Expenses: Nihaf/Naveen's side business expenses (not counter petty cash)
CREATE TABLE IF NOT EXISTS business_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  notes TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_biz_exp_at ON business_expenses(recorded_at);

-- Bank Transactions: deposits, withdrawals, opening balance
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  method TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_at ON bank_transactions(recorded_at);
CREATE INDEX IF NOT EXISTS idx_bank_txn_type ON bank_transactions(type);
