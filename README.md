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

All data lives under one `chrome.storage.local` key (`collections_data`):

```jsonc
{
  "version": 1,
  "collections": [
    {
      "id": "…", "name": "My collection",
      "createdAt": 0, "updatedAt": 0,
      "items": [
        { "id": "…", "type": "page|note|image",
          "title": "", "url": "", "favIconUrl": "", "thumbnail": "",
          "note": "", "imageUrl": "", "addedAt": 0 }
      ]
    }
  ]
}
```

Exported JSON uses the same shape, so files are interchangeable with the store.

## Load the extension (unpacked)

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `collection` folder.
4. Click the extension's toolbar icon to open the **Collections** side panel.

Requires Chromium/Edge 114+ (for the Side Panel API).
