// Single source of truth for the chrome.storage.sync size budget and the
// text-only projection used to measure it. Both the sync layer (which decides
// what actually fits in synced storage) and the repository (which hard-stops
// the user before they create data that could not sync) import from here, so
// the "will this sync?" question has exactly one answer.
//
// This module is pure: no chrome, no IndexedDB, no side effects — safe to
// import from any context (service worker, panel page, or a test).

// Per-key ceiling. chrome.storage.sync QUOTA_BYTES_PER_ITEM is 8192; we leave a
// little headroom so a value that measures "within budget" here still fits once
// the browser adds its own serialization overhead.
export const ITEM_BUDGET_BYTES = 8000;

// Whole-store ceiling. chrome.storage.sync QUOTA_BYTES is 102400. We reserve
// headroom for the index key (one entry per collection) and the settings key,
// which also count against the total.
export const TOTAL_BUDGET_BYTES = 98000;

export const KEY_PREFIX = "c:";

export function isLinkUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// Text-only projection sent to synced storage. Drops media (thumbnail, imageUrl)
// and any favicon that is an inlined data: URL — those stay local in IndexedDB.
export function project(rec) {
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

// Approximate the serialized size (key + JSON value) of an arbitrary key/value.
export function withinBudget(key, value) {
  return key.length + JSON.stringify(value).length + 8 <= ITEM_BUDGET_BYTES;
}

// Serialized size a collection would occupy in synced storage.
export function collectionSyncBytes(rec) {
  const key = KEY_PREFIX + rec.id;
  return key.length + JSON.stringify(project(rec)).length + 8;
}

// True when the collection still fits under the per-key ceiling.
export function withinItemBudget(rec) {
  return collectionSyncBytes(rec) <= ITEM_BUDGET_BYTES;
}
