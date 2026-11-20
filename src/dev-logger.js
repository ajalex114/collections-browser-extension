// Dev-only persistent logger for the Collection extension.
// Posts fire-and-forget JSON entries to a local log server (log-server.js).
// Automatically disabled in production (store-installed) builds — no flags
// or manifest changes needed. Safe to import in any context.

let _isDev = false;
chrome.management.getSelf(self => { _isDev = self.installType === "development"; });

/**
 * Fire-and-forget structured log entry to the local dev log server.
 * Silent no-op in production or when the server is not running.
 *
 * @param {string} event  - Short dot-namespaced event name, e.g. "openOverlay.start"
 * @param {object} [data] - Additional key/value pairs to include in the entry
 */
export function flog(event, data = {}) {
  if (!_isDev) return;
  fetch("http://localhost:7700/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: Date.now(), ts: new Date().toISOString(), event, ...data }),
  }).catch(() => {}); // server not running → silent no-op
}
