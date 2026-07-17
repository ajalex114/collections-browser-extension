# Privacy Policy — Collection

_Last updated: 2026-07-17_

**Collection does not collect, transmit, or sell any personal data.** There are
no analytics, no telemetry, no ads, no third-party scripts, and no network
requests to any server operated by the developer or anyone else.

## What data the extension stores

All data you create — collections, sections, page/note/image cards, and settings
— is stored **locally in your browser** using IndexedDB and `chrome.storage`:

- **Local storage (IndexedDB + `chrome.storage.local`)** holds the full data,
  including image thumbnails. This never leaves your device except through the
  browser's own sync feature (below).
- **Browser sync (`chrome.storage.sync`)**, when you are signed in and have
  extension sync enabled, mirrors a **text-only** projection of your collections
  (titles, URLs, notes — **no images**) across your own signed-in devices. This
  data is synced by **your browser vendor (Microsoft Edge / Google Chrome)**
  under their privacy terms, not by this extension, and is only accessible to
  your own account.

You can export all data to a JSON file and re-import it at any time. Removing the
extension deletes its local data.

## Permissions and why they are needed

| Permission     | Why it is used                                                        |
| -------------- | --------------------------------------------------------------------- |
| `storage`      | Save collections/settings locally and mirror text to browser sync.    |
| `tabs`         | Read the current tab's title/URL and list open tabs for "Add tabs".   |
| `activeTab`    | Read the active page (with `scripting`) to save it on a user action.  |
| `scripting`    | Show the quick-save / spotlight overlay on the current page on demand. |
| `contextMenus` | Provide the right-click "Add to Collection" menu.                     |
| `sidePanel`    | Display the Collections UI in the browser side panel.                 |
| `alarms`       | Keep the background service worker responsive to shortcuts.           |

The extension requests **no host permissions** and injects content only on an
explicit user action (keyboard shortcut or menu click) via `activeTab`.

## Contact

For questions about this policy, contact the developer through the extension's
store listing support channel.
