// Domain layer for collections. Owns the collection record shape and every
// write to the `collections` object store. Depends only on the injected
// storage adapter (an IndexedDbAdapter, but any store with the same shape would
// do) and a `clock` for timestamps / revisions / device identity — so it stays
// unit-testable and free of engine details (Dependency Inversion, SRP).
//
// Every mutation stamps sync metadata: `updatedAt`, a monotonic `rev`, the
// origin `deviceId`, and `dirty: true`. Deletes write a tombstone (`deletedAt`)
// instead of removing the row, so a delete propagates across devices (and, one
// day, to a backend) rather than being silently resurrected by a stale peer.

export const STORE_COLLECTIONS = "collections";
export const STORE_META = "meta";
export const INDEX_UPDATED_AT = "updatedAt";

export class CollectionRepository {
  /**
   * @param {import("./db.js").IndexedDbAdapter} db
   * @param {{ now(): number, nextRev(): string, deviceId: string, uid(): string }} clock
   */
  constructor(db, clock) {
    this._db = db;
    this._clock = clock;
  }

  // --- Reads ---------------------------------------------------------------

  // All live collections (tombstones excluded), normalized and ordered.
  async listCollections() {
    const all = await this._db.getAll(STORE_COLLECTIONS);
    return all
      .filter((c) => c && !c.deletedAt)
      .map(normalize)
      .sort((a, b) => a.order - b.order);
  }

  async getCollection(id) {
    const rec = await this._db.get(STORE_COLLECTIONS, id);
    return rec && !rec.deletedAt ? normalize(rec) : null;
  }

  // Raw record incl. tombstones and sync metadata — for the sync layer only.
  getRaw(id) {
    return this._db.get(STORE_COLLECTIONS, id);
  }

  getAllRaw() {
    return this._db.getAll(STORE_COLLECTIONS);
  }

  // --- Write helpers -------------------------------------------------------

  _stamp(record) {
    record.updatedAt = this._clock.now();
    record.rev = this._clock.nextRev();
    record.deviceId = this._clock.deviceId;
    record.dirty = true;
    return record;
  }

  async _save(record) {
    await this._db.put(STORE_COLLECTIONS, record);
    return record;
  }

  async _nextOrder() {
    const all = await this._db.getAll(STORE_COLLECTIONS);
    let max = -1;
    for (const c of all) if (typeof c.order === "number" && c.order > max) max = c.order;
    return max + 1;
  }

  // --- Collection mutations ------------------------------------------------

  async createCollection(name) {
    const now = this._clock.now();
    const count = (await this._db.getAll(STORE_COLLECTIONS)).filter((c) => !c.deletedAt).length;
    const record = this._stamp({
      id: this._clock.uid(),
      name: (name && name.trim()) || `Collection ${count + 1}`,
      createdAt: now,
      order: await this._nextOrder(),
      sections: [],
      items: [],
      deletedAt: null,
    });
    await this._save(record);
    return normalize(record);
  }

  async renameCollection(collectionId, name) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return null;
    col.name = (name && name.trim()) || col.name;
    await this._save(this._stamp(col));
    return normalize(col);
  }

  async deleteCollection(collectionId) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return;
    // Tombstone: keep the id so peers learn of the deletion; drop the payload.
    const tomb = this._stamp({
      id: col.id,
      name: col.name,
      createdAt: col.createdAt,
      order: col.order,
      sections: [],
      items: [],
      deletedAt: this._clock.now(),
    });
    await this._save(tomb);
  }

  async reorderCollections(orderedIds) {
    const all = await this._db.getAll(STORE_COLLECTIONS);
    const live = all.filter((c) => !c.deletedAt);
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    // Unlisted collections keep a stable position after the listed ones.
    let tail = orderedIds.length;
    const touched = [];
    for (const col of live) {
      const nextOrder = rank.has(col.id) ? rank.get(col.id) : tail++;
      if (col.order !== nextOrder) {
        col.order = nextOrder;
        touched.push(this._stamp(col));
      }
    }
    if (touched.length) await this._db.bulkPut(STORE_COLLECTIONS, touched);
  }

  // --- Item mutations ------------------------------------------------------

  async addItem(collectionId, item, atTop = false) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return null;
    normalize(col);
    if (item.url) {
      const existing = col.items.find((i) => i.url && i.url === item.url);
      if (existing) return { duplicate: true, item: existing };
    }
    const newItem = {
      id: this._clock.uid(),
      type: item.type || "page",
      title: item.title || "",
      url: item.url || "",
      favIconUrl: item.favIconUrl || "",
      thumbnail: item.thumbnail || "",
      note: item.note || "",
      color: item.color || "",
      imageUrl: item.imageUrl || "",
      sectionId: item.sectionId || null,
      addedAt: this._clock.now(),
    };
    if (atTop) col.items.unshift(newItem);
    else col.items.push(newItem);
    await this._save(this._stamp(col));
    return newItem;
  }

  async updateItem(collectionId, itemId, patch) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return null;
    normalize(col);
    const item = col.items.find((i) => i.id === itemId);
    if (!item) return null;
    Object.assign(item, patch);
    await this._save(this._stamp(col));
    return item;
  }

  async deleteItem(collectionId, itemId) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return;
    normalize(col);
    col.items = col.items.filter((i) => i.id !== itemId);
    await this._save(this._stamp(col));
  }

  async reorderItems(collectionId, orderedItemIds) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return;
    normalize(col);
    col.items = reorderBy(col.items, orderedItemIds);
    await this._save(this._stamp(col));
  }

  // --- Section mutations ---------------------------------------------------

  async addSection(collectionId, title) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return null;
    normalize(col);
    const section = {
      id: this._clock.uid(),
      title: (title && title.trim()) || `Section ${col.sections.length + 1}`,
      createdAt: this._clock.now(),
    };
    col.sections.push(section);
    await this._save(this._stamp(col));
    return section;
  }

  async renameSection(collectionId, sectionId, title) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return null;
    normalize(col);
    const section = col.sections.find((s) => s.id === sectionId);
    if (!section) return null;
    section.title = (title && title.trim()) || section.title;
    await this._save(this._stamp(col));
    return section;
  }

  async deleteSection(collectionId, sectionId) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return;
    normalize(col);
    col.sections = col.sections.filter((s) => s.id !== sectionId);
    for (const item of col.items) {
      if (item.sectionId === sectionId) item.sectionId = null;
    }
    await this._save(this._stamp(col));
  }

  async reorderSections(collectionId, orderedSectionIds) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return;
    normalize(col);
    col.sections = reorderBy(col.sections, orderedSectionIds);
    await this._save(this._stamp(col));
  }

  // Set each item's order and section membership in one write.
  async applyItemLayout(collectionId, entries) {
    const col = await this.getRaw(collectionId);
    if (!col || col.deletedAt) return;
    normalize(col);
    const map = new Map(col.items.map((i) => [i.id, i]));
    const ordered = [];
    for (const entry of entries) {
      const item = map.get(entry.id);
      if (!item) continue;
      item.sectionId = entry.sectionId || null;
      ordered.push(item);
      map.delete(entry.id);
    }
    for (const item of map.values()) ordered.push(item);
    col.items = ordered;
    await this._save(this._stamp(col));
  }

  // --- Bulk import ---------------------------------------------------------

  // `collections` are already sanitized domain objects. In "replace" mode every
  // existing live collection is tombstoned first so the replacement propagates.
  async importCollections(collections, mode) {
    if (mode === "replace") {
      const all = await this._db.getAll(STORE_COLLECTIONS);
      for (const col of all) {
        if (col.deletedAt) continue;
        await this._save(
          this._stamp({
            id: col.id,
            name: col.name,
            createdAt: col.createdAt,
            order: col.order,
            sections: [],
            items: [],
            deletedAt: this._clock.now(),
          })
        );
      }
    }
    let order = await this._nextOrder();
    const records = collections.map((c) =>
      this._stamp({ ...c, order: order++, deletedAt: null })
    );
    await this._db.bulkPut(STORE_COLLECTIONS, records);
    return records.length;
  }

  // --- Sync support (used only by the sync layer) --------------------------

  async listDirty() {
    const all = await this._db.getAll(STORE_COLLECTIONS);
    return all.filter((c) => c.dirty);
  }

  async markClean(ids) {
    const touched = [];
    for (const id of ids) {
      const rec = await this._db.get(STORE_COLLECTIONS, id);
      if (rec && rec.dirty) {
        rec.dirty = false;
        touched.push(rec);
      }
    }
    if (touched.length) await this._db.bulkPut(STORE_COLLECTIONS, touched);
  }

  // Persist a record received from a peer. Written clean (already in sync) so it
  // is not immediately pushed back out. LWW arbitration happens in the caller.
  async putRemote(record) {
    record.dirty = false;
    await this._db.put(STORE_COLLECTIONS, record);
  }
}

// Ensure a record has the arrays/fields the UI expects. Mutates in place and
// also returns it. Mirrors the legacy normalization in the old storage layer.
export function normalize(col) {
  if (!Array.isArray(col.sections)) col.sections = [];
  if (!Array.isArray(col.items)) col.items = [];
  if (typeof col.order !== "number") col.order = 0;
  for (const item of col.items) {
    if (item.sectionId === undefined) item.sectionId = null;
  }
  return col;
}

// Reorder `list` to match `orderedIds`, appending any entries not listed.
function reorderBy(list, orderedIds) {
  const map = new Map(list.map((x) => [x.id, x]));
  const out = orderedIds.map((id) => map.get(id)).filter(Boolean);
  for (const x of list) if (!orderedIds.includes(x.id)) out.push(x);
  return out;
}
