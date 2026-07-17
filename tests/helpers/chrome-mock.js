// Minimal in-memory doubles for the slices of the `chrome.*` API the storage
// layer touches: `chrome.storage.local` / `chrome.storage.sync` areas and a
// shared `chrome.storage.onChanged` hub. Enough to exercise the real modules
// without a browser.

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

export function createOnChangedHub() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    _dispatch(changes, area) {
      for (const fn of listeners.slice()) fn(changes, area);
    },
  };
}

// A `chrome.storage.StorageArea`-compatible area. Every method supports both the
// callback form (used by sync.js) and the promise form (used by storage.js).
// Writes fire `onChanged` on the shared hub with this area's name.
export class MemoryStorageArea {
  constructor(areaName, hub) {
    this._data = {};
    this._area = areaName;
    this._hub = hub;
  }

  get(keys, cb) {
    const out = {};
    if (keys == null) {
      for (const k of Object.keys(this._data)) out[k] = clone(this._data[k]);
    } else if (typeof keys === "string") {
      if (keys in this._data) out[keys] = clone(this._data[keys]);
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (k in this._data) out[k] = clone(this._data[k]);
    } else if (typeof keys === "object") {
      for (const k of Object.keys(keys)) {
        out[k] = k in this._data ? clone(this._data[k]) : clone(keys[k]);
      }
    }
    if (cb) return void cb(out);
    return Promise.resolve(out);
  }

  set(obj, cb) {
    const changes = {};
    for (const k of Object.keys(obj)) {
      changes[k] = { oldValue: clone(this._data[k]), newValue: clone(obj[k]) };
      this._data[k] = clone(obj[k]);
    }
    if (this._hub) this._hub._dispatch(changes, this._area);
    if (cb) return void cb();
    return Promise.resolve();
  }

  remove(keys, cb) {
    const list = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of list) {
      if (k in this._data) {
        changes[k] = { oldValue: clone(this._data[k]), newValue: undefined };
        delete this._data[k];
      }
    }
    if (Object.keys(changes).length && this._hub) this._hub._dispatch(changes, this._area);
    if (cb) return void cb();
    return Promise.resolve();
  }

  clear(cb) {
    this._data = {};
    if (cb) return void cb();
    return Promise.resolve();
  }
}

// Build a full `chrome` double. `sync` is optional (some suites share one area
// across simulated devices and inject it directly).
export function createChrome({ hub, sync } = {}) {
  const onChanged = hub || createOnChangedHub();
  return {
    runtime: { lastError: null },
    storage: {
      onChanged,
      local: new MemoryStorageArea("local", onChanged),
      sync: sync || new MemoryStorageArea("sync", onChanged),
    },
  };
}
