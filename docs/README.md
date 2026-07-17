# Collection

A Chrome/Edge (Manifest V3) browser extension that reimplements the deprecated
**Edge Collections** feature. Everything is stored locally in the browser, with
JSON download/upload for portability.

## Features

- **Collections**: create, rename, delete, and drag-to-reorder collections.
- **Items**: web page cards, free-text note cards, and image cards.
- **Add pages**: "Add current page" (captures title, favicon, and a thumbnail),
  "Add open tabs…" (multi-select picker), or right-click → **Add to Collection**
  for any page, link, image, or selected text.
- **Edit / delete / reorder** items within a collection (drag-and-drop).
- **Open all links** and **Copy all** for a whole collection.
- **Export** a single collection or all collections to a `.json` file.
- **Import** collections from a `.json` file (merge or replace).
- Docked **side panel** UI with light/dark theme support.

## Data model

Collections are persisted locally in **IndexedDB** (database `collections_db`,
object store `collections`), one record per collection. Each record carries sync
metadata (`updatedAt`, `rev`, `deviceId`, `dirty`, soft-delete `deletedAt`):

```jsonc
{
  "id": "…", "name": "My collection",
  "createdAt": 0, "updatedAt": 0, "order": 0,
  "rev": "…", "deviceId": "…", "dirty": false, "deletedAt": null,
  "sections": [ { "id": "…", "title": "", "createdAt": 0 } ],
  "items": [
    { "id": "…", "type": "page|note|image",
      "title": "", "url": "", "favIconUrl": "", "thumbnail": "",
      "note": "", "color": "", "imageUrl": "", "sectionId": null, "addedAt": 0 }
  ]
}
```

`chrome.storage.local` holds only a small **revision beacon** (`collections_data`)
used to notify open views of changes. A text-only projection of each collection
is mirrored to `chrome.storage.sync` for **cross-device sync** (Edge↔Edge /
Chrome↔Chrome; images stay local). See `behavior.md` → *Storage & privacy*.

Exported JSON uses a clean, portable shape (no internal sync metadata) — files
remain interchangeable across installs.

## Project layout

```
collection/
  src/      the loadable MV3 extension (manifest.json + JS/CSS/HTML + icons)
  docs/     README.md, behavior.md
  tests/    node:test suites (repository, sync, storage) + chrome/IndexedDB mocks
```

## Load the extension (unpacked)

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the **`src/`** folder.
4. Click the extension's toolbar icon to open the **Collections** side panel.

Requires Chromium/Edge 114+ (for the Side Panel API).

## Development / tests

No build step — `src/` loads as-is. Automated tests cover the storage layer
(domain repository, cross-device sync merge, and the facade + migration) using
Node's built-in test runner and `fake-indexeddb`:

```
npm install   # once, installs the fake-indexeddb dev dependency
npm test      # runs node --test on tests/
```

## Publishing

To ship to the Chrome Web Store and Edge Add-ons, see **`docs/PUBLISHING.md`**
(package/build steps, listing assets, permission justifications) and
**`docs/PRIVACY.md`** (the privacy policy to host and link). Build the upload
ZIP from the repo root with:

```powershell
Compress-Archive -Path src\* -DestinationPath collection.zip -Force
```
