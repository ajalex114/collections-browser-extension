// Test factories: build the real IndexedDbAdapter + CollectionRepository against
// fake-indexeddb, with a controllable clock so tests can force timestamps for
// last-write-wins scenarios. Import `fake-indexeddb/auto` before using these so
// the global `indexedDB` is installed.

import { IndexedDbAdapter } from "../../src/db.js";
import {
  CollectionRepository,
  STORE_COLLECTIONS,
  STORE_META,
  INDEX_UPDATED_AT,
} from "../../src/repository.js";

let dbSeq = 0;

// Deterministic clock. `now()` returns a mutable value tests can set/advance.
export function makeClock(deviceId = "devTest", startAt = 1000) {
  let uidSeq = 0;
  let rev = 0;
  const state = { t: startAt };
  return {
    deviceId,
    now: () => state.t,
    nextRev: () => `${deviceId}-r${rev++}`,
    uid: () => `${deviceId}-id${uidSeq++}`,
    set(t) {
      state.t = t;
    },
    tick(ms = 1) {
      state.t += ms;
      return state.t;
    },
  };
}

// Fresh adapter over a unique db name, mirroring storage.js's schema.
export function makeAdapter() {
  const name = `test_db_${process.pid}_${dbSeq++}_${Date.now()}`;
  return new IndexedDbAdapter(name, 1, (database) => {
    if (!database.objectStoreNames.contains(STORE_COLLECTIONS)) {
      const store = database.createObjectStore(STORE_COLLECTIONS, { keyPath: "id" });
      store.createIndex(INDEX_UPDATED_AT, "updatedAt");
    }
    if (!database.objectStoreNames.contains(STORE_META)) {
      database.createObjectStore(STORE_META, { keyPath: "key" });
    }
  });
}

export function makeRepo(deviceId = "devTest") {
  const clock = makeClock(deviceId);
  const db = makeAdapter();
  const repo = new CollectionRepository(db, clock);
  return { repo, db, clock };
}
