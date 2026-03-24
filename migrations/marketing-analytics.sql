-- Marketing Analytics Schema Extension
-- Run: wrangler d1 execute nch-db --remote --file=migrations/marketing-analytics.sql
-- Purpose: GMB OAuth storage, location cache, daily analytics snapshots

-- GMB OAuth refresh tokens (one per brand)
CREATE TABLE IF NOT EXISTS gmb_tokens (
  brand TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  token_expires_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- GMB location name cache (avoid re-discovering on every call)
CREATE TABLE IF NOT EXISTS gmb_locations (
  brand TEXT PRIMARY KEY,
  location_name TEXT NOT NULL,
  account_name TEXT,
  place_id TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Daily analytics snapshots for historical tracking
CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(brand, date, platform, metric)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ad_brand_date ON analytics_daily(brand, date);
CREATE INDEX IF NOT EXISTS idx_ad_platform ON analytics_daily(brand, platform, metric);
