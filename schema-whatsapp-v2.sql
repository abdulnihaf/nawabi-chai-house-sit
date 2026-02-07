-- WhatsApp v2 Schema Migration — Add business_type column
-- Run: wrangler d1 execute nch-settlements --file=schema-whatsapp-v2.sql --remote

ALTER TABLE wa_users ADD COLUMN business_type TEXT;
