// NCH POS Bridge — shared config + auth secret.
// All extension scripts (service worker, content script, popup) load this.
//
// IMPORTANT: this secret must match the POS_BRIDGE_SECRET env var set on
// the Cloudflare Pages project. If they don't match, the cloud rejects
// every request from this extension.
//
// To rotate the secret:
//   1. Pick a new strong random string
//   2. Set it via: wrangler pages secret put POS_BRIDGE_SECRET
//   3. Update DEFAULT_SECRET below and re-load the unpacked extension
//
// You can also override per-machine via the popup → Settings (saved in
// chrome.storage.local under key 'nch_bridge_secret'). The popup-stored
// value takes precedence over DEFAULT_SECRET.

self.NCH_BRIDGE_CONFIG = {
  CLOUD_BASE: 'https://nawabichaihouse.com',
  BEACON_PATH: '/api/pos-health/beacon',
  LOGS_PATH: '/api/pos-health/logs',
  SNAPSHOT_PATH: '/api/pos-health/snapshot',
  COMMANDS_POLL_PATH: '/api/pos-health/commands',
  COMMAND_RESULT_PATH: '/api/pos-health/command-result',

  BEACON_INTERVAL_SEC: 60,
  LOG_FLUSH_INTERVAL_SEC: 30,
  COMMAND_POLL_INTERVAL_SEC: 30,
  CONTENT_POLL_INTERVAL_SEC: 30,

  // Default level captured by the log mirror. 'info' = info+warn+error.
  // 'debug' = everything (verbose; toggle on demand via 'set-log-level' command).
  DEFAULT_LOG_LEVEL: 'info',

  // Default shared secret. Must match Cloudflare env var POS_BRIDGE_SECRET.
  // Override per-machine in popup → Settings if needed.
  DEFAULT_SECRET: 'nch-pos-bridge-7f3a9c8e2d1b4a5f6e7d8c9b0a1c2d3e',
};
