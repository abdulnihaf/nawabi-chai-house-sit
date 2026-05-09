-- NCH POS Bridge — D1 schema for terminal health beacons.
-- Each row is a heartbeat from the Chrome extension installed on a POS terminal.
-- Used by the cron-tick alert system to detect dead/stuck terminals within 5 min.

CREATE TABLE IF NOT EXISTS pos_beacons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,            -- stable UUID per Chrome profile
  ts TEXT NOT NULL,                    -- ISO timestamp the agent generated the beacon
  received_at TEXT DEFAULT (datetime('now')),
  online INTEGER NOT NULL DEFAULT 1,   -- navigator.onLine at the agent
  pos_tab_open INTEGER NOT NULL DEFAULT 0,
  unsynced_count INTEGER,              -- NULL if pos_tab_open=0
  last_sync_attempt_at TEXT,
  last_sync_ok INTEGER,                -- 1 / 0 / NULL
  last_error TEXT,
  extension_version TEXT,
  user_agent TEXT,
  reason TEXT,                         -- 'alarm', 'reconnect', 'content-request', etc.
  replayed INTEGER DEFAULT 0           -- 1 if this beacon was queued offline and resent
);

CREATE INDEX IF NOT EXISTS idx_beacons_machine_ts ON pos_beacons(machine_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_beacons_received ON pos_beacons(received_at DESC);

-- Aggregate view for dashboards: latest beacon per machine
-- (D1 doesn't support views well, so use a query in code:
--   SELECT * FROM pos_beacons WHERE id IN (
--     SELECT MAX(id) FROM pos_beacons GROUP BY machine_id
--   ))
