-- Settlement v2 Schema — Cash Trail & Multi-Level Handover
-- Run: wrangler d1 execute nch-db --file=schema-v2.sql
-- Does NOT modify existing 'settlements' table (kept as read-only archive)

-- Staff table: replaces hardcoded PINs and runner maps
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('runner', 'cashier', 'manager', 'counter', 'staff')),
  pin TEXT,
  runner_odoo_id INTEGER,
  runner_barcode TEXT,
  is_active INTEGER DEFAULT 1
);

-- Handovers: every cash exchange event between two people
CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handover_type TEXT NOT NULL CHECK(handover_type IN ('runner_to_cashier', 'counter_to_cashier', 'cashier_to_manager')),
  from_staff_id TEXT NOT NULL,
  to_staff_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  expected_tokens REAL DEFAULT 0,
  expected_sales REAL DEFAULT 0,
  expected_upi REAL DEFAULT 0,
  expected_cash REAL DEFAULT 0,
  actual_cash REAL NOT NULL,
  discrepancy REAL DEFAULT 0,
  discrepancy_reason TEXT,
  discrepancy_attributed_to TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  notes TEXT DEFAULT '',
  collection_id INTEGER,
  FOREIGN KEY (from_staff_id) REFERENCES staff(id),
  FOREIGN KEY (to_staff_id) REFERENCES staff(id)
);

CREATE INDEX IF NOT EXISTS idx_handovers_from ON handovers(from_staff_id);
CREATE INDEX IF NOT EXISTS idx_handovers_to ON handovers(to_staff_id);
CREATE INDEX IF NOT EXISTS idx_handovers_type ON handovers(handover_type);
CREATE INDEX IF NOT EXISTS idx_handovers_created ON handovers(created_at);
CREATE INDEX IF NOT EXISTS idx_handovers_collection ON handovers(collection_id);

-- Expenses: petty cash spent from counter cash
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('police', 'supplies', 'transport', 'other')),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  collection_id INTEGER,
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE INDEX IF NOT EXISTS idx_expenses_staff ON expenses(staff_id);
CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_collection ON expenses(collection_id);

-- Collections: manager's final collection event
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id TEXT NOT NULL,
  total_expected REAL NOT NULL,
  total_received REAL NOT NULL,
  total_expenses REAL DEFAULT 0,
  total_discrepancy REAL DEFAULT 0,
  net_cash REAL NOT NULL,
  created_at TEXT NOT NULL,
  notes TEXT DEFAULT '',
  FOREIGN KEY (manager_id) REFERENCES staff(id)
);

CREATE INDEX IF NOT EXISTS idx_collections_manager ON collections(manager_id);
CREATE INDEX IF NOT EXISTS idx_collections_created ON collections(created_at);

-- Seed staff data
INSERT OR IGNORE INTO staff VALUES ('runner_64', 'FAROOQ', 'runner', NULL, 64, 'RUN001', 1);
INSERT OR IGNORE INTO staff VALUES ('runner_65', 'AMIN', 'runner', NULL, 65, 'RUN002', 1);
INSERT OR IGNORE INTO staff VALUES ('runner_66', 'NCH Runner 03', 'runner', NULL, 66, 'RUN003', 1);
INSERT OR IGNORE INTO staff VALUES ('runner_67', 'NCH Runner 04', 'runner', NULL, 67, 'RUN004', 1);
INSERT OR IGNORE INTO staff VALUES ('runner_68', 'NCH Runner 05', 'runner', NULL, 68, 'RUN005', 1);
INSERT OR IGNORE INTO staff VALUES ('counter_pos27', 'Cash Counter', 'counter', NULL, NULL, 'POS-27', 1);
INSERT OR IGNORE INTO staff VALUES ('cashier_jafar', 'Jafar', 'cashier', '3946', NULL, NULL, 1);
INSERT OR IGNORE INTO staff VALUES ('cashier_kesmat', 'Md Kesmat', 'cashier', '7115', NULL, NULL, 1);
INSERT OR IGNORE INTO staff VALUES ('manager_nihaf', 'Nihaf', 'manager', '0305', NULL, NULL, 1);
INSERT OR IGNORE INTO staff VALUES ('manager_naveen', 'Naveen', 'manager', '1234', NULL, NULL, 1);
INSERT OR IGNORE INTO staff VALUES ('staff_tanveer', 'Tanveer', 'staff', '6890', NULL, NULL, 0);
