-- Daily P&L Settlement Schema
-- Run: wrangler d1 execute nch-settlements --file=schema-daily-pnl.sql

-- ═══════════════════════════════════════════════════════════════
-- VESSELS: kitchen/counter vessels with known empty weights
-- Staff selects vessel → enters weight → system subtracts tare
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vessels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  liquid_type TEXT NOT NULL,       -- 'boiled_milk', 'decoction', 'oil', 'raw_milk'
  location TEXT NOT NULL,          -- 'kitchen', 'counter'
  empty_weight_kg REAL NOT NULL,
  notes TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════
-- RECIPES: product → raw material mapping with quantities
-- One row per product-material pair
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  material_id INTEGER NOT NULL,
  material_name TEXT NOT NULL,
  qty_per_unit REAL NOT NULL,      -- qty of material per 1 unit of product
  uom TEXT NOT NULL,               -- 'L', 'kg', 'Units'
  updated_at TEXT NOT NULL,
  updated_by TEXT DEFAULT '',
  UNIQUE(product_id, material_id)
);

-- ═══════════════════════════════════════════════════════════════
-- SETTLEMENT STATES: defines what physical states exist
-- and how to decompose them back to raw materials
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS settlement_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,        -- 'boiled_milk', 'tea_decoction', 'tea_sugar_box', etc.
  name TEXT NOT NULL,               -- 'Boiled Milk', 'Tea Decoction', etc.
  category TEXT NOT NULL,           -- 'milk_dairy', 'tea_coffee', 'buns', 'fried', 'biscuits', 'other'
  input_type TEXT NOT NULL,         -- 'vessel_weight', 'count', 'weight_kg', 'volume_l'
  input_uom TEXT NOT NULL,          -- 'kg', 'L', 'units', 'boxes', 'packets'
  display_label TEXT NOT NULL,      -- what staff sees: "Boiled Milk — Kitchen"
  display_order INTEGER DEFAULT 0,
  -- Decomposition: JSON mapping of material_id → qty_per_input_unit
  -- e.g. for boiled_milk: {"1095": 0.957, "1096": 0.02392, "1112": 0.01914}
  decomposition TEXT NOT NULL DEFAULT '{}',
  -- For vessel_weight types: density in kg/L for weight→volume conversion
  density_kg_per_l REAL DEFAULT NULL,
  -- For packet types: units per packet
  units_per_pack REAL DEFAULT NULL,
  notes TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════
-- DENSITY CONSTANTS: liquid type → kg per litre conversion
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS density_constants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  liquid_type TEXT NOT NULL UNIQUE,
  density_kg_per_l REAL NOT NULL,
  notes TEXT DEFAULT '',
  updated_at TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════
-- MATERIAL COSTS: tracks purchase price per raw material
-- Auto-updated from Odoo POs, can be manually overridden
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS material_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  material_name TEXT NOT NULL,
  cost_per_unit REAL NOT NULL,
  uom TEXT NOT NULL,
  source TEXT DEFAULT 'manual',     -- 'purchase_order', 'manual'
  effective_from TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matcost_material ON material_costs(material_id, effective_from);

-- ═══════════════════════════════════════════════════════════════
-- STAFF SALARIES: daily prorated into settlement OpEx
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS staff_salaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  monthly_salary REAL NOT NULL,
  effective_from TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  updated_at TEXT NOT NULL,
  odoo_employee_id INTEGER DEFAULT NULL,  -- Odoo hr.employee ID
  category TEXT DEFAULT 'nch_direct',     -- 'nch_direct' or 'office'
  start_date TEXT DEFAULT ''              -- employee joining date YYYY-MM-DD
);

-- ═══════════════════════════════════════════════════════════════
-- DAILY SETTLEMENTS: the main settlement record
-- One row per settlement period (previous settled_at → now)
-- Multiple settlements per day allowed (shift changes)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS daily_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_date TEXT NOT NULL,         -- '2026-02-10' (business date for display)
  period_start TEXT NOT NULL,            -- ISO: previous settlement's settled_at
  period_end TEXT NOT NULL,              -- ISO: this settlement's time
  settled_by TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'bootstrap', 'completed'

  -- Revenue (auto from Odoo)
  revenue_total REAL DEFAULT 0,
  revenue_cash_counter REAL DEFAULT 0,
  revenue_runner_counter REAL DEFAULT 0,
  revenue_whatsapp REAL DEFAULT 0,
  revenue_breakdown TEXT DEFAULT '{}',

  -- COGS
  cogs_actual REAL DEFAULT 0,
  cogs_expected REAL DEFAULT 0,

  -- Gross Profit
  gross_profit REAL DEFAULT 0,

  -- Operating Expenses
  opex_salaries REAL DEFAULT 0,
  opex_counter_expenses REAL DEFAULT 0,
  opex_non_consumable REAL DEFAULT 0,
  opex_total REAL DEFAULT 0,

  -- Net Profit
  net_profit REAL DEFAULT 0,

  -- Inventory snapshot: raw input from staff
  inventory_raw_input TEXT NOT NULL DEFAULT '{}',
  -- Inventory decomposed to raw materials
  inventory_decomposed TEXT NOT NULL DEFAULT '{}',
  -- Opening stock (from previous settlement or bootstrap)
  inventory_opening TEXT NOT NULL DEFAULT '{}',
  -- Purchases received in period
  inventory_purchases TEXT NOT NULL DEFAULT '{}',
  -- Closing stock (this settlement's count)
  inventory_closing TEXT NOT NULL DEFAULT '{}',
  -- Consumption = opening + purchases - closing
  inventory_consumption TEXT NOT NULL DEFAULT '{}',
  -- Expected consumption from recipes × sales
  inventory_expected TEXT NOT NULL DEFAULT '{}',
  -- Discrepancy per material
  inventory_discrepancy TEXT NOT NULL DEFAULT '{}',
  -- Total discrepancy value
  discrepancy_value REAL DEFAULT 0,

  -- Wastage (recorded separately)
  wastage_items TEXT DEFAULT '[]',
  wastage_total_value REAL DEFAULT 0,

  -- Runner tokens at settlement time
  runner_tokens TEXT DEFAULT '{}',
  runner_tokens_total INTEGER DEFAULT 0,

  -- Adjusted
  adjusted_net_profit REAL DEFAULT 0,

  notes TEXT DEFAULT '',
  previous_settlement_id INTEGER DEFAULT NULL,
  timestamp_adjustments TEXT DEFAULT '{}',

  -- Edit trail: {fieldId: [{value, at}]} — tracks every field edit with timestamp
  edit_trail TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_settlements(settlement_date);
CREATE INDEX IF NOT EXISTS idx_daily_status ON daily_settlements(status);
CREATE INDEX IF NOT EXISTS idx_daily_settled_at ON daily_settlements(settled_at);
