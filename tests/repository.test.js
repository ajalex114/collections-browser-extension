// Domain-layer tests for CollectionRepository: record shape, sync metadata,
// tombstones, ordering, and item/section mutations. No chrome, no sync — pure
// IndexedDB via fake-indexeddb.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo } from "./helpers/factory.js";
import { normalize } from "../src/repository.js";
import { ITEM_BUDGET_BYTES } from "../src/limits.js";

test("createCollection stamps sync metadata and auto-names", async () => {
  const { repo, clock } = makeRepo("devA");
  clock.set(5000);
  const c = await repo.createCollection("");
  assert.equal(c.name, "Collection 1");
  assert.equal(c.order, 0);

  const raw = await repo.getRaw(c.id);
  assert.equal(raw.updatedAt, 5000);
  assert.equal(raw.deviceId, "devA");
  assert.equal(raw.dirty, true);
  assert.equal(raw.deletedAt, null);
  assert.ok(raw.rev);
});

test("createCollection increments order and default name count", async () => {
  const { repo } = makeRepo();
  const a = await repo.createCollection("Alpha");
  const b = await repo.createCollection("");
  assert.equal(a.order, 0);
  assert.equal(b.order, 1);
  assert.equal(b.name, "Collection 2");
});

test("listCollections excludes tombstones and sorts by order", async () => {
  const { repo } = makeRepo();
  const a = await repo.createCollection("A");
  const b = await repo.createCollection("B");
  const c = await repo.createCollection("C");
  await repo.reorderCollections([c.id, a.id, b.id]);
  await repo.deleteCollection(b.id);

  const list = await repo.listCollections();
  assert.deepEqual(
    list.map((x) => x.name),
    ["C", "A"]
  );
});

test("deleteCollection writes a tombstone, not a hard delete", async () => {
  const { repo, clock } = makeRepo();
  const c = await repo.createCollection("Doomed");
  clock.tick();
  await repo.deleteCollection(c.id);

  assert.equal(await repo.getCollection(c.id), null);
  const raw = await repo.getRaw(c.id);
  assert.ok(raw, "row should still exist as a tombstone");
  assert.ok(raw.deletedAt > 0);
  assert.equal(raw.dirty, true);
  assert.deepEqual(raw.items, []);
});

test("renameCollection keeps old name when given blank", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("Keep");
  const r = await repo.renameCollection(c.id, "   ");
  assert.equal(r.name, "Keep");
});

test("addItem dedupes by url and honours atTop", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("Links");
  await repo.addItem(c.id, { url: "https://a.test", title: "A" });
  const dup = await repo.addItem(c.id, { url: "https://a.test", title: "A again" });
  assert.equal(dup.duplicate, true);

  await repo.addItem(c.id, { url: "https://b.test", title: "B" }, true);
  const col = await repo.getCollection(c.id);
  assert.deepEqual(
    col.items.map((i) => i.title),
    ["B", "A"]
  );
});

test("updateItem patches fields; deleteItem removes", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("C");
  const it = await repo.addItem(c.id, { type: "note", note: "hi" });
  await repo.updateItem(c.id, it.id, { note: "bye", color: "red" });
  let col = await repo.getCollection(c.id);
  assert.equal(col.items[0].note, "bye");
  assert.equal(col.items[0].color, "red");

  await repo.deleteItem(c.id, it.id);
  col = await repo.getCollection(c.id);
  assert.equal(col.items.length, 0);
});

test("sections: add, rename, and delete unassigns member items", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("C");
  const s = await repo.addSection(c.id, "Docs");
  const it = await repo.addItem(c.id, { title: "in section", sectionId: s.id });
  assert.equal(it.sectionId, s.id);

  await repo.renameSection(c.id, s.id, "Papers");
  await repo.deleteSection(c.id, s.id);

  const col = await repo.getCollection(c.id);
  assert.equal(col.sections.length, 0);
  assert.equal(col.items[0].sectionId, null);
});

test("reorderItems and applyItemLayout reorder and reassign", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("C");
  const s = await repo.addSection(c.id, "S");
  const a = await repo.addItem(c.id, { title: "a" });
  const b = await repo.addItem(c.id, { title: "b" });

  await repo.reorderItems(c.id, [b.id, a.id]);
  let col = await repo.getCollection(c.id);
  assert.deepEqual(col.items.map((i) => i.title), ["b", "a"]);

  await repo.applyItemLayout(c.id, [
    { id: a.id, sectionId: s.id },
    { id: b.id, sectionId: null },
  ]);
  col = await repo.getCollection(c.id);
  assert.deepEqual(col.items.map((i) => i.title), ["a", "b"]);
  assert.equal(col.items[0].sectionId, s.id);
});

test("importCollections replace tombstones existing live collections", async () => {
  const { repo } = makeRepo();
  const old = await repo.createCollection("Old");
  const n = await repo.importCollections(
    [{ id: "imp1", name: "Imported", createdAt: 1, sections: [], items: [] }],
    "replace"
  );
  assert.equal(n, 1);

  const list = await repo.listCollections();
  assert.deepEqual(list.map((c) => c.name), ["Imported"]);
  const raw = await repo.getRaw(old.id);
  assert.ok(raw.deletedAt, "old collection should be tombstoned");
});

test("listDirty / markClean / putRemote manage sync flags", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("C");
  let dirty = await repo.listDirty();
  assert.equal(dirty.length, 1);

  await repo.markClean([c.id]);
  dirty = await repo.listDirty();
  assert.equal(dirty.length, 0);

  await repo.putRemote({
    id: "remote1",
    name: "Remote",
    createdAt: 1,
    order: 9,
    sections: [],
    items: [],
    updatedAt: 10,
    rev: "x",
    deviceId: "devB",
    deletedAt: null,
  });
  const raw = await repo.getRaw("remote1");
  assert.equal(raw.dirty, false, "remote writes land clean");
});

test("normalize fills missing arrays and item.sectionId", () => {
  const col = normalize({ items: [{ id: "1" }] });
  assert.deepEqual(col.sections, []);
  assert.equal(col.order, 0);
  assert.equal(col.items[0].sectionId, null);
});

// --- Summary index --------------------------------------------------------

test("listSummaries reflects writes without item payloads", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("Links");
  await repo.addSection(c.id, "Docs");
  await repo.addItem(c.id, { url: "https://a.test", title: "A", favIconUrl: "fa" });
  await repo.addItem(c.id, { url: "https://b.test", title: "B", imageUrl: "img" });

  const sums = await repo.listSummaries();
  assert.equal(sums.length, 1);
  const s = sums[0];
  assert.equal(s.id, c.id);
  assert.equal(s.name, "Links");
  assert.equal(s.itemCount, 2);
  assert.equal(s.sectionCount, 1);
  assert.deepEqual(s.preview, ["fa", "img"]);
  assert.equal(s.items, undefined, "summary carries no item payloads");
});

test("listSummaries excludes tombstones and sorts by order", async () => {
  const { repo } = makeRepo();
  const a = await repo.createCollection("A");
  const b = await repo.createCollection("B");
  const c = await repo.createCollection("C");
  await repo.reorderCollections([c.id, a.id, b.id]);
  await repo.deleteCollection(b.id);

  const sums = await repo.listSummaries();
  assert.deepEqual(sums.map((s) => s.name), ["C", "A"]);
});

test("ensureSummaries backfills an empty summary store from collections", async () => {
  const { repo, db } = makeRepo();
  const c = await repo.createCollection("Seeded");
  await repo.addItem(c.id, { url: "https://a.test", title: "A" });

  // Simulate a pre-upgrade DB whose summaries store is empty.
  await db._tx("summaries", "readwrite", (tx) => tx.objectStore("summaries").clear());
  assert.equal((await db.getAll("summaries")).length, 0);

  await repo.ensureSummaries();
  const sums = await db.getAll("summaries");
  assert.equal(sums.length, 1);
  assert.equal(sums[0].itemCount, 1);
});

// --- Sync-size hard stop --------------------------------------------------

test("summarize carries the synced footprint and oversized flag", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("Sized");
  await repo.addItem(c.id, { url: "https://a.test", title: "A" });
  const [s] = await repo.listSummaries();
  assert.equal(typeof s.syncBytes, "number");
  assert.ok(s.syncBytes > 0);
  assert.equal(s.oversized, false);
});

test("addItem hard-stops when a collection would exceed the sync size limit", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("Big");
  const res = await repo.addItem(c.id, { type: "note", note: "x".repeat(ITEM_BUDGET_BYTES) });
  assert.deepEqual(res, { limit: "collection" });
  // The blocked add leaves no trace.
  const col = await repo.getCollection(c.id);
  assert.equal(col.items.length, 0);
});

test("addItem allows items comfortably under the per-collection budget", async () => {
  const { repo } = makeRepo();
  const c = await repo.createCollection("Ok");
  const res = await repo.addItem(c.id, { url: "https://a.test", title: "A" });
  assert.ok(res && res.id, "small add succeeds");
});

test("createCollection hard-stops when synced storage is full", async () => {
  const { repo } = makeRepo();
  // Seed near the total ceiling via import (a restore path that is intentionally
  // not limited). Each stays under the per-item budget so all count toward the
  // synced total.
  const note = "y".repeat(7000);
  const seed = [];
  for (let i = 0; i < 15; i++) {
    seed.push({ id: "seed" + i, name: "C" + i, sections: [], items: [{ id: "i" + i, type: "note", note }] });
  }
  await repo.importCollections(seed, "merge");
  const res = await repo.createCollection("One more");
  assert.deepEqual(res, { limit: "total" });
});
