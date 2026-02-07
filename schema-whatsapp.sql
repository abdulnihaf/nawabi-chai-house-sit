-- WhatsApp Ordering System - D1 Migration
-- Run: wrangler d1 execute nch-settlements --file=schema-whatsapp.sql

CREATE TABLE IF NOT EXISTS wa_users (
  wa_id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  location_lat REAL,
  location_lng REAL,
  location_address TEXT,
  first_order_redeemed INTEGER DEFAULT 0,
  last_order_id INTEGER,
  total_orders INTEGER DEFAULT 0,
  total_spent REAL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code TEXT UNIQUE,
  wa_id TEXT NOT NULL,
  items TEXT NOT NULL,
  subtotal REAL NOT NULL,
  discount REAL DEFAULT 0,
  discount_reason TEXT,
  total REAL NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT DEFAULT 'pending',
  delivery_lat REAL,
  delivery_lng REAL,
  delivery_address TEXT,
  delivery_distance_m INTEGER,
  status TEXT DEFAULT 'confirmed',
  runner_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS wa_sessions (
  wa_id TEXT PRIMARY KEY,
  state TEXT DEFAULT 'idle',
  cart TEXT DEFAULT '[]',
  cart_total REAL DEFAULT 0,
  pending_item_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_orders_wa_id ON wa_orders(wa_id);
CREATE INDEX IF NOT EXISTS idx_wa_orders_status ON wa_orders(status);
CREATE INDEX IF NOT EXISTS idx_wa_orders_created ON wa_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_wa_orders_code ON wa_orders(order_code);
