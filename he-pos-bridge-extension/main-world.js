// HE POS Bridge — MAIN-world Script (v1.0)
// Runs in the same JS context as the Odoo POS app. Has direct access to
// the POS model, its sync functions, and the Owl runtime. Bridges to the
// ISOLATED content script via window.postMessage.

(function () {
  'use strict';
  const TAG = '[HE-Bridge main]';

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
      __he_bridge: true, type: 'pos-state',
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
      // Direct fallback — relative URL resolves to test.hamzahotel.com (same origin)
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
    try {
      const fn = new Function(`return (async () => { return (${code}) })()`);
      const value = await fn();
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
            __he_bridge: true, type: 'log',
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
        __he_bridge: true, type: 'log',
        payload: {
          ts: new Date().toISOString(), level: 'error', source,
          message: `[uncaught] ${ev.message}`,
          metadata: { filename: ev.filename, lineno: ev.lineno, colno: ev.colno, stack: ev.error?.stack },
        },
      }, '*');
    });
    window.addEventListener('unhandledrejection', (ev) => {
      window.postMessage({
        __he_bridge: true, type: 'log',
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
    if (!data || data.__he_bridge !== true) return;

    if (data.type === 'request-state') reportState();
    if (data.type === 'force-sync') {
      const r = await forceSync();
      if (data.command_id) {
        window.postMessage({ __he_bridge: true, type: 'main-command-result', command_id: data.command_id, result: r }, '*');
      }
    }
    if (data.type === 'main-command') {
      let result, error;
      try {
        if (data.main_type === 'snapshot') result = snapshotPosState();
        else if (data.main_type === 'eval') result = await runEval(data.payload?.code);
        else throw new Error('unknown main-command type: ' + data.main_type);
      } catch (e) { error = e.message; }
      window.postMessage({ __he_bridge: true, type: 'main-command-result', command_id: data.command_id, result, error }, '*');
    }
  });

  // ── Auto-sync on online event ───────────────────────────────
  window.addEventListener('online', () => {
    console.info(TAG, 'online event — attempting forceSync');
    setTimeout(forceSync, 2000);
  });

  setInterval(reportState, 30_000);
  setTimeout(reportState, 5000);

  // ── Captain Promise Pile (live badge in HE POS UI) ──────────
  // Mirrors NCH Runner Promise Pile pattern but uses /api/v2?action=captain-owes
  // (HE's per-operator cash settlement). Shows each FOH operator with their
  // 'owes' amount (cash collected - cash handed over). Plus counter UPI today
  // (qr_SFifkGfaapvPPX) — last 8 payments + total.
  // Visible on HE POS configs 5 (Cash Counter), 6 (Captain), 32 (GF Waiter).
  setTimeout(() => setupCaptainPile(), 8000);

  function setupCaptainPile() {
    try {
      const found = findPosModel();
      if (!found) { setTimeout(setupCaptainPile, 5000); return; }
      const configId = found.model.config?.id;
      if (![5, 6, 32].includes(configId)) {
        console.info(TAG, 'captain pile: not HE POS config 5/6/32, skipping');
        return;
      }

      if (document.getElementById('he-captain-pile-badge')) return;
      const badge = document.createElement('div');
      badge.id = 'he-captain-pile-badge';
      badge.style.cssText = [
        'position:fixed', 'top:60px', 'right:12px', 'z-index:99999',
        'background:#fff', 'border:2px solid #D4A44C', 'border-radius:8px',
        'padding:10px 12px', 'min-width:300px', 'max-width:340px',
        'max-height:560px', 'overflow-y:auto',
        'box-shadow:0 4px 14px rgba(0,0,0,0.15)',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif', 'font-size:12px',
        'color:#1F1A12', 'cursor:move', 'user-select:none',
      ].join(';');
      badge.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;border-bottom:1px solid #E5DBC9;padding-bottom:6px;">
          <strong style="font-size:11px;letter-spacing:.04em;color:#7A6B55;text-transform:uppercase;">Captain Promise Pile <small style="color:#D4A44C;font-weight:500;">HE v1.1</small></strong>
          <button id="he-cpp-close" style="background:transparent;border:0;color:#7A6B55;cursor:pointer;font-size:16px;padding:0 4px;">×</button>
        </div>
        <div id="he-cpp-body">Loading…</div>
        <div id="he-cpp-footer" style="font-size:9px;color:#7A6B55;margin-top:6px;text-align:right;">…</div>
      `;
      document.body.appendChild(badge);

      document.getElementById('he-cpp-close').addEventListener('click', () => {
        badge.style.display = 'none';
        try { sessionStorage.setItem('he_cpp_hidden', '1'); } catch (_) {}
      });
      try { if (sessionStorage.getItem('he_cpp_hidden') === '1') badge.style.display = 'none'; } catch (_) {}

      let dragging = false, ox = 0, oy = 0;
      badge.addEventListener('mousedown', e => {
        if (e.target.id === 'he-cpp-close') return;
        dragging = true;
        ox = e.clientX - badge.getBoundingClientRect().left;
        oy = e.clientY - badge.getBoundingClientRect().top;
      });
      document.addEventListener('mousemove', e => {
        if (!dragging) return;
        badge.style.left = (e.clientX - ox) + 'px';
        badge.style.top = (e.clientY - oy) + 'px';
        badge.style.right = 'auto';
      });
      document.addEventListener('mouseup', () => { dragging = false; });

      console.info(TAG, 'captain promise pile badge mounted on POS_' + configId);
      refreshCaptainPile();
      setInterval(refreshCaptainPile, 30_000);
    } catch (e) { console.error(TAG, 'setupCaptainPile failed', e); }
  }

  async function refreshCaptainPile() {
    const body = document.getElementById('he-cpp-body');
    const footer = document.getElementById('he-cpp-footer');
    if (!body) return;
    try {
      const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const fmtR = n => '₹' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

      // Parallel fetch: captain-owes + counter UPI last 8 (on hamzaexpress.in)
      const [coRes, ctrRes] = await Promise.all([
        fetch('https://hamzaexpress.in/api/v2?action=captain-owes').then(r => r.json()).catch(() => null),
        fetch('https://hamzaexpress.in/api/counter-recent?qr=qr_SFifkGfaapvPPX&limit=8').then(r => r.json()).catch(() => null),
      ]);

      // ─── Captain rows ───
      const operators = coRes?.operators || coRes?.data?.operators || [];
      const captainRows = operators.length === 0
        ? '<div style="color:#7A6B55;padding:6px 0;font-size:11px;">No active operators on shift</div>'
        : operators.map(op => {
            const owes = parseFloat(op.owes || 0);
            const color = owes <= 0 ? '#0A7A3A' : owes > 1000 ? '#B4291F' : '#C8651C';
            const weight = owes <= 0 ? '500' : '700';
            const role = (op.role || '').toUpperCase().slice(0, 3);
            return `<div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='block'?'none':'block'" style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dotted #F0E8D8;cursor:pointer;">
              <span style="color:#1F1A12;">${escHtml(op.name || '—')} <span style="color:#999;font-size:10px;">${escHtml(role)}</span></span>
              <span style="color:${color};font-weight:${weight};font-variant-numeric:tabular-nums;">${fmtR(owes)}</span>
            </div>
            <div style="display:none;font-size:10px;color:#7A6B55;padding:4px 8px 8px;background:#FFFAF0;border-bottom:1px solid #F0E8D8;">
              Collected ${fmtR(op.cash_collected)} · Handed ${fmtR(op.cash_handed_over)}${op.excess_handover > 0 ? ' · <span style="color:#B4291F;">Excess +' + fmtR(op.excess_handover) + '</span>' : ''}
            </div>`;
          }).join('');

      const totalOwes = operators.reduce((s, op) => s + (parseFloat(op.owes || 0)), 0);
      const totalLine = `<div style="display:flex;justify-content:space-between;padding-top:6px;margin-top:4px;border-top:2px solid #D4A44C;font-weight:700;">
        <span>Total pending</span>
        <span style="color:#D4A44C;font-variant-numeric:tabular-nums;">${fmtR(totalOwes)}</span>
      </div>`;

      // ─── Counter UPI section ───
      const counter = ctrRes?.success ? { amount: ctrRes.total_amount || 0, count: ctrRes.total_count || 0, payments: ctrRes.payments || [] } : { amount: 0, count: 0, payments: [] };
      const pmtList = (counter.payments || []).slice(0, 8).map(p => {
        const time = new Date(p.time).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
        const vpaShort = (p.vpa || '').replace(/^[^@]*@/, '@');
        return `<div style="display:flex;justify-content:space-between;font-size:10px;padding:2px 0;color:#7A6B55;font-variant-numeric:tabular-nums;">
          <span style="color:#1F1A12;">${escHtml(time)}</span>
          <span style="flex:1;text-align:center;color:#999;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;">${escHtml(vpaShort)}</span>
          <span style="color:#0A7A3A;font-weight:600;">${fmtR(p.amount)}</span>
        </div>`;
      }).join('');
      const counterSection = `<div style="margin-top:10px;padding-top:8px;border-top:2px dotted #E5DBC9;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong style="font-size:10px;letter-spacing:.04em;color:#7A6B55;text-transform:uppercase;">Counter UPI today</strong>
          <span style="color:#0A7A3A;font-weight:700;font-size:12px;font-variant-numeric:tabular-nums;">${fmtR(counter.amount)} · ${counter.count}</span>
        </div>
        ${pmtList || '<div style="font-size:10px;color:#7A6B55;text-align:center;padding:4px;">No UPI payments yet today</div>'}
      </div>`;

      body.innerHTML = captainRows + totalLine + counterSection;
      footer.textContent = `Updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })} · ${operators.length} operators · refresh 30s`;
    } catch (e) {
      console.warn(TAG, 'refreshCaptainPile error', e);
      body.innerHTML = `<div style="color:#B4291F;font-size:11px;">Refresh failed: ${e.message}</div>`;
    }
  }

  console.info(TAG, 'main-world script ready');
})();
