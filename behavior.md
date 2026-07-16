# Behavior

User workflows for every feature. Update this file whenever a feature is added
or its behavior changes.

## Collections

### Create collection
1. In the list view, click **＋ New collection**.
2. A new collection (`Collection N` if unnamed) opens in detail view.
3. The name field is focused for immediate rename.

### Rename collection
1. In detail view, edit the name field at the top.
2. Change is saved on blur or Enter.

### Delete collection
1. Detail view → **⋯** menu → **Delete collection**.
2. Confirm the prompt. Collection and its items are removed; returns to list.

### Reorder collections
1. In the list view, drag a collection card (grip handle) up/down.
2. New order is saved on drop.

### View collections
- List view shows every collection with name, a 2×2 thumbnail preview from the
  first items, and a meta line reading `N sections · N items` (the section count
  is omitted when there are none).

## Items

### Add current page
1. Detail view → **＋ Add current tab** button (below the header), or **⋯** → **Add current page**.
2. Active tab's title, URL, and favicon are saved as a page card.

### Add open tabs
1. Detail view → **⋯** → **Add open tabs…**.
2. Check the tabs to add in the picker → **Add selected**.

### Add note
1. Detail view → **⋯** → **Add note**.
2. An empty yellow note card is added and opened for editing.

### Add image by URL
1. Detail view → **⋯** → **Add image by URL…**.
2. Enter an image URL; it is saved as an image card.

### Add via right-click (any page)
1. Right-click a page, link, image, or selection.
2. **Add to Collection ▸** → pick a collection or **New collection…**.
3. Image → image card; selection → note; link → page card; page → page card.
4. The side panel opens to show the result.

### Add current tab via keyboard shortcut
1. Press **Ctrl+Shift+S** (macOS: **Cmd+Shift+S**) on any page.
2. A centered **Save to…** picker appears over the middle of the page (like the
   spotlight), blurring the rest of the window. It lists your collections.
3. **Hover** (or arrow to) a collection to reveal its sections on the right.
   **Click the collection** to save the page to the **top** of that collection;
   **click a section** (or the **↑ Top of…** option) to save it there — a single
   click, no extra confirmation.
   - The collections pane ends with a **＋ New collection** row and the sections
     pane with a **＋ New section** row. Click either to turn it into a text box;
     type a name and press **Enter** (or click elsewhere) to create it. The
     picker **stays open** and selects what you just created, so you can then
     click it (or the item within) to save the page — or add a section to a new
     collection first. Press **Esc** in the box to cancel. (With no collections
     yet, the picker opens straight to the new-collection box.)
4. Keyboard: **↑/↓** move within the current pane, **→** jumps to the sections
   pane, **←** returns to collections, **Enter** saves the current selection,
   **Esc** backs out of the sections pane or closes the picker.
5. If the page's URL is already in the chosen collection it is not added again —
   an "Already in this collection" message is shown and the picker stays open so
   you can choose another.
6. On restricted pages (e.g. `edge://`, the Web Store) where the overlay can't be
   injected, it falls back to opening the side panel with an **Add current tab
   to…** dialog. The shortcut can be remapped at `edge://extensions/shortcuts`.

### Spotlight search
1. Press **Ctrl+Space** on any page.
2. A search popup appears centered over the **entire browser window**, blurring
   the page behind it (injected into the active tab). It follows the extension's
   **theme** setting (System/Light/Dark) so it matches the collections UI.
3. Type to search across all collections. Typing works reliably even on sites
   with single-key keyboard shortcuts (keystrokes are isolated from the page).
   Each result shows the item title and, below it, its **collection - section**
   (the `- section` is omitted when the item isn't in a section). Searching a
   **collection name** or **section name** lists every item within it.
4. Use **↑/↓** to move the selection. **Enter** opens the highlighted result in
   the **current tab**; **Ctrl/Cmd+Enter** opens it in a **new tab**. Clicking a
   result opens it (Ctrl/Cmd-click for a new tab). A note or whole-collection
   match opens that collection in the side panel instead. **Esc** or a backdrop
   click closes.
5. On pages that block script injection (e.g. `edge://` pages, the Web Store),
   the side panel opens instead so search stays reachable.

### Cross-collection search (list view)
- The search bar in the list view matches item titles, URLs, notes, and also
  **collection** and **section** names. Matching a collection or section name
  lists all items within it. Each result shows `in collection - section`.

### Duplicate links
- Adding a page/link whose URL already exists in the target collection is
  blocked; an "Already in this collection" message is shown. Notes and images
  are never treated as duplicates.

### Open link
- Click a page/image card's title to open its URL in a new tab.

### Edit item
1. Click the ✎ on a card.
2. Page/image: edit title. Note: edit text. Saved on blur (Enter for titles).
3. Note: while editing, pick a swatch in the color palette to recolor the note
   card. The color is saved immediately and persists.

### Delete item
- Click 🗑 on a card. Removed immediately.

### Reorder items
- Drag item cards within a collection; order saved on drop.
- Drag a card into or out of a **section** to change its grouping; both the
  order and section membership are saved on drop.

### Right-click menu (inside a collection)
- Right-click anywhere in the collection detail view (except text fields) to open
  the same action menu as the **⋯** button, positioned at the cursor.

## Sections

Sections render **inline** (not boxes): a subtle uppercase title with an item
count badge, followed by the items beneath it — matching a clean, grouped list.

### Add section
- **Inline:** at the end of a collection, the **＋ Add section** line reads as
  plain text; hovering (or clicking) turns it into a text box. Type a title and
  press **Enter** to create the section; **Esc** clears it.
- **Menu:** Detail view → **⋯** (or right-click) → **Add section** creates an
  untitled section with its title focused for immediate rename.

### Rename section
- Edit the section's title; saved on blur or Enter.

### Delete section
- Hover a section header and click 🗑, then confirm. The section is removed and
  its items move back to the ungrouped area at the top.

### Reorder sections
- Drag a section by its grip handle (⠿ in the header) to reorder sections.

## Settings & appearance

### Theme
1. List view → **⚙ Settings** → **Theme**.
2. Choose **Browser theme** (follows the OS), **Light**, or **Dark**. The choice
   applies immediately to the side panel and the Ctrl+Space spotlight, and
   persists.

### Pin panel
- Default is **unpinned**: clicking the toolbar icon opens Collections as a
  **popup** (420×600) that hangs from the toolbar icon (like a typical
  extension).
- Click the **📌 Pin** button (or the Settings checkbox) to **pin** it: the view
  switches **immediately** — the current window closes and the docked side panel
  opens on the right. Unpinning does the reverse (closes the panel and pops the
  hanging window). The button highlights when pinned.

## Appearance
- The UI uses a **Neon Mint** palette (deep-navy dark theme with mint accents;
  a matching cool light theme), rounded cards, and a soft mint glow on primary
  actions and the pinned state. The Ctrl+Space spotlight mirrors the same theme.

## Accessibility
- All interactive elements are keyboard operable: collection cards, item titles,
  and search results are focusable and activate with **Enter/Space**; the ⋯ menu
  items and modal buttons are reachable by Tab.
- **Esc** closes any open modal or the action menu.
- ARIA roles/labels are set throughout: icon buttons have `aria-label`, the pin
  button exposes `aria-pressed`, the ⋯ button `aria-expanded`, modals are
  `role="dialog" aria-modal`, the theme picker is a `radiogroup`, the toast is an
  `aria-live` status region, and the spotlight is a labelled `dialog` with a
  `listbox`/`option` result list driven by `aria-activedescendant`.
- Visible keyboard-focus outlines are shown via `:focus-visible`, and
  `prefers-reduced-motion` disables transitions/animations.

## Logging
- Both the service worker and the side panel log key actions with a
  `[Collection]` prefix (mutations, commands, spotlight injection, theme/pin
  changes, errors). View them at `edge://extensions` → Collection → *service
  worker* (background) or by inspecting the side panel (panel).
  within the collection; the new order is saved on drop.

## Search

### Search across collections
1. List view → type in the **Search across all collections…** box.
2. Matches (by collection name, page/image title, URL, or note text) from every
   collection are listed, each labelled with its **collection - section** (the
   `- section` is omitted when the item isn't in a section). Clicking a result
   opens its collection.
3. Clearing the box restores the normal collection list.

## Collection actions

### Open all links
- Detail view → **⋯** → **Open all links**. Opens every card's URL in new tabs.

### Copy all
- Detail view → **⋯** → **Copy all**. Copies titles + URLs / notes to clipboard.

## Data portability

### Export all
- List view → **⭳**. Downloads all collections as `collections-YYYY-MM-DD.json`.

### Export one
- Detail view → **⋯** → **Export this collection**. Downloads that collection.

### Import
1. List view → **⭱**, choose a `.json` file.
2. Confirm: **OK = merge**, **Cancel = replace all**.
3. Imported collections appear in the list.

## Storage & privacy
- All data is stored in `chrome.storage.local` only.
- No network requests, telemetry, or third-party code.
