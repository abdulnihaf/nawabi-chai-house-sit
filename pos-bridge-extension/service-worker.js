// NCH POS Bridge — Service Worker
// Runs in background, sends health beacons to the cloud every 60 sec.
// Triggers force-sync attempts when connectivity returns after an outage.
// Also wakes up via chrome.alarms even when no POS tab is open, so we
// always know the terminal's status.

const BEACON_URL = 'https://nawabichaihouse.com/api/pos-health';
const BEACON_INTERVAL_SEC = 60;
const MACHINE_ID_KEY = 'nch_machine_id';

// ── Setup ─────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await ensureMachineId();
  chrome.alarms.create('beacon', { periodInMinutes: 1 });
  chrome.alarms.create('connectivity-check', { periodInMinutes: 0.5 });
  console.log('[NCH-Bridge] installed, alarms armed');
  updateBadge({ online: navigator.onLine, unsynced: 0, posOpen: false });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureMachineId();
  chrome.alarms.create('beacon', { periodInMinutes: 1 });
  chrome.alarms.create('connectivity-check', { periodInMinutes: 0.5 });
});

// ── Alarm handlers ────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'beacon') {
    await sendBeacon('alarm');
  } else if (alarm.name === 'connectivity-check') {
    // After an outage, ping the POS tab to push pending orders
    await pingPosTabIfRecovered();
  }
});

// ── Messages from content script ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'pos-status-update') {
    handleStatusUpdate(msg.payload, sender.tab);
    sendResponse({ ok: true });
  }
  if (msg.type === 'request-beacon') {
    sendBeacon('content-request');
    sendResponse({ ok: true });
  }
  return true;
});

// ── Track latest known status (from content script) ───────────────
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

// ── Beacon sender ─────────────────────────────────────────────────
async function sendBeacon(reason) {
  const machineId = await getMachineId();
  const stored = await chrome.storage.local.get(['latestStatus']);
  const status = stored.latestStatus || latestStatus;

  // If no recent update from content script, mark posOpen=false
  const updatedAt = status.updatedAt ? new Date(status.updatedAt).getTime() : 0;
  const ageSec = (Date.now() - updatedAt) / 1000;
  const posOpen = ageSec < 120; // content script reports every 30 sec, allow 2 min slack

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
    const res = await fetch(`${BEACON_URL}/beacon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(beacon),
    });
    if (!res.ok) console.warn('[NCH-Bridge] beacon HTTP', res.status);
  } catch (e) {
    // Beacon failed — likely we're offline. Store locally for retry on next reconnect.
    console.warn('[NCH-Bridge] beacon send failed:', e.message);
    await queueOfflineBeacon(beacon);
  }

  updateBadge({ ...status, online: navigator.onLine, posOpen });
}

async function queueOfflineBeacon(beacon) {
  const { offlineBeacons = [] } = await chrome.storage.local.get(['offlineBeacons']);
  offlineBeacons.push(beacon);
  // Keep only last 50 to avoid storage blowup
  if (offlineBeacons.length > 50) offlineBeacons.splice(0, offlineBeacons.length - 50);
  await chrome.storage.local.set({ offlineBeacons });
}

// On reconnect, flush queued beacons
self.addEventListener('online', async () => {
  console.log('[NCH-Bridge] connectivity restored — flushing queued beacons');
  const { offlineBeacons = [] } = await chrome.storage.local.get(['offlineBeacons']);
  for (const b of offlineBeacons) {
    try {
      await fetch(`${BEACON_URL}/beacon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...b, replayed: true }),
      });
    } catch (e) { /* one more try later */ }
  }
  await chrome.storage.local.set({ offlineBeacons: [] });
  await sendBeacon('reconnect');
  await pingPosTabIfRecovered();
});

// ── On reconnection, force the POS tab to re-attempt sync ─────────
async function pingPosTabIfRecovered() {
  if (!navigator.onLine) return;
  const tabs = await chrome.tabs.query({
    url: ['https://ops.hamzahotel.com/pos/ui*', 'https://ops.hamzahotel.com/odoo/pos*'],
  });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'force-sync-attempt' });
    } catch (e) { /* tab may be unloaded */ }
  }
}

// ── Machine ID — stable identifier per terminal ───────────────────
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

// ── Badge — visible indicator on the extension icon ──────────────
function updateBadge(s) {
  let text = '';
  let color = '#4caf50'; // green = healthy

  if (!s.online) {
    text = 'OFF';
    color = '#ef5350'; // red = no internet
  } else if (!s.posOpen) {
    text = '?';
    color = '#ff9800'; // orange = POS tab not open
  } else if (s.unsynced > 0) {
    text = String(s.unsynced);
    color = s.unsynced >= 5 ? '#ef5350' : '#ff9800';
  }

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
