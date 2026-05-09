# NCH POS Bridge — Windows Install Guide

This Chrome extension runs on the POS terminal at the counter. It:

- Reads the offline queue from Odoo POS's IndexedDB every 30 sec
- Sends a heartbeat to `nawabichaihouse.com/api/pos-health/beacon` every 60 sec
- When the internet comes back after an outage, it auto-triggers the Odoo POS sync
- Shows a red badge on the extension icon showing how many orders are unsynced

The cron at `/api/wa-alerts?action=cron-tick` (runs every 5 min) reads beacons
and sends WhatsApp + FCM alerts within 5 min of any problem.

---

## Step 1 — Get the extension folder onto the POS PC

You have two options. Use whichever is easier.

### Option A — USB drive (no internet needed on the terminal)

1. On any computer with the repo:
   - Locate the folder `pos-bridge-extension/` in the repo.
   - Right-click → "Send to" → Compressed (zipped) folder. You get
     `pos-bridge-extension.zip`.
2. Copy the ZIP to a USB drive.
3. Plug into the POS PC.
4. Copy the ZIP to `C:\NCH\` (create the folder if it doesn't exist).
5. Right-click the ZIP → "Extract All…" → extract to `C:\NCH\`.
6. You should now have a folder `C:\NCH\pos-bridge-extension\` containing
   `manifest.json`, `service-worker.js`, etc.

### Option B — Direct download

Once the extension is committed to the repo, you can download a ZIP straight from
GitHub:

```
https://github.com/abdulnihaf/nawabi-chai-house-sit/archive/refs/heads/main.zip
```

After unzipping, look inside for `pos-bridge-extension/` and move it to
`C:\NCH\pos-bridge-extension\`.

> **Path matters.** Chrome remembers the path you load the extension from.
> If you later move the folder, the extension breaks. Pick a permanent path
> like `C:\NCH\pos-bridge-extension\` and don't move it.

---

## Step 2 — Load the extension into Chrome

1. Open Chrome on the POS PC.
2. In the URL bar, type: `chrome://extensions/`  → press Enter.
3. **Top-right corner**: turn ON the toggle labelled **"Developer mode"**.
4. Three new buttons appear at the top-left: **Load unpacked**, Pack
   extension, Update. Click **Load unpacked**.
5. A folder picker opens. Navigate to `C:\NCH\pos-bridge-extension\` and
   click **Select Folder**.
6. The extension card appears with the name **NCH POS Bridge** and version
   1.0.0. Make sure the toggle on the card is **ON**.

If you see a red "Errors" button on the card, click it and tell me what the
error says.

---

## Step 3 — Pin the extension icon

1. Click the **puzzle-piece icon** in the Chrome toolbar (top-right).
2. Find **NCH POS Bridge** in the dropdown.
3. Click the **pushpin icon** next to it. The icon now stays visible in the
   toolbar.

---

## Step 4 — Open Odoo POS and verify

1. Open a new tab to `https://ops.hamzahotel.com/pos/ui` and log in / open the
   Cash Counter session as usual.
2. Within ~5 seconds the extension icon should change:
   - **Green badge** (no number) → all healthy
   - **Orange/red number** → that many orders are unsynced
   - **Orange `?`** → POS tab not detected (refresh the POS tab)
3. Click the extension icon. The popup shows:
   - Internet: `✓ online`
   - POS tab open: `✓ open`
   - Unsynced orders: `0`
   - Session: e.g. `Cash Counter #169`
   - Last sync: a recent timestamp
   - Status: `Healthy`
   - Machine ID: `nch-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

**Copy that Machine ID and send it to me** — I'll register it in the
dashboard so we can identify which terminal is which.

---

## Step 5 — Verify the beacon reaches the cloud

On any device, open:

```
https://nawabichaihouse.com/api/pos-health/status
```

You should see JSON with `machines` containing your terminal's machine ID,
its `severity: "ok"`, and `age_sec` under 90.

If `age_sec` is large (>120) or the machine isn't listed, click the **"Send
beacon"** button in the extension popup and refresh the URL.

---

## Step 6 — Make sure Chrome auto-starts on boot

This is critical so the extension wakes up after every restart.

1. Press `Win + R`, type `shell:startup`, press Enter. Explorer opens the
   Startup folder.
2. Right-click in the empty area → **New** → **Shortcut**.
3. Browse to `C:\Program Files\Google\Chrome\Application\chrome.exe` (or
   wherever Chrome is installed) and click Next.
4. Name it `Chrome – POS auto-start` → Finish.
5. Right-click the new shortcut → **Properties**. In the **Target** field,
   append this AFTER the existing path (note the space):
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --restore-last-session
   ```
6. Click OK.

Now whenever the PC reboots, Chrome will auto-launch and re-open the POS
tab — and the extension will start sending beacons within 60 seconds.

---

## Step 7 — Disable Chrome's "stop background apps when Chrome closes"

The extension's service worker only runs while Chrome is open. We don't want
Chrome to ever fully close while the POS is in use.

1. `chrome://settings/system`
2. Turn ON: **"Continue running background apps when Google Chrome is
   closed"**.

---

## Done. What happens now

| Event | What the system does |
|---|---|
| Cashier closes the POS tab | Extension reports `pos_tab_open: false` → cron alert fires within 5 min |
| Internet drops at the store | Extension reports `online: false` → no alert (expected during outage) |
| Internet returns + queue exists | Extension auto-fires `forceSync()` → orders push to Odoo within seconds |
| Sync fails repeatedly | Extension reports `last_sync_ok: false` → cron alert: "POS sync stuck" |
| PC reboots / Chrome crashes | Beacons stop arriving → cron alert "POS terminal DEAD" within 10 min |
| Cashier issues 5+ tokens during an outage | Extension badge shows red number `5+` → cashier sees it immediately |

---

## Remote install (for Claude / Nihaf)

If you (Nihaf) want me to install this myself, do this on the POS PC:

1. Close all Chrome windows.
2. Open Command Prompt as Administrator.
3. Run:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-allow-origins=*
   ```
   Chrome opens. Re-open the POS tab.
4. Get the PC's local network IP: `ipconfig` → look for `IPv4 Address`
   (something like `192.168.1.42`).
5. From your router, set up port-forwarding: external port 9222 → internal
   `192.168.1.42:9222`. (Or use a Cloudflare Tunnel / ngrok for safer
   exposure.)
6. Tell me the public address (e.g. `https://nch-pos.your-tunnel.com`).
   I'll connect via Chrome DevTools Protocol to install the extension and
   test it without you needing to do anything more.

> **Security:** Open port 9222 ONLY for the duration of the install, then
> close it. With the debug port open, anyone on that IP can run JavaScript
> in the POS terminal's Chrome.

---

## Troubleshooting

**Q: The extension card says "Service worker (Inactive)"**
A: That's normal — the SW sleeps when idle. Click "Inspect views: service
worker" to wake it up and see logs. It re-wakes every minute via alarms.

**Q: Status URL shows my machine but `severity: "warn"` reason
`"pos-tab-closed"`**
A: The Odoo POS tab needs to be open. Re-open it and wait 30 sec.

**Q: Status URL shows `severity: "warn"` reason `"sync-stuck"`**
A: Click the extension icon → "Force sync now". If that doesn't help, the
local Odoo POS state may have been wiped. Tell me the machine ID and I'll
investigate.

**Q: I see no `unsynced_count`, just `null`**
A: That means the extension can't read IndexedDB on this Odoo version. Tell
me which Odoo version is running (visible in `chrome://extensions/` →
Inspect views → Console) and I'll add support.
