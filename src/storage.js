// Storage facade. Public surface for the rest of the app: `CollectionStore`.
// The API is unchanged from the original single-blob implementation so callers
// (background.js, sidepanel.js, overlay.js) keep working untouched — but the
// backing store is now IndexedDB (per-collection records → O(1)-ish writes,
// room for images) with a chrome.storage.sync mirror for cross-device sync.
//
// Composition (each part has one responsibility):
//   IndexedDbAdapter     — raw IndexedDB primitives (db.js)
//   CollectionRepository — domain reads/writes + sync metadata (repository.js)
//   SyncMirror           — chrome.storage.sync push/pull + LWW merge (sync.js)
//   notifier             — bumps a revision beacon in chrome.storage.local so the
//                          existing chrome.storage.onChanged listeners still fire
//   migrateLegacyBlob    — one-time move of the legacy single-blob into IndexedDB
//
// `collections_data` in chrome.storage.local no longer holds data — it is the
// lightweight change beacon. Views observe it exactly as before.

import { IndexedDbAdapter } from "./db.js";
import {
  CollectionRepository,
  STORE_COLLECTIONS,
  STORE_META,
  INDEX_UPDATED_AT,
  normalize,
} from "./repository.js";
import { SyncMirror } from "./sync.js";

const STORAGE_KEY = "collections_data"; // now a revision beacon, not the data
const SETTINGS_KEY = "app_settings";
const SCHEMA_VERSION = 1; // export-file schema (kept stable for interop)

const DB_NAME = "collections_db";
const DB_VERSION = 1;

const DEFAULT_SETTINGS = { theme: "system", pinned: false };

// Extension pages have a `window`; the module service worker does not. Only the
// service worker migrates and drives outbound sync (single writer).
const IS_SERVICE_WORKER = typeof window === "undefined";

const log = (...a) => console.log("[Collection][store]", ...a);

// --- Ids / revisions -------------------------------------------------------

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let revSeq = 0;
function nextRev() {
  return `${Date.now().toString(36)}-${(revSeq++).toString(36)}`;
}

// --- Wiring ----------------------------------------------------------------

const db = new IndexedDbAdapter(DB_NAME, DB_VERSION, (database) => {
  if (!database.objectStoreNames.contains(STORE_COLLECTIONS)) {
    const store = database.createObjectStore(STORE_COLLECTIONS, { keyPath: "id" });
    store.createIndex(INDEX_UPDATED_AT, "updatedAt");
  }
  if (!database.objectStoreNames.contains(STORE_META)) {
    database.createObjectStore(STORE_META, { keyPath: "key" });
  }
});

// deviceId is filled during init(); mutations await ready first, so every
// write is stamped with a real device id.
const clock = { now: () => Date.now(), nextRev, deviceId: "pending", uid };

const repository = new CollectionRepository(db, clock);

let beaconSeq = 0;
const notifier = {
  bump(source) {
    // Any value change here fires chrome.storage.onChanged in every context.
    chrome.storage.local
      .set({ [STORAGE_KEY]: { at: Date.now(), n: beaconSeq++, source: source || "local" } })
      .catch(() => {});
  },
};

const settingsBridge = {
  read: () => getSettings(),
  applyRemote: (remote) => writeSettingsLocal(remote),
};

const sync = new SyncMirror({
  repository,
  deviceId: clock.deviceId, // replaced with the resolved id in init()
  notifier,
  settingsBridge,
  log,
});

// --- Init: device id, migration, sync start --------------------------------

async function ensureDeviceId() {
  const existing = await db.get(STORE_META, "deviceId");
  if (existing && existing.value) return existing.value;
  if (!IS_SERVICE_WORKER) return "local"; // pages don't own id creation
  const value =
    (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) || `dev-${uid()}`;
  await db.put(STORE_META, { key: "deviceId", value });
  return value;
}

async function migrateLegacyBlob() {
  const flag = await db.get(STORE_META, "migrated");
  if (flag && flag.value) return;
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const legacy = res[STORAGE_KEY];
  if (legacy && Array.isArray(legacy.collections)) {
    let order = 0;
    const now = Date.now();
    const records = legacy.collections.map((c) => {
      const rec = normalize({ ...c });
      rec.order = order++;
      rec.createdAt = c.createdAt || now;
      rec.updatedAt = c.updatedAt || now;
      rec.rev = nextRev();
      rec.deviceId = clock.deviceId;
      rec.deletedAt = null;
      rec.dirty = true; // seed the sync mirror with migrated data
      return rec;
    });
    if (records.length) await db.bulkPut(STORE_COLLECTIONS, records);
    log("migrated", records.length, "collections from legacy blob");
  }
  await db.put(STORE_META, { key: "migrated", value: true });
  notifier.bump("migrate"); // also overwrites the legacy blob with a beacon
}

async function init() {
  clock.deviceId = await ensureDeviceId();
  sync._deviceId = clock.deviceId;
  if (IS_SERVICE_WORKER) {
    await migrateLegacyBlob();
    sync.start();
  }
}

const ready = init().catch((err) => {
  console.warn("[Collection][store] init failed:", err?.message);
});

// --- Settings --------------------------------------------------------------

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

// Write settings to local storage (fires the existing SETTINGS_KEY listeners).
async function writeSettingsLocal(next) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...(patch || {}),
    updatedAt: Date.now(),
    deviceId: clock.deviceId,
  };
  await writeSettingsLocal(next);
  sync.pushSettings(next).catch(() => {});
  return next;
}

// --- Reads -----------------------------------------------------------------

async function getCollections() {
  await ready;
  return repository.listCollections();
}

// One call that returns both collections and settings for the hot path
// (overlay boot / command handling).
async function getSnapshot() {
  await ready;
  const [collections, settings] = await Promise.all([
    repository.listCollections(),
    getSettings(),
  ]);
  return { collections, settings };
}

// --- Export / Import -------------------------------------------------------

// Strip internal sync metadata so export files stay portable and match the
// original format.
function toExport(col) {
  return {
    id: col.id,
    name: col.name,
    createdAt: col.createdAt,
    updatedAt: col.updatedAt,
    sections: (col.sections || []).map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
    })),
    items: (col.items || []).map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      url: i.url,
      favIconUrl: i.favIconUrl,
      thumbnail: i.thumbnail,
      note: i.note,
      color: i.color,
      imageUrl: i.imageUrl,
      sectionId: i.sectionId || null,
      addedAt: i.addedAt,
    })),
  };
}

async function exportData(collectionId) {
  await ready;
  const collections = await repository.listCollections();
  const chosen = collectionId
    ? collections.filter((c) => c.id === collectionId)
    : collections;
  return {
    version: SCHEMA_VERSION,
    exportedAt: Date.now(),
    collections: chosen.map(toExport),
  };
}

// Never trust imported JSON — sanitize into clean domain objects here.
function sanitizeImported(raw) {
  const collectionsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.collections)
    ? raw.collections
    : null;
  if (!collectionsRaw) {
    throw new Error("File does not contain a valid collections array.");
  }
  const now = Date.now();
  return collectionsRaw.map((c) => {
    const sections = Array.isArray(c.sections)
      ? c.sections
          .filter((s) => s && typeof s.title === "string")
          .map((s) => ({ id: uid(), title: s.title, createdAt: Number(s.createdAt) || now }))
      : [];
    const idRemap = new Map();
    if (Array.isArray(c.sections)) {
      c.sections.forEach((orig, idx) => {
        if (sections[idx]) idRemap.set(orig.id, sections[idx].id);
      });
    }
    return {
      id: uid(),
      name: typeof c.name === "string" && c.name.trim() ? c.name : "Imported collection",
      createdAt: Number(c.createdAt) || now,
      updatedAt: now,
      sections,
      items: Array.isArray(c.items)
        ? c.items.map((i) => ({
            id: uid(),
            type: ["page", "note", "image"].includes(i.type) ? i.type : "page",
            title: typeof i.title === "string" ? i.title : "",
            url: typeof i.url === "string" ? i.url : "",
            favIconUrl: typeof i.favIconUrl === "string" ? i.favIconUrl : "",
            thumbnail: typeof i.thumbnail === "string" ? i.thumbnail : "",
            note: typeof i.note === "string" ? i.note : "",
            color: typeof i.color === "string" ? i.color : "",
            imageUrl: typeof i.imageUrl === "string" ? i.imageUrl : "",
            sectionId: idRemap.get(i.sectionId) || null,
            addedAt: Number(i.addedAt) || now,
          }))
        : [],
    };
  });
}

async function importData(raw, mode) {
  const imported = sanitizeImported(raw);
  return repository.importCollections(imported, mode);
}

// --- Mutation plumbing -----------------------------------------------------

// Serialize all mutations so concurrent read-modify-write cycles can't clobber
// each other. Mutations run one at a time in the order they are enqueued.
let writeChain = Promise.resolve();
function serialize(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function afterMutation() {
  notifier.bump("local");
  if (IS_SERVICE_WORKER) sync.scheduleFlush();
}

const MUTATION_METHODS = [
  "createCollection",
  "renameCollection",
  "deleteCollection",
  "reorderCollections",
  "addItem",
  "updateItem",
  "deleteItem",
  "reorderItems",
  "addSection",
  "renameSection",
  "deleteSection",
  "reorderSections",
  "applyItemLayout",
  "importData",
];

// Repository holds the domain logic; importData wraps sanitize + repository.
const impl = {
  createCollection: (...a) => repository.createCollection(...a),
  renameCollection: (...a) => repository.renameCollection(...a),
  deleteCollection: (...a) => repository.deleteCollection(...a),
  reorderCollections: (...a) => repository.reorderCollections(...a),
  addItem: (...a) => repository.addItem(...a),
  updateItem: (...a) => repository.updateItem(...a),
  deleteItem: (...a) => repository.deleteItem(...a),
  reorderItems: (...a) => repository.reorderItems(...a),
  addSection: (...a) => repository.addSection(...a),
  renameSection: (...a) => repository.renameSection(...a),
  deleteSection: (...a) => repository.deleteSection(...a),
  reorderSections: (...a) => repository.reorderSections(...a),
  applyItemLayout: (...a) => repository.applyItemLayout(...a),
  importData: (...a) => importData(...a),
};

const serializedMutations = Object.fromEntries(
  MUTATION_METHODS.map((name) => [
    name,
    (...args) =>
      serialize(async () => {
        await ready;
        const result = await impl[name](...args);
        afterMutation();
        return result;
      }),
  ])
);

export const CollectionStore = {
  STORAGE_KEY,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  uid,
  getCollections,
  getSnapshot,
  exportData,
  MUTATION_METHODS,
  ...serializedMutations,
};
