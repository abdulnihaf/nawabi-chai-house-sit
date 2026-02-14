CREATE TABLE IF NOT EXISTS token_box_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settled_at TEXT NOT NULL,
  settled_by TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  is_bootstrap INTEGER DEFAULT 0,
  gross_weight_kg REAL,
  box_tare_kg REAL DEFAULT 0.338,
  token_weight_kg REAL DEFAULT 0.00110,
  token_count INTEGER,
  odoo_total_beverages INTEGER,
  odoo_chai INTEGER DEFAULT 0,
  odoo_coffee INTEGER DEFAULT 0,
  odoo_lemon_tea INTEGER DEFAULT 0,
  token_issue_qty INTEGER DEFAULT 0,
  runner_delivered_qty INTEGER DEFAULT 0,
  runner_unsold_qty INTEGER DEFAULT 0,
  expected_tokens INTEGER,
  discrepancy INTEGER,
  notes TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tbs_settled_at ON token_box_settlements(settled_at);
