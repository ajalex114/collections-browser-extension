// Centered overlay window: renders either the spotlight search or the quick-save
// picker as its own extension popup window (opened via chrome.windows.create by
// the service worker). Because this is our own extension page — not code injected
// into a web page — there is no Shadow DOM, no page CSS to fight, and no
// page-level keyboard handlers to defeat. It reads collections straight from
// storage (one read) instead of receiving them serialized through executeScript.

import { CollectionStore } from "./storage.js";

const log = (...a) => console.log("[Collection][overlay]", ...a);
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "quicksave" ? "quicksave" : "spotlight";
const app = document.getElementById("app");

let ctx = null; // { mode, tab: {id,url,title,favIconUrl,windowId}, at }
let collections = [];

boot();

async function boot() {
  const t0 = performance.now();
  const [snap, sess] = await Promise.all([
    CollectionStore.getSnapshot(),
    chrome.storage.session.get("overlay_ctx"),
  ]);
  collections = snap.collections || [];
  ctx = sess.overlay_ctx || null;
  document.documentElement.setAttribute("data-theme", snap.settings.theme || "system");

  if (mode === "quicksave") renderQuickSave();
  else renderSpotlight();

  // Modal-ish behavior: close when the window loses OS focus (e.g. the user
  // clicks back into the browser) so it never lingers behind other windows.
  // Attach after a short delay so a transient focus shift while the window is
  // still opening can't close it immediately.
  setTimeout(() => {
    window.addEventListener("blur", () => window.close());
  }, 250);
  log("ready in", Math.round(performance.now() - t0), "ms · mode", mode);
}

function closeWindow() {
  window.close();
}

// Focus the original window/tab, since acting on a result should return the
// user to where they were.
function focusSource() {
  if (ctx && ctx.tab && ctx.tab.windowId != null) {
    chrome.windows.update(ctx.tab.windowId, { focused: true }).catch(() => {});
  }
}

/* ============================ Spotlight ============================ */

function renderSpotlight() {
  const entries = buildEntries(collections);

  app.setAttribute("aria-label", "Search collections");
  app.innerHTML =
    "<input class='sl-input' type='text' role='combobox' aria-autocomplete='list' " +
    "aria-expanded='true' aria-controls='sl-list' aria-label='Search collections' " +
    "placeholder='Search…   ↵ open here · Ctrl+↵ new tab' />" +
    "<ul class='sl-list' id='sl-list' role='listbox' aria-label='Search results'></ul>" +
    "<div class='sl-empty' role='status' style='display:none'>No matches</div>";

  const input = app.querySelector(".sl-input");
  const list = app.querySelector(".sl-list");
  const empty = app.querySelector(".sl-empty");
  let matches = [];
  let selected = 0;

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

  // Enter opens the match in the ORIGINAL tab; Ctrl/Cmd+Enter opens a new tab.
  // Notes / whole-collection matches (no URL) open the side panel instead.
  function activate(idx, newTab) {
    const m = matches[idx];
    if (!m) return;
    if (m.url) {
      const t = ctx && ctx.tab;
      if (newTab || !t || t.id == null) {
        chrome.tabs.create({ url: m.url, windowId: t ? t.windowId : undefined });
      } else {
        chrome.tabs.update(t.id, { url: m.url, active: true });
      }
      focusSource();
    } else {
      chrome.runtime.sendMessage({
        type: "open-collection",
        collectionId: m.collectionId,
        windowId: ctx && ctx.tab ? ctx.tab.windowId : undefined,
      });
    }
    closeWindow();
  }

  input.addEventListener("input", (e) => render(e.target.value));
  document.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      closeWindow();
    } else if (k === "ArrowDown") {
      e.preventDefault();
      select(selected + 1);
    } else if (k === "ArrowUp") {
      e.preventDefault();
      select(selected - 1);
    } else if (k === "Enter") {
      e.preventDefault();
      activate(selected, e.ctrlKey || e.metaKey);
    }
  });

  input.focus();
}

// Flatten collections into searchable entries with a "collection - section"
// label. Matching also considers collection + section names so searching a
// collection or section name lists all items within it.
function buildEntries(cols) {
  const entries = [];
  for (const col of cols) {
    const sectionTitle = {};
    for (const s of col.sections || []) sectionTitle[s.id] = s.title;
    const items = col.items || [];
    if (items.length === 0) {
      entries.push({ title: col.name, label: col.name, hay: (col.name || "").toLowerCase(), url: "", collectionId: col.id });
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
        hay: (title + " " + label + " " + (item.url || item.imageUrl || "")).toLowerCase(),
        url: item.type === "note" ? "" : item.url || item.imageUrl || "",
        collectionId: col.id,
      });
    }
  }
  return entries;
}

/* ============================ Quick save ============================ */

function renderQuickSave() {
  app.setAttribute("aria-label", "Save to collection");
  app.innerHTML =
    "<div class='qs-head'>" +
    "<label class='field-label' for='qs-title'>Save as</label>" +
    "<input class='field' id='qs-title' type='text' aria-label='Item name' />" +
    "<div class='search'><span class='mag' aria-hidden='true'>🔍</span>" +
    "<input class='field' id='qs-search' type='text' " +
    "placeholder='Search collections & sections…' aria-label='Search collections and sections' /></div>" +
    "</div>" +
    "<div class='qs-body'>" +
    "<div class='qs-col' role='listbox' aria-label='Collections' id='qs-cols'></div>" +
    "<div class='qs-sec' role='listbox' aria-label='Sections' id='qs-secs'></div>" +
    "</div>" +
    "<div class='qs-foot'><span class='hint'>↑↓ move · → sections · ↵ save · Esc close</span>" +
    "<span role='status' aria-live='polite' class='status'></span></div>";

  const colWrap = app.querySelector("#qs-cols");
  const secWrap = app.querySelector("#qs-secs");
  const statusEl = app.querySelector(".status");
  const titleInput = app.querySelector("#qs-title");
  const searchInput = app.querySelector("#qs-search");
  const srcTab = ctx && ctx.tab ? ctx.tab : null;
  titleInput.value = (srcTab && srcTab.title) || (srcTab && srcTab.url) || "";

  let query = "";
  let visibleCols = collections.slice();
  let zone = "col"; // "col" | "sec"
  let colIdx = 0;
  let secIdx = 0;
  let curSecOptions = []; // [{sectionId, label}]

  function curCol() {
    return visibleCols[colIdx];
  }

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

  function commit(payload, label) {
    if (!srcTab || !srcTab.url) {
      statusEl.textContent = "No page to save";
      return;
    }
    statusEl.textContent = "Saving…";
    const title = (titleInput.value || "").trim();
    chrome.runtime.sendMessage(
      Object.assign(
        { type: "quick-save", title: title || undefined, tab: srcTab },
        payload
      ),
      (resp) => {
        if (resp && resp.duplicate) {
          statusEl.textContent = "Already in this collection — pick another";
          return;
        }
        if (!resp || resp.error) {
          statusEl.textContent = "Couldn't save";
          return;
        }
        statusEl.textContent = "Saved to " + label + " ✓";
        setTimeout(closeWindow, 600);
      }
    );
  }

  function save(collectionId, sectionId, label) {
    commit({ collectionId, sectionId: sectionId || null }, label);
  }

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

  // Swap a "＋ New…" row for an inline text input. Enter or blur commits; Esc
  // cancels and restores the row.
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
    input.addEventListener("blur", () => finish(true));
    row.replaceWith(input);
    input.focus();
  }

  function createCollection(name) {
    statusEl.textContent = "Creating…";
    chrome.runtime.sendMessage({ type: "create-collection", name }, (resp) => {
      if (!resp || resp.error || !resp.collection) {
        statusEl.textContent = "Couldn't create collection";
        return;
      }
      collections.push({ id: resp.collection.id, name: resp.collection.name, sections: [], items: [] });
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

  function renderSections() {
    const col = curCol();
    secWrap.innerHTML = "";
    if (!col) return;
    const title = document.createElement("div");
    title.className = "pane-title";
    title.textContent = col.name || "Untitled";
    secWrap.appendChild(title);

    // When searching and the collection matched only via a section name, narrow
    // the section list to matching sections; if the collection name matched,
    // show all its sections.
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
      openInlineInput(newSec, "Section name…", (t) => createSection(t))
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
    visibleCols = collections.filter(collectionMatches);
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

  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    colIdx = 0;
    secIdx = 0;
    zone = "col";
    renderCollections();
    renderSections();
    paintSel();
  });

  document.addEventListener("keydown", (e) => {
    const ae = document.activeElement;
    // Inline create inputs manage their own keys entirely.
    if (ae && ae.classList && ae.classList.contains("inline-input")) return;
    // Item-name field: typing, except Enter saves and Esc closes.
    if (ae === titleInput) {
      if (e.key === "Escape") { e.preventDefault(); closeWindow(); return; }
      if (e.key === "Enter") { e.preventDefault(); saveCurrent(); return; }
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        focusList();
        return;
      }
      return;
    }
    // Search field: only Up/Down/Enter/Esc drive the list; other keys type.
    if (ae === searchInput) {
      const navKeys = ["ArrowUp", "ArrowDown", "Enter", "Escape"];
      if (!navKeys.includes(e.key)) return;
    }
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
      } else closeWindow();
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
  });

  renderCollections();
  renderSections();
  paintSel();
  searchInput.focus();
}
