# HE POS Bridge — Installation Guide (Windows)

This Chrome extension runs on the Cash Counter PC and monitors all 3 HE POS tabs
simultaneously: Cash Counter (POS 5), Captain (POS 6), Ground Floor (POS 32).

---

## Step 1 — Get the extension files onto the PC

Option A: USB drive
1. Copy the entire `pos-bridge-extension/` folder to a USB drive
2. Plug into Cash Counter PC, copy to `C:\HE-POS-Bridge\`

Option B: Remote download
1. Open Chrome on Cash Counter PC
2. Download the ZIP from wherever Nihaf hosts it, extract to `C:\HE-POS-Bridge\`

**Important:** You need these 7 files in the folder (icons/ subfolder is optional):
```
manifest.json
config.js
service-worker.js
content-script.js
main-world.js
popup.html
popup.js
icons/  (copy the NCH icons folder or create placeholder PNGs)
```

---

## Step 2 — Copy NCH icons (quick workaround)

The extension needs 3 PNG icons. Easiest: copy from the NCH extension:
1. Open `C:\NCH-POS-Bridge\icons\` (if NCH bridge is installed)
2. Copy `icon-16.png`, `icon-48.png`, `icon-128.png` to `C:\HE-POS-Bridge\icons\`

Alternatively, create any 3 PNG files with those names — any image will do.

---

## Step 3 — Load as unpacked extension in Chrome

1. Open Chrome → address bar → type `chrome://extensions` → Enter
2. Toggle **Developer mode** ON (top-right switch)
3. Click **Load unpacked**
4. Navigate to `C:\HE-POS-Bridge\` → click **Select Folder**
5. The "HE POS Bridge" extension appears in the list with a 🟢 status

---

## Step 4 — Pin the extension

1. Click the puzzle piece icon (🧩) in Chrome toolbar
2. Find "HE POS Bridge" → click the pin icon
3. The 🟠 HE icon appears in the toolbar

---

## Step 5 — Set the cloud secret

The secret must match what's set on the Cloudflare Pages project (`POS_BRIDGE_SECRET`).

1. Click the extension icon → go to **Settings** tab
2. Enter the secret Nihaf gives you → click **Save secret**
3. Or: leave blank to use the default baked into config.js

To verify the secret is working:
1. Go to **Status** tab → look at "Cloud reachable"
2. Should show ✓ 200

---

## Step 6 — Open all 3 POS tabs

The extension runs on all 3 POS simultaneously. Open each in a separate tab:

| POS | URL | Config ID |
|-----|-----|-----------|
| Cash Counter | `https://test.hamzahotel.com/pos/ui#action=...&config_id=5` | 5 |
| Captain | `https://test.hamzahotel.com/pos/ui#action=...&config_id=6` | 6 |
| Ground Floor | `https://test.hamzahotel.com/pos/ui#action=...&config_id=32` | 32 |

Or just open each POS from the Odoo backend (Apps → Point of Sale → select config).

Once all 3 are open, the extension icon badge should be blank/green (not showing a number).

---

## Step 7 — Verify the machine ID

1. Click extension → **Status** tab
2. At the bottom: copy the machine ID (looks like `he-xxxxxxxx-xxxx-...`)
3. Send the machine ID to Nihaf
4. Nihaf registers it in the pos-bridge.env file so Claude can control this terminal

---

## Daily operation

The extension runs automatically as long as Chrome is open. No action needed.

If the badge shows a number → that many orders are unsynced. Click the extension → **Force sync all POS**.

If the badge shows **OFF** → internet is down. Orders are queued locally, will sync when internet returns.

---

## Troubleshooting

**Cloud reachable shows ✗ 401**: wrong secret. Go Settings → enter correct secret.

**Badge shows ? (orange)**: no POS tab is open. Open test.hamzahotel.com/pos tabs.

**Extension not loading**: check Developer Mode is ON in chrome://extensions.

**POS tab says "no POS tab detected"**: make sure you're on `test.hamzahotel.com` (not `ops.hamzahotel.com` which is NCH).

**Extension disappeared after Chrome restart**: go to chrome://extensions → re-enable it. Consider pinning Chrome to taskbar and enabling "Continue running background apps when Chrome is closed" in Chrome settings.

---

## Rotating the secret

If you need to change the secret:
1. Nihaf runs: `wrangler pages secret put POS_BRIDGE_SECRET --project-name hamza-express-site`
2. Nihaf updates `DEFAULT_SECRET` in `config.js` and re-packages the extension
3. On the Cash Counter PC: click extension → Settings → enter new secret → Save
4. Or: Nihaf can send a `clear-secret` remote command (clears the stored override, falls back to new config.js default after extension reload)

---

*Last updated: May 2026. Extension v1.0.0.*
