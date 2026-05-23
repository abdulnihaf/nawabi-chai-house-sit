// HE POS Bridge — shared config + auth secret.
// All extension scripts (service worker, content script, popup) load this.
//
// IMPORTANT: this secret must match the POS_BRIDGE_SECRET env var set on
// the Cloudflare Pages project (hamza-express-site). If they don't match,
// the cloud rejects every request from this extension.
//
// To rotate the secret:
//   1. Pick a new strong random string
//   2. Set it via: wrangler pages secret put POS_BRIDGE_SECRET --project-name hamza-express-site
//   3. Update DEFAULT_SECRET below and re-load the unpacked extension
//
// You can also override per-machine via the popup → Settings (saved in
// chrome.storage.local under key 'he_bridge_secret'). The popup-stored
// value takes precedence over DEFAULT_SECRET.

self.HE_BRIDGE_CONFIG = {
  CLOUD_BASE: 'https://hamzaexpress.in',
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

  // Default shared secret. Must match Cloudflare env var POS_BRIDGE_SECRET
  // on the hamza-express-site Pages project.
  // Override per-machine in popup → Settings if needed.
  DEFAULT_SECRET: 'he-pos-bridge-9c4f2a7e5b1d8c3a6f0e2d4b8c1f3a5e',
};
