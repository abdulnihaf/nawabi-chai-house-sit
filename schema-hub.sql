-- Hub schema — session tracking and FCM token storage
-- Run: wrangler d1 execute nch-db --file=schema-hub.sql

-- Hub sessions (optional — login works without this)
CREATE TABLE IF NOT EXISTS hub_sessions (
  staff_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  session_token TEXT,
  created_at TEXT NOT NULL
);

-- FCM tokens for native app push notifications
CREATE TABLE IF NOT EXISTS fcm_tokens (
  staff_id TEXT PRIMARY KEY,
  fcm_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_updated ON fcm_tokens(updated_at);
