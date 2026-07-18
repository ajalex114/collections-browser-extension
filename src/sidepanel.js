import { CollectionStore } from "./storage.js";
import { ITEM_BUDGET_BYTES, collectionSyncBytes } from "./limits.js";

// Boot timing: helps diagnose slow first-open. Durations print to the panel
// devtools console as "[Collection][perf] …". T0 is module-evaluation start.
const BOOT_T0 = performance.now();
const perf = (label) =>
  console.log(`[Collection][perf] ${label}: ${(performance.now() - BOOT_T0).toFixed(0)}ms`);

const $ = (sel) => document.querySelector(sel);

// This document serves two surfaces: the docked side panel and the toolbar
// popup (opened with ?mode=popup). Some behaviors differ between them.
const IS_POPUP = new URLSearchParams(location.search).get("mode") === "popup";

// Lightweight logging (open the side panel devtools to view). Mirrors the
// background logger so behavior is observable across both contexts.
const log = (...args) => console.log("[Collection][panel]", ...args);
const warn = (...args) => console.warn("[Collection][panel]", ...args);

// Mutations run in the service worker (single writer). Reads stay local.
function sendMutation(method, ...args) {
  return chrome.runtime.sendMessage({ type: "mutate", method, args }).then((res) => {
    if (!res || res.error) {
      warn("mutation failed:", method, res?.error);
      throw new Error(res?.error || "mutation failed");
    }
    return res.result;
  });
}

const Store = { ...CollectionStore };
for (const method of CollectionStore.MUTATION_METHODS) {
  Store[method] = (...args) => sendMutation(method, ...args);
}

const state = {
  currentCollectionId: null,
  searchQuery: "",
  pendingItem: null,
};

// --- View switching --------------------------------------------------------

function showList() {
  cancelPendingMount(); // stop mounting into the now-hidden detail list
  state.currentCollectionId = null;
  $("#detail-view").classList.add("hidden");
  $("#list-view").classList.remove("hidden");
  const search = $("#search-input");
  if (search) search.value = "";
  state.searchQuery = "";
  $("#search-results").classList.add("hidden");
  $("#empty-search").classList.add("hidden");
  $("#collections-list").classList.remove("hidden");
  return renderList();
}

function showDetail(collectionId) {
  state.currentCollectionId = collectionId;
  $("#list-view").classList.add("hidden");
  $("#detail-view").classList.remove("hidden");
  $("#detail-menu").classList.add("hidden");
  renderDetail();
}

// --- Rendering: list -------------------------------------------------------

async function renderList() {
  const summaries = await Store.getSummaries();
  const list = $("#collections-list");
  list.innerHTML = "";

  $("#empty-collections").classList.toggle("hidden", summaries.length > 0);

  for (const sum of summaries) {
    list.appendChild(collectionCard(sum));
  }
}

function collectionCard(col) {
  const li = document.createElement("li");
  li.className = "collection-card";
  li.draggable = true;
  li.dataset.id = col.id;
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.setAttribute("aria-label", `Open collection ${col.name}`);

  const thumbs = document.createElement("div");
  thumbs.className = "collection-thumbs";
  const preview = col.preview || [];
  for (let i = 0; i < 4; i++) {
    const src = preview[i];
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.onerror = () => (img.style.visibility = "hidden");
      thumbs.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "thumb-fallback";
      thumbs.appendChild(ph);
    }
  }

  const meta = document.createElement("div");
  meta.className = "collection-meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = col.name;
  const count = document.createElement("div");
  count.className = "count";
  const secN = col.sectionCount || 0;
  const itemN = col.itemCount || 0;
  const itemLabel = `${itemN} item${itemN === 1 ? "" : "s"}`;
  count.textContent = secN
    ? `${secN} section${secN === 1 ? "" : "s"} · ${itemLabel}`
    : itemLabel;
  meta.append(name, count);

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  handle.setAttribute("aria-hidden", "true");

  li.append(thumbs, meta, handle);

  li.addEventListener("click", (e) => {
    if (e.target === handle) return;
    showDetail(col.id);
  });
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      showDetail(col.id);
    }
  });

  attachDragReorder(li, list_reorderCollections);
  return li;
}

// --- Rendering: detail -----------------------------------------------------

async function renderDetail() {
  const token = ++detailRenderToken;
  cancelPendingMount(); // abandon any in-flight mount from a previous render
  const col = await Store.getCollection(state.currentCollectionId);
  if (token !== detailRenderToken) return; // superseded while awaiting the read
  if (!col) {
    showList();
    return;
  }

  $("#collection-name-input").value = col.name;

  const sections = col.sections || [];

  // Group items in one pass. Items keep document order within their bucket;
  // an item whose sectionId matches no live section is dropped (as before).
  const ungrouped = [];
  const bySection = new Map(sections.map((s) => [s.id, []]));
  for (const item of col.items) {
    if (!item.sectionId) {
      ungrouped.push(item);
      continue;
    }
    const bucket = bySection.get(item.sectionId);
    if (bucket) bucket.push(item);
  }

  const list = $("#items-list");
  list.innerHTML = "";
  const sectionsWrap = $("#sections-container");
  sectionsWrap.innerHTML = "";

  // Build the structure (section headers + empty item lists) synchronously so
  // section drag targets exist immediately, and collect every item card into a
  // single ordered mount queue. The queue is drained first-screenful-now, rest
  // in animation-frame batches — so opening a huge collection stays responsive
  // without changing the final DOM.
  const tasks = [];
  for (const item of ungrouped) tasks.push({ container: list, item });
  for (const section of sections) {
    const items = bySection.get(section.id);
    const { box, ul } = sectionBox(section, items);
    sectionsWrap.appendChild(box);
    for (const item of items) tasks.push({ container: ul, item });
  }

  const isEmpty = col.items.length === 0 && sections.length === 0;
  $("#empty-items").classList.toggle("hidden", !isEmpty);
  $("#add-section").classList.remove("hidden");

  // Warn (and, via the domain hard-stop, block) once this collection is at the
  // per-collection sync size limit. Shown from ~600 bytes short of the ceiling
  // so the user sees it before the next add is refused.
  const banner = $("#detail-limit-banner");
  const full = collectionSyncBytes(col) >= ITEM_BUDGET_BYTES - 600;
  banner.classList.toggle("hidden", !full);

  mountTasks(tasks, token);
}

// --- Incremental item mounting ---------------------------------------------
// Opening a collection builds one DOM node per item. For large collections that
// synchronous burst is the dominant cost, so we render the first screenful
// immediately and append the remainder in animation-frame batches. Every card
// still ends up in the DOM, so drag-and-drop and persistItemLayout (which read
// the whole list) are unaffected — but any operation that must see the complete
// list first calls flushPendingMount() to finish synchronously.
const FIRST_CHUNK = 30; // rendered synchronously — more than one viewport of cards
const MOUNT_BATCH = 60; // appended per animation frame thereafter
let detailRenderToken = 0;
let pendingMount = null; // { token, tasks, i, rafId } | null

function mountTasks(tasks, token) {
  let i = 0;
  const first = Math.min(FIRST_CHUNK, tasks.length);
  for (; i < first; i++) tasks[i].container.appendChild(itemCard(tasks[i].item));
  if (i >= tasks.length) {
    pendingMount = null;
    return;
  }
  pendingMount = { token, tasks, i, rafId: 0 };
  const step = () => {
    if (!pendingMount || pendingMount.token !== token) return; // superseded
    const end = Math.min(pendingMount.i + MOUNT_BATCH, tasks.length);
    for (let k = pendingMount.i; k < end; k++) {
      tasks[k].container.appendChild(itemCard(tasks[k].item));
    }
    pendingMount.i = end;
    if (end >= tasks.length) {
      pendingMount = null;
      return;
    }
    pendingMount.rafId = requestAnimationFrame(step);
  };
  pendingMount.rafId = requestAnimationFrame(step);
}

function cancelPendingMount() {
  if (pendingMount && pendingMount.rafId) cancelAnimationFrame(pendingMount.rafId);
  pendingMount = null;
}

// Synchronously append every not-yet-mounted card. Call before any operation
// that reads the full item DOM (drag start, layout persist) so it never sees a
// partially populated list.
function flushPendingMount() {
  if (!pendingMount) return;
  const { tasks, i } = pendingMount;
  cancelPendingMount();
  for (let k = i; k < tasks.length; k++) {
    tasks[k].container.appendChild(itemCard(tasks[k].item));
  }
}

function sectionBox(section, items) {
  const box = document.createElement("div");
  box.className = "section-box";
  box.dataset.sectionId = section.id;

  const header = document.createElement("div");
  header.className = "section-header";

  const handle = document.createElement("span");
  handle.className = "section-handle drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder section";
  handle.setAttribute("aria-hidden", "true");
  handle.draggable = true;
  attachSectionDrag(handle, box);

  const titleInput = document.createElement("input");
  titleInput.className = "section-title";
  titleInput.type = "text";
  titleInput.value = section.title;
  titleInput.setAttribute("aria-label", "Section title");
  titleInput.addEventListener("change", async () => {
    await Store.renameSection(state.currentCollectionId, section.id, titleInput.value);
  });
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") titleInput.blur();
  });

  const count = document.createElement("span");
  count.className = "section-count";
  count.textContent = String(items.length);
  count.setAttribute("aria-label", `${items.length} item${items.length === 1 ? "" : "s"}`);

  const del = document.createElement("button");
  del.className = "icon-btn section-del";
  del.textContent = "🗑";
  del.title = "Delete section (keeps its items)";
  del.setAttribute("aria-label", "Delete section");
  del.addEventListener("click", async () => {
    if (confirm("Delete this section? Its items move back to the top.")) {
      await Store.deleteSection(state.currentCollectionId, section.id);
      renderDetail();
    }
  });

  header.append(handle, titleInput, count, del);

  const ul = document.createElement("ul");
  ul.className = "items-list section-items item-container";
  ul.dataset.sectionId = section.id;
  attachItemContainer(ul);

  // Item cards are appended by the caller's incremental mount queue. Show the
  // "drop here" hint only when the section is genuinely empty (known up front
  // from the item count, not from the DOM which fills in asynchronously).
  if (items.length === 0) {
    const hint = document.createElement("div");
    hint.className = "section-empty hint";
    hint.textContent = "Drag items here";
    ul.appendChild(hint);
  }

  box.append(header, ul);
  return { box, ul };
}

async function addSection() {
  const section = await Store.addSection(state.currentCollectionId, "");
  await renderDetail();
  const input = document.querySelector(
    `.section-box[data-section-id="${section.id}"] .section-title`
  );
  if (input) {
    input.focus();
    input.select();
  }
}

function itemCard(item) {
  const li = document.createElement("li");
  li.className = `item-card type-${item.type}`;
  li.draggable = true;
  li.dataset.id = item.id;

  if (item.type === "image") {
    const img = document.createElement("img");
    img.className = "item-image";
    img.src = item.imageUrl;
    img.alt = item.title || "image";
    img.onerror = () => (img.style.visibility = "hidden");
    li.appendChild(img);
  } else if (item.type === "note") {
    // Notes get no leading icon; the card background signals the type.
    if (item.color) {
      li.style.background = item.color;
      li.style.borderColor = item.color;
    }
  } else {
    const fav = document.createElement("img");
    fav.className = "item-favicon";
    fav.src = item.favIconUrl || faviconFor(item.url);
    fav.onerror = () => (fav.style.visibility = "hidden");
    li.appendChild(fav);
  }

  const body = document.createElement("div");
  body.className = "item-body";

  if (item.type === "note") {
    const note = document.createElement("div");
    note.className = "item-note";
    note.textContent = item.note || "(empty note)";
    body.appendChild(note);
  } else {
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.title || item.url || "(untitled)";
    title.title = "Open link";
    if (item.url) {
      title.tabIndex = 0;
      title.setAttribute("role", "button");
      title.setAttribute("aria-label", `Open ${item.title || item.url}`);
    }
    const openItem = () => {
      if (item.url) chrome.tabs.create({ url: item.url });
    };
    title.addEventListener("click", openItem);
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openItem();
      }
    });
    body.appendChild(title);

    if (item.url) {
      const url = document.createElement("div");
      url.className = "item-url";
      url.textContent = prettyUrl(item.url);
      body.appendChild(url);
    }
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.textContent = "✎";
  editBtn.title = "Edit";
  editBtn.setAttribute("aria-label", "Edit item");
  editBtn.addEventListener("click", () => startEdit(li, item));

  const delBtn = document.createElement("button");
  delBtn.textContent = "🗑";
  delBtn.title = "Remove";
  delBtn.setAttribute("aria-label", "Remove item");
  delBtn.addEventListener("click", async () => {
    await Store.deleteItem(state.currentCollectionId, item.id);
    renderDetail();
  });

  actions.append(editBtn, delBtn);
  li.append(body, actions);

  attachItemDrag(li);
  return li;
}

function startEdit(li, item) {
  const body = li.querySelector(".item-body");
  body.innerHTML = "";

  if (item.type === "note") {
    const ta = document.createElement("textarea");
    ta.className = "note-edit";
    ta.value = item.note;
    body.appendChild(ta);

    const palette = document.createElement("div");
    palette.className = "color-palette";
    for (const color of NOTE_COLORS) {
      const swatch = document.createElement("button");
      swatch.className = "color-swatch";
      swatch.style.background = color || "var(--surface)";
      swatch.title = color ? color : "Default";
      swatch.setAttribute("aria-label", color ? `Note color ${color}` : "Default note color");
      if ((item.color || "") === color) swatch.classList.add("selected");
      // mousedown + preventDefault keeps textarea focus so the editor stays open.
      swatch.addEventListener("mousedown", async (e) => {
        e.preventDefault();
        item.color = color;
        li.style.background = color || "";
        li.style.borderColor = color || "";
        palette.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
        swatch.classList.add("selected");
        await Store.updateItem(state.currentCollectionId, item.id, { color });
      });
      palette.appendChild(swatch);
    }
    body.appendChild(palette);

    ta.focus();
    ta.addEventListener("blur", async () => {
      await Store.updateItem(state.currentCollectionId, item.id, { note: ta.value });
      renderDetail();
    });
    return;
  }

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "name-input";
  titleInput.value = item.title;
  titleInput.style.width = "100%";
  body.appendChild(titleInput);
  titleInput.focus();
  titleInput.select();

  const commit = async () => {
    await Store.updateItem(state.currentCollectionId, item.id, {
      title: titleInput.value,
    });
    renderDetail();
  };
  titleInput.addEventListener("blur", commit);
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") titleInput.blur();
    if (e.key === "Escape") renderDetail();
  });
}

// --- Drag & drop reordering ------------------------------------------------

let dragEl = null;

function attachDragReorder(el, persistFn) {
  el.addEventListener("dragstart", () => {
    dragEl = el;
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    dragEl = null;
    persistFn();
  });
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragEl || dragEl === el) return;
    const parent = el.parentNode;
    const rect = el.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    parent.insertBefore(dragEl, after ? el.nextSibling : el);
  });
}

async function list_reorderCollections() {
  const ids = [...$("#collections-list").children].map((li) => li.dataset.id);
  await Store.reorderCollections(ids);
}

// Item drag supports moving items within and across sections. On drop the full
// layout (order + section membership) is persisted in one write.
const NOTE_COLORS = ["", "#fff7d6", "#ffd6d6", "#d6f0ff", "#d9f7d6", "#e8d6ff", "#ffe4c4"];

let dragItemEl = null;

function attachItemDrag(el) {
  el.addEventListener("dragstart", (e) => {
    // Ensure every card exists before a reorder begins — the drop logic and
    // persistItemLayout enumerate the whole list.
    flushPendingMount();
    dragItemEl = el;
    el.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    dragItemEl = null;
    persistItemLayout();
  });
}

function attachItemContainer(container) {
  container.addEventListener("dragover", (e) => {
    if (!dragItemEl) return;
    e.preventDefault();
    const after = getDragAfterElement(container, e.clientY);
    if (after == null) container.appendChild(dragItemEl);
    else container.insertBefore(dragItemEl, after);
  });
}

function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll(".item-card:not(.dragging)")];
  let closest = { offset: -Infinity, element: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

async function persistItemLayout() {
  flushPendingMount(); // never persist a partially mounted list
  const entries = [];
  for (const container of document.querySelectorAll("#detail-view .item-container")) {
    const sectionId = container.dataset.sectionId || null;
    for (const li of container.children) {
      if (li.dataset && li.dataset.id) entries.push({ id: li.dataset.id, sectionId });
    }
  }
  await Store.applyItemLayout(state.currentCollectionId, entries);
}

// Section drag — reorder whole section boxes within #sections-container. The
// drag is initiated from the section's grip handle so it won't fight item drag.
let dragSectionEl = null;

function attachSectionDrag(handle, box) {
  handle.addEventListener("dragstart", (e) => {
    dragSectionEl = box;
    box.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  handle.addEventListener("dragend", () => {
    box.classList.remove("dragging");
    dragSectionEl = null;
    persistSectionOrder();
  });
}

function attachSectionContainer(container) {
  container.addEventListener("dragover", (e) => {
    if (!dragSectionEl) return;
    e.preventDefault();
    const after = getSectionAfterElement(container, e.clientY);
    if (after == null) container.appendChild(dragSectionEl);
    else container.insertBefore(dragSectionEl, after);
  });
}

function getSectionAfterElement(container, y) {
  const els = [...container.querySelectorAll(".section-box:not(.dragging)")];
  let closest = { offset: -Infinity, element: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

async function persistSectionOrder() {
  const ids = [...$("#sections-container").children]
    .map((el) => el.dataset.sectionId)
    .filter(Boolean);
  await Store.reorderSections(state.currentCollectionId, ids);
}

// --- Item creation helpers -------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function addCurrentPage() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    toast("No active page to add.");
    return;
  }
  const res = await Store.addItem(state.currentCollectionId, {
    type: "page",
    title: tab.title || tab.url,
    url: tab.url,
    favIconUrl: tab.favIconUrl || faviconFor(tab.url),
  });
  if (handledLimit(res)) return;
  if (res && res.duplicate) {
    toast("Already in this collection");
    return;
  }
  renderDetail();
  toast("Added current page");
}

async function addNote() {
  const res = await Store.addItem(state.currentCollectionId, { type: "note", note: "" });
  if (handledLimit(res)) return;
  await renderDetail();
  // Immediately open the newly-added (last) note for editing.
  const last = $("#items-list").lastElementChild;
  if (last) last.querySelector(".item-actions button").click();
}

async function addImageByUrl() {
  const url = prompt("Image URL:");
  if (!url) return;
  const res = await Store.addItem(state.currentCollectionId, {
    type: "image",
    imageUrl: url.trim(),
    title: "Image",
  });
  if (handledLimit(res)) return;
  renderDetail();
}

// --- Open-tabs picker ------------------------------------------------------

async function openTabsPicker() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const picker = $("#tabs-picker");
  picker.innerHTML = "";
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith("chrome-extension://")) continue;
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.tabId = tab.id;
    const fav = document.createElement("img");
    fav.src = tab.favIconUrl || faviconFor(tab.url);
    fav.onerror = () => (fav.style.visibility = "hidden");
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url;
    li.dataset.title = tab.title || tab.url;
    li.dataset.url = tab.url;
    li.dataset.favicon = tab.favIconUrl || "";
    li.append(cb, fav, title);
    li.addEventListener("click", (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
    });
    picker.appendChild(li);
  }
  $("#tabs-modal").classList.remove("hidden");
}

async function addSelectedTabs() {
  const checked = [...$("#tabs-picker").querySelectorAll("input:checked")];
  let added = 0;
  let skipped = 0;
  let limited = false;
  for (const cb of checked) {
    const li = cb.closest("li");
    const res = await Store.addItem(state.currentCollectionId, {
      type: "page",
      title: li.dataset.title,
      url: li.dataset.url,
      favIconUrl: li.dataset.favicon || faviconFor(li.dataset.url),
    });
    if (res && res.limit) {
      limited = true;
      break; // collection/storage full — stop before creating unsyncable data
    }
    if (res && res.duplicate) skipped++;
    else added++;
  }
  $("#tabs-modal").classList.add("hidden");
  renderDetail();
  if (limited) {
    toast(limitMessage("collection"));
    return;
  }
  const suffix = skipped ? ` (${skipped} already present)` : "";
  toast(`Added ${added} tab${added === 1 ? "" : "s"}${suffix}`);
}

// --- Collection-level actions ----------------------------------------------

async function openAllLinks() {
  const col = await Store.getCollection(state.currentCollectionId);
  if (!col) return;
  const urls = col.items.filter((i) => i.type !== "note" && i.url).map((i) => i.url);
  for (const url of urls) chrome.tabs.create({ url, active: false });
  toast(`Opened ${urls.length} link${urls.length === 1 ? "" : "s"}`);
}

async function copyAll() {
  const col = await Store.getCollection(state.currentCollectionId);
  if (!col) return;
  const lines = col.items.map((i) => {
    if (i.type === "note") return i.note;
    if (i.type === "image") return i.imageUrl;
    return `${i.title}\n${i.url}`;
  });
  await navigator.clipboard.writeText(lines.join("\n\n"));
  toast("Copied to clipboard");
}

// --- Cross-collection search -----------------------------------------------

async function findMatches(query) {
  const q = (query || "").trim().toLowerCase();
  const matches = [];
  if (!q) return matches;
  const collections = await Store.getCollections();
  for (const col of collections) {
    const nameMatch = col.name.toLowerCase().includes(q);
    // Which sections match by title — every item inside them should be listed.
    const sectionTitle = {};
    const sectionMatch = {};
    for (const s of col.sections || []) {
      sectionTitle[s.id] = s.title;
      sectionMatch[s.id] = s.title.toLowerCase().includes(q);
    }
    let itemMatched = false;
    for (const item of col.items) {
      const secTitle = item.sectionId ? sectionTitle[item.sectionId] || "" : "";
      const hay = [item.title, item.url, item.note, secTitle, col.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const inMatchedSection = item.sectionId && sectionMatch[item.sectionId];
      if (nameMatch || inMatchedSection || hay.includes(q)) {
        matches.push({ col, item });
        itemMatched = true;
      }
    }
    if (nameMatch && !itemMatched) matches.push({ col, item: null });
  }
  return matches;
}

let searchTimer;
function debouncedSearch(rawQuery) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(rawQuery), 75);
}

async function runSearch(rawQuery) {
  const query = (rawQuery || "").trim().toLowerCase();
  state.searchQuery = query;

  const listEl = $("#collections-list");
  const resultsEl = $("#search-results");
  const emptySearch = $("#empty-search");
  const emptyCollections = $("#empty-collections");

  if (!query) {
    resultsEl.classList.add("hidden");
    emptySearch.classList.add("hidden");
    listEl.classList.remove("hidden");
    renderList();
    return;
  }

  listEl.classList.add("hidden");
  emptyCollections.classList.add("hidden");

  const matches = await findMatches(query);
  resultsEl.innerHTML = "";
  for (const { col, item } of matches) resultsEl.appendChild(searchResultCard(col, item));
  resultsEl.classList.remove("hidden");
  emptySearch.classList.toggle("hidden", matches.length > 0);
}

function collectionSectionLabel(col, item) {
  if (!item || !item.sectionId) return col.name;
  const section = (col.sections || []).find((s) => s.id === item.sectionId);
  return section ? `${col.name} - ${section.title}` : col.name;
}

function searchResultCard(col, item) {
  const li = document.createElement("li");
  li.className = "item-card search-result";
  li.tabIndex = 0;
  li.setAttribute("role", "button");

  const body = document.createElement("div");
  body.className = "item-body";

  const title = document.createElement("div");
  title.className = "item-title";
  if (!item) {
    title.textContent = col.name;
  } else if (item.type === "note") {
    title.textContent = item.note || "(empty note)";
  } else {
    title.textContent = item.title || item.url || "(untitled)";
  }

  const sub = document.createElement("div");
  sub.className = "item-url";
  sub.textContent = item ? `in ${collectionSectionLabel(col, item)}` : "collection";

  body.append(title, sub);
  li.appendChild(body);
  li.setAttribute("aria-label", `${title.textContent}, ${sub.textContent}`);
  li.addEventListener("click", () => showDetail(col.id));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      showDetail(col.id);
    }
  });
  return li;
}

// --- Keyboard-shortcut pick modal ------------------------------------------

async function checkPendingAdd() {
  const { pending_add } = await chrome.storage.local.get("pending_add");
  if (pending_add && pending_add.item) openPickModal(pending_add.item);
}

async function openPickModal(pendingItem) {
  state.pendingItem = pendingItem;
  $("#pick-tab-preview").textContent = pendingItem.title || pendingItem.url || "";
  await renderPickCollections();
  $("#pick-modal").classList.remove("hidden");
}

// Step 1: choose a collection.
async function renderPickCollections() {
  $("#pick-modal .modal-card h2").textContent = "Add current tab to…";
  const list = $("#pick-list");
  list.innerHTML = "";
  const summaries = await Store.getSummaries();
  if (summaries.length === 0) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "No collections yet — create one below.";
    list.appendChild(hint);
  }
  for (const sum of summaries) {
    const li = document.createElement("li");
    li.className = "pick-item";
    li.textContent = sum.name;
    li.addEventListener("click", () => choosePickCollection(sum));
    list.appendChild(li);
  }
}

// Step 2 (only when the collection has sections): choose a section. `summary`
// is a lightweight summary; the full record is loaded only if it has sections.
async function choosePickCollection(summary) {
  if (!summary.sectionCount) {
    await confirmPick(summary.id, null);
    return;
  }
  const col = await Store.getCollection(summary.id);
  if (!col) {
    await confirmPick(summary.id, null);
    return;
  }
  const sections = col.sections || [];
  if (sections.length === 0) {
    await confirmPick(col.id, null);
    return;
  }
  $("#pick-modal .modal-card h2").textContent = `Add to “${col.name}” →`;
  const list = $("#pick-list");
  list.innerHTML = "";

  const back = document.createElement("li");
  back.className = "pick-item pick-back";
  back.textContent = "← Back to collections";
  back.addEventListener("click", () => renderPickCollections());
  list.appendChild(back);

  const top = document.createElement("li");
  top.className = "pick-item";
  top.textContent = "Ungrouped (top)";
  top.addEventListener("click", () => confirmPick(col.id, null));
  list.appendChild(top);

  for (const section of sections) {
    const li = document.createElement("li");
    li.className = "pick-item";
    li.textContent = section.title;
    li.addEventListener("click", () => confirmPick(col.id, section.id));
    list.appendChild(li);
  }
}

async function confirmPick(collectionId, sectionId = null) {
  const item = state.pendingItem;
  if (!item) return;
  const res = await Store.addItem(collectionId, { ...item, sectionId });
  if (res && res.limit) {
    toast(limitMessage(res.limit));
    return; // keep the pending item and modal open so the user can pick elsewhere
  }
  await clearPending();
  $("#pick-modal").classList.add("hidden");
  state.pendingItem = null;
  showDetail(collectionId);
  toast(res && res.duplicate ? "Already in this collection" : "Added current tab");
}

async function clearPending() {
  await chrome.storage.local.remove("pending_add");
}

// The page-injected spotlight can request opening a collection in this panel.
async function checkFocusCollection() {
  const { focus_collection } = await chrome.storage.local.get("focus_collection");
  if (focus_collection && focus_collection.collectionId) {
    await chrome.storage.local.remove("focus_collection");
    showDetail(focus_collection.collectionId);
  }
}

// --- Import / Export -------------------------------------------------------

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeName(name) {
  return (name || "collections").replace(/[^a-z0-9\-_ ]/gi, "_").trim() || "collections";
}

async function exportAll() {
  const data = await Store.exportData(null);
  downloadJson(data, `collections-${dateStamp()}.json`);
  toast("Exported all collections");
}

async function exportOne() {
  const data = await Store.exportData(state.currentCollectionId);
  const name = data.collections[0]?.name;
  downloadJson(data, `${safeName(name)}-${dateStamp()}.json`);
  toast("Exported collection");
}

async function handleImportFile(file) {
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const merge = confirm(
      "Import collections?\n\nOK = merge with existing collections.\nCancel = replace ALL existing collections."
    );
    const count = await Store.importData(raw, merge ? "merge" : "replace");
    showList();
    toast(`Imported ${count} collection${count === 1 ? "" : "s"}`);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
}

// --- Misc helpers ----------------------------------------------------------

function faviconFor(url) {
  try {
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function prettyUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function isEditing() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

// Copy for a blocked write. "collection" = this collection hit the per-item sync
// ceiling; "total" = synced storage as a whole is full.
function limitMessage(scope) {
  return scope === "total"
    ? "Sync storage is full — delete some items to save more."
    : "This collection is full — it's reached the sync size limit.";
}

// True when a mutation result signals a hard-stop; toasts the reason.
function handledLimit(res) {
  if (res && res.limit) {
    toast(limitMessage(res.limit));
    return true;
  }
  return false;
}

// Populate and open the About modal with live synced-storage usage.
async function openAbout() {
  $("#about-modal").classList.remove("hidden");
  const fill = $("#about-usage-fill");
  const text = $("#about-usage-text");
  try {
    const u = await Store.getUsage();
    const usedKb = (u.usedBytes / 1024).toFixed(1);
    const totalKb = Math.round(u.totalBytes / 1024);
    const pct = Math.min(100, Math.round((u.usedBytes / u.totalBytes) * 100));
    fill.style.width = pct + "%";
    fill.classList.toggle("near-full", pct >= 85);
    let msg = `Using ${usedKb} KB of ~${totalKb} KB (${pct}%) across ${u.syncedCollections} synced collection${
      u.syncedCollections === 1 ? "" : "s"
    }.`;
    if (u.oversizedCollections > 0) {
      msg += ` ${u.oversizedCollections} collection${
        u.oversizedCollections === 1 ? " is" : "s are"
      } too large to sync (kept on this device only).`;
    }
    text.textContent = msg;
  } catch (e) {
    warn("usage read failed:", e);
    text.textContent = "Couldn't read current usage.";
  }
}

// One-shot messages stashed by contexts without their own UI (e.g. the context
// menu). Read once and cleared.
async function checkFlash() {
  const { flash } = await chrome.storage.local.get("flash");
  if (flash && flash.message) {
    await chrome.storage.local.remove("flash");
    toast(flash.message);
  }
}

// --- Settings, theme & pin -------------------------------------------------

function applyTheme(theme) {
  const t = theme === "light" || theme === "dark" ? theme : "system";
  document.documentElement.dataset.theme = t;
  log("applied theme:", t);
}

function reflectPin(pinned) {
  const btn = $("#pin-btn");
  btn.classList.toggle("active", !!pinned);
  btn.setAttribute("aria-pressed", pinned ? "true" : "false");
  btn.title = pinned
    ? "Pinned to the side panel — click to unpin (opens as a popup)"
    : "Unpinned — opens as a toolbar popup. Click to pin to the side panel";
  const cb = $("#settings-pin");
  if (cb) cb.checked = !!pinned;
}

async function initSettings() {
  const settings = await Store.getSettings();
  applyTheme(settings.theme);
  reflectPin(settings.pinned);
  const radio = document.querySelector(`input[name="theme"][value="${settings.theme}"]`);
  if (radio) radio.checked = true;
}

async function setTheme(theme) {
  applyTheme(theme);
  await Store.saveSettings({ theme });
  log("theme saved:", theme);
}

async function setPinned(pinned) {
  await Store.saveSettings({ pinned });
  reflectPin(pinned);

  // Apply the surface switch immediately from here (don't wait for the
  // background storage listener) so the change feels instant.
  try {
    if (pinned) {
      await chrome.action.setPopup({ popup: "" });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } else {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.action.setPopup({ popup: "sidepanel.html?mode=popup" });
    }
  } catch (err) {
    warn("pin surface switch failed:", err?.message);
  }

  if (!pinned && !IS_POPUP) {
    // Unpinned from the docked side panel: close it and pop the hanging window.
    try {
      await chrome.action.openPopup();
      log("opened toolbar popup after unpin");
    } catch (err) {
      warn("openPopup unavailable, closing panel only:", err?.message);
    }
    window.close();
    return;
  }

  if (pinned && IS_POPUP) {
    // Pinned from the popup: open the docked side panel and close the popup.
    try {
      const win = await chrome.windows.getLastFocused();
      await chrome.sidePanel.open({ windowId: win.id });
      log("opened side panel after pin");
    } catch (err) {
      warn("sidePanel.open failed:", err?.message);
    }
    window.close();
    return;
  }

  toast(
    pinned
      ? "Pinned to the side panel — reopen from the toolbar to dock it"
      : "Unpinned — opens as a popup from the toolbar"
  );
}

async function togglePin() {
  const settings = await Store.getSettings();
  await setPinned(!settings.pinned);
}

// Inline "＋ Add section" input at the end of the collection.
async function addSectionFromInput() {
  const input = $("#add-section-input");
  const title = input.value.trim();
  if (!title) return;
  await Store.addSection(state.currentCollectionId, title);
  input.value = "";
  await renderDetail();
  log("added section from inline input");
}

// --- Wiring ----------------------------------------------------------------

function bindEvents() {
  $("#new-collection-btn").addEventListener("click", async () => {
    const col = await Store.createCollection("");
    if (handledLimit(col)) return;
    showDetail(col.id);
    // Focus the name field so the user can rename immediately.
    const input = $("#collection-name-input");
    input.focus();
    input.select();
  });

  $("#export-all-btn").addEventListener("click", exportAll);
  $("#import-btn").addEventListener("click", () => $("#import-file").click());

  // Pin toggle + settings modal.
  $("#pin-btn").addEventListener("click", togglePin);
  $("#settings-btn").addEventListener("click", () => {
    $("#settings-modal").classList.remove("hidden");
  });
  $("#settings-close").addEventListener("click", () => {
    $("#settings-modal").classList.add("hidden");
  });
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") $("#settings-modal").classList.add("hidden");
  });

  // About & sync-limits modal.
  $("#about-btn").addEventListener("click", openAbout);
  $("#about-close").addEventListener("click", () => {
    $("#about-modal").classList.add("hidden");
  });
  $("#about-modal").addEventListener("click", (e) => {
    if (e.target.id === "about-modal") $("#about-modal").classList.add("hidden");
  });
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.addEventListener("change", (e) => {
      if (e.target.checked) setTheme(e.target.value);
    });
  }
  $("#settings-pin").addEventListener("change", (e) => setPinned(e.target.checked));

  // Inline add-section input.
  const addSectionInput = $("#add-section-input");
  addSectionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSectionFromInput();
    } else if (e.key === "Escape") {
      addSectionInput.value = "";
      addSectionInput.blur();
    }
  });
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = "";
  });

  $("#back-btn").addEventListener("click", showList);

  const nameInput = $("#collection-name-input");
  nameInput.addEventListener("change", async () => {
    await Store.renameCollection(state.currentCollectionId, nameInput.value);
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
  });

  $("#detail-menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#detail-menu");
    // Reset any inline position set by the right-click handler.
    menu.style.left = "";
    menu.style.top = "";
    menu.style.right = "";
    const nowHidden = menu.classList.toggle("hidden");
    $("#detail-menu-btn").setAttribute("aria-expanded", nowHidden ? "false" : "true");
  });

  $("#add-current-tab-btn").addEventListener("click", () => addCurrentPage());

  // Right-click anywhere in the collection shows the same actions as the ⋯ menu.
  $("#detail-view").addEventListener("contextmenu", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return; // keep native menu on editable fields
    e.preventDefault();
    const menu = $("#detail-menu");
    menu.classList.remove("hidden");
    $("#detail-menu-btn").setAttribute("aria-expanded", "true");
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 320;
    menu.style.right = "auto";
    menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - mw - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - mh - 4)) + "px";
  });

  // Ungrouped items container accepts drops (its section list counterparts are
  // wired when each section box is rendered).
  attachItemContainer($("#items-list"));
  // Section boxes can be dragged to reorder within their container.
  attachSectionContainer($("#sections-container"));

  // Cross-collection search. Debounced so typing doesn't re-query storage and
  // rebuild the results list on every keystroke.
  $("#search-input").addEventListener("input", (e) => debouncedSearch(e.target.value));

  // Keyboard-shortcut pick modal.
  $("#pick-cancel").addEventListener("click", async () => {
    $("#pick-modal").classList.add("hidden");
    state.pendingItem = null;
    await clearPending();
  });
  $("#pick-new").addEventListener("click", async () => {
    const col = await Store.createCollection("");
    if (handledLimit(col)) return;
    await confirmPick(col.id);
  });

  document.addEventListener("click", () => {
    $("#detail-menu").classList.add("hidden");
    $("#detail-menu-btn").setAttribute("aria-expanded", "false");
  });
  $("#detail-menu").addEventListener("click", (e) => e.stopPropagation());

  $("#detail-menu").addEventListener("click", async (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    $("#detail-menu").classList.add("hidden");
    $("#detail-menu-btn").setAttribute("aria-expanded", "false");
    switch (action) {
      case "add-current":
        await addCurrentPage();
        break;
      case "add-tabs":
        await openTabsPicker();
        break;
      case "add-note":
        await addNote();
        break;
      case "add-image":
        await addImageByUrl();
        break;
      case "add-section":
        await addSection();
        break;
      case "open-all":
        await openAllLinks();
        break;
      case "copy-all":
        await copyAll();
        break;
      case "export-one":
        await exportOne();
        break;
      case "delete-collection":
        if (confirm("Delete this collection and all its items?")) {
          await Store.deleteCollection(state.currentCollectionId);
          showList();
        }
        break;
    }
  });

  $("#tabs-cancel").addEventListener("click", () => $("#tabs-modal").classList.add("hidden"));
  $("#tabs-add").addEventListener("click", addSelectedTabs);

  // Escape closes any open modal or the action menu (accessibility).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    let closed = false;
    for (const id of ["#settings-modal", "#tabs-modal", "#pick-modal"]) {
      const el = $(id);
      if (el && !el.classList.contains("hidden")) {
        el.classList.add("hidden");
        closed = true;
      }
    }
    const menu = $("#detail-menu");
    if (menu && !menu.classList.contains("hidden")) {
      menu.classList.add("hidden");
      $("#detail-menu-btn").setAttribute("aria-expanded", "false");
      closed = true;
    }
    if (closed) e.stopPropagation();
  });

  // Refresh the open view whenever storage changes (e.g. context-menu adds).
  // Skip while the user is editing a field so self-writes don't wipe input.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    // A keyboard-shortcut add stashes a pending item; prompt for its collection.
    if (changes["pending_add"] && changes["pending_add"].newValue) {
      checkPendingAdd();
    }
    // The page spotlight can request focusing a collection in this panel.
    if (changes["focus_collection"] && changes["focus_collection"].newValue) {
      checkFocusCollection();
    }
    // A UI-less context (context menu) may leave a one-shot message to surface.
    if (changes["flash"] && changes["flash"].newValue) {
      checkFlash();
    }

    if (!changes[Store.STORAGE_KEY]) return;
    if (isEditing()) return;
    if (state.currentCollectionId) {
      renderDetail();
    } else if (state.searchQuery) {
      runSearch(state.searchQuery);
    } else {
      renderList();
    }
  });
}

async function init() {
  perf("module eval → init start");
  bindEvents();
  perf("bindEvents done");
  // Settings (theme/pin) and the collection list read from independent stores
  // and don't depend on each other — run both concurrently so the list isn't
  // gated behind the settings round-trip. The "system" theme is already applied
  // statically via <html data-theme="system">, so there's no flash while the
  // stored theme resolves.
  const settingsDone = initSettings();
  const listDone = showList();
  await Promise.all([listDone, settingsDone]);
  perf("showList + initSettings done (collections painted)");
  await checkPendingAdd();
  await checkFocusCollection();
  await checkFlash();
  perf("init complete");
}

init();
