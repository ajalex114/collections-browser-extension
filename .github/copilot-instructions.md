# Copilot instructions — Collection extension

A Manifest V3 browser extension (Edge + Chrome) reimplementing the deprecated
Edge Collections feature. Vanilla JS, no build step. Side-panel UI. Local storage.

Repo layout: the loadable extension lives in `src/`, documentation in `docs/`,
and automated storage-layer tests in `tests/` (`npm test` → `node --test`).

## Non-negotiable rules

1. **Production quality.** Write clean, correct, best-practice code across HTML,
   CSS, and JS. No dead code, no console noise, no placeholders.
2. **Scalable & flexible.** Design so new features (item types, storage backends,
   sync) can be added without rewrites. Keep the data model extensible.
3. **Privacy first.** No network calls, no telemetry, no third-party scripts.
   Collections live locally in IndexedDB; a text-only projection (no images) is
   mirrored to `chrome.storage.sync` for cross-device sync. Request the minimum
   permissions needed.
4. **Responsive UI.** Layout must adapt to any side-panel width. Support light
   and dark themes via `prefers-color-scheme`.
5. **Reuse before writing.** Always check for an existing helper/module and reuse
   it. Do not duplicate logic.
6. **Least code.** Prefer the smallest, simplest solution. Avoid long, complex
   lines — split them. Fewer lines, clearer intent.
7. **Behavior discipline.**
   - Every new feature must be documented in `docs/behavior.md` with its user workflow.
   - Before editing existing code, confirm the behavior is not changing.
   - If a behavior change is expected, **confirm with the developer first.**
8. **Terse communication.** Messages to the developer use the fewest words/
   sentences possible.

## Architecture

All extension source lives under `src/`:

- `src/manifest.json` — MV3 config (module service worker + side panel).
- `src/storage.js` — public facade (`CollectionStore`); unchanged API. Composes:
  - `src/db.js` — `IndexedDbAdapter`: generic IndexedDB primitives.
  - `src/repository.js` — `CollectionRepository`: domain reads/writes + sync metadata.
  - `src/sync.js` — `SyncMirror`: `chrome.storage.sync` push/pull + last-write-wins.
  Collections live in IndexedDB; `collections_data` in `chrome.storage.local` is
  only a change beacon. All reads/writes still go through `CollectionStore`.
- `src/background.js` — service worker: context menus + side-panel opening.
- `src/sidepanel.{html,css,js}` — the primary UI surface.
- `src/overlay.{html,css,js}` — framed quick-save/spotlight fallback.
- `docs/behavior.md` — feature list + user workflows (keep in sync with code).
- `tests/` — `node:test` suites for the storage layer (`fake-indexeddb`).

## Conventions

- ES modules (`type: module`) everywhere.
- All storage mutations return the updated entity; UI re-renders from storage.
- Never trust imported JSON — sanitize in `storage.js`.
- Use `chrome.storage.onChanged` to keep views in sync; don't manually push
  state between contexts.
- Keep permissions minimal; justify any new permission in the PR/commit message.
