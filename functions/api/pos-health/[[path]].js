// NCH POS Bridge — cloud-side health endpoints
// Receives beacons from the Chrome extension running on POS terminals,
// stores them in D1, and serves status queries for the dashboard + cron.
//
// Endpoints:
//   POST /api/pos-health/beacon       — extension heartbeat
//   GET  /api/pos-health/status       — latest beacon per machine
//   GET  /api/pos-health/history      — beacon history for a machine
//
// Routing: this Pages Function lives at /api/pos-health/* — the path
// after /api/pos-health/ is read from URL.pathname.

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const url = new URL(context.request.url);
  // path is "/api/pos-health/<sub>"
  const sub = url.pathname.replace(/^\/api\/pos-health\/?/, '');
  const DB = context.env.DB;
  if (!DB) return json({ success: false, error: 'DB not configured' }, cors, 500);

  try {
    // Ensure schema exists (idempotent — safe to run on every request)
    await ensureSchema(DB);

    if (sub === 'beacon' && context.request.method === 'POST') {
      return await receiveBeacon(context, DB, cors);
    }
    if (sub === 'status' && context.request.method === 'GET') {
      return await getStatus(DB, cors);
    }
    if (sub === 'history' && context.request.method === 'GET') {
      return await getHistory(url, DB, cors);
    }
    return json({ success: false, error: `Unknown path: ${sub}` }, cors, 404);
  } catch (e) {
    return json({ success: false, error: e.message, stack: e.stack }, cors, 500);
  }
}

// ── Schema bootstrap (creates table on first hit) ─────────────────
async function ensureSchema(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS pos_beacons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      received_at TEXT DEFAULT (datetime('now')),
      online INTEGER NOT NULL DEFAULT 1,
      pos_tab_open INTEGER NOT NULL DEFAULT 0,
      unsynced_count INTEGER,
      last_sync_attempt_at TEXT,
      last_sync_ok INTEGER,
      last_error TEXT,
      extension_version TEXT,
      user_agent TEXT,
      reason TEXT,
      replayed INTEGER DEFAULT 0
    )
  `).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_beacons_machine_ts ON pos_beacons(machine_id, ts DESC)`).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_beacons_received ON pos_beacons(received_at DESC)`).run();
}

// ── POST /api/pos-health/beacon ──────────────────────────────────
async function receiveBeacon(context, DB, cors) {
  const body = await context.request.json().catch(() => ({}));
  const { machine_id, ts } = body;
  if (!machine_id || !ts) {
    return json({ success: false, error: 'machine_id and ts required' }, cors, 400);
  }

  await DB.prepare(`
    INSERT INTO pos_beacons (
      machine_id, ts, online, pos_tab_open, unsynced_count,
      last_sync_attempt_at, last_sync_ok, last_error,
      extension_version, user_agent, reason, replayed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    machine_id,
    ts,
    body.online === false ? 0 : 1,
    body.pos_tab_open ? 1 : 0,
    body.unsynced_count == null ? null : body.unsynced_count,
    body.last_sync_attempt_at || null,
    body.last_sync_ok == null ? null : (body.last_sync_ok ? 1 : 0),
    body.last_error || null,
    body.extension_version || null,
    body.user_agent || null,
    body.reason || null,
    body.replayed ? 1 : 0,
  ).run();

  // Trim — keep last 5000 rows total to bound storage
  await DB.prepare(`
    DELETE FROM pos_beacons WHERE id IN (
      SELECT id FROM pos_beacons ORDER BY id DESC LIMIT -1 OFFSET 5000
    )
  `).run().catch(() => {});

  return json({ success: true, received_at: new Date().toISOString() }, cors);
}

// ── GET /api/pos-health/status ───────────────────────────────────
// Returns latest beacon per machine, computed health flags
async function getStatus(DB, cors) {
  const rows = await DB.prepare(`
    SELECT b.* FROM pos_beacons b
    INNER JOIN (
      SELECT machine_id, MAX(id) AS max_id FROM pos_beacons GROUP BY machine_id
    ) latest ON b.id = latest.max_id
    ORDER BY b.ts DESC
  `).all();

  const now = Date.now();
  const machines = (rows.results || []).map((r) => {
    const ageSec = Math.round((now - new Date(r.ts).getTime()) / 1000);
    const flags = computeFlags(r, ageSec);
    return { ...r, age_sec: ageSec, ...flags };
  });

  const summary = {
    total: machines.length,
    healthy: machines.filter((m) => m.severity === 'ok').length,
    warning: machines.filter((m) => m.severity === 'warn').length,
    critical: machines.filter((m) => m.severity === 'crit').length,
  };

  return json({ success: true, summary, machines }, cors);
}

// ── GET /api/pos-health/history?machine_id=X&limit=N ────────────
async function getHistory(url, DB, cors) {
  const machine_id = url.searchParams.get('machine_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
  if (!machine_id) return json({ success: false, error: 'machine_id required' }, cors, 400);

  const rows = await DB.prepare(`
    SELECT * FROM pos_beacons WHERE machine_id = ? ORDER BY id DESC LIMIT ?
  `).bind(machine_id, limit).all();

  return json({ success: true, machine_id, beacons: rows.results || [] }, cors);
}

// ── Health computation (used by status endpoint AND by cron) ─────
function computeFlags(b, ageSec) {
  // ─ no beacon for >5 min  ⇒  terminal is dead (machine off / Chrome closed)
  // ─ pos_tab_open = false  ⇒  Chrome running but POS tab gone
  // ─ unsynced > 0 + online ⇒  agent stuck, sync isn't working
  // ─ unsynced > 0 + offline⇒  expected during outage (warn only)
  if (ageSec > 600) return { severity: 'crit', reason: 'no-beacon-10min' };
  if (ageSec > 300) return { severity: 'warn', reason: 'no-beacon-5min' };
  if (!b.online) {
    if (b.unsynced_count > 0) return { severity: 'warn', reason: 'offline-with-queue' };
    return { severity: 'warn', reason: 'offline' };
  }
  if (!b.pos_tab_open) return { severity: 'warn', reason: 'pos-tab-closed' };
  if (b.unsynced_count >= 5) return { severity: 'crit', reason: 'sync-stuck' };
  if (b.unsynced_count > 0) return { severity: 'warn', reason: 'sync-pending' };
  if (b.last_sync_ok === 0) return { severity: 'warn', reason: 'last-sync-failed' };
  return { severity: 'ok', reason: 'healthy' };
}

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors });
}
