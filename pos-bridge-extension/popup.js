// NCH POS Bridge — popup script
async function refresh() {
  const { latestStatus, nch_machine_id } = await chrome.storage.local.get(['latestStatus', 'nch_machine_id']);
  const s = latestStatus || {};
  const online = navigator.onLine;

  document.getElementById('online').textContent = online ? '✓ online' : '✗ OFFLINE';
  document.getElementById('online').className = 'val ' + (online ? 'ok' : 'err');

  const posOpen = !!s.posOpen;
  document.getElementById('posOpen').textContent = posOpen ? '✓ open' : '✗ closed';
  document.getElementById('posOpen').className = 'val ' + (posOpen ? 'ok' : 'warn');

  const unsynced = s.unsynced ?? '?';
  document.getElementById('unsynced').textContent = unsynced;
  document.getElementById('unsynced').className =
    'val ' + (unsynced === 0 ? 'ok' : unsynced === '?' ? 'warn' : 'err');

  document.getElementById('session').textContent =
    s.sessionId ? `${s.configName || 'POS'} #${s.sessionId}` : '–';

  document.getElementById('lastSync').textContent = s.lastSyncAttemptAt
    ? new Date(s.lastSyncAttemptAt).toLocaleTimeString()
    : '–';

  let status = 'Healthy';
  let cls = 'ok';
  if (!online) { status = 'No internet'; cls = 'err'; }
  else if (!posOpen) { status = 'POS tab not open'; cls = 'warn'; }
  else if (unsynced > 0) { status = `${unsynced} unsynced`; cls = unsynced >= 5 ? 'err' : 'warn'; }
  else if (s.lastSyncOk === false) { status = `Last sync failed: ${s.lastError || 'unknown'}`; cls = 'err'; }
  document.getElementById('status').textContent = status;
  document.getElementById('status').className = 'val ' + cls;

  document.getElementById('machineId').textContent = nch_machine_id ? `ID: ${nch_machine_id}` : '';
}

document.getElementById('forceSyncBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({
    url: ['https://ops.hamzahotel.com/pos/ui*', 'https://ops.hamzahotel.com/odoo/pos*'],
  });
  if (tabs.length === 0) {
    alert('Open the Odoo POS tab first.');
    return;
  }
  for (const tab of tabs) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'force-sync-attempt' }); } catch (e) {}
  }
  setTimeout(refresh, 1500);
});

document.getElementById('sendBeaconBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'request-beacon' });
  setTimeout(refresh, 800);
});

refresh();
setInterval(refresh, 2000);
