-- Takht / validator-cron revival — 2026-05-29
-- Adds a provenance tag to payment_discrepancies so Takht can distinguish
-- auto-detected (cron-driven) UPI reconciliation hits from manual/client-triggered ones.
-- Applied to D1 nch-settlements (3388724b-41b2-4925-a7df-12f068c19e6e) on 2026-05-29.
-- Idempotent note: ALTER ... ADD COLUMN errors if re-run; column already present in prod.

ALTER TABLE payment_discrepancies ADD COLUMN source TEXT DEFAULT 'manual';
-- 'cron_auto'  → written by validator?action=razorpay-verify&source=cron_auto (nch-cron worker)
-- 'manual'     → written by client-triggered razorpay-verify (/ops/settlement or /ops/v2)
