// /api/pos-health-autofix — Auto-fix cron for stuck POS terminals.
//
// Trigger this every 5 min from external cron (or chain from wa-alerts cron-tick).
//
// What it does (purely defined, no operational-context decisions):
//   1. Read pos-health status of all NCH terminals
//   2. For each terminal with severity=crit OR (unsynced>0 AND sync-stuck reason):
//      → queue an eval command that detects + removes corrupted orders matching
//        the SAFE pattern (state=paid + finalized + 0 payment lines + >24h old +
//        not the currently selected order)
//   3. Log each fix attempt to pos_auto_fix_log table
//   4. Returns summary
//
// SAFETY:
//   - Never touches drafts (state != 'paid')
//   - Never touches recent orders (<24h old) — gives the cashier time to notice
//     and fix manually
//   - Never touches the order the cashier is currently editing
//   - Never touches orders with payment lines (those represent real money flow)
//   - Eval is idempotent — re-running does nothing if nothing matches
//
// This pattern was validated manually on 2026-05-23 when terminal
// nch-4c856699 had 12 stuck orders (10 corrupted + 2 active drafts).
// The 10 corrupted were cleared, the 2 drafts left intact.

const POS_BRIDGE_SECRET = 'nch-pos-bridge-7f3a9c8e2d1b4a5f6e7d8c9b0a1c2d3e';
const CLOUD_BASE = 'https://nawabichaihouse.com';

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const secret = context.env.POS_BRIDGE_SECRET || POS_BRIDGE_SECRET;
  const DB = context.env.DB;

  try {
    // ──────── 1. Read terminal status ─────────────────────────
    const statusRes = await fetch(`${CLOUD_BASE}/api/pos-health/status`, {
      headers: { 'Authorization': `Bearer ${secret}` },
    });
    if (!statusRes.ok) throw new Error(`status fetch HTTP ${statusRes.status}`);
    const statusJson = await statusRes.json();
    const machines = statusJson.machines || [];

    // ──────── 2. Identify candidates for auto-fix ────────────
    // Auto-fix triggers when a terminal has been stuck for at least 5 min
    // (>1 beacon cycle) AND has unsynced orders. Excludes terminals where
    // sync is just normally pending (small queue, recent activity).
    const candidates = machines.filter(m => {
      const stuck = m.severity === 'crit' || (m.unsynced_count > 5 && m.reason === 'sync-stuck');
      return stuck && m.pos_tab_open === 1;
    });

    const actions = [];
    for (const m of candidates) {
      // STEP 1: Queue force-sync FIRST — handles legitimate stuck orders
      // (sequence gap, real orders sitting in IDB that just need to push up).
      // Validated 2026-05-23: drained 14 stuck on Runner Counter in one shot.
      try {
        const fs = await queueForceSync(secret, m.machine_id);
        actions.push({ machine_id: m.machine_id, action: 'force-sync', command_id: fs.command_id, status: 'queued' });
      } catch (e) {
        actions.push({ machine_id: m.machine_id, action: 'force-sync', status: 'queue_failed', error: e.message });
      }
      // STEP 2: Queue corruption cleanup eval — handles paid+0-payment ghosts
      // that force-sync can't drain (server would reject them anyway).
      try {
        const r = await queueCorruptionCleanup(secret, m.machine_id);
        actions.push({ machine_id: m.machine_id, action: 'corruption-cleanup', unsynced_before: m.unsynced_count, command_id: r.command_id, status: 'queued' });
      } catch (e) {
        actions.push({ machine_id: m.machine_id, action: 'corruption-cleanup', status: 'queue_failed', error: e.message });
      }
    }

    // ──────── 3. Log to DB if available ─────────────────────
    if (DB && actions.length > 0) {
      try {
        await DB.prepare(
          `CREATE TABLE IF NOT EXISTS pos_auto_fix_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id TEXT,
            unsynced_before INTEGER,
            command_id INTEGER,
            status TEXT,
            error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`
        ).run();
        for (const a of actions) {
          await DB.prepare(
            `INSERT INTO pos_auto_fix_log (machine_id, unsynced_before, command_id, status, error) VALUES (?,?,?,?,?)`
          ).bind(a.machine_id, a.unsynced_before || 0, a.command_id || null, a.status, a.error || null).run();
        }
      } catch (_) { /* don't fail the autofix on logging errors */ }
    }

    return new Response(JSON.stringify({
      success: true,
      total_machines: machines.length,
      candidates: candidates.length,
      actions,
      note: candidates.length === 0 ? 'No stuck terminals — no action needed.' : 'Cleanup queued; terminals will pick up within 30 sec.',
    }), { headers: cors });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, stack: e.stack }), {
      status: 500, headers: cors,
    });
  }
}

async function queueForceSync(secret, machineId) {
  const res = await fetch(`${CLOUD_BASE}/api/pos-health/commands`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_id: machineId, type: 'force-sync', created_by: 'auto-fix-cron' }),
  });
  if (!res.ok) throw new Error(`force-sync queue HTTP ${res.status}`);
  return await res.json();
}

async function queueCorruptionCleanup(secret, machineId) {
  // The exact eval that worked on 2026-05-23.
  // Filters in the eval itself — safe to call on healthy terminals (no-op).
  const code = `(() => {
    const pos = window.posmodel || document.querySelector(".pos")?.__owl__?.app?.env?.services?.pos;
    if (!pos) return { error: "no pos model" };
    const all = pos.models?.["pos.order"]?.getAll?.() || pos.get_order_list?.() || [];
    const unsynced = all.filter(o => typeof o.id === "string" || o.id < 0);
    const currentId = pos.get_order?.()?.id || pos.selectedOrder?.id || null;
    const dayAgoMs = Date.now() - 24*3600*1000;
    const corrupted = unsynced.filter(o => {
      if (o.id === currentId) return false;
      const payCount = (o.payment_ids?.length) || (o.paymentlines?.length) || 0;
      const orderTs = new Date(o.date_order || o.creation_date || 0).getTime();
      return o.state === "paid" && o.finalized && payCount === 0 && orderTs > 0 && orderTs < dayAgoMs;
    });
    const removed = [];
    for (const o of corrupted) {
      try {
        if (pos.models?.["pos.order"]?.delete) {
          pos.models["pos.order"].delete(o);
          removed.push({ id: o.id, date: o.date_order, amount: o.amount_total });
        } else { removed.push({ id: o.id, error: "no delete method" }); }
      } catch(e) { removed.push({ id: o.id, error: e.message }); }
    }
    const after = (pos.models?.["pos.order"]?.getAll?.() || []).filter(o => typeof o.id === "string" || o.id < 0).length;
    return {
      total_unsynced_before: unsynced.length,
      corrupted_found: corrupted.length,
      removed,
      total_unsynced_after: after,
      action: corrupted.length > 0 ? "cleaned" : "no_corruption_detected"
    };
  })()`;

  const res = await fetch(`${CLOUD_BASE}/api/pos-health/commands`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: machineId,
      type: 'eval',
      params: { code },
      created_by: 'auto-fix-cron',
    }),
  });
  if (!res.ok) throw new Error(`commands HTTP ${res.status}`);
  return await res.json();
}
