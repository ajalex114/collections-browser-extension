// Storage layer for Collections. All data lives in chrome.storage.local under a
// single key so import/export stays a straightforward JSON blob.

const STORAGE_KEY = "collections_data";
const SETTINGS_KEY = "app_settings";
const SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS = { theme: "system", pinned: false };

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...(patch || {}) };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function emptyStore() {
  return { version: SCHEMA_VERSION, collections: [] };
}

async function loadStore() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const data = result[STORAGE_KEY];
  if (!data || !Array.isArray(data.collections)) {
    return emptyStore();
  }
  // Normalize older stores that predate sections / per-item section membership.
  for (const col of data.collections) {
    if (!Array.isArray(col.sections)) col.sections = [];
    if (Array.isArray(col.items)) {
      for (const item of col.items) {
        if (item.sectionId === undefined) item.sectionId = null;
      }
    }
  }
  return data;
}

async function saveStore(store) {
  store.version = SCHEMA_VERSION;
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
  return store;
}

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

async function getCollections() {
  const store = await loadStore();
  return store.collections;
}

async function createCollection(name) {
  const store = await loadStore();
  const existingCount = store.collections.length;
  const now = Date.now();
  const collection = {
    id: uid(),
    name: (name && name.trim()) || `Collection ${existingCount + 1}`,
    createdAt: now,
    updatedAt: now,
    sections: [],
    items: [],
  };
  store.collections.push(collection);
  await saveStore(store);
  return collection;
}

async function renameCollection(collectionId, name) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return null;
  col.name = (name && name.trim()) || col.name;
  col.updatedAt = Date.now();
  await saveStore(store);
  return col;
}

async function deleteCollection(collectionId) {
  const store = await loadStore();
  store.collections = store.collections.filter((c) => c.id !== collectionId);
  await saveStore(store);
}

async function reorderCollections(orderedIds) {
  const store = await loadStore();
  const map = new Map(store.collections.map((c) => [c.id, c]));
  const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
  // Keep any collections not present in the ordered list (safety).
  for (const c of store.collections) {
    if (!orderedIds.includes(c.id)) reordered.push(c);
  }
  store.collections = reordered;
  await saveStore(store);
}

async function addItem(collectionId, item, atTop = false) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return null;
  // Reject a link that already exists in this collection (by URL).
  if (item.url) {
    const existing = col.items.find((i) => i.url && i.url === item.url);
    if (existing) return { duplicate: true, item: existing };
  }
  const newItem = {
    id: uid(),
    type: item.type || "page",
    title: item.title || "",
    url: item.url || "",
    favIconUrl: item.favIconUrl || "",
    thumbnail: item.thumbnail || "",
    note: item.note || "",
    color: item.color || "",
    imageUrl: item.imageUrl || "",
    sectionId: item.sectionId || null,
    addedAt: Date.now(),
  };
  if (atTop) col.items.unshift(newItem);
  else col.items.push(newItem);
  col.updatedAt = Date.now();
  await saveStore(store);
  return newItem;
}

async function updateItem(collectionId, itemId, patch) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return null;
  const item = col.items.find((i) => i.id === itemId);
  if (!item) return null;
  Object.assign(item, patch);
  col.updatedAt = Date.now();
  await saveStore(store);
  return item;
}

async function deleteItem(collectionId, itemId) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return;
  col.items = col.items.filter((i) => i.id !== itemId);
  col.updatedAt = Date.now();
  await saveStore(store);
}

async function reorderItems(collectionId, orderedItemIds) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return;
  const map = new Map(col.items.map((i) => [i.id, i]));
  const reordered = orderedItemIds.map((id) => map.get(id)).filter(Boolean);
  for (const i of col.items) {
    if (!orderedItemIds.includes(i.id)) reordered.push(i);
  }
  col.items = reordered;
  col.updatedAt = Date.now();
  await saveStore(store);
}

// --- Sections --------------------------------------------------------------

async function addSection(collectionId, title) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return null;
  if (!Array.isArray(col.sections)) col.sections = [];
  const section = {
    id: uid(),
    title: (title && title.trim()) || `Section ${col.sections.length + 1}`,
    createdAt: Date.now(),
  };
  col.sections.push(section);
  col.updatedAt = Date.now();
  await saveStore(store);
  return section;
}

async function renameSection(collectionId, sectionId, title) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return null;
  const section = (col.sections || []).find((s) => s.id === sectionId);
  if (!section) return null;
  section.title = (title && title.trim()) || section.title;
  col.updatedAt = Date.now();
  await saveStore(store);
  return section;
}

async function deleteSection(collectionId, sectionId) {  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return;
  col.sections = (col.sections || []).filter((s) => s.id !== sectionId);
  // Items belonging to the removed section fall back to ungrouped.
  for (const item of col.items) {
    if (item.sectionId === sectionId) item.sectionId = null;
  }
  col.updatedAt = Date.now();
  await saveStore(store);
}

async function reorderSections(collectionId, orderedSectionIds) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col || !Array.isArray(col.sections)) return;
  const map = new Map(col.sections.map((s) => [s.id, s]));
  const reordered = orderedSectionIds.map((id) => map.get(id)).filter(Boolean);
  for (const s of col.sections) {
    if (!orderedSectionIds.includes(s.id)) reordered.push(s);
  }
  col.sections = reordered;
  col.updatedAt = Date.now();
  await saveStore(store);
}

// Apply a full item layout: sets each item's order and section membership in a
// single write. `entries` is an ordered array of { id, sectionId }.
async function applyItemLayout(collectionId, entries) {
  const store = await loadStore();
  const col = store.collections.find((c) => c.id === collectionId);
  if (!col) return;
  const map = new Map(col.items.map((i) => [i.id, i]));
  const ordered = [];
  for (const entry of entries) {
    const item = map.get(entry.id);
    if (!item) continue;
    item.sectionId = entry.sectionId || null;
    ordered.push(item);
    map.delete(entry.id);
  }
  // Preserve any items not represented in the layout (safety).
  for (const item of map.values()) ordered.push(item);
  col.items = ordered;
  col.updatedAt = Date.now();
  await saveStore(store);
}

// --- Import / Export -------------------------------------------------------

function sanitizeImported(raw) {
  // Accept either a full store { collections: [...] } or a bare array.
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
    // Remap imported section ids so item.sectionId still resolves after import.
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

async function exportData(collectionId) {
  const store = await loadStore();
  if (collectionId) {
    const col = store.collections.find((c) => c.id === collectionId);
    return { version: SCHEMA_VERSION, exportedAt: Date.now(), collections: col ? [col] : [] };
  }
  return { version: SCHEMA_VERSION, exportedAt: Date.now(), collections: store.collections };
}

async function importData(raw, mode) {
  const imported = sanitizeImported(raw);
  const store = await loadStore();
  if (mode === "replace") {
    store.collections = imported;
  } else {
    store.collections = store.collections.concat(imported);
  }
  await saveStore(store);
  return imported.length;
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

const impl = {
  createCollection,
  renameCollection,
  deleteCollection,
  reorderCollections,
  addItem,
  updateItem,
  deleteItem,
  reorderItems,
  addSection,
  renameSection,
  deleteSection,
  reorderSections,
  applyItemLayout,
  importData,
};

const serializedMutations = Object.fromEntries(
  MUTATION_METHODS.map((name) => [name, (...args) => serialize(() => impl[name](...args))])
);

export const CollectionStore = {
  STORAGE_KEY,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  uid,
  getCollections,
  exportData,
  MUTATION_METHODS,
  ...serializedMutations,
};
