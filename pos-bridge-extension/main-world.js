// NCH POS Bridge — MAIN-world Script
// Runs in the same JavaScript context as the Odoo POS app (Owl/Vue runtime).
// Has direct access to the POS model and its sync functions.
// Reports state back to the ISOLATED content script via window.postMessage.

(function () {
  'use strict';
  const TAG = '[NCH-Bridge main]';
  console.log(TAG, 'injected into', window.location.href);

  let lastSyncAttemptAt = null;
  let lastSyncOk = null;
  let lastError = null;

  // ── Utility: find the live POS model (Odoo 17/18/19 variants) ──
  function findPosModel() {
    // 1. Newer Odoo (17/18+): exposed on window.posmodel or window.posModel
    if (window.posmodel) return { model: window.posmodel, source: 'window.posmodel' };
    if (window.posModel) return { model: window.posModel, source: 'window.posModel' };

    // 2. Owl env (Odoo 17+): __owl__ on root component or env
    const root = document.querySelector('.pos, .pos-screen, .pos-content');
    if (root && root.__owl__) {
      const env = root.__owl__.app?.env;
      if (env?.services?.pos) {
        return { model: env.services.pos, source: 'owl.env.services.pos' };
      }
    }

    // 3. Try odoo global
    if (window.odoo?.__DEBUG__?.services?.['point_of_sale.pos_store']) {
      return {
        model: window.odoo.__DEBUG__.services['point_of_sale.pos_store'],
        source: 'odoo.__DEBUG__',
      };
    }
    return null;
  }

  // ── Utility: count unsynced orders ─────────────────────────────
  function getUnsyncedOrderCount(pos) {
    if (!pos) return null;
    try {
      // Odoo 17+: pos.db.get_unpaid_orders_to_sync() or pos.unsynced_orders
      if (typeof pos.db?.get_unpaid_orders_to_sync === 'function') {
        const list = pos.db.get_unpaid_orders_to_sync() || [];
        return list.length;
      }
      // Odoo 18/19: pos.models['pos.order'].filter(o => !o.id || typeof o.id === 'string')
      // Locally-created orders have string ids until synced
      if (pos.models?.['pos.order']) {
        const all = pos.models['pos.order'].getAll?.() || [];
        const local = all.filter((o) => typeof o.id === 'string' || o.id < 0 || o.uiState?.unsynced);
        return local.length;
      }
      // Older POS: pos.get_order_list().filter(o => !o.server_id)
      if (typeof pos.get_order_list === 'function') {
        const orders = pos.get_order_list() || [];
        return orders.filter((o) => !o.server_id && !o.backendId).length;
      }
    } catch (e) {
      console.warn(TAG, 'count error', e);
    }
    return null;
  }

  function getSessionInfo(pos) {
    if (!pos) return {};
    try {
      const session = pos.pos_session || pos.session || pos.config?.current_session_id;
      const config = pos.config;
      return {
        sessionId: session?.id || null,
        sessionName: session?.name || null,
        configId: config?.id || null,
        configName: config?.name || null,
      };
    } catch (_) { return {}; }
  }

  // ── Force-sync attempt ─────────────────────────────────────────
  async function forceSync() {
    const found = findPosModel();
    if (!found) {
      lastSyncOk = false;
      lastError = 'POS model not found';
      reportState();
      return { ok: false, reason: 'no-pos-model' };
    }
    const pos = found.model;
    lastSyncAttemptAt = new Date().toISOString();

    try {
      // Try every known sync method, in order of preference
      const candidates = [
        () => pos.push_orders_with_closing_popup?.(),
        () => pos.push_orders?.(),
        () => pos.syncAllOrders?.(),
        () => pos.sync_from_ui?.(),
        () => pos.db?.flush_orders?.(),
      ];
      for (const fn of candidates) {
        try {
          const result = fn();
          if (result !== undefined) {
            const awaited = result?.then ? await result : result;
            lastSyncOk = true;
            lastError = null;
            reportState();
            return { ok: true, via: fn.toString().slice(0, 80) };
          }
        } catch (e) {
          // try next method
          lastError = e.message || String(e);
        }
      }
      // Last-ditch: directly post to Odoo /pos/sync_pos_order with locally-queued orders
      const localOrders = collectLocalOrderJSON(pos);
      if (localOrders.length > 0) {
        const csrfToken = window.odoo?.csrf_token || document.querySelector('input[name="csrf_token"]')?.value;
        const res = await fetch('/web/dataset/call_kw/pos.order/sync_from_ui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: { model: 'pos.order', method: 'sync_from_ui', args: [localOrders], kwargs: {} },
          }),
        });
        if (res.ok) {
          lastSyncOk = true;
          lastError = null;
          reportState();
          return { ok: true, via: 'direct-sync_from_ui', count: localOrders.length };
        }
        lastError = `direct sync HTTP ${res.status}`;
      }
      lastSyncOk = false;
      reportState();
      return { ok: false, reason: 'no-sync-method-worked' };
    } catch (e) {
      lastSyncOk = false;
      lastError = e.message || String(e);
      reportState();
      return { ok: false, error: lastError };
    }
  }

  function collectLocalOrderJSON(pos) {
    try {
      const orders = pos.get_order_list?.() || pos.models?.['pos.order']?.getAll?.() || [];
      return orders
        .filter((o) => !o.server_id && !o.backendId && (typeof o.id === 'string' || o.id < 0))
        .map((o) => (typeof o.export_as_JSON === 'function' ? o.export_as_JSON() : o.serialize ? o.serialize() : o));
    } catch (_) { return []; }
  }

  // ── Report state to ISOLATED content script ────────────────────
  function reportState() {
    const found = findPosModel();
    const pos = found?.model;
    const unsynced = getUnsyncedOrderCount(pos);
    const session = getSessionInfo(pos);

    window.postMessage(
      {
        __nch_bridge: true,
        type: 'pos-state',
        unsyncedCount: unsynced,
        lastSyncAttemptAt,
        lastSyncOk,
        lastError,
        ...session,
        modelSource: found?.source || null,
      },
      '*'
    );
  }

  // ── Listen for requests from content script ────────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__nch_bridge !== true) return;
    if (data.type === 'request-state') reportState();
    if (data.type === 'force-sync') forceSync();
  });

  // ── Auto-sync attempt on `online` event ────────────────────────
  window.addEventListener('online', () => {
    console.log(TAG, 'online event — attempting forceSync');
    setTimeout(forceSync, 2000); // give the network a moment to stabilize
  });

  // ── Periodic state report (every 30 sec) ───────────────────────
  setInterval(reportState, 30_000);
  // Initial report after a short delay to let POS finish booting
  setTimeout(reportState, 5000);
})();
