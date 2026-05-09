// NCH POS Bridge — Content Script (ISOLATED world)
// Bridges between the page (MAIN world) and the service worker.
// Periodically polls IndexedDB for unsynced order count and reports
// to the service worker for beaconing.

const POLL_INTERVAL_MS = 30_000; // 30 sec
const POS_INDEXEDDB_NAMES = ['pos_data', 'pos_database', 'pos']; // tries each

let pollHandle = null;

console.log('[NCH-Bridge content] loaded on', window.location.href);

// ── Listen for messages from the MAIN-world script and the SW ──
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
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'force-sync-attempt') {
    console.log('[NCH-Bridge content] received force-sync request from SW');
    window.postMessage({ __nch_bridge: true, type: 'force-sync' }, '*');
    sendResponse({ ok: true });
  }
  if (msg.type === 'get-status') {
    pollAndReport().then((r) => sendResponse(r)).catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }
  return true;
});

// ── IndexedDB inspection from ISOLATED world (works in parallel with MAIN) ──
async function readUnsyncedFromIndexedDB() {
  for (const dbName of POS_INDEXEDDB_NAMES) {
    try {
      const count = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => resolve(null);
        req.onsuccess = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames || db.objectStoreNames.length === 0) {
            db.close();
            return resolve(null);
          }
          // Look for an object store that holds queued/pending orders
          const stores = Array.from(db.objectStoreNames);
          const orderStore =
            stores.find((s) => /order/i.test(s) && /(unsynced|pending|queue|sync)/i.test(s)) ||
            stores.find((s) => /order/i.test(s));
          if (!orderStore) {
            db.close();
            return resolve(null);
          }
          try {
            const tx = db.transaction(orderStore, 'readonly');
            const store = tx.objectStore(orderStore);
            const countReq = store.count();
            countReq.onsuccess = () => {
              db.close();
              resolve(countReq.result);
            };
            countReq.onerror = () => {
              db.close();
              resolve(null);
            };
          } catch (e) {
            db.close();
            resolve(null);
          }
        };
        req.onblocked = () => resolve(null);
      });
      if (count !== null) {
        return { source: `idb:${dbName}`, count };
      }
    } catch (_) {
      // try next name
    }
  }
  return { source: 'idb:none', count: null };
}

// ── Polling loop ──────────────────────────────────────────────────
async function pollAndReport() {
  // Always ask the MAIN-world script first — it has access to Odoo's runtime
  window.postMessage({ __nch_bridge: true, type: 'request-state' }, '*');

  // As a fallback, also read raw IndexedDB
  const idb = await readUnsyncedFromIndexedDB();
  if (idb.count !== null) {
    sendStatusToSW({ unsynced: idb.count, source: idb.source });
  }
  return { idb };
}

function sendStatusToSW(payload) {
  try {
    chrome.runtime.sendMessage({ type: 'pos-status-update', payload });
  } catch (e) {
    // SW may be sleeping briefly; retry on next poll
  }
}

// ── Boot ──────────────────────────────────────────────────────────
function start() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(pollAndReport, POLL_INTERVAL_MS);
  // Run one immediately
  setTimeout(pollAndReport, 2000);
  // Tell SW we're alive
  sendStatusToSW({ unsynced: 0, posOpen: true });
}

if (document.readyState === 'complete') start();
else window.addEventListener('load', start);
