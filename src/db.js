// Low-level IndexedDB access. This module knows nothing about collections — it
// only exposes generic object-store primitives (get / put / delete / cursor).
// The domain layer (repository.js) depends on this abstraction, not on the raw
// IndexedDB API, so the storage engine can be swapped without touching domain
// code (Dependency Inversion).
//
// A single connection is cached and lazily (re)opened. Manifest V3 service
// workers can be suspended at any time; if the connection is closed underneath
// us we transparently reopen on the next call.

export class IndexedDbAdapter {
  /**
   * @param {string} name    Database name.
   * @param {number} version Schema version (bump to trigger `upgrade`).
   * @param {(db: IDBDatabase, oldVersion: number) => void} upgrade
   *        Called inside the versionchange transaction to create stores/indexes.
   */
  constructor(name, version, upgrade) {
    this._name = name;
    this._version = version;
    this._upgrade = upgrade;
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this._name, this._version);
      req.onupgradeneeded = (event) => this._upgrade(req.result, event.oldVersion);
      req.onsuccess = () => {
        const db = req.result;
        // Drop the cache if the connection is force-closed (e.g. a newer
        // version opened elsewhere) so the next call reopens cleanly.
        db.onclose = () => {
          this._dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          this._dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    }).catch((err) => {
      this._dbPromise = null;
      throw err;
    });
    return this._dbPromise;
  }

  async _tx(storeNames, mode, run) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      let result;
      let tx;
      try {
        tx = db.transaction(storeNames, mode);
      } catch (err) {
        // Connection closed between _open() and here: reset and let caller retry.
        this._dbPromise = null;
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
      // `run` schedules requests and hands back the value to resolve with.
      result = run(tx);
    });
  }

  static _await(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(store, key) {
    return this._tx(store, "readonly", (tx) =>
      IndexedDbAdapter._await(tx.objectStore(store).get(key))
    );
  }

  async getAll(store) {
    return this._tx(store, "readonly", (tx) =>
      IndexedDbAdapter._await(tx.objectStore(store).getAll())
    );
  }

  async put(store, value) {
    await this._tx(store, "readwrite", (tx) =>
      IndexedDbAdapter._await(tx.objectStore(store).put(value))
    );
    return value;
  }

  async delete(store, key) {
    return this._tx(store, "readwrite", (tx) =>
      IndexedDbAdapter._await(tx.objectStore(store).delete(key))
    );
  }

  // Write many records to one store in a single transaction (atomic bulk write).
  async bulkPut(store, values) {
    if (!values.length) return;
    return this._tx(store, "readwrite", (tx) => {
      const os = tx.objectStore(store);
      for (const value of values) os.put(value);
    });
  }

  // Replace the full contents of a store atomically (clear + write).
  async replaceAll(store, values) {
    return this._tx(store, "readwrite", (tx) => {
      const os = tx.objectStore(store);
      os.clear();
      for (const value of values) os.put(value);
    });
  }

  // Cursor over an index, newest-first by the index key, invoking `visit(value)`
  // until it returns false or the cursor is exhausted. Used for "changed since"
  // style scans without loading the whole store.
  async forEachByIndex(store, index, visit) {
    return this._tx(store, "readonly", (tx) => {
      const source = tx.objectStore(store).index(index);
      return new Promise((resolve, reject) => {
        const req = source.openCursor(null, "prev");
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve();
          if (visit(cursor.value) === false) return resolve();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }
}
