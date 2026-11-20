# Privacy Policy - Collection

Last updated: November 20, 2026

## Overview

Collection is a Chrome and Microsoft Edge extension for saving and organizing
web pages, selected text, notes, and images. The developer does not operate a
backend, receive your collections, sell your information, or use advertising,
remote analytics, or third-party executable scripts. This does not mean that
all data stays on your device: browser-account sync and loading saved remote
images or favicons can involve network requests, as described below.

## Information used and stored

On your actions, the extension can read the active tab's title, URL, and favicon;
list open tabs in the Add open tabs picker; and save a page, link, image URL, or
selected text from a context menu. Quick-save and Spotlight inject an overlay
only in response to your command, with an extension-window fallback on restricted
pages. The extension does not record general browsing history or read passwords
or authentication cookies.

Collections, sections, saved URLs, titles, notes, image sources, available
thumbnail data, item order, timestamps, and sync metadata are stored in
IndexedDB in your browser profile. A generated installation identifier and
revision metadata support synchronization and conflict resolution, not analytics.
Browser local storage holds settings, change notifications, and pending actions;
session storage holds temporary quick-save/Spotlight context such as the source
tab URL and title. Your saved content can contain personal or confidential
information; choose what you save and export accordingly.

## Browser-account synchronization

The extension writes a text-only projection of collections to
`chrome.storage.sync`. It includes collection and section names, page titles,
saved URLs, notes, note colors, ordering, timestamps, revision/device identifiers,
deletion markers, and HTTP(S) favicon URLs. Settings also sync. Image payloads,
thumbnails, image-source fields, and inlined data-URL favicons are excluded from
this projection; ordinary saved URL fields may still point to image resources.

When browser-account extension sync is enabled, your browser vendor may transmit
and store this data to synchronize your signed-in devices. The developer does
not receive it. Sync is within the same browser family and extension ID
(Chrome-to-Chrome or Edge-to-Edge), not Edge-to-Chrome. Browser quotas apply;
oversized imported collections remain local-only. There is no separate
extension-level sync switch; manage extension sync through browser settings.

Browser vendors handle account sync under their own privacy policies:
[Google](https://policies.google.com/privacy) and
[Microsoft](https://privacy.microsoft.com/privacystatement).

## Images, favicons, and opening saved links

Displaying saved images, collection previews, or favicons can cause your browser
to request those resources from their original hosts. A missing favicon can
fall back to the saved site's `/favicon.ico`. Those hosts may receive your IP
address, browser request information, and any cookies the browser permits for
the request. Their own privacy practices apply. Embedded data images do not
require a remote image request.

Opening a saved link or Open all links navigates the browser to the chosen
websites. Opening support or privacy links contacts GitHub. These are not
developer analytics requests. The store package contains all executable code
locally and has no telemetry endpoint or localhost logging transport.

## Import, export, clipboard, and retention

- Export downloads a JSON copy of the selected collections, including saved
  content and media fields. The file remains wherever you save or share it.
- Import reads the JSON file you select and merges it or replaces collections
  after confirmation. No file is uploaded to the developer.
- Copy all writes selected collection content to your system clipboard; other
  applications or clipboard-history settings may retain it.
- Data does not expire automatically. Delete items or collections in the UI.
  Collection deletion uses sync tombstones; deletion metadata can remain so
  your devices can reconcile the deletion.
- Uninstalling removes extension-local data through the browser, but must not
  be relied on to erase browser-account sync copies, other devices, downloaded
  exports, clipboard history, console captures, or backups. Manage those
  separately through their respective applications and browser settings.

## Diagnostics and development installs

Operational logs in the local browser console can include saved URLs, collection
names/IDs, item operations, timing, and error messages. Review and redact any log
before sharing it; do not attach raw captures to a public issue.

Unpacked source installs have an additional development-only logger that can
send active-tab URLs and debugging context to a local server at
`http://localhost:7700/log`. It is disabled for store-installed builds. The
repository's store-packaging command replaces that module with a no-op, so the
upload ZIP cannot send those development logs even when loaded unpacked. Local
debug files and the log server are not included in the store package.

## Permissions

| Permission | Purpose |
| --- | --- |
| `storage` | Persist settings/change state and mirror text-only collection data through browser-account sync. Full collections use local IndexedDB. |
| `tabs` | Read tab titles, URLs, and favicons for explicit save actions, show the Add open tabs picker, and open chosen saved links. |
| `activeTab` | Temporarily access the current page when you invoke a shortcut or command. |
| `scripting` | Inject the quick-save or Spotlight overlay on an explicit user action. |
| `contextMenus` | Offer Add to Collection for pages, links, images, and selections. |
| `sidePanel` | Display the docked Collections interface when pinned. |
| `alarms` | Schedule a lightweight local storage touch to improve shortcut responsiveness; no network polling or analytics. |

No persistent host permissions are requested. User-triggered injection relies on
`activeTab`; normal browser rules apply to image loading and navigation.

## Sharing and limited use

The developer does not sell, rent, or use your saved content for advertising,
creditworthiness, or purposes unrelated to organizing your collections. Use of
user data is limited to the extension's single purpose and complies with the
Chrome Web Store User Data Policy, including its Limited Use requirements.
Browser sync and original resource hosts receive only the requests/data
described above; there is no developer-operated collection service.

## Changes and contact

Updates will appear here with a revised date. For privacy questions, open an issue
without personal information, saved private URLs, exports, or logs at the
[project repository](https://github.com/ajalex114/collections-browser-extension/issues).
