-- WhatsApp v3 Schema Migration — Add Razorpay UPI payment tracking
-- Run: wrangler d1 execute nch-settlements --file=schema-whatsapp-v3.sql --remote

ALTER TABLE wa_orders ADD COLUMN razorpay_link_id TEXT;
ALTER TABLE wa_orders ADD COLUMN razorpay_payment_id TEXT;
ALTER TABLE wa_orders ADD COLUMN razorpay_link_url TEXT;
