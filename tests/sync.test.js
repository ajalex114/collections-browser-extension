// Cross-device sync tests. Two simulated devices (A, B) share one in-memory
// chrome.storage.sync area. Device A pushes (flush); device B reconciles
// (_pullAll). Exercises projection, last-write-wins, tombstone propagation,
// local-image preservation, the size budget, and echo suppression.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

// sync.js reads `chrome.runtime.lastError` inside _set — provide a global double.
import { MemoryStorageArea } from "./helpers/chrome-mock.js";
globalThis.chrome = { runtime: { lastError: null }, storage: {} };

import { makeRepo } from "./helpers/factory.js";
import { SyncMirror } from "../src/sync.js";

const KEY_INDEX = "c_index";
const KEY_PREFIX = "c:";

function makeDevice(deviceId, area) {
  const { repo, db, clock } = makeRepo(deviceId);
  const notifier = { bumps: 0, bump() { this.bumps++; } };
  const settings = { value: {} };
  const settingsBridge = {
    read: async () => settings.value,
    applyRemote: async (s) => { settings.value = s; },
  };
  const sync = new SyncMirror({
    repository: repo,
    deviceId,
    notifier,
    settingsBridge,
    storageSync: area,
    log: () => {},
  });
  return { deviceId, repo, db, clock, notifier, settings, sync };
}

function pair() {
  const area = new MemoryStorageArea("sync", null); // no hub: manual pull model
  return { area, A: makeDevice("devA", area), B: makeDevice("devB", area) };
}

test("flush projects a collection that another device pulls in", async () => {
  const { A, B } = pair();
  A.clock.set(100);
  const c = await A.repo.createCollection("Trip");
  await A.sync.flush();
  await B.sync._pullAll();

  const list = await B.repo.listCollections();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Trip");
  assert.equal(list[0].id, c.id);
});

test("last-write-wins: newer update wins, older is ignored", async () => {
  const { A, B } = pair();
  A.clock.set(100);
  const c = await A.repo.createCollection("Base");
  await A.sync.flush();
  await B.sync._pullAll();

  // Stale edit on B (older timestamp) must not override A's version on A.
  B.clock.set(50);
  await B.repo.renameCollection(c.id, "Stale");
  await B.sync.flush();
  await A.sync._pullAll();
  assert.equal((await A.repo.getCollection(c.id)).name, "Base");

  // Newer edit on B wins.
  B.clock.set(300);
  await B.repo.renameCollection(c.id, "Fresh");
  await B.sync.flush();
  await A.sync._pullAll();
  assert.equal((await A.repo.getCollection(c.id)).name, "Fresh");
});

test("deletion propagates as a tombstone", async () => {
  const { A, B } = pair();
  A.clock.set(100);
  const c = await A.repo.createCollection("Gone");
  await A.sync.flush();
  await B.sync._pullAll();
  assert.equal((await B.repo.listCollections()).length, 1);

  A.clock.set(200);
  await A.repo.deleteCollection(c.id);
  await A.sync.flush();
  await B.sync._pullAll();

  assert.equal((await B.repo.listCollections()).length, 0);
  assert.ok((await B.repo.getRaw(c.id)).deletedAt, "B keeps a tombstone");
});

test("projection strips media; rehydrate preserves local images", async () => {
  const { area, A, B } = pair();
  A.clock.set(100);
  const c = await A.repo.createCollection("Media");
  const it = await A.repo.addItem(c.id, {
    url: "https://p.test",
    title: "Pic",
    thumbnail: "THUMB",
    imageUrl: "IMG",
    favIconUrl: "data:image/png;base64,AAAA",
  });
  await A.sync.flush();

  const payload = area._data[KEY_PREFIX + c.id];
  const projected = payload.items[0];
  assert.equal("thumbnail" in projected, false, "thumbnail not synced");
  assert.equal("imageUrl" in projected, false, "imageUrl not synced");
  assert.equal(projected.favIconUrl, "", "data-URL favicon stripped");

  await B.sync._pullAll();
  assert.equal((await B.repo.getCollection(c.id)).items[0].thumbnail, "");

  // B has its own local thumbnail for the same item id.
  const bRaw = await B.repo.getRaw(c.id);
  bRaw.items[0].thumbnail = "BTHUMB";
  await B.repo.putRemote(bRaw);

  // A makes a newer text change; B pulls and must keep its local image.
  A.clock.set(400);
  await A.repo.renameCollection(c.id, "Media2");
  await A.sync.flush();
  await B.sync._pullAll();

  const bCol = await B.repo.getCollection(c.id);
  assert.equal(bCol.name, "Media2");
  assert.equal(bCol.items[0].thumbnail, "BTHUMB", "local image preserved");
  assert.equal(it.id, bCol.items[0].id);
});

test("oversized collections stay local and are flagged in the index", async () => {
  const { area, A } = pair();
  A.clock.set(100);
  // The per-item add path now hard-stops before a collection gets too big to
  // sync, so an oversized collection can only arrive via bulk import (restore)
  // or a legacy record. Import one and confirm sync keeps it local-only.
  await A.repo.importCollections(
    [{ id: "big1", name: "Big", sections: [], items: [{ id: "i1", type: "note", note: "x".repeat(9000) }] }],
    "merge"
  );
  const [c] = await A.repo.listCollections();
  await A.sync.flush();

  assert.equal(area._data[KEY_PREFIX + c.id], undefined, "payload not synced");
  assert.equal(area._data[KEY_INDEX][c.id].oversized, true);
  assert.equal((await A.repo.getRaw(c.id)).dirty, false, "still marked clean");
});

test("pulled remote writes land clean and do not bounce back", async () => {
  const { area, A, B } = pair();
  A.clock.set(100);
  const c = await A.repo.createCollection("One");
  await A.sync.flush();
  await B.sync._pullAll();

  assert.equal((await B.repo.listDirty()).length, 0);
  await B.sync.flush(); // nothing dirty → no rewrite
  assert.equal(area._data[KEY_INDEX][c.id].deviceId, "devA");
});

test("settings sync applies a newer remote payload", async () => {
  const { A, B } = pair();
  await A.sync.pushSettings({ theme: "dark", updatedAt: 500 });
  await B.sync._pullAll();
  assert.equal(B.settings.value.theme, "dark");
});
