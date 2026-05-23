// HE POS Bridge — popup script
const $ = (id) => document.getElementById(id);

// Tabs
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('pane-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'logs') refreshLogs();
    if (t.dataset.tab === 'pos-tabs') refreshPosTabs();
  });
});

async function refresh() {
  const { latestStatus, he_machine_id, he_bridge_secret } = await chrome.storage.local.get([
    'latestStatus', 'he_machine_id', 'he_bridge_secret',
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

  const activePosCount = s.activePosCount ?? '?';
  $('activePosCount').textContent = activePosCount === '?' ? '?' : `${activePosCount} / 3`;
  $('activePosCount').className = 'val ' + (activePosCount >= 3 ? 'ok' : activePosCount === '?' ? 'warn' : 'warn');

  $('lastSync').textContent = s.lastSyncAttemptAt ? new Date(s.lastSyncAttemptAt).toLocaleTimeString() : '–';

  let status = 'Healthy', cls = 'ok';
  if (!online) { status = 'No internet'; cls = 'err'; }
  else if (!posOpen) { status = 'No POS tab open'; cls = 'warn'; }
  else if (unsynced > 0) { status = `${unsynced} unsynced`; cls = unsynced >= 5 ? 'err' : 'warn'; }
  else if (s.lastSyncOk === false) { status = `Last sync failed: ${(s.lastError || 'unknown').slice(0, 40)}`; cls = 'err'; }
  $('status').textContent = status;
  $('status').className = 'val ' + cls;

  $('machineId').textContent = he_machine_id || '(not set)';
  $('secretInput').placeholder = he_bridge_secret ? '(saved — type to replace)' : '(using default from config.js)';

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
}

async function refreshPosTabs() {
  const tabs = await chrome.tabs.query({
    url: ['https://test.hamzahotel.com/pos/ui*', 'https://test.hamzahotel.com/odoo/pos*'],
  });

  const container = $('posTabsList');
  if (tabs.length === 0) {
    container.innerHTML = '<div style="color:#ef5350;font-size:11px;padding:8px">No POS tabs open. Open test.hamzahotel.com/pos/ui for each register.</div>';
    return;
  }

  container.innerHTML = '';
  for (const tab of tabs) {
    const div = document.createElement('div');
    div.className = 'pos-row';
    const title = tab.title || tab.url;
    const url = tab.url || '';
    // Try to extract config name from URL or title
    const configMatch = url.match(/config_id=(\d+)/) || title.match(/POS\s*(\d+)/i);
    const configLabel = configMatch ? `config ${configMatch[1]}` : 'unknown config';

    div.innerHTML = `
      <div class="pos-name">${title.slice(0, 50)}</div>
      <div class="pos-detail">Tab #${tab.id} · ${configLabel} · ${tab.active ? '🟢 active' : '🟡 background'}</div>
    `;
    container.appendChild(div);
  }

  if (tabs.length < 3) {
    const warn = document.createElement('div');
    warn.style.cssText = 'color:#ffa726;font-size:10px;margin-top:8px;padding:6px;background:#2a1800;border-radius:4px';
    warn.textContent = `Only ${tabs.length}/3 POS tabs open. Missing tabs have no coverage.`;
    container.appendChild(warn);
  }
}

// Cloud reachability test
async function pingCloud() {
  try {
    const { he_bridge_secret } = await chrome.storage.local.get(['he_bridge_secret']);
    const secret = he_bridge_secret || 'he-pos-bridge-9c4f2a7e5b1d8c3a6f0e2d4b8c1f3a5e';
    const res = await fetch('https://hamzaexpress.in/api/pos-health/status', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${secret}` },
    });
    $('cloudOk').textContent = res.ok ? '✓ ' + res.status : '✗ ' + res.status;
    $('cloudOk').className = 'val ' + (res.ok ? 'ok' : 'err');
  } catch (e) {
    $('cloudOk').textContent = '✗ ' + e.message;
    $('cloudOk').className = 'val err';
  }
}

// Buttons
$('forceSyncBtn').addEventListener('click', async () => {
  const btn = $('forceSyncBtn');
  const orig = btn.textContent;
  btn.textContent = 'Syncing…';
  btn.disabled = true;
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://test.hamzahotel.com/pos/ui*', 'https://test.hamzahotel.com/odoo/pos*'],
    });
    if (tabs.length === 0) { alert('Open the POS tabs in test.hamzahotel.com first.'); return; }
    for (const tab of tabs) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'force-sync-attempt' }); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 3000));
    await refresh();
    const { latestStatus } = await chrome.storage.local.get(['latestStatus']);
    const unsynced = latestStatus?.unsynced ?? '?';
    btn.textContent = unsynced === 0 ? '✓ All synced' : `Done (${unsynced} remain)`;
  } finally {
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  }
});

$('sendBeaconBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'request-beacon' });
  setTimeout(refresh, 800);
});

$('snapshotBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({
    url: ['https://test.hamzahotel.com/pos/ui*', 'https://test.hamzahotel.com/odoo/pos*'],
  });
  if (tabs.length === 0) return alert('Open a POS tab in test.hamzahotel.com first.');
  const fakeId = 'manual-' + Date.now();
  await chrome.tabs.sendMessage(tabs[0].id, {
    type: 'run-command', command_id: fakeId, cmd_type: 'snapshot', params: { kind: 'full' },
  }).catch((e) => alert('Failed: ' + e.message));
  alert('Snapshot dispatched. Check /api/pos-health/snapshots after ~3 sec.');
});

$('copyId').addEventListener('click', async () => {
  const { he_machine_id } = await chrome.storage.local.get(['he_machine_id']);
  if (he_machine_id) await navigator.clipboard.writeText(he_machine_id);
  $('copyId').textContent = '✓ copied';
  setTimeout(() => ($('copyId').textContent = 'click to copy machine ID'), 2000);
});

$('saveSecretBtn').addEventListener('click', async () => {
  const v = $('secretInput').value.trim();
  if (!v) {
    await chrome.storage.local.remove('he_bridge_secret');
    alert('Cleared — using default from config.js');
  } else {
    await chrome.storage.local.set({ he_bridge_secret: v });
    alert('Secret saved.');
  }
  $('secretInput').value = '';
  refresh();
});

$('reloadExtBtn').addEventListener('click', () => chrome.runtime.reload());
$('reloadTabBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: ['https://test.hamzahotel.com/*'] });
  for (const t of tabs) await chrome.tabs.reload(t.id);
});
$('clearStorageBtn').addEventListener('click', async () => {
  if (!confirm('Wipe local storage (KEEP machine_id and secret)?')) return;
  const keep = await chrome.storage.local.get(['he_machine_id', 'he_bridge_secret']);
  await chrome.storage.local.clear();
  await chrome.storage.local.set(keep);
  alert('Cleared.');
});

$('clearLogsBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ he_log_buffer: [] });
  refreshLogs();
});
$('flushLogsBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'request-beacon' });
  alert('Flush triggered.');
});

async function refreshLogs() {
  const { he_log_buffer = [] } = await chrome.storage.local.get(['he_log_buffer']);
  const list = $('logList');
  list.innerHTML = '';
  const recent = he_log_buffer.slice(-20).reverse();
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
