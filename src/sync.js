// Cross-device sync via chrome.storage.sync. Reflects a text-only, size-bounded
// projection of each collection to the browser's synced storage (Edge/Chrome
// sync the values across the user's signed-in devices). Images and other heavy
// blobs stay local in IndexedDB — storage.sync is tiny (~100 KB total, ~8 KB per
// item), so we never try to push them.
//
// This is one concrete implementation of an implicit SyncTarget contract:
//   start(), scheduleFlush(), and inbound handling.
// A future HTTP-backed sync can implement the same contract and drop in behind
// the facade without touching the repository or UI (Open/Closed).
//
// Writes are debounced and coalesced (storage.sync is rate-limited). Conflicts
// resolve last-write-wins by (updatedAt, deviceId). Our own writes echo back
// through onChanged but lose the LWW comparison (equal timestamps), so they are
// ignored without special-casing.

const KEY_PREFIX = "c:";
const KEY_INDEX = "c_index";
const KEY_SETTINGS = "settings";
const FLUSH_DELAY_MS = 2000;
// Leave headroom under chrome.storage.sync QUOTA_BYTES_PER_ITEM (8192).
const ITEM_BUDGET_BYTES = 8000;

export class SyncMirror {
  /**
   * @param {{
   *   repository: import("./repository.js").CollectionRepository,
   *   deviceId: string,
   *   notifier: { bump(source?: string): void },
   *   settingsBridge: { read(): Promise<object>, applyRemote(s: object): Promise<void> },
   *   storageSync?: chrome.storage.StorageArea,
   *   log?: (...a: any[]) => void,
   * }} deps
   */
  constructor({ repository, deviceId, notifier, settingsBridge, storageSync, log }) {
    this._repo = repository;
    this._deviceId = deviceId;
    this._notifier = notifier;
    this._settings = settingsBridge;
    this._sync = storageSync || (typeof chrome !== "undefined" ? chrome.storage?.sync : null);
    this._log = log || (() => {});
    this._flushTimer = null;
    this._flushing = false;
    this._started = false;
  }

  get available() {
    return !!this._sync;
  }

  // Attach the inbound listener. Call once, in the single-writer context (SW).
  start() {
    if (this._started || !this.available) return;
    this._started = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") this._onRemoteChange(changes).catch((e) => this._log("pull failed", e));
    });
    // Reconcile anything that changed while this context was asleep.
    this._pullAll().catch((e) => this._log("initial pull failed", e));
  }

  // Debounced push of all dirty local collections + settings.
  scheduleFlush() {
    if (!this.available) return;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch((e) => this._log("flush failed", e));
    }, FLUSH_DELAY_MS);
  }

  async flush() {
    if (!this.available || this._flushing) return;
    this._flushing = true;
    try {
      const dirty = await this._repo.listDirty();
      if (!dirty.length) return;

      const index = (await this._get(KEY_INDEX)) || {};
      const batch = {};
      const removals = [];
      const cleaned = [];

      for (const rec of dirty) {
        const key = KEY_PREFIX + rec.id;
        index[rec.id] = summarize(rec);
        cleaned.push(rec.id);
        if (rec.deletedAt) {
          // Tombstone: keep only the index marker, drop the payload key.
          removals.push(key);
          continue;
        }
        const payload = project(rec);
        if (withinBudget(key, payload)) {
          batch[key] = payload;
        } else {
          // Too big for synced storage even after stripping media: keep it
          // local-only. Mark it so peers don't treat it as a deletion.
          index[rec.id].oversized = true;
          removals.push(key);
          this._log("collection too large to sync, keeping local:", rec.id);
        }
      }

      batch[KEY_INDEX] = index;
      await this._set(batch);
      if (removals.length) await this._remove(removals);
      await this._repo.markClean(cleaned);
    } finally {
      this._flushing = false;
    }
  }

  // Mirror a settings change out to synced storage.
  async pushSettings(settings) {
    if (!this.available) return;
    const stamped = { ...settings, updatedAt: settings.updatedAt || Date.now(), deviceId: this._deviceId };
    await this._set({ [KEY_SETTINGS]: stamped }).catch((e) => this._log("settings push failed", e));
  }

  // --- Inbound -------------------------------------------------------------

  async _onRemoteChange(changes) {
    let touched = false;
    for (const key of Object.keys(changes)) {
      const { newValue } = changes[key];
      if (key === KEY_SETTINGS) {
        if (await this._mergeSettings(newValue)) touched = true;
      } else if (key === KEY_INDEX) {
        // Deletions live only in the index (the payload key is removed), so
        // apply any tombstone markers we see here.
        for (const id of Object.keys(newValue || {})) {
          const meta = newValue[id];
          if (meta.deletedAt && (await this._mergeCollection(id, null, meta))) touched = true;
        }
      } else if (key.startsWith(KEY_PREFIX)) {
        if (await this._mergeCollection(key.slice(KEY_PREFIX.length), newValue)) touched = true;
      }
    }
    if (touched) this._notifier.bump("sync");
  }

  // Full reconciliation from the current synced snapshot (used on startup).
  async _pullAll() {
    const all = (await this._getAll()) || {};
    let touched = false;
    if (all[KEY_SETTINGS] && (await this._mergeSettings(all[KEY_SETTINGS]))) touched = true;
    const index = all[KEY_INDEX] || {};
    for (const id of Object.keys(index)) {
      const meta = index[id];
      const payload = meta.deletedAt ? null : all[KEY_PREFIX + id];
      if (await this._mergeCollection(id, payload, meta)) touched = true;
    }
    if (touched) this._notifier.bump("sync");
  }

  // Returns true if the local store changed.
  async _mergeCollection(id, payload, metaHint) {
    const remoteMeta = payload || metaHint;
    if (!remoteMeta) return false;
    const local = await this._repo.getRaw(id);
    if (!wins(remoteMeta, local, this._deviceId)) return false;

    if (remoteMeta.deletedAt) {
      await this._repo.putRemote({
        id,
        name: remoteMeta.name || "",
        createdAt: remoteMeta.createdAt || Date.now(),
        order: remoteMeta.order || 0,
        sections: [],
        items: [],
        updatedAt: remoteMeta.updatedAt,
        rev: remoteMeta.rev,
        deviceId: remoteMeta.deviceId,
        deletedAt: remoteMeta.deletedAt,
      });
      return true;
    }
    if (!payload) return false; // index says live but payload absent (oversized peer)
    await this._repo.putRemote(rehydrate(payload, local));
    return true;
  }

  async _mergeSettings(remote) {
    if (!remote) return false;
    const local = await this._settings.read();
    const localAt = local.updatedAt || 0;
    const remoteAt = remote.updatedAt || 0;
    if (remoteAt <= localAt) return false;
    if (remote.deviceId && remote.deviceId === this._deviceId) return false;
    await this._settings.applyRemote(remote);
    return false; // settings bridge handles its own view refresh
  }

  // --- storage.sync wrappers (promised, tolerant of missing area) ----------

  _get(key) {
    return new Promise((resolve) =>
      this._sync.get(key, (res) => resolve(res ? res[key] : undefined))
    );
  }
  _getAll() {
    return new Promise((resolve) => this._sync.get(null, (res) => resolve(res || {})));
  }
  _set(obj) {
    return new Promise((resolve, reject) =>
      this._sync.set(obj, () => {
        const err = chrome.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      })
    );
  }
  _remove(keys) {
    return new Promise((resolve) => this._sync.remove(keys, () => resolve()));
  }
}

// --- Pure helpers (projection + conflict resolution) -----------------------

// Lightweight index entry: enough to arbitrate LWW without reading the payload.
function summarize(rec) {
  return {
    updatedAt: rec.updatedAt,
    rev: rec.rev,
    deviceId: rec.deviceId,
    createdAt: rec.createdAt,
    order: rec.order,
    name: rec.name,
    deletedAt: rec.deletedAt || null,
  };
}

// Text-only projection sent to synced storage. Drops media (thumbnail, imageUrl)
// and any favicon that is an inlined data: URL — those stay in IndexedDB.
function project(rec) {
  return {
    id: rec.id,
    name: rec.name,
    createdAt: rec.createdAt,
    order: rec.order,
    updatedAt: rec.updatedAt,
    rev: rec.rev,
    deviceId: rec.deviceId,
    deletedAt: rec.deletedAt || null,
    sections: (rec.sections || []).map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
    items: (rec.items || []).map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      url: i.url,
      note: i.note,
      color: i.color,
      sectionId: i.sectionId || null,
      addedAt: i.addedAt,
      favIconUrl: isLinkUrl(i.favIconUrl) ? i.favIconUrl : "",
    })),
  };
}

// Rebuild a full local record from a synced projection, preserving any local
// media (images/thumbnails/data-URL favicons) matched by item id.
function rehydrate(payload, local) {
  const localItems = new Map((local?.items || []).map((i) => [i.id, i]));
  return {
    id: payload.id,
    name: payload.name,
    createdAt: payload.createdAt,
    order: typeof payload.order === "number" ? payload.order : 0,
    updatedAt: payload.updatedAt,
    rev: payload.rev,
    deviceId: payload.deviceId,
    deletedAt: null,
    sections: payload.sections || [],
    items: (payload.items || []).map((i) => {
      const prev = localItems.get(i.id) || {};
      return {
        id: i.id,
        type: i.type || "page",
        title: i.title || "",
        url: i.url || "",
        note: i.note || "",
        color: i.color || "",
        sectionId: i.sectionId || null,
        addedAt: i.addedAt || Date.now(),
        favIconUrl: i.favIconUrl || prev.favIconUrl || "",
        thumbnail: prev.thumbnail || "",
        imageUrl: prev.imageUrl || "",
      };
    }),
  };
}

// Last-write-wins: newer updatedAt wins; ties broken by deviceId string order.
function wins(remote, local, localDeviceId) {
  if (!local) return true;
  const ra = remote.updatedAt || 0;
  const la = local.updatedAt || 0;
  if (ra !== la) return ra > la;
  const rd = remote.deviceId || "";
  const ld = local.deviceId || localDeviceId || "";
  return rd > ld;
}

function isLinkUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function withinBudget(key, value) {
  // Approximate the serialized item size (key + JSON value) against the quota.
  return key.length + JSON.stringify(value).length + 8 <= ITEM_BUDGET_BYTES;
}
