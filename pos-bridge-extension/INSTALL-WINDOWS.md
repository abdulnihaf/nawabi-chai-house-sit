# NCH POS Bridge — Windows Install Guide (v1.1)

This Chrome extension is the **bidirectional bridge** between the POS terminal
and our cloud. It does five things:

1. **Heartbeat** — sends a beacon to `nawabichaihouse.com` every 60 sec
2. **Log mirror** — mirrors all extension `console.log/warn/error` to the cloud
3. **Auto-sync** — when internet returns after an outage, force-pushes
   queued IndexedDB orders to Odoo
4. **Remote diagnostics** — accepts commands from the cloud (snapshot, eval,
   force-sync, reload-tab, read-idb) and posts results back
5. **Live badge** — extension icon shows red number = unsynced order count

The cron at `/api/wa-alerts?action=cron-tick` (runs every 5 min) reads the
beacon stream and sends WhatsApp + FCM alerts within 5 min of any problem.

When something looks broken, Claude (or any operator) can:
- Read the latest logs: `GET /api/pos-health/logs?machine_id=X`
- Take a snapshot: `POST /api/pos-health/commands {type: "snapshot"}` then
  `GET /api/pos-health/snapshots?machine_id=X` to see the full IndexedDB +
  POS state dump
- Run debug JS: `POST /api/pos-health/commands {type: "eval", params:{code:"..."}}`

---

## Step 1 — Get the extension folder onto the POS PC

**Easiest path** — download the repo ZIP directly from the POS PC:

1. Open Chrome on the POS PC
2. Go to: `https://github.com/abdulnihaf/nawabi-chai-house-sit/archive/refs/heads/main.zip`
3. Save the ZIP, then extract it
4. Inside, find `nawabi-chai-house-sit-main\pos-bridge-extension\`
5. Move that folder to `C:\NCH\pos-bridge-extension\` (create `C:\NCH\` if needed)

> **Path matters.** Chrome remembers the exact path you load the extension
> from. If you later move the folder, the extension stops working.

**Alternative:** USB drive — copy the `pos-bridge-extension` folder from any
machine that has the repo cloned, to `C:\NCH\pos-bridge-extension\` on the
POS PC.

---

## Step 2 — Load the extension into Chrome

1. Open Chrome on the POS PC
2. URL bar: `chrome://extensions/` → Enter
3. **Top-right** → turn ON **Developer mode**
4. **Top-left** → click **Load unpacked**
5. Browse to `C:\NCH\pos-bridge-extension\` → **Select Folder**
6. Card appears: **NCH POS Bridge v1.1.0**. Make sure its toggle is ON.

If you see a red **Errors** button on the card, click it and tell me what it says.

---

## Step 3 — Pin the icon

Click the **puzzle-piece** icon (top-right of Chrome) → find **NCH POS
Bridge** → click the pushpin so it stays visible in the toolbar.

---

## Step 4 — Open Odoo POS and verify

1. New tab → `https://ops.hamzahotel.com/pos/ui` → log in / open the Cash
   Counter session as usual.
2. Within ~5 sec the extension icon should change:
   - **Green badge (no number)** → all healthy
   - **Orange/red number** → that many orders unsynced
   - **Orange `?`** → POS tab not detected (refresh the POS tab)
3. Click the extension icon. The popup has 3 tabs: **Status / Logs /
   Settings**. The Status tab should show:
   - Internet: `✓ online`
   - POS tab open: `✓ open`
   - Unsynced orders: `0`
   - Session: e.g. `Cash Counter #169`
   - Cloud reachable: `✓ 200`
   - Status: `Healthy`
4. The Machine ID is shown at the bottom — click "click to copy machine ID"
   and **send it to me**. This is how I'll address commands at this specific
   terminal.

---

## Step 5 — Verify telemetry reaches the cloud

On any device, open:

```
https://nawabichaihouse.com/api/pos-health/status
```

You should see JSON with `machines` containing your terminal, `severity:
"ok"`, `age_sec` under 90.

Then:

```
https://nawabichaihouse.com/api/pos-health/logs?machine_id=<your-machine-id>&limit=10
```

You should see recent log lines from the extension. (If you get `401
unauthorized` here, that's expected — the GET endpoints require the
Authorization header. Server-side cron and Claude have it.)

---

## Step 6 — Make Chrome auto-start on boot

Critical: the extension only runs while Chrome is open.

1. `Win + R` → `shell:startup` → Enter
2. Right-click in the empty area → **New** → **Shortcut**
3. Browse to `C:\Program Files\Google\Chrome\Application\chrome.exe` → Next
4. Name it `Chrome – POS auto-start` → Finish
5. Right-click new shortcut → **Properties**
6. In **Target**, append after the chrome.exe path (note the space):
   ```
    --restore-last-session
   ```
7. OK

Now reboot to test — Chrome should auto-launch and re-open the POS tab.

---

## Step 7 — Disable Chrome's "stop background apps when closed"

`chrome://settings/system` → turn ON **"Continue running background apps
when Google Chrome is closed"**.

This keeps the extension's service worker alive even if the user accidentally
closes the Chrome window. The SW continues sending beacons.

---

## Step 8 — (Optional) Set a custom secret

The extension's `config.js` ships with a default `POS_BRIDGE_SECRET` that
matches what's already set in Cloudflare Pages. **You can ignore this step**
unless you want to rotate the secret.

To rotate:

1. Pick a new random string, e.g. `openssl rand -hex 32`
2. On a dev machine: `wrangler pages secret put POS_BRIDGE_SECRET` → paste
   the new value
3. On the POS Chrome: open the extension popup → **Settings** tab → paste
   the same value into "Cloud secret" → **Save secret**
4. Wait 60 sec; the next beacon should still succeed.

---

## Done. What happens now

| Event | Auto behaviour |
|---|---|
| Cashier closes the POS tab | Beacon `pos_tab_open: false` → cron WhatsApps Naveen within 5 min |
| Internet drops at the store | Beacon shows `online: false` → no alert (expected during outage) |
| Internet returns + queue exists | Extension auto-fires `forceSync()` within ~2 sec |
| Sync fails repeatedly | `last_sync_ok: false` → cron alert "POS sync stuck" |
| PC reboots / Chrome crashes | Beacons stop → cron alert "POS terminal DEAD" within 10 min |
| Cashier issues 5+ tokens during outage | Badge turns red with the count |

---

## How to ask me to debug

Just message me with the machine ID (or just say "the POS"). I'll:

1. `GET /api/pos-health/status` — see live state
2. `GET /api/pos-health/logs?machine_id=X&level=error` — see recent errors
3. `POST /api/pos-health/commands {type: "snapshot"}` — get a full dump of
   IndexedDB + POS model state. The terminal polls every 30 sec, executes
   the command, and posts the result back.
4. `GET /api/pos-health/snapshots?machine_id=X&limit=5` — read the dump
5. If needed: `POST /api/pos-health/commands {type: "eval", params:{code:"..."}}`
   to run any JS in the POS tab's MAIN world (full Odoo runtime access).

I never need to be on the same network as the POS — everything flows over HTTPS.

---

## Troubleshooting

**Q: Status URL shows my machine but `severity: "warn"` reason `"pos-tab-closed"`**
A: The Odoo POS tab needs to be open. Re-open it and wait 30 sec.

**Q: Beacons reach the cloud but logs don't**
A: Open the extension popup → Logs tab → click "Flush to cloud now". If
that fails, check the Settings tab → secret matches the one on the server.

**Q: "Cloud reachable: ✗ ..." in popup**
A: Either the POS PC has no internet, or `nawabichaihouse.com` is down.
Test by opening the URL directly in a new tab.

**Q: I clicked Force sync but it didn't push the queued orders**
A: Send me the machine ID, I'll send a `snapshot` command and a `read-idb`
command to see exactly what's in IndexedDB and why the sync function isn't
finding it. This usually reveals the Odoo POS version mismatch.

**Q: I want to give Claude direct DevTools access to this Chrome**
A: Run Chrome with `--remote-debugging-port=9222 --remote-allow-origins=*`,
expose port 9222 via ngrok or Cloudflare Tunnel, send me the URL. Use only
for the install/debug session — close the port immediately after.
