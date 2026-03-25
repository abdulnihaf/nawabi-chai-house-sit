-- Marketing Drive Integration Migration
-- Run: wrangler d1 execute nch-db --remote --file=migrations/marketing-drive.sql
-- Purpose: Google Drive folder cache + asset tracking in publish log

-- Cache Drive folder IDs to avoid re-searching on every upload
CREATE TABLE IF NOT EXISTS drive_folders (
  brand TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(brand, folder_path)
);

-- Add asset tracking columns to publish log
ALTER TABLE post_publish_log ADD COLUMN image_url TEXT;
ALTER TABLE post_publish_log ADD COLUMN drive_file_id TEXT;
