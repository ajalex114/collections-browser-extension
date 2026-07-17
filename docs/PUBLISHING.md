# Publishing checklist — Chrome Web Store & Edge Add-ons

The loadable extension is the **`src/`** folder. Everything below prepares it for
submission to both stores. `docs/` and `tests/` are **not** part of the package.

## 1. Build the upload package

The store expects a ZIP whose **root contains `manifest.json`** (not a parent
folder). From the repo root:

```powershell
Remove-Item collection.zip -ErrorAction SilentlyContinue
Compress-Archive -Path src\* -DestinationPath collection.zip -Force
```

Verify: unzip and confirm `manifest.json`, `background.js`, `icons/…` sit at the
ZIP root. Do **not** include `docs/`, `tests/`, `node_modules/`, `package.json`,
or `.git`.

## 2. Manifest sanity (already satisfied)

- `manifest_version: 3`, valid `name`, `version` (`1.0.0`), `description` (≤132).
- Icons present at exactly **16×16, 48×48, 128×128** PNG.
- No `key` field (each store assigns a stable extension ID on publish).
- No remote code, no `eval`, no external scripts — MV3 default CSP is used.
- No host permissions; page injection is gesture-only via `activeTab` +
  `scripting`.
- Bump `version` on every re-upload (stores reject a duplicate version).

## 3. Store listing assets (entered in each dashboard, not in the ZIP)

Prepare these before submitting:

- **Icon**: 128×128 (store also shows it in listings).
- **Screenshots**: at least one 1280×800 (or 640×400) PNG/JPEG of the side panel,
  quick-save overlay, and spotlight.
- **Small promo tile**: 440×280 (recommended for both stores).
- **Category**: Productivity.
- **Summary / detailed description**: reuse `docs/README.md` feature list.
- **Privacy policy URL**: host `docs/PRIVACY.md` publicly and link it (required
  because the extension requests `tabs`).
- **Language**: English (add more via `_locales` later if desired).

## 4. Data-use / privacy disclosures (review forms)

Both stores ask you to declare data handling. Answer:

- **Does it collect user data?** No data is collected or transmitted to the
  developer. User content stays local; a text-only projection may sync via the
  browser's own account sync.
- **Single purpose**: "Save, organize, and export web pages, notes, and images
  into collections."
- **Permission justifications** (paste per permission — see the table in
  `docs/PRIVACY.md`). The most-scrutinized one is `tabs`: needed to read the
  current tab's title/URL and to enumerate open tabs for the "Add open tabs"
  picker.

## 5. Cross-device sync note

`chrome.storage.sync` only propagates between a user's devices when the extension
has the **same ID** on both. Unpacked/dev installs get a path-derived ID, so sync
won't work in development. **After publishing**, each store issues a fixed ID, so
sync works across that user's devices within the same browser family
(Edge↔Edge, Chrome↔Chrome). Images are intentionally never synced.

## 6. Submit

- **Chrome Web Store**: https://chrome.google.com/webstore/devconsole (one-time
  US$5 developer registration). Upload `collection.zip`, fill listing + privacy,
  submit for review.
- **Edge Add-ons**: https://partner.microsoft.com/dashboard/microsoftedge (free).
  Upload the same `collection.zip`, fill listing + privacy, submit.

## 7. Optional hardening before wide release

- The background worker uses an `alarms`-based keep-alive; reviewers may ask about
  it. It only keeps the worker responsive to shortcuts and does no periodic work.
- Consider gating `console.log` behind a debug flag to remove console noise.
- Avoid `Alt+Shift+*` command defaults on Windows (OS layout-switch hotkey).
