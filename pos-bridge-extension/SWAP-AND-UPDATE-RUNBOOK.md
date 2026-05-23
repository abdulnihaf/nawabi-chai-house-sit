# NCH POS — PC Swap (Cash Counter) + Extension Update (Runner Counter)

**Use this runbook on 2026-05-23+ when:**
- Replacing the PC on NCH Cash Counter (POS_27) → follow Procedure A
- Updating the existing Runner Counter PC (POS_28) to extension v1.2.0 → follow Procedure B

**Pre-flight verified 2026-05-23 (already passing):**
- ✓ Cloud endpoints reachable
- ✓ Old POS_27 has 0 unsynced orders → safe to unplug, no data loss
- ✓ Repo at extension v1.2.0
- ✓ Auto-fix cron live every 5 min
- ✓ Live page http://nawabichaihouse.com/ops/impossibilities/

---

## PROCEDURE A — POS_27 Cash Counter (NEW PC, full install)

**Time estimate: 30–40 minutes including peripheral reconnect.**

### A1. BEFORE you unplug the old PC
1. On the old PC's Chrome → click NCH POS Bridge extension icon → Status tab → confirm **Unsynced orders: 0**. If non-zero, send me the count first, don't unplug.
2. On the old PC's Odoo POS → if a cashier is in mid-order (Lines > 0), complete or void it first.
3. Note down what's physically connected (receipt printer USB port, cash drawer cable, network cable). Photograph the back of the old PC.
4. The old machine_id `nch-664c9e87-aa5a-4472-b35f-fa337648f5ee` will go silent after unplug — that's expected. Don't panic.

### A2. Set up the new PC (Windows fresh)
1. Plug in new PC. Boot, complete Windows initial setup.
2. Connect to outlet wifi (or use the same ethernet cable from the old PC if cabled).
3. Test internet by opening `https://nawabichaihouse.com` in Edge → should load.
4. Download + install **Google Chrome** from `https://www.google.com/chrome/`.
5. Open Chrome, sign in is NOT required — leave it as a local profile.

### A3. Connect peripherals
1. Plug in receipt printer (POS80) to USB. Wait for Windows to install driver (should be auto).
2. Plug in cash drawer cable (usually RJ11 from cash drawer into the receipt printer's "DK" port).
3. Open Notepad → print test page (Ctrl+P → select POS80 printer) → confirm printer + cash-drawer kick fire.

### A4. Install the NCH POS Bridge extension (v1.2.0)
1. In Chrome address bar:
   `https://github.com/abdulnihaf/nawabi-chai-house-sit/archive/refs/heads/main.zip`
2. Download → wait for ZIP → right-click → Extract All → choose `C:\NCH\`.
3. Inside `C:\NCH\nawabi-chai-house-sit-main\`, find the folder `pos-bridge-extension`.
4. Move (cut/paste) **just the `pos-bridge-extension` folder** to `C:\NCH\pos-bridge-extension\`. You can delete the rest of `nawabi-chai-house-sit-main\` afterwards.
5. Verify `C:\NCH\pos-bridge-extension\manifest.json` exists and contains `"version": "1.2.0"`.
6. In Chrome: `chrome://extensions/` → toggle **Developer mode** ON (top right).
7. Click **Load unpacked** → browse to `C:\NCH\pos-bridge-extension\` → **Select Folder**.
8. Card should appear: **NCH POS Bridge v1.2.0**. Toggle ON.
9. If a red **Errors** button shows → click it → screenshot → send to me. STOP here.

### A5. Pin the icon + open Odoo POS
1. Top-right of Chrome → puzzle-piece icon → find **NCH POS Bridge** → click the pin icon.
2. New tab → `https://ops.hamzahotel.com/pos/ui` → log in as Cash Counter user (the one previously used).
3. Wait 8–10 seconds for the POS to fully load.

### A6. Verify the badge appears
- Top-right of the POS screen: a floating box titled **RUNNER PROMISE PILE** should appear.
- It shows each runner with their pending ₹ amount.
- If it doesn't appear within 30 sec: open browser DevTools (F12) → Console tab → look for any `[NCH-Bridge` errors → screenshot to me.

### A7. Capture and send me the new machine_id
1. Click the NCH POS Bridge icon in Chrome toolbar → popup opens.
2. Status tab → at the bottom, the **Machine ID** is shown.
3. Click "copy machine ID" → paste it to me in chat.
4. I'll register it as the new POS_27 terminal and retire the old `nch-664c9e87…` ID.

### A8. Verify cloud connectivity
1. Same popup → Status tab should show:
   - Internet: ✓ online
   - POS tab open: ✓ open
   - Unsynced orders: 0
   - Cloud reachable: ✓ 200
   - Status: Healthy

### A9. Configure Chrome to auto-start on boot
1. `Win+R` → type `shell:startup` → Enter
2. Right-click empty area → New → Shortcut
3. Browse to `C:\Program Files\Google\Chrome\Application\chrome.exe` → Next
4. Name it `Chrome – POS auto-start` → Finish
5. Right-click the new shortcut → Properties
6. In **Target**, after the chrome.exe path (with a space), append:
   ```
   --restore-last-session
   ```
7. OK.

### A10. Allow Chrome background apps
1. URL: `chrome://settings/system` → toggle ON **"Continue running background apps when Google Chrome is closed"**.

### A11. Reboot test
1. Reboot the PC.
2. Chrome should auto-launch and re-open the POS tab.
3. Badge should reappear within 30 sec of POS loading.
4. Cashier can immediately start a new shift.

### A12. Test transaction
1. Have the cashier do one small real order (e.g., a ₹10 chai paid cash).
2. Confirm receipt prints, cash drawer kicks open.
3. After save, refresh `https://nawabichaihouse.com/api/pos-health/status` → your new machine_id should show `unsynced_count: 0` within 60 sec.

**Done. The new PC is now POS_27 Cash Counter.**

---

## PROCEDURE B — POS_28 Runner Counter (existing PC, update only)

**Time estimate: 5 minutes.**

### B1. Pull the new extension files onto the PC
1. On the Runner Counter PC's Chrome:
   `https://github.com/abdulnihaf/nawabi-chai-house-sit/archive/refs/heads/main.zip`
2. Download → extract.
3. Inside extracted folder, find `pos-bridge-extension`.
4. **Copy ALL files from there**, paste into `C:\NCH\pos-bridge-extension\` → overwrite when prompted.
5. Verify `C:\NCH\pos-bridge-extension\manifest.json` now shows `"version": "1.2.0"`.

### B2. Reload the extension
1. Chrome → `chrome://extensions/`
2. Find **NCH POS Bridge** card → click the circular **refresh/reload** icon (small arrow in a circle).
3. Card should now show **v1.2.0**.

### B3. Reload the POS tab
1. Go to the POS tab → press **Ctrl+R** (or F5).
2. Wait 8–10 sec for POS to fully load.
3. The **Runner Promise Pile** badge should appear top-right.

### B4. Verify with me
- Send me a quick "POS_28 updated" message so I can confirm beacons are still healthy with extension_version 1.2.0.
- The existing machine_id `nch-4c856699-ea26-4051-9e34-427abebe0f40` stays — no change.

**Done. POS_28 now has the badge + v1.2.0 features.**

---

## What to send me after both are done

1. **New POS_27 machine_id** (the one shown in the new PC's extension popup).
2. **"POS_28 updated"** confirmation.

I'll then:
- Mark the old POS_27 machine_id `nch-664c9e87…` as decommissioned in the pos-health tracking.
- Verify both new beacons are healthy with extension_version=1.2.0.
- Update the impossibility registry's terminal references.

---

## If anything goes wrong

| Symptom | First action |
|---|---|
| Badge doesn't appear | F12 → Console → look for `[NCH-Bridge]` errors → screenshot to me |
| `chrome://extensions/` shows red Errors button on the card | Click Errors → screenshot → send to me |
| Popup shows "Cloud reachable: ✗" | Check PC internet (open google.com in another tab) |
| Beacons silent in `/api/pos-health/status` after 5 min | Extension popup → Settings → confirm "Cloud secret" field is empty (uses default) OR matches the server one |
| Cashier complains POS feels slow | Hide the badge (× button in top-right of the badge); ephemeral preference, returns on next reload |
| Cash drawer doesn't open on print | Driver issue — reinstall printer driver; the POS isn't the cause |

---

## What is NOT changing today

- POS_27 session 169 stays open in Odoo (we are NOT closing the session as part of the PC swap).
- POS_28 session 170 stays open.
- All historical data in Odoo is unaffected — the PC swap is just the client device. All orders, payments, sessions live on `ops.hamzahotel.com`.
- The Cashier user login (e.g. "NCH - Cash Counter") stays the same.
- No Odoo configuration change.

This is purely a client-device swap (POS_27) + extension upgrade (POS_28).

---

*Runbook version 1.0 · 2026-05-23 · matches extension v1.2.0.*
