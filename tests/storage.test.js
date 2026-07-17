// Facade + migration tests for the public CollectionStore. Runs the real
// storage.js against fake-indexeddb and a chrome double. Globals must be
// installed BEFORE importing storage.js (its module init reads chrome + opens
// the db), so we seed the legacy blob and import dynamically at top level.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createChrome } from "./helpers/chrome-mock.js";

globalThis.chrome = createChrome();

// Seed a legacy single-blob payload so the one-time migration has work to do.
await globalThis.chrome.storage.local.set({
  collections_data: {
    collections: [
      {
        id: "legacy-col-1",
        name: "Legacy",
        createdAt: 1,
        sections: [],
        items: [
          { id: "legacy-item-1", type: "page", title: "Old page", url: "https://old.test" },
        ],
      },
    ],
  },
});

const { CollectionStore } = await import("../src/storage.js");

test("migrates the legacy blob into IndexedDB on first init", async () => {
  const cols = await CollectionStore.getCollections();
  assert.equal(cols.length, 1);
  assert.equal(cols[0].name, "Legacy");
  assert.equal(cols[0].items[0].url, "https://old.test");
});

test("collections_data becomes a change beacon after a mutation", async () => {
  await CollectionStore.createCollection("Fresh");
  const beacon = globalThis.chrome.storage.local._data.collections_data;
  assert.equal(Array.isArray(beacon.collections), false);
  assert.equal(typeof beacon.n, "number");
  assert.ok(beacon.source);

  const cols = await CollectionStore.getCollections();
  assert.ok(cols.some((c) => c.name === "Fresh"));
});

test("public mutation API round-trips through the repository", async () => {
  const c = await CollectionStore.createCollection("Work");
  const item = await CollectionStore.addItem(c.id, { title: "n", type: "note", note: "hi" });
  const sec = await CollectionStore.addSection(c.id, "Refs");
  await CollectionStore.updateItem(c.id, item.id, { note: "edited" });

  const snap = await CollectionStore.getSnapshot();
  const work = snap.collections.find((x) => x.id === c.id);
  assert.equal(work.items[0].note, "edited");
  assert.equal(work.sections[0].title, "Refs");
  assert.equal(work.sections[0].id, sec.id);
});

test("saveSettings persists and merges defaults", async () => {
  await CollectionStore.saveSettings({ theme: "dark" });
  const s = await CollectionStore.getSettings();
  assert.equal(s.theme, "dark");
  assert.equal(s.pinned, false); // default preserved
  assert.equal(globalThis.chrome.storage.local._data.app_settings.theme, "dark");
});

test("export produces a portable shape; import replace swaps contents", async () => {
  const exported = await CollectionStore.exportData();
  assert.equal(exported.version, 1);
  assert.ok(Array.isArray(exported.collections));
  // Export omits internal sync metadata.
  assert.equal("dirty" in exported.collections[0], false);
  assert.equal("rev" in exported.collections[0], false);

  const count = await CollectionStore.importData(
    { collections: [{ name: "Solo", sections: [], items: [] }] },
    "replace"
  );
  assert.equal(count, 1);
  const cols = await CollectionStore.getCollections();
  assert.deepEqual(cols.map((c) => c.name), ["Solo"]);
});
