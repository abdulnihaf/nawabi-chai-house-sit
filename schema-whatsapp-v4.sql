-- WhatsApp v4 Schema Migration — Add language preference
-- Run: wrangler d1 execute nch-settlements --file=schema-whatsapp-v4.sql --remote

ALTER TABLE wa_users ADD COLUMN preferred_language TEXT DEFAULT NULL;
