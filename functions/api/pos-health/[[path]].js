// NCH POS Bridge — cloud-side endpoints (v2: bidirectional remote diagnostics)
//
// The POS terminal Chrome extension phones home over HTTPS. This is the
// only viable channel: the terminal is behind NAT, so the cloud cannot
// initiate a connection to it. Everything flows from terminal → cloud,
// or terminal polls the cloud for queued commands.
//
// Endpoints:
//   ── Telemetry (terminal pushes) ──
//   POST /api/pos-health/beacon            — heartbeat (basic status)
//   POST /api/pos-health/logs              — batched console logs
//   POST /api/pos-health/snapshot          — diagnostic dump (IndexedDB, POS state)
//   POST /api/pos-health/command-result    — result of a previously-queued command
//
//   ── Queries (Claude / dashboard pulls) ──
//   GET  /api/pos-health/status            — latest beacon per machine + flags
//   GET  /api/pos-health/history           — beacon history for a machine
//   GET  /api/pos-health/logs              — recent log lines
//   GET  /api/pos-health/snapshots         — recent diagnostic dumps
//   GET  /api/pos-health/command-result    — get result for a command id
//
//   ── Command queue (Claude pushes, terminal polls) ──
//   POST /api/pos-health/commands          — Claude enqueues a command
//   GET  /api/pos-health/commands          — terminal polls for pending cmds (machine_id required)
//
// Auth: every request must include `Authorization: Bearer <POS_BRIDGE_SECRET>`.
// Set POS_BRIDGE_SECRET in Cloudflare Pages env vars. The same value is
// stored in chrome.storage on the extension side. Beacon endpoint allows
// missing auth (so deployment isn't a chicken-and-egg) but logs the offence.

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const url = new URL(context.request.url);
  const sub = url.pathname.replace(/^\/api\/pos-health\/?/, '');
  const DB = context.env.DB;
  const SECRET = context.env.POS_BRIDGE_SECRET;
  if (!DB) return json({ success: false, error: 'DB not configured' }, cors, 500);

  // ── Auth check ────────────────────────────────────────────────
  const authOK = !SECRET || verifyAuth(context.request, SECRET);
  // beacon, logs, command-result are write paths from terminal — auth required if SECRET set
  // commands GET (terminal polls) — auth required
  // commands POST, status, history, snapshots, logs GET — operator queries, auth required
  const requiresAuth = sub !== '' && SECRET; // everything requires auth when SECRET is set
  if (requiresAuth && !authOK) {
    return json({ success: false, error: 'unauthorized' }, cors, 401);
  }

  try {
    await ensureSchema(DB);
    const method = context.request.method;

    // ── Telemetry from terminal ──
    if (sub === 'beacon' && method === 'POST') return await receiveBeacon(context, DB, cors);
    if (sub === 'logs' && method === 'POST') return await receiveLogs(context, DB, cors);
    if (sub === 'snapshot' && method === 'POST') return await receiveSnapshot(context, DB, cors);
    if (sub === 'command-result' && method === 'POST') return await receiveCommandResult(context, DB, cors);

    // ── Queries from operator/Claude ──
    if (sub === 'status' && method === 'GET') return await getStatus(DB, cors);
    if (sub === 'history' && method === 'GET') return await getHistory(url, DB, cors);
    if (sub === 'logs' && method === 'GET') return await getLogs(url, DB, cors);
    if (sub === 'snapshots' && method === 'GET') return await getSnapshots(url, DB, cors);
    if (sub === 'command-result' && method === 'GET') return await getCommandResult(url, DB, cors);

    // ── Command queue ──
    if (sub === 'commands' && method === 'POST') return await enqueueCommand(context, DB, cors);
    if (sub === 'commands' && method === 'GET') return await pollCommands(url, DB, cors);

    return json({ success: false, error: `Unknown path: ${sub}` }, cors, 404);
  } catch (e) {
    return json({ success: false, error: e.message, stack: e.stack }, cors, 500);
  }
}

// ── Auth ──────────────────────────────────────────────────────────
function verifyAuth(request, secret) {
  const h = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return false;
  return h.slice(7).trim() === secret;
}

// ── Schema bootstrap (creates all tables on first hit) ────────────
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

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS pos_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      received_at TEXT DEFAULT (datetime('now')),
      level TEXT NOT NULL,            -- 'debug'|'info'|'warn'|'error'
      source TEXT NOT NULL,           -- 'sw'|'content'|'main'|'popup'
      message TEXT NOT NULL,
      metadata TEXT                   -- JSON string of extra context (stack, args, etc.)
    )
  `).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_logs_machine_ts ON pos_logs(machine_id, ts DESC)`).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_logs_level ON pos_logs(level, ts DESC)`).run();

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS pos_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      received_at TEXT DEFAULT (datetime('now')),
      kind TEXT NOT NULL,             -- 'indexeddb'|'pos-state'|'full'|'manual'
      summary TEXT,                   -- short human-readable
      payload TEXT NOT NULL,          -- JSON dump (can be large)
      bytes INTEGER
    )
  `).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_snapshots_machine_ts ON pos_snapshots(machine_id, ts DESC)`).run();

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS pos_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      type TEXT NOT NULL,             -- 'snapshot'|'force-sync'|'reload-tab'|'eval'|'set-log-level'|'read-idb'|...
      params TEXT,                    -- JSON
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'claimed'|'completed'|'failed'|'expired'
      created_at TEXT DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT,
      created_by TEXT,                -- who enqueued it
      result TEXT,                    -- JSON result from terminal
      error TEXT
    )
  `).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cmds_machine_status ON pos_commands(machine_id, status, created_at DESC)`).run();
}

// ── POST /beacon ──────────────────────────────────────────────────
async function receiveBeacon(context, DB, cors) {
  const body = await context.request.json().catch(() => ({}));
  const { machine_id, ts } = body;
  if (!machine_id || !ts) return json({ success: false, error: 'machine_id and ts required' }, cors, 400);

  await DB.prepare(`
    INSERT INTO pos_beacons (
      machine_id, ts, online, pos_tab_open, unsynced_count,
      last_sync_attempt_at, last_sync_ok, last_error,
      extension_version, user_agent, reason, replayed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    machine_id, ts,
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

  await DB.prepare(`DELETE FROM pos_beacons WHERE id IN (SELECT id FROM pos_beacons ORDER BY id DESC LIMIT -1 OFFSET 5000)`).run().catch(() => {});

  return json({ success: true, received_at: new Date().toISOString() }, cors);
}

// ── POST /logs ────────────────────────────────────────────────────
async function receiveLogs(context, DB, cors) {
  const body = await context.request.json().catch(() => ({}));
  const { machine_id, logs } = body;
  if (!machine_id || !Array.isArray(logs)) {
    return json({ success: false, error: 'machine_id + logs[] required' }, cors, 400);
  }

  let inserted = 0;
  for (const l of logs.slice(0, 200)) { // cap per request
    if (!l.ts || !l.level || !l.source || l.message == null) continue;
    await DB.prepare(`
      INSERT INTO pos_logs (machine_id, ts, level, source, message, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      machine_id, l.ts, String(l.level), String(l.source),
      String(l.message).slice(0, 4000),
      l.metadata ? JSON.stringify(l.metadata).slice(0, 8000) : null,
    ).run();
    inserted++;
  }

  // Trim — keep last 20k log lines
  await DB.prepare(`DELETE FROM pos_logs WHERE id IN (SELECT id FROM pos_logs ORDER BY id DESC LIMIT -1 OFFSET 20000)`).run().catch(() => {});

  return json({ success: true, inserted }, cors);
}

// ── POST /snapshot ────────────────────────────────────────────────
async function receiveSnapshot(context, DB, cors) {
  const body = await context.request.json().catch(() => ({}));
  const { machine_id, ts, kind, summary, payload } = body;
  if (!machine_id || !ts || !kind || payload == null) {
    return json({ success: false, error: 'machine_id, ts, kind, payload required' }, cors, 400);
  }
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // D1 row size practical cap ~1MB; reject above 800KB to be safe
  if (payloadStr.length > 800_000) {
    return json({ success: false, error: 'payload too large (>800KB)' }, cors, 413);
  }

  const result = await DB.prepare(`
    INSERT INTO pos_snapshots (machine_id, ts, kind, summary, payload, bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(machine_id, ts, kind, summary || null, payloadStr, payloadStr.length).run();

  // Trim — keep last 500 snapshots total
  await DB.prepare(`DELETE FROM pos_snapshots WHERE id IN (SELECT id FROM pos_snapshots ORDER BY id DESC LIMIT -1 OFFSET 500)`).run().catch(() => {});

  return json({ success: true, snapshot_id: result.meta?.last_row_id }, cors);
}

// ── POST /command-result ──────────────────────────────────────────
async function receiveCommandResult(context, DB, cors) {
  const body = await context.request.json().catch(() => ({}));
  const { command_id, result, error } = body;
  if (!command_id) return json({ success: false, error: 'command_id required' }, cors, 400);

  const status = error ? 'failed' : 'completed';
  await DB.prepare(`
    UPDATE pos_commands
    SET status = ?, completed_at = datetime('now'),
        result = ?, error = ?
    WHERE id = ?
  `).bind(
    status,
    result == null ? null : (typeof result === 'string' ? result : JSON.stringify(result).slice(0, 50_000)),
    error ? String(error).slice(0, 4000) : null,
    command_id,
  ).run();

  return json({ success: true, status }, cors);
}

// ── POST /commands  (enqueue from operator) ───────────────────────
async function enqueueCommand(context, DB, cors) {
  const body = await context.request.json().catch(() => ({}));
  const { machine_id, type, params, created_by } = body;
  if (!machine_id || !type) return json({ success: false, error: 'machine_id and type required' }, cors, 400);

  const allowedTypes = ['snapshot', 'force-sync', 'reload-tab', 'eval', 'set-log-level', 'read-idb', 'reload-extension', 'beacon-now', 'clear-storage'];
  if (!allowedTypes.includes(type)) {
    return json({ success: false, error: `unknown command type: ${type}`, allowed: allowedTypes }, cors, 400);
  }

  const result = await DB.prepare(`
    INSERT INTO pos_commands (machine_id, type, params, created_by)
    VALUES (?, ?, ?, ?)
  `).bind(
    machine_id, type,
    params ? JSON.stringify(params) : null,
    created_by || 'unknown',
  ).run();

  return json({
    success: true,
    command_id: result.meta?.last_row_id,
    machine_id, type,
    poll_url: `/api/pos-health/command-result?id=${result.meta?.last_row_id}`,
  }, cors);
}

// ── GET /commands?machine_id=X  (terminal polls) ──────────────────
async function pollCommands(url, DB, cors) {
  const machine_id = url.searchParams.get('machine_id');
  if (!machine_id) return json({ success: false, error: 'machine_id required' }, cors, 400);

  // Atomically claim pending commands for this machine
  const rows = await DB.prepare(`
    SELECT id, type, params FROM pos_commands
    WHERE machine_id = ? AND status = 'pending'
    ORDER BY created_at ASC LIMIT 10
  `).bind(machine_id).all();

  const cmds = rows.results || [];
  if (cmds.length > 0) {
    const ids = cmds.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    await DB.prepare(`UPDATE pos_commands SET status='claimed', claimed_at=datetime('now') WHERE id IN (${placeholders})`)
      .bind(...ids).run();
  }

  // Expire commands older than 1 hour still 'pending' or 'claimed'
  await DB.prepare(`UPDATE pos_commands SET status='expired' WHERE status IN ('pending','claimed') AND created_at < datetime('now','-1 hour')`).run().catch(() => {});

  return json({
    success: true,
    commands: cmds.map(c => ({ id: c.id, type: c.type, params: c.params ? JSON.parse(c.params) : null })),
  }, cors);
}

// ── GET /status ───────────────────────────────────────────────────
async function getStatus(DB, cors) {
  const rows = await DB.prepare(`
    SELECT b.* FROM pos_beacons b
    INNER JOIN (SELECT machine_id, MAX(id) AS max_id FROM pos_beacons GROUP BY machine_id) latest
      ON b.id = latest.max_id
    ORDER BY b.ts DESC
  `).all();

  const now = Date.now();
  const machines = (rows.results || []).map((r) => {
    const ageSec = Math.round((now - new Date(r.ts).getTime()) / 1000);
    return { ...r, age_sec: ageSec, ...computeFlags(r, ageSec) };
  });

  const summary = {
    total: machines.length,
    healthy: machines.filter((m) => m.severity === 'ok').length,
    warning: machines.filter((m) => m.severity === 'warn').length,
    critical: machines.filter((m) => m.severity === 'crit').length,
  };

  return json({ success: true, summary, machines }, cors);
}

// ── GET /history ──────────────────────────────────────────────────
async function getHistory(url, DB, cors) {
  const machine_id = url.searchParams.get('machine_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
  if (!machine_id) return json({ success: false, error: 'machine_id required' }, cors, 400);

  const rows = await DB.prepare(`SELECT * FROM pos_beacons WHERE machine_id = ? ORDER BY id DESC LIMIT ?`).bind(machine_id, limit).all();
  return json({ success: true, machine_id, beacons: rows.results || [] }, cors);
}

// ── GET /logs ─────────────────────────────────────────────────────
async function getLogs(url, DB, cors) {
  const machine_id = url.searchParams.get('machine_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 1000);
  const level = url.searchParams.get('level'); // optional: 'error', 'warn', etc.
  const since = url.searchParams.get('since'); // optional ISO timestamp

  let sql = `SELECT * FROM pos_logs WHERE 1=1`;
  const binds = [];
  if (machine_id) { sql += ` AND machine_id = ?`; binds.push(machine_id); }
  if (level) { sql += ` AND level = ?`; binds.push(level); }
  if (since) { sql += ` AND ts >= ?`; binds.push(since); }
  sql += ` ORDER BY id DESC LIMIT ?`;
  binds.push(limit);

  const rows = await DB.prepare(sql).bind(...binds).all();
  return json({ success: true, count: (rows.results || []).length, logs: rows.results || [] }, cors);
}

// ── GET /snapshots ────────────────────────────────────────────────
async function getSnapshots(url, DB, cors) {
  const machine_id = url.searchParams.get('machine_id');
  const id = url.searchParams.get('id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

  if (id) {
    // Return one snapshot's full payload
    const row = await DB.prepare(`SELECT * FROM pos_snapshots WHERE id = ?`).bind(id).first();
    if (!row) return json({ success: false, error: 'not found' }, cors, 404);
    // Try to parse payload as JSON for convenience
    try { row.payload = JSON.parse(row.payload); } catch (_) {}
    return json({ success: true, snapshot: row }, cors);
  }

  // List recent snapshots (without payload — too big)
  let sql = `SELECT id, machine_id, ts, received_at, kind, summary, bytes FROM pos_snapshots`;
  const binds = [];
  if (machine_id) { sql += ` WHERE machine_id = ?`; binds.push(machine_id); }
  sql += ` ORDER BY id DESC LIMIT ?`;
  binds.push(limit);

  const rows = await DB.prepare(sql).bind(...binds).all();
  return json({ success: true, snapshots: rows.results || [] }, cors);
}

// ── GET /command-result?id=X ──────────────────────────────────────
async function getCommandResult(url, DB, cors) {
  const id = url.searchParams.get('id');
  if (!id) return json({ success: false, error: 'id required' }, cors, 400);
  const row = await DB.prepare(`SELECT * FROM pos_commands WHERE id = ?`).bind(id).first();
  if (!row) return json({ success: false, error: 'not found' }, cors, 404);
  // Parse JSON fields
  try { if (row.params) row.params = JSON.parse(row.params); } catch (_) {}
  try { if (row.result) row.result = JSON.parse(row.result); } catch (_) {}
  return json({ success: true, command: row }, cors);
}

// ── Health flag computation ───────────────────────────────────────
function computeFlags(b, ageSec) {
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
