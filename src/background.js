import { CollectionStore } from "./storage.js";

const PARENT_ID = "collection-add-parent";
const NEW_COLLECTION_ID = "collection-add-new";

// Serializes context-menu rebuilds so overlapping triggers never interleave.
let menuChain = Promise.resolve();

// Lightweight logging so behavior is observable in the service-worker console
// (edge://extensions → Collection → "service worker" / "Inspect views").
const log = (...args) => console.log("[Collection][bg]", ...args);
const warn = (...args) => console.warn("[Collection][bg]", ...args);

// Service-worker boot timing. Each cold start logs when the SW script finished
// evaluating; compare against onStartup/onInstalled/rebuildMenus timings below.
const SW_T0 = Date.now();
log("service worker evaluated at", new Date(SW_T0).toISOString());

// Reflect the user's pin preference into the browser's UI surface.
// - Pinned: clicking the toolbar icon opens the docked side panel (right edge).
// - Unpinned (default): clicking opens a popup that hangs from the toolbar icon,
//   like a typical extension.
async function applyPinPreference() {
  try {
    const { pinned } = await CollectionStore.getSettings();
    if (pinned) {
      await chrome.action.setPopup({ popup: "" });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } else {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.action.setPopup({ popup: "sidepanel.html?mode=popup" });
    }
    log("applied pin preference:", pinned ? "pinned (side panel)" : "unpinned (popup)");
  } catch (err) {
    warn("applyPinPreference failed:", err?.message);
  }
}

// Keep-alive: an alarm firing every ~30s resets the service-worker idle timer,
// so the SW stays warm during active use and the *second* and later shortcut
// presses in a session avoid a cold-start (the main cause of the 1–10s delay).
// The alarm handler does a trivial storage touch and returns immediately.
const KEEPALIVE_ALARM = "collection-keepalive";
function ensureKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Touching storage is enough to keep the worker alive this cycle.
    chrome.storage.local.get(CollectionStore.SETTINGS_KEY).catch(() => {});
  }
});
ensureKeepAlive();

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  log("onInstalled");
  ensureKeepAlive();
  applyPinPreference();
  rebuildMenus();
});

chrome.runtime.onStartup.addListener(() => {
  log("onStartup");
  ensureKeepAlive();
  applyPinPreference();
  rebuildMenus();
});

// All mutations run here so writes are serialized in a single context.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "mutate") return;
  if (!CollectionStore.MUTATION_METHODS.includes(msg.method)) {
    warn("unknown mutation:", msg.method);
    sendResponse({ error: `unknown mutation: ${msg.method}` });
    return;
  }
  log("mutate:", msg.method);
  CollectionStore[msg.method](...(msg.args || []))
    .then((result) => sendResponse({ result }))
    .catch((err) => {
      warn("mutation failed:", msg.method, err?.message);
      sendResponse({ error: err.message });
    });
  return true; // keep the channel open for the async response
});

// Re-apply pin preference whenever settings change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CollectionStore.SETTINGS_KEY]) {
    applyPinPreference();
  }
});

// Quick-save picker (page overlay) asks to save the current tab into a chosen
// collection/section, at the top. Replies with the outcome so the overlay can
// confirm or warn about a duplicate.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "quick-save") return;
  // The overlay runs as an extension page (not a content script), so it passes
  // the target tab explicitly; fall back to sender.tab for any legacy caller.
  const tab = msg.tab || sender?.tab;
  if (!tab || !tab.url) {
    sendResponse({ error: "no tab" });
    return;
  }
  (async () => {
    let collectionId = msg.collectionId;
    let sectionId = msg.sectionId || null;
    if (msg.newCollection != null) {
      const col = await CollectionStore.createCollection(msg.newCollection);
      if (col && col.limit) {
        sendResponse({ limit: col.limit });
        return;
      }
      collectionId = col.id;
      sectionId = null;
      log("quick-save: created collection", col.id, col.name);
    }
    if (msg.newSection != null && collectionId) {
      const sec = await CollectionStore.addSection(collectionId, msg.newSection);
      sectionId = sec ? sec.id : null;
      log("quick-save: created section", sectionId);
    }
    if (!collectionId) {
      sendResponse({ error: "no collection" });
      return;
    }
    const item = {
      type: "page",
      title: (msg.title && msg.title.trim()) || tab.title || tab.url,
      url: tab.url,
      favIconUrl: tab.favIconUrl || faviconFor(tab.url),
      sectionId,
    };
    log("quick-save:", tab.url, "->", collectionId, "section", sectionId || "(none)");
    const res = await CollectionStore.addItem(collectionId, item, true);
    if (res && res.limit) sendResponse({ limit: res.limit });
    else if (res && res.duplicate) sendResponse({ duplicate: true });
    else sendResponse({ added: true, collectionId });
  })().catch((err) => {
    warn("quick-save failed:", err?.message);
    sendResponse({ error: err.message });
  });
  return true; // async response
});

// Quick-save picker: create a collection or section without saving anything yet,
// so the picker can stay open and let the user then choose where to save.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "create-collection") {
    CollectionStore.createCollection(msg.name)
      .then((col) => {
        if (col && col.limit) {
          sendResponse({ limit: col.limit });
          return;
        }
        log("create-collection:", col.id, col.name);
        sendResponse({ collection: { id: col.id, name: col.name } });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg?.type === "create-section") {
    CollectionStore.addSection(msg.collectionId, msg.title)
      .then((sec) => {
        log("create-section:", sec && sec.id);
        sendResponse({ section: sec ? { id: sec.id, title: sec.title } : null });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// Spotlight (overlay window) asks to open a collection in the side panel.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "open-collection") return;
  log("open-collection:", msg.collectionId);
  chrome.storage.local.set({
    focus_collection: { collectionId: msg.collectionId, at: Date.now() },
  });
  const winId = msg.windowId != null ? msg.windowId : sender?.tab?.windowId;
  if (winId != null) chrome.sidePanel.open({ windowId: winId }).catch(() => {});
});

// Keep the "Add to Collection" submenu in sync with stored collections. Item
// edits fire this too (via the shared beacon), so the actual rebuild is
// debounced and skipped when the collection set/names/order are unchanged.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CollectionStore.STORAGE_KEY]) {
    rebuildMenus();
  }
});

let menuTimer = null;
let lastMenuSig = null;
const MENU_DEBOUNCE_MS = 400;

// Debounced scheduler: coalesces bursts of mutations and keeps the (data-
// scanning) rebuild off the immediate cold-boot critical path so a shortcut
// pressed at startup is served first.
function rebuildMenus() {
  if (menuTimer) return;
  menuTimer = setTimeout(() => {
    menuTimer = null;
    menuChain = menuChain.then(doRebuildMenus, doRebuildMenus);
  }, MENU_DEBOUNCE_MS);
}

async function doRebuildMenus() {
  const t0 = Date.now();
  // Fetch BEFORE removeAll() so the parent and every child are created in one
  // synchronous burst — no await between them — guaranteeing the parent exists
  // before any child references it.
  const collections = await CollectionStore.getSummaries();

  // The menu only reflects collection ids/names/order — not their items. Skip
  // the contextMenus churn when nothing menu-relevant changed (e.g. an item was
  // added or edited). lastMenuSig is null after a cold SW start (menus don't
  // persist across restarts), so the first rebuild always runs.
  const sig = collections.map((c) => c.id + "\u0000" + (c.name || "")).join("\u0001");
  if (sig === lastMenuSig) {
    log("rebuildMenus skipped (unchanged) in", Date.now() - t0, "ms");
    return;
  }
  lastMenuSig = sig;

  await chrome.contextMenus.removeAll();
  const contexts = ["page", "link", "image", "selection"];
  chrome.contextMenus.create({
    id: PARENT_ID,
    title: "Add to Collection",
    contexts,
  });

  for (const col of collections) {
    chrome.contextMenus.create({
      id: `col:${col.id}`,
      parentId: PARENT_ID,
      title: col.name || "Untitled",
      contexts,
    });
  }

  if (collections.length > 0) {
    chrome.contextMenus.create({
      id: "sep",
      parentId: PARENT_ID,
      type: "separator",
      contexts,
    });
  }
  chrome.contextMenus.create({
    id: NEW_COLLECTION_ID,
    parentId: PARENT_ID,
    title: "＋ New collection…",
    contexts,
  });
  log("rebuildMenus done in", Date.now() - t0, "ms for", collections.length, "collections");
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let collectionId;

  if (info.menuItemId === NEW_COLLECTION_ID) {
    const col = await CollectionStore.createCollection("");
    if (col && col.limit) return flashLimit(col.limit, tab);
    collectionId = col.id;
  } else if (typeof info.menuItemId === "string" && info.menuItemId.startsWith("col:")) {
    collectionId = info.menuItemId.slice(4);
  } else {
    return;
  }

  const item = buildItemFromContext(info, tab);
  const res = await CollectionStore.addItem(collectionId, item);
  if (res && res.limit) return flashLimit(res.limit, tab);

  // Surface the panel so the user sees the result.
  if (tab && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

// The context menu has no UI of its own to warn in, so stash a one-shot message
// the side panel picks up (see sidepanel.js checkFlash) and open the panel.
function flashLimit(scope, tab) {
  const message =
    scope === "total"
      ? "Sync storage is full — delete some items to save more."
      : "That collection is full — it's reached the sync size limit.";
  chrome.storage.local.set({ flash: { message, at: Date.now() } });
  if (tab && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
}

// Keyboard shortcuts open a centered overlay WINDOW (an extension page) rather
// than injecting an overlay into the current page. This works everywhere —
// including edge://, the Web Store, and IE-mode tabs — renders instantly (no
// injection, no serialized args), and is immune to page-level keyboard handlers.
const PENDING_KEY = "pending_add";
const OVERLAY_CTX_KEY = "overlay_ctx";
const OVERLAY_W = 640;
const OVERLAY_H = { quicksave: 540, spotlight: 520 };

// Center an overlay of the given size over the user's focused browser window.
async function openOverlayWindow(mode) {
  const t0 = Date.now();
  const [[tab], focused] = await Promise.all([
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    chrome.windows.getLastFocused().catch(() => null),
  ]);

  // Hand the source tab to the overlay page (it reads collections itself).
  await chrome.storage.session.set({
    [OVERLAY_CTX_KEY]: {
      mode,
      tab: tab
        ? {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            favIconUrl: tab.favIconUrl || faviconFor(tab.url || ""),
            windowId: tab.windowId,
          }
        : null,
      at: Date.now(),
    },
  });

  const w = OVERLAY_W;
  const h = OVERLAY_H[mode] || 520;
  const opts = {
    url: chrome.runtime.getURL(`overlay.html?mode=${mode}`),
    type: "popup",
    width: w,
    height: h,
    focused: true,
  };
  if (focused && focused.width) {
    opts.left = Math.max(0, Math.round(focused.left + (focused.width - w) / 2));
    // Sit in the upper third, echoing the old spotlight placement.
    opts.top = Math.max(0, Math.round(focused.top + (focused.height - h) / 3));
  }
  try {
    await chrome.windows.create(opts);
    log(mode, "overlay window opened in", Date.now() - t0, "ms");
  } catch (err) {
    warn(mode, "overlay window failed:", err?.message);
  }
}

// Whether a page can host an injected overlay. Restricted surfaces (edge://,
// the Web Store, view-source, extension pages, IE-mode) reject scripting; those
// fall back to a framed overlay window.
function isInjectablePage(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

// Open the picker/spotlight: prefer a frameless in-page overlay (injected into
// the active tab), and fall back to a centered overlay WINDOW on pages that
// disallow injection. The in-page path gives a frameless, page-blurring UI on
// ~99% of pages; the window path guarantees it still works everywhere else.
async function openOverlay(mode) {
  const t0 = Date.now();
  const func = mode === "spotlight" ? spotlightOverlay : quickSaveOverlay;
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (_) {}

  if (tab && tab.id != null && isInjectablePage(tab.url)) {
    try {
      // Paint the overlay shell immediately using only the theme (a cheap
      // storage.local read) — do NOT wait on the collections snapshot, which on
      // a cold-booted worker also pays IndexedDB open + getAll.
      const { theme } = await CollectionStore.getSettings();
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func,
        args: [null, theme || "system"],
      });
      log(mode, "overlay shell injected in", Date.now() - t0, "ms");

      // Hydrate with data as soon as it's ready; this never blocks the paint.
      const { collections } = await CollectionStore.getSnapshot();
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: hydrateOverlay,
        args: [mode, collections],
      });
      log(mode, "overlay hydrated in", Date.now() - t0, "ms");
      return;
    } catch (err) {
      warn(mode, "injection failed, falling back to window:", err?.message);
    }
  }
  await openOverlayWindow(mode);
}

// Second-phase injection: hand the collections snapshot to the already-painted
// overlay via the hydrate hook it exposed on its host element. Self-contained.
function hydrateOverlay(mode, collections) {
  const hostId =
    mode === "spotlight" ? "__collection_spotlight_host__" : "__collection_quicksave_host__";
  const host = document.getElementById(hostId);
  if (host && typeof host.__collHydrate === "function") host.__collHydrate(collections);
}

chrome.commands.onCommand.addListener((command) => {
  log("command:", command);
  if (command === "add-current-tab") openOverlay("quicksave");
  else if (command === "spotlight-search") openOverlay("spotlight");
});

// Injected into the active page to render a full-window spotlight search. Runs
// in the page as a self-contained function (no external references allowed).
function spotlightOverlay(collections, theme) {
  const log = (...a) => console.log("[Collection][spotlight]", ...a);
  const HOST_ID = "__collection_spotlight_host__";
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    const inp = existing.shadowRoot && existing.shadowRoot.querySelector("input");
    if (inp) inp.focus();
    log("overlay already open, refocused input");
    return;
  }

  // Resolve theme: follow the page's OS preference when set to "system".
  let dark = theme === "dark";
  if (theme !== "dark" && theme !== "light") {
    dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  log("opening overlay, theme:", theme, "resolved dark:", dark);

  const c = dark
    ? {
        cardBg: "oklch(0.24 0.05 220)", text: "oklch(0.96 0.01 170)",
        border: "oklch(0.78 0.16 170 / 0.16)", dim: "oklch(0.72 0.03 200)",
        selBg: "oklch(0.78 0.16 170)", selText: "oklch(0.19 0.04 240)",
        scrim: "oklch(0.12 0.03 240 / 0.55)",
        glow: "0 0 0 1px oklch(0.78 0.16 170 / 0.3), 0 30px 80px -20px oklch(0.05 0.03 240 / 0.7)",
      }
    : {
        cardBg: "oklch(0.99 0.006 200)", text: "oklch(0.25 0.03 240)",
        border: "oklch(0.55 0.03 220 / 0.22)", dim: "oklch(0.52 0.03 220)",
        selBg: "oklch(0.62 0.13 172)", selText: "oklch(0.99 0.01 170)",
        scrim: "oklch(0.3 0.03 240 / 0.32)",
        glow: "0 0 0 1px oklch(0.62 0.13 172 / 0.25), 0 30px 80px -20px oklch(0.2 0.03 240 / 0.4)",
      };

  // Flatten collections into searchable entries with a "collection - section"
  // label. Filled by hydrate(), which runs inline when the snapshot is passed
  // directly, or via the deferred second-phase injection (skeleton-first paint).
  let entries = [];
  function hydrate(cols) {
    entries = [];
    for (const col of cols || []) {
      const sectionTitle = {};
      for (const s of col.sections || []) sectionTitle[s.id] = s.title;
      const items = col.items || [];
      if (items.length === 0) {
        entries.push({ title: col.name, label: col.name, url: "", collectionId: col.id });
        continue;
      }
      for (const item of items) {
        let title;
        if (item.type === "note") title = item.note || "(empty note)";
        else title = item.title || item.url || "(untitled)";
        const sec = item.sectionId ? sectionTitle[item.sectionId] : "";
        const label = sec ? col.name + " - " + sec : col.name;
        entries.push({
          title,
          label,
          // Matching also considers collection + section names so searching a
          // collection or section name lists all items within it.
          hay: (title + " " + label + " " + (item.url || item.imageUrl || "")).toLowerCase(),
          url: item.type === "note" ? "" : item.url || item.imageUrl || "",
          collectionId: col.id,
        });
      }
    }
    for (const e of entries) if (!e.hay) e.hay = (e.title + " " + e.label).toLowerCase();
    // Reflect any text the user already typed before the data arrived.
    if (input) render(input.value);
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "Search collections");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;" +
    "justify-content:center;padding-top:16vh;background:" + c.scrim + ";" +
    "backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML =
    "<style>" +
    "*{box-sizing:border-box;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;}" +
    ".card{width:min(560px,92vw);max-height:64vh;display:flex;flex-direction:column;" +
    "background:" + c.cardBg + ";color:" + c.text + ";border:1px solid " + c.border + ";" +
    "border-radius:18px;box-shadow:" + c.glow + ";overflow:hidden;}" +
    "input{border:none;border-bottom:1px solid " + c.border + ";background:transparent;color:" + c.text + ";" +
    "font-size:19px;padding:16px 18px;outline:none;}" +
    "ul{list-style:none;margin:0;padding:6px;overflow-y:auto;}" +
    "li{padding:9px 12px;border-radius:10px;cursor:pointer;}" +
    "li.sel{background:" + c.selBg + ";color:" + c.selText + ";}" +
    ".t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
    ".s{font-size:12px;opacity:0.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
    ".empty{padding:18px;text-align:center;color:" + c.dim + ";}" +
    "</style>" +
    "<div class='card'><input type='text' role='combobox' aria-autocomplete='list' " +
    "aria-expanded='true' aria-controls='sl-list' aria-label='Search collections' " +
    "placeholder='Search…   ↵ open here · Ctrl+↵ new tab' />" +
    "<ul id='sl-list' role='listbox' aria-label='Search results'></ul>" +
    "<div class='empty' role='status' style='display:none'>No matches</div></div>";
  (document.body || document.documentElement).appendChild(host);

  const input = shadow.querySelector("input");
  const list = shadow.querySelector("ul");
  const empty = shadow.querySelector(".empty");
  let matches = [];
  let selected = 0;

  function close() {
    window.removeEventListener("keydown", onKeyCapture, true);
    host.remove();
    log("overlay closed");
  }

  function render(q) {
    const query = q.trim().toLowerCase();
    list.innerHTML = "";
    if (!query) {
      matches = [];
      empty.style.display = "none";
      return;
    }
    matches = entries.filter((e) => e.hay.includes(query));
    selected = 0;
    empty.style.display = matches.length ? "none" : "block";
    matches.forEach((m, idx) => {
      const li = document.createElement("li");
      li.id = "sl-opt-" + idx;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", idx === 0 ? "true" : "false");
      if (idx === 0) li.className = "sel";
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = m.title;
      const s = document.createElement("div");
      s.className = "s";
      s.textContent = m.label;
      li.append(t, s);
      li.addEventListener("mouseenter", () => select(idx));
      li.addEventListener("click", (ev) => activate(idx, ev.ctrlKey || ev.metaKey));
      list.appendChild(li);
    });
    if (matches.length) input.setAttribute("aria-activedescendant", "sl-opt-0");
    else input.removeAttribute("aria-activedescendant");
  }

  function select(idx) {
    const lis = [...list.children];
    if (!lis.length) return;
    selected = (idx + lis.length) % lis.length;
    lis.forEach((el, i) => {
      const on = i === selected;
      el.classList.toggle("sel", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", "sl-opt-" + selected);
    lis[selected].scrollIntoView({ block: "nearest" });
  }

  // Enter opens the match in the CURRENT page; Ctrl/Cmd+Enter opens a new tab.
  // Notes / whole-collection matches (no URL) open the side panel either way.
  function activate(idx, newTab) {
    const m = matches[idx];
    if (!m) return;
    close();
    if (m.url) {
      if (newTab) window.open(m.url, "_blank");
      else window.location.href = m.url;
    } else {
      chrome.runtime.sendMessage({ type: "open-collection", collectionId: m.collectionId });
    }
  }

  // Keep keystrokes inside the overlay: many sites bind single-key shortcuts
  // (e.g. "h", "p", "s") on document and preventDefault them, which would
  // otherwise swallow those characters before they reach our input. Stopping
  // propagation on the input's key events prevents the page from ever seeing
  // them. (Capital letters worked before because Shift changes the shortcut.)
  const swallow = (e) => e.stopPropagation();
  input.addEventListener("keydown", swallow, true);
  input.addEventListener("keypress", swallow, true);
  input.addEventListener("keyup", swallow, true);

  input.addEventListener("input", (e) => render(e.target.value));

  // Navigation keys are handled on WINDOW in the capture phase so the overlay
  // gets them before any page-level handler (some sites capture Arrow/Enter/Esc
  // and preventDefault them, which would otherwise break navigation). For these
  // keys we fully own the event: preventDefault + stopImmediatePropagation so
  // neither the page nor the input's default (cursor move / newline) reacts.
  // Other keys fall through to the focused input so typing still works.
  function onKeyCapture(e) {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    } else if (k === "ArrowDown") {
      e.preventDefault();
      e.stopImmediatePropagation();
      select(selected + 1);
    } else if (k === "ArrowUp") {
      e.preventDefault();
      e.stopImmediatePropagation();
      select(selected - 1);
    } else if (k === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      activate(selected, e.ctrlKey || e.metaKey);
    }
  }
  window.addEventListener("keydown", onKeyCapture, true);

  host.addEventListener("click", (e) => {
    if (e.target === host) close();
  });
  // Expose the hydrate hook so the deferred second-phase injection can feed in
  // collections; hydrate inline when they were passed directly.
  host.__collHydrate = hydrate;
  if (Array.isArray(collections)) hydrate(collections);
  input.focus();
}

// Injected on Ctrl+Shift+S: a centered picker to save the current tab. Lists
// collections; hovering (or arrowing to) a collection reveals its sections on
// the right. Clicking a section saves there; clicking the collection (or the
// "Top of…" option) saves to the top of the collection. Self-contained.
function quickSaveOverlay(collections, theme) {
  const log = (...a) => console.log("[Collection][quicksave]", ...a);
  const HOST_ID = "__collection_quicksave_host__";
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    const f = existing.shadowRoot && existing.shadowRoot.querySelector("[data-first]");
    if (f) f.focus();
    return;
  }

  let dark = theme === "dark";
  if (theme !== "dark" && theme !== "light") {
    dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  const c = dark
    ? {
        cardBg: "oklch(0.24 0.05 220)", text: "oklch(0.96 0.01 170)",
        border: "oklch(0.78 0.16 170 / 0.16)", dim: "oklch(0.72 0.03 200)",
        selBg: "oklch(0.78 0.16 170)", selText: "oklch(0.19 0.04 240)",
        hover: "oklch(0.29 0.05 220)", scrim: "oklch(0.12 0.03 240 / 0.55)",
        glow: "0 0 0 1px oklch(0.78 0.16 170 / 0.3), 0 30px 80px -20px oklch(0.05 0.03 240 / 0.7)",
      }
    : {
        cardBg: "oklch(0.99 0.006 200)", text: "oklch(0.25 0.03 240)",
        border: "oklch(0.55 0.03 220 / 0.22)", dim: "oklch(0.52 0.03 220)",
        selBg: "oklch(0.62 0.13 172)", selText: "oklch(0.99 0.01 170)",
        hover: "oklch(0.93 0.018 210)", scrim: "oklch(0.3 0.03 240 / 0.32)",
        glow: "0 0 0 1px oklch(0.62 0.13 172 / 0.25), 0 30px 80px -20px oklch(0.2 0.03 240 / 0.4)",
      };

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "Save to collection");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML =
    "<style>" +
    "*{box-sizing:border-box;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;}" +
    ".backdrop{position:fixed;inset:0;display:flex;align-items:flex-start;justify-content:center;" +
    "padding-top:14vh;background:" + c.scrim + ";backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);}" +
    ".card{width:min(620px,94vw);max-height:66vh;display:flex;flex-direction:column;" +
    "background:" + c.cardBg + ";color:" + c.text + ";border:1px solid " + c.border + ";" +
    "border-radius:18px;box-shadow:" + c.glow + ";overflow:hidden;}" +
    ".head{padding:14px 18px;border-bottom:1px solid " + c.border + ";font-size:14px;color:" + c.dim + ";}" +
    ".head b{color:" + c.text + ";font-weight:600;}" +
    ".body{display:flex;min-height:0;flex:1;}" +
    ".col{flex:1;min-width:0;overflow-y:auto;padding:6px;border-right:1px solid " + c.border + ";}" +
    ".sec{flex:1;min-width:0;overflow-y:auto;padding:6px;}" +
    ".pane-title{font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:" + c.dim + ";padding:8px 10px 4px;}" +
    ".row{padding:10px 12px;border-radius:10px;cursor:pointer;white-space:nowrap;overflow:hidden;" +
    "text-overflow:ellipsis;outline:none;}" +
    ".row:hover,.row.sel{background:" + c.hover + ";}" +
    ".row.active{background:" + c.selBg + ";color:" + c.selText + ";}" +
    ".row .meta{font-size:12px;color:" + c.dim + ";}" +
    ".row.active .meta{color:" + c.selText + ";opacity:0.85;}" +
    ".top-opt{font-weight:600;}" +
    ".foot{padding:10px 18px;border-top:1px solid " + c.border + ";font-size:12px;color:" + c.dim + ";" +
    "display:flex;justify-content:space-between;gap:10px;}" +
    ".hint{opacity:0.8;}" +
    ".empty{padding:22px;text-align:center;color:" + c.dim + ";}" +
    ".newrow{padding:10px 12px;border-radius:10px;cursor:pointer;color:" + c.dim + ";" +
    "font-weight:600;outline:none;}" +
    ".newrow:hover,.newrow:focus-visible{background:" + c.hover + ";color:" + c.text + ";}" +
    ".inline-input{width:calc(100% - 8px);margin:2px 4px;padding:9px 11px;border-radius:10px;" +
    "border:1px solid " + c.selBg + ";background:" + c.cardBg + ";color:" + c.text + ";" +
    "font-size:14px;outline:none;}" +
    ".field-label{font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:" + c.dim + ";" +
    "margin-bottom:5px;display:block;}" +
    ".field{width:100%;padding:9px 12px;border-radius:10px;border:1px solid " + c.border + ";" +
    "background:" + c.cardBg + ";color:" + c.text + ";font-size:14px;outline:none;}" +
    ".field:focus{border-color:" + c.selBg + ";}" +
    ".search{position:relative;margin-top:10px;}" +
    ".search .field{padding-left:34px;}" +
    ".search .mag{position:absolute;left:12px;top:50%;transform:translateY(-50%);" +
    "color:" + c.dim + ";font-size:13px;pointer-events:none;}" +
    "</style>" +
    "<div class='backdrop'>" +
    "<div class='card'>" +
    "<div class='head'>" +
    "<label class='field-label' for='qs-title'>Save as</label>" +
    "<input class='field' id='qs-title' type='text' aria-label='Item name' />" +
    "<div class='search'><span class='mag' aria-hidden='true'>🔍</span>" +
    "<input class='field' id='qs-search' type='text' " +
    "placeholder='Search collections & sections…' aria-label='Search collections and sections' /></div>" +
    "</div>" +
    "<div class='body'>" +
    "<div class='col' role='listbox' aria-label='Collections' id='qs-cols'></div>" +
    "<div class='sec' role='listbox' aria-label='Sections' id='qs-secs'></div>" +
    "</div>" +
    "<div class='foot'><span class='hint'>↑↓ move · → sections · ↵ save · Esc close</span>" +
    "<span role='status' aria-live='polite' class='status'></span></div>" +
    "</div>" +
    "</div>";
  (document.body || document.documentElement).appendChild(host);

  const backdrop = shadow.querySelector(".backdrop");
  const colWrap = shadow.getElementById("qs-cols");
  const secWrap = shadow.getElementById("qs-secs");
  const statusEl = shadow.querySelector(".status");
  const titleInput = shadow.getElementById("qs-title");
  const searchInput = shadow.getElementById("qs-search");
  titleInput.value = document.title || location.href || "";
  let query = "";
  let baseCollections = [];
  let visibleCols = [];
  // Feed collections in (inline, or via the deferred second-phase injection)
  // and repaint the collection/section panes.
  function hydrate(cols) {
    baseCollections = (cols || []).slice();
    renderCollections();
    renderSections();
    paintSel();
  }

  function close() {
    host.remove();
    log("overlay closed");
  }

  function commit(payload, label) {
    statusEl.textContent = "Saving…";
    const title = (titleInput.value || "").trim();
    chrome.runtime.sendMessage(
      Object.assign({ type: "quick-save", title: title || undefined }, payload),
      (resp) => {
        if (resp && resp.limit) {
          statusEl.textContent =
            resp.limit === "total"
              ? "Sync storage is full — can't save more"
              : "This collection is full — pick another";
          return;
        }
        if (resp && resp.duplicate) {
          statusEl.textContent = "Already in this collection — pick another";
          return;
        }
        if (!resp || resp.error) {
          statusEl.textContent = "Couldn't save";
          return;
        }
        statusEl.textContent = "Saved to " + label + " ✓";
        setTimeout(close, 650);
      }
    );
  }

  function save(collectionId, sectionId, label) {
    commit({ collectionId, sectionId: sectionId || null }, label);
  }

  // Save into the current selection (used by Enter from the search box / list).
  function saveCurrent() {
    const col = curCol();
    if (!col) return;
    if (zone === "sec") {
      const opt = curSecOptions[secIdx];
      if (opt) save(col.id, opt.sectionId, opt.label);
    } else {
      save(col.id, null, col.name || "collection");
    }
  }

  // Swap a "＋ New…" row for an inline text input. Enter OR clicking elsewhere
  // (blur) commits the typed name; Esc cancels and restores the row. Empty text
  // just restores. Keystrokes are isolated from the page (some sites bind
  // single-key shortcuts that would otherwise swallow letters).
  function openInlineInput(row, placeholder, onCommit) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder);
    input.className = "inline-input";
    let done = false;
    const finish = (accept) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (accept && v) onCommit(v);
      else if (input.parentNode) input.replaceWith(row);
    };
    const swallow = (e) => e.stopPropagation();
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("keypress", swallow);
    input.addEventListener("keyup", swallow);
    input.addEventListener("blur", () => finish(true));
    row.replaceWith(input);
    input.focus();
  }

  function curCol() {
    return visibleCols[colIdx];
  }

  // Create a collection and keep the picker open, selecting the new collection
  // so the user can then pick/create a section or click to save into it.
  function createCollection(name) {
    statusEl.textContent = "Creating…";
    chrome.runtime.sendMessage({ type: "create-collection", name }, (resp) => {
      if (resp && resp.limit) {
        statusEl.textContent = "Sync storage is full — can't add collections";
        return;
      }
      if (!resp || resp.error || !resp.collection) {
        statusEl.textContent = "Couldn't create collection";
        return;
      }
      baseCollections.push({ id: resp.collection.id, name: resp.collection.name, sections: [], items: [] });
      query = "";
      searchInput.value = "";
      zone = "col";
      renderCollections();
      colIdx = visibleCols.findIndex((col) => col.id === resp.collection.id);
      if (colIdx < 0) colIdx = visibleCols.length - 1;
      renderSections();
      paintSel();
      statusEl.textContent = "Created “" + resp.collection.name + "”";
      const rows = [...colWrap.querySelectorAll(".row")];
      if (rows[colIdx]) rows[colIdx].focus();
    });
  }

  // Create a section in the current collection and keep the picker open,
  // selecting the new section.
  function createSection(title) {
    const col = curCol();
    if (!col) return;
    statusEl.textContent = "Adding section…";
    chrome.runtime.sendMessage({ type: "create-section", collectionId: col.id, title }, (resp) => {
      if (!resp || resp.error || !resp.section) {
        statusEl.textContent = "Couldn't add section";
        return;
      }
      if (!Array.isArray(col.sections)) col.sections = [];
      col.sections.push({ id: resp.section.id, title: resp.section.title });
      query = "";
      searchInput.value = "";
      zone = "sec";
      renderCollections();
      renderSections();
      secIdx = curSecOptions.findIndex((o) => o.sectionId === resp.section.id);
      if (secIdx < 0) secIdx = 0;
      paintSel();
      statusEl.textContent = "Added section “" + resp.section.title + "”";
      const rows = [...secWrap.querySelectorAll(".row")];
      if (rows[secIdx]) rows[secIdx].focus();
    });
  }

  let zone = "col"; // "col" | "sec"
  let colIdx = 0;
  let secIdx = 0;
  let curSecOptions = []; // [{sectionId, label}]

  function renderSections() {
    const col = curCol();
    secWrap.innerHTML = "";
    if (!col) return;
    const title = document.createElement("div");
    title.className = "pane-title";
    title.textContent = col.name || "Untitled";
    secWrap.appendChild(title);

    // When searching and the collection matched only via a section name, narrow
    // to matching sections; if the collection name matched, show all sections.
    const colMatches = !query || (col.name || "").toLowerCase().includes(query);
    let secs = col.sections || [];
    if (query && !colMatches) {
      secs = secs.filter((s) => (s.title || "").toLowerCase().includes(query));
    }

    curSecOptions = [{ sectionId: null, label: "Top of " + (col.name || "collection") }];
    for (const s of secs) curSecOptions.push({ sectionId: s.id, label: s.title });

    curSecOptions.forEach((opt, i) => {
      const row = document.createElement("div");
      row.className = "row" + (i === 0 ? " top-opt" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.tabIndex = -1;
      row.textContent = i === 0 ? "↑ " + opt.label : opt.label;
      row.addEventListener("mouseenter", () => {
        zone = "sec";
        secIdx = i;
        paintSel();
      });
      row.addEventListener("click", () => save(col.id, opt.sectionId, opt.label));
      secWrap.appendChild(row);
    });

    const newSec = document.createElement("div");
    newSec.className = "newrow";
    newSec.tabIndex = 0;
    newSec.textContent = "＋ New section";
    newSec.addEventListener("click", () =>
      openInlineInput(newSec, "Section name…", (title) => createSection(title))
    );
    secWrap.appendChild(newSec);
    paintSel();
  }

  function collectionMatches(col) {
    if (!query) return true;
    if ((col.name || "").toLowerCase().includes(query)) return true;
    return (col.sections || []).some((s) => (s.title || "").toLowerCase().includes(query));
  }

  function renderCollections() {
    colWrap.innerHTML = "";
    visibleCols = baseCollections.filter(collectionMatches);
    if (colIdx >= visibleCols.length) colIdx = Math.max(0, visibleCols.length - 1);

    if (query && !visibleCols.length) {
      const em = document.createElement("div");
      em.className = "empty";
      em.textContent = "No matches";
      colWrap.appendChild(em);
    }

    visibleCols.forEach((col, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.tabIndex = i === 0 ? 0 : -1;
      if (i === 0) row.setAttribute("data-first", "");
      const name = document.createElement("div");
      name.textContent = col.name || "Untitled";
      const meta = document.createElement("div");
      meta.className = "meta";
      const secN = (col.sections || []).length;
      meta.textContent = secN ? secN + " section" + (secN === 1 ? "" : "s") : "no sections";
      row.append(name, meta);
      row.addEventListener("mouseenter", () => {
        colIdx = i;
        zone = "col";
        renderSections();
        paintSel();
      });
      // Clicking the collection saves to its top.
      row.addEventListener("click", () => save(col.id, null, col.name || "collection"));
      colWrap.appendChild(row);
    });

    const newCol = document.createElement("div");
    newCol.className = "newrow";
    newCol.tabIndex = 0;
    newCol.textContent = "＋ New collection";
    newCol.addEventListener("click", () =>
      openInlineInput(newCol, "Collection name…", (name) => createCollection(name))
    );
    colWrap.appendChild(newCol);
  }

  function paintSel() {
    const colRows = [...colWrap.querySelectorAll(".row")];
    const secRows = [...secWrap.querySelectorAll(".row")];
    colRows.forEach((el, i) => {
      const on = i === colIdx;
      el.classList.toggle("active", on && zone === "col");
      el.classList.toggle("sel", on && zone !== "col");
      el.setAttribute("aria-selected", on ? "true" : "false");
      el.tabIndex = on ? 0 : -1;
    });
    secRows.forEach((el, i) => {
      const on = i === secIdx && zone === "sec";
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      el.tabIndex = zone === "sec" && on ? 0 : -1;
    });
    if (zone === "col" && colRows[colIdx]) colRows[colIdx].scrollIntoView({ block: "nearest" });
    if (zone === "sec" && secRows[secIdx]) secRows[secIdx].scrollIntoView({ block: "nearest" });
  }

  renderCollections();
  renderSections();
  paintSel();

  // Move keyboard focus from the "Save as" field into the collection list so
  // arrow keys resume navigating collections/sections.
  function focusList() {
    if (!visibleCols.length) {
      const nr = colWrap.querySelector(".newrow");
      if (nr) nr.focus();
      return;
    }
    zone = "col";
    if (colIdx < 0 || colIdx >= visibleCols.length) colIdx = 0;
    paintSel();
    const rows = colWrap.querySelectorAll(".row");
    if (rows[colIdx]) rows[colIdx].focus();
  }

  // Live filter as the user types in the search box.
  searchInput.addEventListener("input", () => {
    query = (searchInput.value || "").trim().toLowerCase();
    colIdx = 0;
    zone = "col";
    renderCollections();
    renderSections();
    paintSel();
  });

  // Keep page-level single-key shortcuts from swallowing text input.
  [searchInput, titleInput].forEach((inp) => {
    inp.addEventListener("keypress", (e) => e.stopPropagation());
    inp.addEventListener("keyup", (e) => e.stopPropagation());
  });

  host.addEventListener("keydown", (e) => {
    const ae = shadow.activeElement;
    // Inline "New…" text inputs fully own their keys (Enter commits, Esc
    // cancels). Return BEFORE stopPropagation so their own handlers still run.
    if (ae && ae.classList && ae.classList.contains("inline-input")) return;
    e.stopPropagation();
    // "Save as" name field: Left/Right/Home/End edit the text as usual; Tab or
    // ArrowDown hands focus back to the collection/section list.
    if (ae === titleInput) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        saveCurrent();
      } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        focusList();
      }
      return;
    }
    // Search field: typing filters; arrows drive list navigation.
    if (ae === searchInput) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        saveCurrent();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (zone === "col") {
          if (!visibleCols.length) return;
          colIdx = (colIdx + 1) % visibleCols.length;
          renderSections();
        } else secIdx = (secIdx + 1) % curSecOptions.length;
        paintSel();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (zone === "col") {
          if (!visibleCols.length) return;
          colIdx = (colIdx - 1 + visibleCols.length) % visibleCols.length;
          renderSections();
        } else secIdx = (secIdx - 1 + curSecOptions.length) % curSecOptions.length;
        paintSel();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!visibleCols.length) return;
        zone = "sec";
        secIdx = 0;
        paintSel();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        zone = "col";
        paintSel();
      }
      return;
    }
    // On a "＋ New…" row, Enter/Space opens its inline input.
    if (ae && ae.classList && ae.classList.contains("newrow")) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        ae.click();
        return;
      }
    }
    // Focus is on the list (not the "Save as" field): typing any printable
    // character (or Backspace) routes into the search box so the user can just
    // start typing to filter, without clicking the search field first.
    if (!e.ctrlKey && !e.metaKey && !e.altKey &&
        (e.key.length === 1 || e.key === "Backspace")) {
      e.preventDefault();
      searchInput.focus();
      if (e.key === "Backspace") searchInput.value = searchInput.value.slice(0, -1);
      else searchInput.value += e.key;
      searchInput.dispatchEvent(new Event("input"));
      return;
    }
    if (e.key === "Escape") {
      if (zone === "sec") {
        zone = "col";
        paintSel();
      } else close();
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (zone === "col") {
        if (!visibleCols.length) return;
        colIdx = (colIdx + 1) % visibleCols.length;
        renderSections();
      } else secIdx = (secIdx + 1) % curSecOptions.length;
      paintSel();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (zone === "col") {
        if (!visibleCols.length) return;
        colIdx = (colIdx - 1 + visibleCols.length) % visibleCols.length;
        renderSections();
      } else secIdx = (secIdx - 1 + curSecOptions.length) % curSecOptions.length;
      paintSel();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!visibleCols.length) return;
      zone = "sec";
      secIdx = 0;
      paintSel();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      zone = "col";
      paintSel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      saveCurrent();
    }
  }, true);
  // Backdrop lives inside the shadow root, so its click target is reliable
  // (host-level clicks are retargeted to the host and can't be distinguished).
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  host.tabIndex = -1;
  // Expose the hydrate hook for the deferred second-phase injection; hydrate
  // inline when collections were passed directly.
  host.__collHydrate = hydrate;
  if (Array.isArray(collections)) hydrate(collections);
  searchInput.focus();
}

function buildItemFromContext(info, tab) {
  // Image context wins first, then selected text, then a link, then the page.
  if (info.mediaType === "image" && info.srcUrl) {
    return {
      type: "image",
      imageUrl: info.srcUrl,
      title: tab?.title || "Image",
      url: info.pageUrl || tab?.url || "",
    };
  }
  if (info.selectionText) {
    return {
      type: "note",
      note: info.selectionText,
      title: tab?.title || "Note",
      url: info.pageUrl || tab?.url || "",
    };
  }
  if (info.linkUrl) {
    return {
      type: "page",
      url: info.linkUrl,
      title: info.linkText || info.linkUrl,
      favIconUrl: faviconFor(info.linkUrl),
    };
  }
  return {
    type: "page",
    url: info.pageUrl || tab?.url || "",
    title: tab?.title || info.pageUrl || "",
    favIconUrl: tab?.favIconUrl || faviconFor(tab?.url || info.pageUrl || ""),
  };
}

function faviconFor(url) {
  try {
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch {
    return "";
  }
}
