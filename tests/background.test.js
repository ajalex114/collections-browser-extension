// Unit tests for src/dev-logger.js — the dev-only persistent logging helper.
// Imports the module directly (not background.js) to avoid the full SW
// initialisation that background.js performs at module level.

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed globalThis.chrome with a minimal double for dev-logger.js. */
function setInstallType(installType) {
  globalThis.chrome = {
    management: {
      getSelf(cb) { cb({ installType }); },
    },
  };
}

/** Replace globalThis.fetch with a spy; returns the calls array. */
function mockFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return { ok: true };
  };
  return calls;
}

function restoreFetch() { delete globalThis.fetch; }

// Cache-bust imports so each test gets a fresh module evaluation with its own
// _isDev state (Node caches ES modules by resolved URL).
let serial = 0;
async function importFlog() {
  const { flog } = await import(`../src/dev-logger.js?t=${serial++}`);
  return flog;
}

// Settle any pending microtasks/timers after a flog() call.
const tick = () => new Promise(r => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("flog does not call fetch when installType is 'normal' (production)", async t => {
  setInstallType("normal");
  const calls = mockFetch();
  t.after(restoreFetch);

  const flog = await importFlog();
  flog("test.event", { foo: "bar" });
  await tick();

  assert.equal(calls.length, 0, "fetch must not be called in prod");
});

test("flog calls fetch with correct shape when installType is 'development'", async t => {
  setInstallType("development");
  const calls = mockFetch();
  t.after(restoreFetch);

  const flog = await importFlog();
  flog("openOverlay.start", { mode: "spotlight", tabUrl: "https://example.com", injectable: true });
  await tick();

  assert.equal(calls.length, 1, "fetch must be called exactly once");
  const { url, body } = calls[0];
  assert.equal(url, "http://localhost:7700/log");
  assert.equal(body.event, "openOverlay.start");
  assert.equal(body.mode, "spotlight");
  assert.equal(body.tabUrl, "https://example.com");
  assert.equal(body.injectable, true);
  assert.ok(typeof body.t === "number", "body.t must be a numeric timestamp");
  assert.ok(typeof body.ts === "string", "body.ts must be an ISO string");
});

test("flog does not throw when fetch rejects (log server not running)", async t => {
  setInstallType("development");
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  t.after(restoreFetch);

  const flog = await importFlog();

  await assert.doesNotReject(async () => {
    flog("command", { command: "spotlight-search" });
    await tick();
  }, "flog must swallow fetch errors silently");
});
