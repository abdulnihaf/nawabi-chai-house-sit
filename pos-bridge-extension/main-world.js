// NCH POS Bridge — MAIN-world Script (v1.1)
// Runs in the same JS context as the Odoo POS app. Has direct access to
// the POS model, its sync functions, and the Owl runtime. Bridges to the
// ISOLATED content script via window.postMessage.

(function () {
  'use strict';
  const TAG = '[NCH-Bridge main]';

  let lastSyncAttemptAt = null;
  let lastSyncOk = null;
  let lastError = null;

  function findPosModel() {
    if (window.posmodel) return { model: window.posmodel, source: 'window.posmodel' };
    if (window.posModel) return { model: window.posModel, source: 'window.posModel' };
    const root = document.querySelector('.pos, .pos-screen, .pos-content');
    if (root && root.__owl__) {
      const env = root.__owl__.app?.env;
      if (env?.services?.pos) return { model: env.services.pos, source: 'owl.env.services.pos' };
    }
    if (window.odoo?.__DEBUG__?.services?.['point_of_sale.pos_store']) {
      return { model: window.odoo.__DEBUG__.services['point_of_sale.pos_store'], source: 'odoo.__DEBUG__' };
    }
    return null;
  }

  function getUnsyncedOrderCount(pos) {
    if (!pos) return null;
    try {
      if (typeof pos.db?.get_unpaid_orders_to_sync === 'function') return (pos.db.get_unpaid_orders_to_sync() || []).length;
      if (pos.models?.['pos.order']) {
        const all = pos.models['pos.order'].getAll?.() || [];
        return all.filter((o) => typeof o.id === 'string' || o.id < 0 || o.uiState?.unsynced).length;
      }
      if (typeof pos.get_order_list === 'function') {
        return (pos.get_order_list() || []).filter((o) => !o.server_id && !o.backendId).length;
      }
    } catch (_) {}
    return null;
  }

  function getSessionInfo(pos) {
    if (!pos) return {};
    try {
      const session = pos.pos_session || pos.session || null;
      const config = pos.config;
      return {
        sessionId: session?.id || null,
        sessionName: session?.name || null,
        configId: config?.id || null,
        configName: config?.name || null,
      };
    } catch (_) { return {}; }
  }

  function reportState() {
    const found = findPosModel();
    const pos = found?.model;
    const unsynced = getUnsyncedOrderCount(pos);
    const session = getSessionInfo(pos);
    window.postMessage({
      __nch_bridge: true, type: 'pos-state',
      unsyncedCount: unsynced,
      lastSyncAttemptAt, lastSyncOk, lastError,
      ...session,
      modelSource: found?.source || null,
    }, '*');
  }

  // ── Force sync ────────────────────────────────────────────────
  async function forceSync() {
    const found = findPosModel();
    if (!found) { lastSyncOk = false; lastError = 'POS model not found'; reportState(); return { ok: false, reason: 'no-pos-model' }; }
    const pos = found.model;
    lastSyncAttemptAt = new Date().toISOString();
    try {
      const candidates = [
        () => pos.push_orders_with_closing_popup?.(),
        () => pos.push_orders?.(),
        () => pos.syncAllOrders?.(),
        () => pos.sync_from_ui?.(),
        () => pos.db?.flush_orders?.(),
      ];
      for (const fn of candidates) {
        try {
          const r = fn();
          if (r !== undefined) {
            const awaited = r?.then ? await r : r;
            lastSyncOk = true; lastError = null; reportState();
            return { ok: true, via: fn.toString().slice(0, 80), result: awaited == null ? 'void' : 'value' };
          }
        } catch (e) { lastError = e.message || String(e); }
      }
      // Direct fallback
      const localOrders = collectLocalOrderJSON(pos);
      if (localOrders.length > 0) {
        const res = await fetch('/web/dataset/call_kw/pos.order/sync_from_ui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            params: { model: 'pos.order', method: 'sync_from_ui', args: [localOrders], kwargs: {} },
          }),
        });
        if (res.ok) {
          lastSyncOk = true; lastError = null; reportState();
          return { ok: true, via: 'direct-sync_from_ui', count: localOrders.length };
        }
        lastError = `direct sync HTTP ${res.status}`;
      }
      lastSyncOk = false; reportState();
      return { ok: false, reason: 'no-sync-method-worked' };
    } catch (e) {
      lastSyncOk = false; lastError = e.message || String(e); reportState();
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

  // ── Snapshot of POS state ────────────────────────────────────
  function snapshotPosState() {
    const found = findPosModel();
    if (!found) return { error: 'no pos model', pageUrl: window.location.href };
    const pos = found.model;
    const out = {
      modelSource: found.source,
      ...getSessionInfo(pos),
      unsyncedCount: getUnsyncedOrderCount(pos),
      timestamp: new Date().toISOString(),
    };
    try {
      // Sample of orders (avoid dumping everything)
      const orders = pos.get_order_list?.() || pos.models?.['pos.order']?.getAll?.() || [];
      out.orders_total = orders.length;
      out.orders_sample = orders.slice(0, 10).map((o) => ({
        id: o.id, uid: o.uid, server_id: o.server_id, backendId: o.backendId,
        date: o.date_order || o.creation_date,
        amount: o.amount_total ?? o.get_total_with_tax?.(),
        partner_id: o.partner_id?.id || o.partner_id,
        unsynced: typeof o.id === 'string' || o.id < 0,
      }));
    } catch (e) { out.orders_error = e.message; }
    try { out.payment_methods = (pos.config?.payment_method_ids || pos.payment_methods || []).map((p) => ({ id: p.id, name: p.name })); } catch (_) {}
    try { out.cashiers = (pos.cashier ? [pos.cashier] : (pos.employees || [])).slice(0, 5).map((e) => ({ id: e.id, name: e.name })); } catch (_) {}
    return out;
  }

  // ── Eval ─────────────────────────────────────────────────────
  async function runEval(code) {
    // Wrapped so async expressions work; user gets the awaited value.
    try {
      const fn = new Function(`return (async () => { return (${code}) })()`);
      const value = await fn();
      // Stringify for transport, with a fallback for circulars.
      let serialised;
      try { serialised = JSON.parse(JSON.stringify(value)); } catch (_) { serialised = String(value); }
      return { ok: true, value: serialised };
    } catch (e) {
      return { ok: false, error: e.message, stack: e.stack };
    }
  }

  // ── Mirror console output to content script ─────────────────
  installLogMirror('main');

  function installLogMirror(source) {
    const levels = ['info', 'warn', 'error'];
    const orig = {};
    for (const lvl of levels) {
      orig[lvl] = console[lvl] || console.log;
      console[lvl] = (...args) => {
        try { orig[lvl].apply(console, args); } catch (_) {}
        try {
          window.postMessage({
            __nch_bridge: true, type: 'log',
            payload: {
              ts: new Date().toISOString(),
              level: lvl, source,
              message: args.map((a) => safeStringify(a)).join(' ').slice(0, 4000),
              metadata: extractStack(args),
            },
          }, '*');
        } catch (_) {}
      };
    }
    window.addEventListener('error', (ev) => {
      window.postMessage({
        __nch_bridge: true, type: 'log',
        payload: {
          ts: new Date().toISOString(), level: 'error', source,
          message: `[uncaught] ${ev.message}`,
          metadata: { filename: ev.filename, lineno: ev.lineno, colno: ev.colno, stack: ev.error?.stack },
        },
      }, '*');
    });
    window.addEventListener('unhandledrejection', (ev) => {
      window.postMessage({
        __nch_bridge: true, type: 'log',
        payload: {
          ts: new Date().toISOString(), level: 'error', source,
          message: `[unhandledrejection] ${ev.reason?.message || ev.reason}`,
          metadata: { stack: ev.reason?.stack },
        },
      }, '*');
    });
  }
  function safeStringify(x) {
    if (x == null) return String(x);
    if (typeof x === 'string') return x;
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    try { return JSON.stringify(x); } catch (_) { return String(x); }
  }
  function extractStack(args) {
    for (const a of args) if (a instanceof Error) return { error: a.name, stack: a.stack };
    return null;
  }

  // ── Listen for content-script requests ──────────────────────
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__nch_bridge !== true) return;

    if (data.type === 'request-state') reportState();
    if (data.type === 'force-sync') {
      const r = await forceSync();
      if (data.command_id) {
        window.postMessage({ __nch_bridge: true, type: 'main-command-result', command_id: data.command_id, result: r }, '*');
      }
    }
    if (data.type === 'main-command') {
      let result, error;
      try {
        if (data.main_type === 'snapshot') result = snapshotPosState();
        else if (data.main_type === 'eval') result = await runEval(data.payload?.code);
        else throw new Error('unknown main-command type: ' + data.main_type);
      } catch (e) { error = e.message; }
      window.postMessage({ __nch_bridge: true, type: 'main-command-result', command_id: data.command_id, result, error }, '*');
    }
  });

  // ── Auto-sync on online event ───────────────────────────────
  window.addEventListener('online', () => {
    console.info(TAG, 'online event — attempting forceSync');
    setTimeout(forceSync, 2000);
  });

  setInterval(reportState, 30_000);
  setTimeout(reportState, 5000);
  console.info(TAG, 'main-world script ready');
})();
