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

  // ── Runner Promise Pile (live badge in POS UI) ──────────────
  // Shows pending cash per runner (cashToCollect from /api/nch-data).
  // Visible on POS_27 and POS_28 only. Refreshes every 30s.
  // Cashier sees "Farooq has ₹420 pending" before issuing another token.
  setTimeout(() => setupRunnerPromisePile(), 8000);

  function setupRunnerPromisePile() {
    try {
      const found = findPosModel();
      if (!found) { setTimeout(setupRunnerPromisePile, 5000); return; }
      const configId = found.model.config?.id;
      if (![27, 28].includes(configId)) {
        console.info(TAG, 'runner promise pile: not POS_27/28, skipping');
        return;
      }

      // Build the badge once
      if (document.getElementById('nch-runner-promise-badge')) return;
      const badge = document.createElement('div');
      badge.id = 'nch-runner-promise-badge';
      badge.style.cssText = [
        'position:fixed', 'top:60px', 'right:12px', 'z-index:99999',
        'background:#fff', 'border:2px solid #AC7E54', 'border-radius:8px',
        'padding:10px 12px', 'min-width:240px', 'max-width:280px',
        'box-shadow:0 4px 14px rgba(0,0,0,0.15)',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif', 'font-size:12px',
        'color:#1F1A12', 'cursor:move', 'user-select:none',
      ].join(';');
      badge.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;border-bottom:1px solid #E5DBC9;padding-bottom:6px;">
          <strong style="font-size:11px;letter-spacing:.04em;color:#7A6B55;text-transform:uppercase;">Runner Promise Pile</strong>
          <div>
            <button id="nch-rpp-help" title="What if a runner shows pending but isn't active?" style="background:transparent;border:1px solid #E5DBC9;color:#7A6B55;cursor:pointer;font-size:11px;padding:0 6px;border-radius:3px;margin-right:4px;">?</button>
            <button id="nch-rpp-close" style="background:transparent;border:0;color:#7A6B55;cursor:pointer;font-size:16px;padding:0 4px;">×</button>
          </div>
        </div>
        <div id="nch-rpp-body">Loading…</div>
        <div id="nch-rpp-footer" style="font-size:9px;color:#7A6B55;margin-top:6px;text-align:right;">…</div>
      `;
      document.body.appendChild(badge);

      // Close button
      document.getElementById('nch-rpp-close').addEventListener('click', () => {
        badge.style.display = 'none';
        try { sessionStorage.setItem('nch_rpp_hidden', '1'); } catch (_) {}
      });
      // Help button
      document.getElementById('nch-rpp-help').addEventListener('click', (e) => {
        e.stopPropagation();
        showRppHelp();
      });
      // Honour user hide-this-session preference
      try { if (sessionStorage.getItem('nch_rpp_hidden') === '1') badge.style.display = 'none'; } catch (_) {}

      // Drag support (cashier can move the badge)
      makeDraggable(badge);

      console.info(TAG, 'runner promise pile badge mounted on POS_' + configId);
      refreshPile();
      setInterval(refreshPile, 30_000);
    } catch (e) { console.error(TAG, 'setupRunnerPromisePile failed', e); }
  }

  const RPP_RUNNERS = [
    { id: 64, code: 'RUN001' }, { id: 65, code: 'RUN002' }, { id: 66, code: 'RUN003' },
    { id: 67, code: 'RUN004' }, { id: 68, code: 'RUN005' },
  ];

  function relTime(iso) {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'just now';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 1) return d + 'd ago';
    if (h > 1) return h + 'h ago';
    if (m > 1) return m + 'min ago';
    return 'just now';
  }

  async function refreshPile() {
    const body = document.getElementById('nch-rpp-body');
    const footer = document.getElementById('nch-rpp-footer');
    if (!body) return;
    try {
      const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 5.5 * 3600000 + 86400000).toISOString().slice(0, 10);
      const [runnerResults, counterResp] = await Promise.all([
        Promise.allSettled(RPP_RUNNERS.map(async (r) => {
          const res = await fetch(`https://nawabichaihouse.com/api/settlement?action=runner-live&runner_id=${r.id}&barcode=${r.code}`);
          const d = await res.json();
          return { ...r, data: d };
        })),
        fetch(`https://nawabichaihouse.com/api/nch-data?from=${today}&to=${tomorrow}`).then(r => r.json()).catch(() => null),
      ]);
      const results = runnerResults;
      const counterUpi = counterResp?.data?.razorpayCounter || { amount: 0, count: 0, payments: [] };
      const rows = results.map((p) => {
        if (p.status === 'rejected' || !p.value?.data?.success) {
          const code = p.value?.code || '?';
          return { code, error: true };
        }
        const d = p.value.data;
        return {
          code: p.value.code,
          runnerId: p.value.id,
          cash: parseFloat(d.cash_to_collect || 0),
          tokens: parseFloat(d.tokens_amount || 0),
          sales: parseFloat(d.sales_amount || 0),
          upi: parseFloat(d.upi?.total || 0),
          lastSettledAt: d.lastSettlement?.settled_at || null,
          lastSettlerName: d.lastSettlement?.runner_name || null,
          posOfflineWarning: d.posOfflineWarning,
          orphanTokenTotal: parseFloat(d.orphanTokenTotal || 0),
        };
      });

      const total = rows.reduce((s, r) => s + (r.cash || 0), 0);
      const rowHtml = rows.map((r) => {
        if (r.error) return `<div style="padding:4px 0;color:#B4291F;font-size:10px;">${escHtml(r.code)}: error</div>`;
        const color = r.cash === 0 ? '#0A7A3A' : r.cash > 1000 ? '#B4291F' : '#C8651C';
        const weight = r.cash === 0 ? '500' : '700';
        const warn = r.posOfflineWarning ? '<span title="POS sync gap — orders trapped offline" style="color:#B4291F;font-size:10px;margin-left:4px;">⚠</span>' : '';
        const orphan = r.orphanTokenTotal > 0 ? `<span title="Orphan tokens ₹${r.orphanTokenTotal}" style="color:#C8651C;font-size:10px;margin-left:4px;">◆</span>` : '';
        return `<div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='block'?'none':'block'" style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dotted #F0E8D8;cursor:pointer;">
          <span style="color:#1F1A12;">${escHtml(r.code)}${warn}${orphan}</span>
          <span style="color:${color};font-weight:${weight};font-variant-numeric:tabular-nums;">₹${r.cash.toLocaleString('en-IN', {minimumFractionDigits: 0, maximumFractionDigits: 0})}</span>
        </div><div style="display:none;font-size:10px;color:#7A6B55;padding:4px 8px 8px;background:#FFFAF0;border-bottom:1px solid #F0E8D8;">
          T ₹${r.tokens.toLocaleString('en-IN')} · S ₹${r.sales.toLocaleString('en-IN')} · UPI -₹${r.upi.toLocaleString('en-IN')}<br>
          Last settled: <strong>${r.lastSettledAt ? relTime(r.lastSettledAt) : 'baseline (never settled)'}</strong>${r.lastSettlerName ? ' by ' + escHtml(r.lastSettlerName) : ''}
        </div>`;
      }).join('');

      // Counter UPI section — live razorpay payments on cash counter QR today
      const paymentsList = (counterUpi.payments || []).slice(0, 8).map(p => {
        const time = new Date(p.time).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
        const vpaShort = (p.vpa || '').replace(/^[^@]*@/, '@');
        return `<div style="display:flex;justify-content:space-between;font-size:10px;padding:2px 0;color:#7A6B55;font-variant-numeric:tabular-nums;">
          <span style="color:#1F1A12;">${escHtml(time)}</span>
          <span style="flex:1;text-align:center;color:#999;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;">${escHtml(vpaShort)}</span>
          <span style="color:#0A7A3A;font-weight:600;">₹${parseFloat(p.amount).toLocaleString('en-IN')}</span>
        </div>`;
      }).join('');
      const counterSection = `<div style="margin-top:10px;padding-top:8px;border-top:2px dotted #E5DBC9;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong style="font-size:10px;letter-spacing:.04em;color:#7A6B55;text-transform:uppercase;">Counter UPI today</strong>
          <span style="color:#0A7A3A;font-weight:700;font-size:12px;font-variant-numeric:tabular-nums;">₹${(counterUpi.amount || 0).toLocaleString('en-IN')} · ${counterUpi.count || 0}</span>
        </div>
        ${paymentsList || '<div style="font-size:10px;color:#7A6B55;text-align:center;padding:4px;">No UPI payments yet today</div>'}
      </div>`;

      body.innerHTML = rowHtml + `<div style="display:flex;justify-content:space-between;padding-top:6px;margin-top:4px;border-top:2px solid #AC7E54;font-weight:700;">
        <span>Total pending</span>
        <span style="color:#AC7E54;font-variant-numeric:tabular-nums;">₹${total.toLocaleString('en-IN', {minimumFractionDigits: 0, maximumFractionDigits: 0})}</span>
      </div>` + counterSection;
      footer.textContent = `Updated ${new Date().toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit', hour12: true})} · settlement-aware · refresh 30s`;
    } catch (e) {
      console.warn(TAG, 'refreshPile error', e);
      body.innerHTML = `<div style="color:#B4291F;font-size:11px;">Refresh failed: ${escHtml(e.message)}</div>`;
    }
  }

  function showRppHelp() {
    const existing = document.getElementById('nch-rpp-help-modal');
    if (existing) { existing.remove(); return; }
    const m = document.createElement('div');
    m.id = 'nch-rpp-help-modal';
    m.style.cssText = 'position:fixed;top:60px;right:300px;z-index:99999;background:#FFFCF6;border:2px solid #AC7E54;border-radius:8px;padding:12px 14px;width:340px;box-shadow:0 6px 18px rgba(0,0,0,0.18);font-family:-apple-system,sans-serif;font-size:11px;color:#1F1A12;line-height:1.5;';
    m.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid #E5DBC9;padding-bottom:6px;">
      <strong style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7A6B55;">If a runner shows pending but isn't active — 5 buckets</strong>
      <button onclick="document.getElementById('nch-rpp-help-modal').remove()" style="background:transparent;border:0;color:#7A6B55;cursor:pointer;font-size:16px;">×</button>
    </div>
    <div style="margin-bottom:8px;"><strong style="color:#0A7A3A;">A. Active with cash in hand</strong><br>Currently on shift, has unreturned cash. Will resolve at next settle. ✓</div>
    <div style="margin-bottom:8px;"><strong style="color:#C8651C;">B. Stale carryover</strong><br>Runner stopped working but never settled. Cash IS sitting with them OR missing. Needs investigation.</div>
    <div style="margin-bottom:8px;"><strong style="color:#C8651C;">C. Cross-attribution at POS</strong><br>Order was tagged to wrong runner. Real cash is with a different runner. Rectify partner_id.</div>
    <div style="margin-bottom:8px;"><strong style="color:#B4291F;">D. POS sync gap</strong> ⚠<br>Orders trapped in offline IndexedDB, missing from server. Force-sync the terminal first.</div>
    <div><strong style="color:#7A6B55;">E. Data-source bug</strong><br>(Fixed v1.2.1 — was happening in v1.2.0)</div>`;
    document.body.appendChild(m);
  }
  window.__nch_rpp_show_help = showRppHelp;

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function makeDraggable(el) {
    let isDragging = false, offsetX = 0, offsetY = 0;
    el.addEventListener('mousedown', (e) => {
      if (e.target.id === 'nch-rpp-close') return;
      isDragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
      el.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (isDragging) { isDragging = false; el.style.cursor = 'move'; }
    });
  }

  console.info(TAG, 'main-world script ready');
})();
