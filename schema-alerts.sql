-- Alert system tables for NCH WhatsApp + FCM notifications
-- Run: wrangler d1 execute nch-db --file=schema-alerts.sql

-- Tracks every alert sent — used for cooldown/deduplication
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL,        -- E1, E2, R1, C1, P1, S1, U1, etc.
  topic_key TEXT NOT NULL,         -- unique per event: "error:42", "runner_cash:RUN001", "collection:7"
  channel TEXT NOT NULL,           -- whatsapp | fcm
  recipient TEXT NOT NULL,         -- slot_code or phone number
  sent_at TEXT DEFAULT (datetime('now')),
  message_preview TEXT,            -- first 100 chars for debugging
  delivery_status TEXT DEFAULT 'sent' -- sent | failed
);

CREATE INDEX IF NOT EXISTS idx_alert_log_topic ON alert_log(alert_type, topic_key, sent_at);
CREATE INDEX IF NOT EXISTS idx_alert_log_recipient ON alert_log(recipient, sent_at);
