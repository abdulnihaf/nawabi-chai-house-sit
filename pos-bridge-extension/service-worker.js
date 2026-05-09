// NCH POS Bridge — Service Worker (v1.1)
// Long-lived background process. Responsibilities:
//   1. BEACON: heartbeat to cloud every 60 sec
//   2. LOGS: mirror console output from all extension contexts to cloud
//   3. COMMANDS: poll for queued commands every 30 sec, dispatch them, return results
//   4. SYNC TRIGGER: on `online` event, force the POS tab to retry sync
//
// All cloud calls send Authorization: Bearer <secret>. Secret is loaded
// from chrome.storage.local (popup-set) or falls back to DEFAULT_SECRET
// in config.js.

importScripts('config.js');
const CFG = self.NCH_BRIDGE_CONFIG;

const MACHINE_ID_KEY = 'nch_machine_id';
const SECRET_KEY = 'nch_bridge_secret';
const LOG_BUFFER_KEY = 'nch_log_buffer';
const OFFLINE_BEACONS_KEY = 'nch_offline_beacons';

// ── Capture console.* in this SW context ───────────────────────────
installLogMirror('sw');

// ── Setup ────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await ensureMachineId();
  chrome.alarms.create('beacon', { periodInMinutes: CFG.BEACON_INTERVAL_SEC / 60 });
  chrome.alarms.create('flush-logs', { periodInMinutes: CFG.LOG_FLUSH_INTERVAL_SEC / 60 });
  chrome.alarms.create('poll-commands', { periodInMinutes: CFG.COMMAND_POLL_INTERVAL_SEC / 60 });
  chrome.alarms.create('connectivity-check', { periodInMinutes: 0.5 });
  console.log('[NCH-Bridge] installed v', chrome.runtime.getManifest().version);
  updateBadge({ online: navigator.onLine, unsynced: 0, posOpen: false });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureMachineId();
  chrome.alarms.create('beacon', { periodInMinutes: CFG.BEACON_INTERVAL_SEC / 60 });
  chrome.alarms.create('flush-logs', { periodInMinutes: CFG.LOG_FLUSH_INTERVAL_SEC / 60 });
  chrome.alarms.create('poll-commands', { periodInMinutes: CFG.COMMAND_POLL_INTERVAL_SEC / 60 });
  chrome.alarms.create('connectivity-check', { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === 'beacon') await sendBeacon('alarm');
    else if (alarm.name === 'flush-logs') await flushLogs();
    else if (alarm.name === 'poll-commands') await pollAndDispatchCommands();
    else if (alarm.name === 'connectivity-check') await pingPosTabIfRecovered();
  } catch (e) { console.error('[NCH-Bridge] alarm error', alarm.name, e); }
});

// ── Messages from content script and popup ───────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'pos-status-update') {
    handleStatusUpdate(msg.payload, sender.tab);
    sendResponse({ ok: true });
  }
  if (msg.type === 'request-beacon') {
    sendBeacon('manual').then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'log-from-context') {
    // content/main script forwarding a log line
    bufferLog(msg.payload).catch(() => {});
    sendResponse({ ok: true });
  }
  if (msg.type === 'command-result-from-content') {
    submitCommandResult(msg.command_id, msg.result, msg.error);
    sendResponse({ ok: true });
  }
  return true;
});

// ── Latest known terminal state (refreshed by content script) ────
let latestStatus = {
  online: true,
  posOpen: false,
  unsynced: 0,
  lastSyncAttemptAt: null,
  lastSyncOk: null,
  lastError: null,
  posTabId: null,
};

async function handleStatusUpdate(payload, tab) {
  latestStatus = {
    ...latestStatus,
    ...payload,
    posOpen: true,
    posTabId: tab?.id || null,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ latestStatus });
  updateBadge(latestStatus);
}

// ── BEACON ───────────────────────────────────────────────────────
async function sendBeacon(reason) {
  const machineId = await getMachineId();
  const stored = await chrome.storage.local.get(['latestStatus']);
  const status = stored.latestStatus || latestStatus;
  const updatedAt = status.updatedAt ? new Date(status.updatedAt).getTime() : 0;
  const ageSec = (Date.now() - updatedAt) / 1000;
  const posOpen = ageSec < 120;

  const beacon = {
    machine_id: machineId,
    ts: new Date().toISOString(),
    online: navigator.onLine,
    pos_tab_open: posOpen,
    unsynced_count: posOpen ? (status.unsynced || 0) : null,
    last_sync_attempt_at: status.lastSyncAttemptAt || null,
    last_sync_ok: status.lastSyncOk,
    last_error: status.lastError || null,
    extension_version: chrome.runtime.getManifest().version,
    user_agent: navigator.userAgent,
    reason,
  };

  try {
    const res = await postToCloud(CFG.BEACON_PATH, beacon);
    if (!res.ok) console.warn('[NCH-Bridge] beacon HTTP', res.status);
  } catch (e) {
    console.warn('[NCH-Bridge] beacon offline, queueing:', e.message);
    await queueOfflineBeacon(beacon);
  }
  updateBadge({ ...status, online: navigator.onLine, posOpen });
}

async function queueOfflineBeacon(beacon) {
  const { [OFFLINE_BEACONS_KEY]: queue = [] } = await chrome.storage.local.get([OFFLINE_BEACONS_KEY]);
  queue.push(beacon);
  if (queue.length > 50) queue.splice(0, queue.length - 50);
  await chrome.storage.local.set({ [OFFLINE_BEACONS_KEY]: queue });
}

self.addEventListener('online', async () => {
  console.log('[NCH-Bridge] connectivity restored');
  const { [OFFLINE_BEACONS_KEY]: queue = [] } = await chrome.storage.local.get([OFFLINE_BEACONS_KEY]);
  for (const b of queue) {
    try { await postToCloud(CFG.BEACON_PATH, { ...b, replayed: true }); } catch (_) {}
  }
  await chrome.storage.local.set({ [OFFLINE_BEACONS_KEY]: [] });
  await sendBeacon('reconnect');
  await flushLogs();
  await pingPosTabIfRecovered();
});

// ── LOG MIRROR ───────────────────────────────────────────────────
function installLogMirror(source) {
  const levels = ['debug', 'info', 'warn', 'error'];
  const orig = {};
  for (const lvl of levels) {
    orig[lvl] = console[lvl] || console.log;
    console[lvl] = (...args) => {
      try { orig[lvl].apply(console, args); } catch (_) {}
      try {
        bufferLog({
          ts: new Date().toISOString(),
          level: lvl,
          source,
          message: args.map((a) => safeStringify(a)).join(' ').slice(0, 4000),
          metadata: extractStack(args),
        }).catch(() => {});
      } catch (_) { /* never let logging break the app */ }
    };
  }
  // Also catch unhandled errors
  self.addEventListener('error', (ev) => {
    bufferLog({
      ts: new Date().toISOString(),
      level: 'error', source,
      message: `[uncaught] ${ev.message}`,
      metadata: { filename: ev.filename, lineno: ev.lineno, colno: ev.colno, stack: ev.error?.stack },
    }).catch(() => {});
  });
  self.addEventListener('unhandledrejection', (ev) => {
    bufferLog({
      ts: new Date().toISOString(),
      level: 'error', source,
      message: `[unhandledrejection] ${ev.reason?.message || ev.reason}`,
      metadata: { stack: ev.reason?.stack },
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
  for (const a of args) {
    if (a instanceof Error) return { error: a.name, stack: a.stack };
  }
  return null;
}

async function bufferLog(entry) {
  const { [LOG_BUFFER_KEY]: buf = [] } = await chrome.storage.local.get([LOG_BUFFER_KEY]);
  buf.push(entry);
  // Cap at 500 in-buffer; flush will eat them. Drop oldest first.
  if (buf.length > 500) buf.splice(0, buf.length - 500);
  await chrome.storage.local.set({ [LOG_BUFFER_KEY]: buf });
  // Errors trigger immediate flush
  if (entry.level === 'error' && navigator.onLine) flushLogs().catch(() => {});
}

async function flushLogs() {
  const { [LOG_BUFFER_KEY]: buf = [] } = await chrome.storage.local.get([LOG_BUFFER_KEY]);
  if (buf.length === 0) return;
  const machineId = await getMachineId();
  // Send in batches of 100
  while (buf.length > 0) {
    const batch = buf.splice(0, 100);
    try {
      const res = await postToCloud(CFG.LOGS_PATH, { machine_id: machineId, logs: batch });
      if (!res.ok) {
        // put them back at front
        buf.unshift(...batch);
        break;
      }
    } catch (_) {
      buf.unshift(...batch);
      break;
    }
  }
  await chrome.storage.local.set({ [LOG_BUFFER_KEY]: buf });
}

// ── COMMAND POLLING & DISPATCH ───────────────────────────────────
async function pollAndDispatchCommands() {
  if (!navigator.onLine) return;
  const machineId = await getMachineId();
  let cmds;
  try {
    const res = await fetch(`${CFG.CLOUD_BASE}${CFG.COMMANDS_POLL_PATH}?machine_id=${encodeURIComponent(machineId)}`, {
      headers: await authHeaders(),
    });
    if (!res.ok) return;
    const j = await res.json();
    cmds = j.commands || [];
  } catch (e) { return; }

  for (const cmd of cmds) {
    dispatchCommand(cmd).catch((e) => submitCommandResult(cmd.id, null, e.message || String(e)));
  }
}

async function dispatchCommand(cmd) {
  console.log('[NCH-Bridge] dispatching command', cmd.id, cmd.type);
  switch (cmd.type) {
    case 'beacon-now':
      await sendBeacon('command');
      return submitCommandResult(cmd.id, { ok: true });

    case 'force-sync': {
      // Forward to all POS tabs
      const tabs = await chrome.tabs.query({ url: ['https://ops.hamzahotel.com/pos/ui*', 'https://ops.hamzahotel.com/odoo/pos*'] });
      if (tabs.length === 0) return submitCommandResult(cmd.id, null, 'no POS tab open');
      const replies = [];
      for (const tab of tabs) {
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'force-sync-attempt', command_id: cmd.id });
          replies.push({ tab_id: tab.id, reply: r });
        } catch (e) { replies.push({ tab_id: tab.id, error: e.message }); }
      }
      return submitCommandResult(cmd.id, { dispatched_to: replies });
    }

    case 'reload-tab': {
      const tabs = await chrome.tabs.query({ url: ['https://ops.hamzahotel.com/*'] });
      if (tabs.length === 0) return submitCommandResult(cmd.id, null, 'no POS tab to reload');
      for (const tab of tabs) await chrome.tabs.reload(tab.id);
      return submitCommandResult(cmd.id, { reloaded_tabs: tabs.map((t) => t.id) });
    }

    case 'reload-extension':
      submitCommandResult(cmd.id, { ok: true, note: 'reloading' });
      setTimeout(() => chrome.runtime.reload(), 500);
      return;

    case 'set-log-level': {
      const level = cmd.params?.level || CFG.DEFAULT_LOG_LEVEL;
      await chrome.storage.local.set({ nch_log_level: level });
      return submitCommandResult(cmd.id, { level_set: level });
    }

    case 'clear-storage': {
      const keep = await chrome.storage.local.get([MACHINE_ID_KEY, SECRET_KEY]);
      await chrome.storage.local.clear();
      await chrome.storage.local.set(keep);
      return submitCommandResult(cmd.id, { cleared: true });
    }

    case 'snapshot':
    case 'read-idb':
    case 'eval': {
      // Dispatch to content script (which forwards to MAIN world if needed)
      const tabs = await chrome.tabs.query({ url: ['https://ops.hamzahotel.com/pos/ui*', 'https://ops.hamzahotel.com/odoo/pos*'] });
      if (tabs.length === 0) {
        // Fall back: do snapshot/read-idb from SW context (no Odoo state, but IDB visible)
        if (cmd.type === 'read-idb') {
          // SW cannot access IDB scoped to Odoo origin, only its own. Return a note.
          return submitCommandResult(cmd.id, null, 'no POS tab open — cannot read Odoo origin IndexedDB');
        }
        return submitCommandResult(cmd.id, null, 'no POS tab open for this command type');
      }
      try {
        const r = await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'run-command', command_id: cmd.id, cmd_type: cmd.type, params: cmd.params,
        });
        // The content script will eventually call back via 'command-result-from-content'.
        // If sendMessage already returned a synchronous result, submit it.
        if (r && r.synchronous_result !== undefined) {
          return submitCommandResult(cmd.id, r.synchronous_result);
        }
        return; // wait for async callback
      } catch (e) { return submitCommandResult(cmd.id, null, 'tab message failed: ' + e.message); }
    }

    default:
      return submitCommandResult(cmd.id, null, `unknown command type: ${cmd.type}`);
  }
}

async function submitCommandResult(commandId, result, error) {
  try {
    await postToCloud(CFG.COMMAND_RESULT_PATH, { command_id: commandId, result, error: error || null });
    console.log('[NCH-Bridge] command', commandId, error ? 'failed:' + error : 'completed');
  } catch (e) { console.warn('[NCH-Bridge] could not submit command result', e); }
}

// ── On reconnect, force POS tab to push pending orders ───────────
async function pingPosTabIfRecovered() {
  if (!navigator.onLine) return;
  const tabs = await chrome.tabs.query({ url: ['https://ops.hamzahotel.com/pos/ui*', 'https://ops.hamzahotel.com/odoo/pos*'] });
  for (const tab of tabs) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'force-sync-attempt' }); } catch (_) {}
  }
}

// ── Auth + cloud helper ──────────────────────────────────────────
async function authHeaders() {
  const { [SECRET_KEY]: stored } = await chrome.storage.local.get([SECRET_KEY]);
  const token = stored || CFG.DEFAULT_SECRET;
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function postToCloud(path, body) {
  return fetch(`${CFG.CLOUD_BASE}${path}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
}

// ── Machine ID ───────────────────────────────────────────────────
async function ensureMachineId() {
  const { [MACHINE_ID_KEY]: existing } = await chrome.storage.local.get([MACHINE_ID_KEY]);
  if (existing) return existing;
  const id = 'nch-' + crypto.randomUUID();
  await chrome.storage.local.set({ [MACHINE_ID_KEY]: id });
  return id;
}
async function getMachineId() {
  const { [MACHINE_ID_KEY]: id } = await chrome.storage.local.get([MACHINE_ID_KEY]);
  return id || (await ensureMachineId());
}

// ── Badge ────────────────────────────────────────────────────────
function updateBadge(s) {
  let text = '', color = '#4caf50';
  if (!s.online) { text = 'OFF'; color = '#ef5350'; }
  else if (!s.posOpen) { text = '?'; color = '#ff9800'; }
  else if (s.unsynced > 0) { text = String(s.unsynced); color = s.unsynced >= 5 ? '#ef5350' : '#ff9800'; }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
