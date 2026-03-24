-- NCH Marketing Schema Migration
-- Run: wrangler d1 execute nch-db --remote --file=migrations/marketing.sql
-- Purpose: Weekly content calendar, image storage tracking, Google reviews

-- Weekly post calendar (21 posts per week)
CREATE TABLE IF NOT EXISTS marketing_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL DEFAULT 'nch',
  week_start TEXT NOT NULL,
  post_number INTEGER NOT NULL,
  post_date TEXT NOT NULL,
  time_slot TEXT NOT NULL,
  title TEXT,
  objective TEXT,
  prompt_ig TEXT,
  prompt_fb TEXT,
  prompt_google TEXT,
  caption_ig TEXT,
  caption_fb TEXT,
  caption_google TEXT,
  image_key_ig TEXT,
  image_key_fb TEXT,
  image_key_google TEXT,
  status_ig TEXT DEFAULT 'pending',
  status_fb TEXT DEFAULT 'pending',
  status_google TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(brand, week_start, post_number)
);

-- Post publish log
CREATE TABLE IF NOT EXISTS post_publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  brand TEXT DEFAULT 'nch',
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  platform_post_id TEXT,
  error_message TEXT,
  published_at TEXT DEFAULT (datetime('now'))
);

-- Daily Google review snapshots
CREATE TABLE IF NOT EXISTS review_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL DEFAULT 'nch',
  snapshot_date TEXT NOT NULL,
  total_reviews INTEGER,
  average_rating REAL,
  stars_5 INTEGER DEFAULT 0,
  stars_4 INTEGER DEFAULT 0,
  stars_3 INTEGER DEFAULT 0,
  stars_2 INTEGER DEFAULT 0,
  stars_1 INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(brand, snapshot_date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mp_week ON marketing_posts(brand, week_start);
CREATE INDEX IF NOT EXISTS idx_ppl_post ON post_publish_log(post_id);
CREATE INDEX IF NOT EXISTS idx_rs_date ON review_snapshots(brand, snapshot_date);
