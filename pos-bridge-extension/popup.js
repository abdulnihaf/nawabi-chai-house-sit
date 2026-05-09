// NCH POS Bridge — popup script
const $ = (id) => document.getElementById(id);

// Tabs
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('pane-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'logs') refreshLogs();
  });
});

async function refresh() {
  const { latestStatus, nch_machine_id, nch_bridge_secret } = await chrome.storage.local.get([
    'latestStatus', 'nch_machine_id', 'nch_bridge_secret',
  ]);
  const s = latestStatus || {};
  const online = navigator.onLine;

  $('online').textContent = online ? '✓ online' : '✗ OFFLINE';
  $('online').className = 'val ' + (online ? 'ok' : 'err');

  const posOpen = !!s.posOpen;
  $('posOpen').textContent = posOpen ? '✓ open' : '✗ closed';
  $('posOpen').className = 'val ' + (posOpen ? 'ok' : 'warn');

  const unsynced = s.unsynced ?? '?';
  $('unsynced').textContent = unsynced;
  $('unsynced').className = 'val ' + (unsynced === 0 ? 'ok' : unsynced === '?' ? 'warn' : 'err');

  $('session').textContent = s.sessionId ? `${s.configName || 'POS'} #${s.sessionId}` : '–';
  $('lastSync').textContent = s.lastSyncAttemptAt ? new Date(s.lastSyncAttemptAt).toLocaleTimeString() : '–';

  let status = 'Healthy', cls = 'ok';
  if (!online) { status = 'No internet'; cls = 'err'; }
  else if (!posOpen) { status = 'POS tab not open'; cls = 'warn'; }
  else if (unsynced > 0) { status = `${unsynced} unsynced`; cls = unsynced >= 5 ? 'err' : 'warn'; }
  else if (s.lastSyncOk === false) { status = `Last sync failed: ${(s.lastError || 'unknown').slice(0, 40)}`; cls = 'err'; }
  $('status').textContent = status;
  $('status').className = 'val ' + cls;

  $('machineId').textContent = nch_machine_id || '(not set)';
  $('secretInput').placeholder = nch_bridge_secret ? '(saved — type to replace)' : '(using default from config.js)';

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
}

// Cloud reachability test
async function pingCloud() {
  try {
    const res = await fetch('https://nawabichaihouse.com/api/pos-health/status', { method: 'GET' });
    $('cloudOk').textContent = res.ok ? '✓ ' + res.status : '✗ ' + res.status;
    $('cloudOk').className = 'val ' + (res.ok ? 'ok' : 'err');
  } catch (e) {
    $('cloudOk').textContent = '✗ ' + e.message;
    $('cloudOk').className = 'val err';
  }
}

// Buttons
$('forceSyncBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: ['https://ops.hamzahotel.com/pos/ui*', 'https://ops.hamzahotel.com/odoo/pos*'] });
  if (tabs.length === 0) return alert('Open the Odoo POS tab first.');
  for (const tab of tabs) { try { await chrome.tabs.sendMessage(tab.id, { type: 'force-sync-attempt' }); } catch (e) {} }
  setTimeout(refresh, 1500);
});

$('sendBeaconBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'request-beacon' });
  setTimeout(refresh, 800);
});

$('snapshotBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: ['https://ops.hamzahotel.com/pos/ui*', 'https://ops.hamzahotel.com/odoo/pos*'] });
  if (tabs.length === 0) return alert('Open the Odoo POS tab first.');
  // Construct a fake "command" and send to content script
  const fakeId = 'manual-' + Date.now();
  await chrome.tabs.sendMessage(tabs[0].id, {
    type: 'run-command', command_id: fakeId, cmd_type: 'snapshot', params: { kind: 'full' },
  }).catch((e) => alert('Failed: ' + e.message));
  alert('Snapshot dispatched. Check /api/pos-health/snapshots after ~3 sec.');
});

$('copyId').addEventListener('click', async () => {
  const { nch_machine_id } = await chrome.storage.local.get(['nch_machine_id']);
  if (nch_machine_id) await navigator.clipboard.writeText(nch_machine_id);
  $('copyId').textContent = '✓ copied';
  setTimeout(() => ($('copyId').textContent = 'click to copy machine ID'), 2000);
});

$('saveSecretBtn').addEventListener('click', async () => {
  const v = $('secretInput').value.trim();
  if (!v) {
    await chrome.storage.local.remove('nch_bridge_secret');
    alert('Cleared — using default from config.js');
  } else {
    await chrome.storage.local.set({ nch_bridge_secret: v });
    alert('Secret saved.');
  }
  $('secretInput').value = '';
  refresh();
});

$('reloadExtBtn').addEventListener('click', () => chrome.runtime.reload());
$('reloadTabBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: ['https://ops.hamzahotel.com/*'] });
  for (const t of tabs) await chrome.tabs.reload(t.id);
});
$('clearStorageBtn').addEventListener('click', async () => {
  if (!confirm('Wipe local storage (KEEP machine_id and secret)?')) return;
  const keep = await chrome.storage.local.get(['nch_machine_id', 'nch_bridge_secret']);
  await chrome.storage.local.clear();
  await chrome.storage.local.set(keep);
  alert('Cleared.');
});

$('clearLogsBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ nch_log_buffer: [] });
  refreshLogs();
});
$('flushLogsBtn').addEventListener('click', async () => {
  // Triggers SW to flush
  await chrome.runtime.sendMessage({ type: 'request-beacon' });
  alert('Flush triggered.');
});

async function refreshLogs() {
  const { nch_log_buffer = [] } = await chrome.storage.local.get(['nch_log_buffer']);
  const list = $('logList');
  list.innerHTML = '';
  const recent = nch_log_buffer.slice(-20).reverse();
  for (const l of recent) {
    const d = document.createElement('div');
    d.className = 'log-line ' + l.level;
    const t = new Date(l.ts).toLocaleTimeString();
    d.textContent = `${t} [${l.source}] ${l.message}`;
    list.appendChild(d);
  }
  if (recent.length === 0) list.innerHTML = '<div style="color:#666;font-size:10px;padding:6px">(no buffered logs)</div>';
}

refresh();
pingCloud();
setInterval(refresh, 2000);
setInterval(pingCloud, 15_000);
