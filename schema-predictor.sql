-- ═══════════════════════════════════════════════════════════
-- NCH Inventory Predictor — D1 Schema
-- Prediction periods, manual intelligence, daily cache, accuracy log
-- ═══════════════════════════════════════════════════════════

-- Business period segments (Ramadan, Post-Ramadan, Normal, etc.)
CREATE TABLE IF NOT EXISTS prediction_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  operating_hours TEXT NOT NULL DEFAULT '[]',
  notes TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Manual intelligence multipliers (overrides on top of statistical prediction)
CREATE TABLE IF NOT EXISTS prediction_multipliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_code TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  scope_id INTEGER,
  day_of_week INTEGER,
  multiplier REAL NOT NULL DEFAULT 1.0,
  reason TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pm_period ON prediction_multipliers(period_code);

-- Pre-aggregated daily sales from Odoo (avoids repeated expensive queries)
CREATE TABLE IF NOT EXISTS prediction_daily_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  period_code TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  qty_sold REAL NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  hourly_breakdown TEXT NOT NULL DEFAULT '{}',
  cached_at TEXT NOT NULL,
  UNIQUE(date, product_id)
);

CREATE INDEX IF NOT EXISTS idx_pdc_date ON prediction_daily_cache(date);
CREATE INDEX IF NOT EXISTS idx_pdc_period ON prediction_daily_cache(period_code);
CREATE INDEX IF NOT EXISTS idx_pdc_product ON prediction_daily_cache(product_id, date);

-- Prediction log: track predictions vs actuals for accuracy
CREATE TABLE IF NOT EXISTS prediction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_date TEXT NOT NULL,
  predicted_at TEXT NOT NULL,
  segment_code TEXT NOT NULL,
  safety_buffer REAL NOT NULL DEFAULT 1.1,
  product_predictions TEXT NOT NULL DEFAULT '{}',
  material_predictions TEXT NOT NULL DEFAULT '{}',
  multipliers_applied TEXT NOT NULL DEFAULT '[]',
  actual_products TEXT,
  actual_materials TEXT,
  accuracy_pct REAL,
  evaluated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pl_date ON prediction_log(prediction_date);

-- Seed initial periods
INSERT OR IGNORE INTO prediction_periods (code, name, start_date, end_date, operating_hours, notes, created_by, created_at, updated_at)
VALUES
  ('pre_ramadan', 'Pre-Ramadan', '2026-02-03', '2026-02-18', '[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]', 'Outlet launch phase, 24h ops', 'system', '2026-03-10T00:00:00', '2026-03-10T00:00:00'),
  ('ramadan_early', 'Ramadan (Early)', '2026-02-19', '2026-03-09', '[17,18,19,20,21,22,23,0,1,2,3,4,5]', 'Ramadan first 19 days, 5PM-6AM', 'system', '2026-03-10T00:00:00', '2026-03-10T00:00:00'),
  ('ramadan_last10', 'Ramadan (Last 10)', '2026-03-10', '2026-03-20', '[17,18,19,20,21,22,23,0,1,2,3,4,5]', 'Last 10 days of Ramadan — peak business expected', 'system', '2026-03-10T00:00:00', '2026-03-10T00:00:00'),
  ('post_ramadan', 'Post-Ramadan', '2026-03-21', NULL, '[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]', 'Back to 24h ops', 'system', '2026-03-10T00:00:00', '2026-03-10T00:00:00');
