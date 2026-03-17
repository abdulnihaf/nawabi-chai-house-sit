-- Add given_to tracking to petty_cash table
-- Tracks who Naveen gave cash to (CASH001, CASH002, GM001, MGR001)
ALTER TABLE petty_cash ADD COLUMN given_to TEXT;
ALTER TABLE petty_cash ADD COLUMN given_to_name TEXT;
