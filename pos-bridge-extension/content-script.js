// NCH POS Bridge — Content Script (ISOLATED world, v1.1)
// Bridges between MAIN-world script (Odoo POS runtime), the service worker,
// and the page's IndexedDB. Mirrors console output to the SW for cloud upload.
// Receives commands from SW (snapshot, eval, force-sync, read-idb) and either
// handles them itself or proxies to MAIN.

const POLL_INTERVAL_MS = 30_000;
const POS_INDEXEDDB_NAMES = ['pos_data', 'pos_database', 'pos'];

let pollHandle = null;
const pendingMainResults = new Map(); // command_id → resolve fn

// ── Mirror console.* to SW ───────────────────────────────────────
installLogMirror('content');

// ── Listen for messages from MAIN-world script ───────────────────
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.__nch_bridge !== true) return;

  if (data.type === 'pos-state') {
    sendStatusToSW({
      unsynced: data.unsyncedCount ?? 0,
      lastSyncAttemptAt: data.lastSyncAttemptAt ?? null,
      lastSyncOk: data.lastSyncOk ?? null,
      lastError: data.lastError ?? null,
      sessionId: data.sessionId ?? null,
      configId: data.configId ?? null,
      modelSource: data.modelSource ?? null,
    });
  }
  if (data.type === 'log') {
    chrome.runtime.sendMessage({ type: 'log-from-context', payload: data.payload }).catch(() => {});
  }
  if (data.type === 'main-command-result') {
    const r = pendingMainResults.get(data.command_id);
    if (r) {
      r({ ok: !data.error, result: data.result, error: data.error });
      pendingMainResults.delete(data.command_id);
    }
  }
});

// ── Listen for messages from SW ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'force-sync-attempt') {
    window.postMessage({ __nch_bridge: true, type: 'force-sync', command_id: msg.command_id || null }, '*');
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'get-status') {
    pollAndReport().then((r) => sendResponse(r)).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'run-command') {
    handleCommand(msg).then((r) => {
      // Async results are submitted by SW directly via 'command-result-from-content'
      if (r && r.synchronous_result !== undefined) sendResponse(r);
      else sendResponse({ ok: true, awaiting: true });
    }).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
});

// ── Command handlers ─────────────────────────────────────────────
async function handleCommand(msg) {
  const { command_id, cmd_type, params } = msg;
  switch (cmd_type) {
    case 'snapshot': return await handleSnapshot(command_id, params);
    case 'read-idb': return await handleReadIdb(command_id, params);
    case 'eval':     return await handleEval(command_id, params);
    default: throw new Error(`unknown content cmd: ${cmd_type}`);
  }
}

async function handleSnapshot(commandId, params) {
  const kind = params?.kind || 'full'; // 'idb-only' | 'pos-state' | 'full'
  const ts = new Date().toISOString();
  let payload = { kind, ts, url: window.location.href };

  if (kind === 'idb-only' || kind === 'full') {
    payload.indexeddb = await dumpIndexedDB(params?.idb_limit ?? 200);
  }
  if (kind === 'pos-state' || kind === 'full') {
    payload.pos_state = await requestFromMain('snapshot', { what: 'pos-state' }).catch((e) => ({ error: e.message }));
  }

  const summary = summarisePayload(payload);
  // Send snapshot directly to cloud via SW
  const machineId = await getMachineIdFromSW();
  await fetchViaSW('https://nawabichaihouse.com/api/pos-health/snapshot', 'POST', {
    machine_id: machineId, ts, kind, summary, payload,
  });
  // Also reply to SW with the result so command is marked completed
  chrome.runtime.sendMessage({ type: 'command-result-from-content', command_id: commandId, result: { ok: true, summary } }).catch(() => {});
  return { synchronous_result: undefined };
}

async function handleReadIdb(commandId, params) {
  const dbName = params?.db || null;
  const storeName = params?.store || null;
  const key = params?.key || null;
  const limit = params?.limit || 50;
  const out = await dumpIndexedDB(limit, { dbName, storeName, key });
  chrome.runtime.sendMessage({ type: 'command-result-from-content', command_id: commandId, result: out }).catch(() => {});
  return { synchronous_result: undefined };
}

async function handleEval(commandId, params) {
  const code = params?.code;
  if (!code || typeof code !== 'string') {
    chrome.runtime.sendMessage({ type: 'command-result-from-content', command_id: commandId, error: 'params.code (string) required' }).catch(() => {});
    return { synchronous_result: undefined };
  }
  try {
    // eval runs in MAIN world for full Odoo access
    const r = await requestFromMain('eval', { code });
    chrome.runtime.sendMessage({ type: 'command-result-from-content', command_id: commandId, result: r }).catch(() => {});
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'command-result-from-content', command_id: commandId, error: e.message }).catch(() => {});
  }
  return { synchronous_result: undefined };
}

// ── Bridge: ask MAIN-world to do something, await reply ──────────
function requestFromMain(type, payload) {
  const command_id = 'main-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingMainResults.delete(command_id);
      reject(new Error('main-world timeout'));
    }, 10_000);
    pendingMainResults.set(command_id, (r) => {
      clearTimeout(timeout);
      r.ok ? resolve(r.result) : reject(new Error(r.error || 'main error'));
    });
    window.postMessage({ __nch_bridge: true, type: 'main-command', main_type: type, command_id, payload }, '*');
  });
}

// ── IndexedDB dump (works without MAIN involvement) ──────────────
async function dumpIndexedDB(limit = 200, filter = {}) {
  const out = { databases: [] };
  let dbNames;
  if (filter.dbName) dbNames = [filter.dbName];
  else if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      dbNames = list.map((d) => d.name).filter(Boolean);
    } catch (_) { dbNames = POS_INDEXEDDB_NAMES; }
  } else { dbNames = POS_INDEXEDDB_NAMES; }

  for (const dbName of dbNames) {
    try {
      const db = await openDb(dbName);
      if (!db) continue;
      const dbInfo = { name: dbName, version: db.version, stores: [] };
      const stores = filter.storeName ? [filter.storeName] : Array.from(db.objectStoreNames || []);
      for (const storeName of stores) {
        if (!db.objectStoreNames.contains(storeName)) continue;
        try {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const count = await reqAsync(store.count());
          const entries = filter.key
            ? [{ key: filter.key, value: await reqAsync(store.get(filter.key)) }]
            : await dumpStoreEntries(store, limit);
          dbInfo.stores.push({ name: storeName, count, sample: entries });
        } catch (e) {
          dbInfo.stores.push({ name: storeName, error: e.message });
        }
      }
      db.close();
      out.databases.push(dbInfo);
    } catch (e) { out.databases.push({ name: dbName, error: e.message }); }
  }
  return out;
}

function openDb(name) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(name); } catch (e) { return resolve(null); }
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}
function reqAsync(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dumpStoreEntries(store, limit) {
  const out = [];
  return new Promise((resolve) => {
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur || out.length >= limit) return resolve(out);
      out.push({ key: cur.key, value: cur.value });
      cur.continue();
    };
    req.onerror = () => resolve(out);
  });
}

// ── Helpers ──────────────────────────────────────────────────────
async function pollAndReport() {
  window.postMessage({ __nch_bridge: true, type: 'request-state' }, '*');
  const idb = await readUnsyncedFromIndexedDB();
  if (idb.count !== null) sendStatusToSW({ unsynced: idb.count, source: idb.source });
  return { idb };
}

async function readUnsyncedFromIndexedDB() {
  for (const dbName of POS_INDEXEDDB_NAMES) {
    try {
      const db = await openDb(dbName);
      if (!db || !db.objectStoreNames || db.objectStoreNames.length === 0) { db?.close(); continue; }
      const stores = Array.from(db.objectStoreNames);
      const store = stores.find((s) => /order/i.test(s) && /(unsynced|pending|queue|sync)/i.test(s)) || stores.find((s) => /order/i.test(s));
      if (!store) { db.close(); continue; }
      const tx = db.transaction(store, 'readonly');
      const count = await reqAsync(tx.objectStore(store).count());
      db.close();
      return { source: `idb:${dbName}:${store}`, count };
    } catch (_) { /* try next */ }
  }
  return { source: 'idb:none', count: null };
}

function sendStatusToSW(payload) {
  try { chrome.runtime.sendMessage({ type: 'pos-status-update', payload }); } catch (_) {}
}

async function getMachineIdFromSW() {
  // Storage is shared between SW and content script
  const { nch_machine_id } = await chrome.storage.local.get(['nch_machine_id']);
  return nch_machine_id || 'nch-unknown';
}

async function fetchViaSW(url, method, body) {
  // Need authHeaders — content script can't read DEFAULT_SECRET, so ask SW
  // Easiest: read from chrome.storage directly here.
  const { nch_bridge_secret } = await chrome.storage.local.get(['nch_bridge_secret']);
  const secret = nch_bridge_secret || 'nch-pos-bridge-7f3a9c8e2d1b4a5f6e7d8c9b0a1c2d3e';
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

function summarisePayload(p) {
  const parts = [];
  if (p.indexeddb) {
    const dbs = p.indexeddb.databases || [];
    parts.push(`${dbs.length} db(s): ` + dbs.map((d) => `${d.name}(${(d.stores || []).reduce((s, st) => s + (st.count || 0), 0)})`).join(', '));
  }
  if (p.pos_state) {
    if (p.pos_state.error) parts.push(`pos-state error: ${p.pos_state.error}`);
    else parts.push(`unsynced=${p.pos_state.unsyncedCount} session=${p.pos_state.sessionId}`);
  }
  return parts.join(' · ');
}

// ── Log mirror ───────────────────────────────────────────────────
function installLogMirror(source) {
  const levels = ['info', 'warn', 'error'];
  const orig = {};
  for (const lvl of levels) {
    orig[lvl] = console[lvl] || console.log;
    console[lvl] = (...args) => {
      try { orig[lvl].apply(console, args); } catch (_) {}
      try {
        chrome.runtime.sendMessage({
          type: 'log-from-context',
          payload: {
            ts: new Date().toISOString(),
            level: lvl, source,
            message: args.map((a) => safeStringify(a)).join(' ').slice(0, 4000),
            metadata: extractStack(args),
          },
        }).catch(() => {});
      } catch (_) {}
    };
  }
  window.addEventListener('error', (ev) => {
    chrome.runtime.sendMessage({
      type: 'log-from-context',
      payload: {
        ts: new Date().toISOString(), level: 'error', source,
        message: `[uncaught] ${ev.message}`,
        metadata: { filename: ev.filename, lineno: ev.lineno, colno: ev.colno, stack: ev.error?.stack },
      },
    }).catch(() => {});
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

// ── Boot ─────────────────────────────────────────────────────────
function start() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(pollAndReport, POLL_INTERVAL_MS);
  setTimeout(pollAndReport, 2000);
  sendStatusToSW({ unsynced: 0, posOpen: true });
  console.info('[NCH-Bridge] content script ready');
}
if (document.readyState === 'complete') start();
else window.addEventListener('load', start);
