-- Migration 001: Timestamp-based settlements
-- Removes UNIQUE(settlement_date) constraint and adds edit_trail column
-- Run: wrangler d1 execute nch-settlements --file=migrations/001-timestamp-settlements.sql

-- 1. Create new table without UNIQUE(settlement_date), with edit_trail column
CREATE TABLE IF NOT EXISTS daily_settlements_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_date TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  settled_by TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',

  revenue_total REAL DEFAULT 0,
  revenue_cash_counter REAL DEFAULT 0,
  revenue_runner_counter REAL DEFAULT 0,
  revenue_whatsapp REAL DEFAULT 0,
  revenue_breakdown TEXT DEFAULT '{}',

  cogs_actual REAL DEFAULT 0,
  cogs_expected REAL DEFAULT 0,

  gross_profit REAL DEFAULT 0,

  opex_salaries REAL DEFAULT 0,
  opex_counter_expenses REAL DEFAULT 0,
  opex_non_consumable REAL DEFAULT 0,
  opex_total REAL DEFAULT 0,

  net_profit REAL DEFAULT 0,

  inventory_raw_input TEXT NOT NULL DEFAULT '{}',
  inventory_decomposed TEXT NOT NULL DEFAULT '{}',
  inventory_opening TEXT NOT NULL DEFAULT '{}',
  inventory_purchases TEXT NOT NULL DEFAULT '{}',
  inventory_closing TEXT NOT NULL DEFAULT '{}',
  inventory_consumption TEXT NOT NULL DEFAULT '{}',
  inventory_expected TEXT NOT NULL DEFAULT '{}',
  inventory_discrepancy TEXT NOT NULL DEFAULT '{}',
  discrepancy_value REAL DEFAULT 0,

  wastage_items TEXT DEFAULT '[]',
  wastage_total_value REAL DEFAULT 0,

  runner_tokens TEXT DEFAULT '{}',
  runner_tokens_total INTEGER DEFAULT 0,

  adjusted_net_profit REAL DEFAULT 0,

  notes TEXT DEFAULT '',
  previous_settlement_id INTEGER DEFAULT NULL,
  timestamp_adjustments TEXT DEFAULT '{}',

  edit_trail TEXT DEFAULT '{}'
);

-- 2. Copy existing data (add empty edit_trail for existing rows)
INSERT INTO daily_settlements_new
  SELECT *, '{}' FROM daily_settlements;

-- 3. Drop old table and indexes
DROP TABLE daily_settlements;

-- 4. Rename new table
ALTER TABLE daily_settlements_new RENAME TO daily_settlements;

-- 5. Recreate indexes
CREATE INDEX idx_daily_date ON daily_settlements(settlement_date);
CREATE INDEX idx_daily_status ON daily_settlements(status);
CREATE INDEX idx_daily_settled_at ON daily_settlements(settled_at);
