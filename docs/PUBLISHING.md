# Publishing - Chrome Web Store and Microsoft Edge Add-ons

## Prepare the upload

```bash
npm ci --registry=https://registry.npmjs.org
npm test
npm run package
```

Upload `release/collection-extension-1.0.0.zip` to each store. The filename follows
the manifest version. The validated ZIP has `manifest.json` at its root and
contains only runtime files from `src/`. Tests, tooling, documentation, store
artwork, existing ZIPs, and diagnostic captures are excluded.

The source extension still loads directly from `src/`, with no build step.
Store packaging replaces `dev-logger.js` with an inert `flog()` implementation.
This preserves its existing store-installed no-op behavior and ensures even an
unpacked copy of the upload ZIP cannot send development logs to localhost.
The source developer logger remains available. The approved sync-startup fix uses
static module imports so browser service workers initialize sync correctly;
existing collection workflows and stored data are preserved.

For subsequent releases, increment both `package.json` and `src/manifest.json`.
Keep 1.0.0 for the initial store submission if it has not already been used.

## Copy-ready listing fields

- **Name:** Collection
- **Category:** Productivity.
- **Language:** English.
- **Website:** https://github.com/ajalex114/collections-browser-extension
- **Support:** https://github.com/ajalex114/collections-browser-extension/issues
- **Privacy policy:** https://github.com/ajalex114/collections-browser-extension/blob/main/docs/PRIVACY.md
- **Short description:** Save, organize, and export web pages, notes, and images into collections. Private, local-first, with cross-device sync.
- **Single purpose:** Save, organize, find, and export user-selected web pages, notes, and images in collections.
- **Edge search terms:** collections; save tabs; organize links; notes; tab manager; spotlight search; bookmarks

### Full description

Turn useful tabs into organized collections of links, notes, and images.
Collection gives your research, reading lists, and inspiration a home inside
Chrome or Microsoft Edge, with a toolbar popup and an optional docked side panel.

SAVE WHAT MATTERS
- Save the current page or choose several open tabs to add at once.
- Right-click a page, link, image, or selected text to add it to a collection.
- Press Alt+Shift+A to open quick-save and choose a collection or section.
- Add your own notes and images by URL.

KEEP THINGS ORGANIZED
- Create, rename, and reorder collections and sections.
- Edit saved link names and URLs, reorder cards, and color your notes.
- Open all links in a collection or copy its contents.
- Export JSON backups and import them again with merge or replace options.

FIND IT AGAIN
- Search across collection names, sections, saved titles, URLs, and notes.
- Press Ctrl+Space for Spotlight search, then open a result with the keyboard.
- Use a popup or pin the interface as a side panel.
- Choose Browser theme, Light, or Dark.

LOCAL-FIRST, WITH BROWSER SYNC
Full collections are stored in local IndexedDB. A text-only projection of titles,
URLs, notes, sections, and settings is mirrored through your browser's built-in
account sync, subject to its quotas and settings. Image payloads stay local;
text and saved URLs can sync. Sync works within the same browser family and
extension ID, not between Edge and Chrome. No separate extension account or
developer-operated backend is required.

Browser sync storage is limited: approximately 8 KB per collection and 100 KB
overall. New additions are blocked when those budgets are full. Oversized JSON
imports remain local-only. Export regularly if you need an independent backup.

Saved remote images and favicons may be requested from their original hosts
when displayed. There are no ads, developer analytics, or remotely loaded
executable scripts. Read the privacy policy for sync and resource-loading details.

Requires Chrome or Chromium-based Microsoft Edge 114 or later. Some browser and
restricted pages use a separate extension window for quick-save or Spotlight.
Keyboard shortcuts can be reassigned in the browser's extension shortcut settings.

Independent project; not affiliated with or endorsed by Microsoft or Google.
Chrome and Microsoft Edge are trademarks of their respective owners.

## Privacy dashboard and permission justifications

Do not declare "no user data handled" or "no network requests". Saved titles,
URLs, notes, selected text, and image sources can be sensitive. The extension
uses browser-account sync and can load resources from saved sites. No user
content is collected by a developer-operated service.

Declare website content and selected/open-tab URL information where the store
asks about data accessed, used, collected, or transmitted. Disclose user-entered
notes and selected text, not just URLs. Do not equate browser-vendor sync with
local-only storage. Review the current dashboard's definitions before certifying
any data-type or data-use checkbox. The privacy policy describes retention,
exports, clipboard use, console diagnostics, and browser-vendor sharing.

| Permission | Justification |
| --- | --- |
| `storage` | Store settings/change beacons and mirror text-only collection data/settings through browser-account sync. Full collections use local IndexedDB. |
| `tabs` | Read title, URL, and favicon for user-triggered saves and the Add open tabs picker; open chosen saved links. No general browsing-history record is maintained. |
| `activeTab` | Temporarily access the current tab on an explicit shortcut or command to display a collection picker or search overlay. |
| `scripting` | Inject the quick-save or Spotlight overlay in response to a user gesture, with a separate-window fallback on restricted pages. |
| `contextMenus` | Provide Add to Collection actions for the chosen page, link, image, or selected text. |
| `sidePanel` | Display the optional docked Collections interface when pinned. |
| `alarms` | Perform a lightweight periodic local storage touch for shortcut responsiveness. No periodic network polling or analytics. |
| Host permissions | None requested. Injection relies on user-granted `activeTab` access. |
| Remote code | No. All executable JavaScript is inside the uploaded package. Saved web links and image resources are not executable extension code. |

Certify single-purpose, no-sale, no-creditworthiness, and Limited Use statements
only after checking the final uploaded version. Developer-account identity,
distribution, and other store-specific declarations must be completed manually.

## Store artwork

| File in `store/assets/` | Size | Upload field |
| --- | --- | --- |
| `logo_128x128.png` | 128 x 128 | Chrome store icon |
| `logo_300x300.png` | 300 x 300 | Edge extension logo |
| `promo_small_440x280.png` | 440 x 280 | Small promotional tile, both stores |
| `promo_large_1400x560.png` | 1400 x 560 | Chrome marquee / Edge large promotional tile |
| `screenshot_collections_1280x800.png` | 1280 x 800 | Actual collection-list UI, fictional data |
| `screenshot_organize_1280x800.png` | 1280 x 800 | Actual detail/sections/notes UI, fictional data |
| `screenshot_spotlight_1280x800.png` | 1280 x 800 | Actual Spotlight UI, fictional data |

Additional logos are supplied at 16, 32, and 48 pixels. Runtime icons remain at
16, 48, and 128 pixels under `src/icons/`. The 128-pixel square icon has 16 pixels
of transparent padding around 96-pixel artwork. Its editable SVG is in
`store/branding/`.

To regenerate artwork:

```bash
npx playwright install chromium
npm run store:assets
```

Packaged-browser regression check (fresh profiles, fictional data, no network):

```bash
npm run package
npm run test:browser
# Also check an installed Microsoft Edge:
npm run test:browser -- --edge
```

The check verifies startup, persisted collection/note mutations, and writes to
the browser's sync storage area. It does not claim to verify cloud propagation
between real signed-in devices. CI runs the Chromium check automatically.

Generation uses a fresh browser context with fictional collections, inlined
sample images, and all external requests blocked. It does not read your current
browser, browsing history, collection database, exports, or diagnostic logs.
Do not replace these with screenshots of a private deployment.

## Reviewer notes and submission

1. Push the policy and artwork and confirm the privacy URL opens without login.
2. Load an extracted copy of the ZIP in clean Chrome and Edge profiles. Test a
   fictional collection, note, section, search, JSON export/import, and shortcuts.
3. Use your own registered Chrome Web Store and Edge Partner Center accounts.
   Complete account verification, any fees, distribution fields, and declarations.
4. Upload the ZIP, copy the listing/privacy information, and upload PNG assets
   separately. Store approval and publication remain manual.

Suggested reviewer notes:

> Collection works locally without an extension account. Open its toolbar popup,
> create a sample collection, add a note or save an example.com page, and test
> search and JSON export/import. Pin toggles the docked side panel. Alt+Shift+A
> invokes quick-save; Ctrl+Space invokes Spotlight. Browser-restricted pages fall
> back to an extension window. Sync is browser-account managed and requires the
> same store extension ID on signed-in devices within the same browser family;
> an unpacked load is not proof of cross-device sync. Image payloads stay local.
> No credentials or private browsing data are needed. Listing screenshots use
> fictional content. The store package excludes development network logging.

Official references checked November 20, 2026:

- [Chrome listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Chrome artwork requirements](https://developer.chrome.com/docs/webstore/images)
- [Edge publication requirements](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)

Recheck the live dashboards when submitting.
