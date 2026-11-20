# Collection

A local-first Chrome and Microsoft Edge extension for saving web pages, notes,
and images into searchable collections and sections. Use the toolbar popup or
pin the docked side panel, quick-save with Alt+Shift+A, and search with Ctrl+Space.

Full collections live in IndexedDB. A text-only projection syncs through your
browser account, subject to browser quotas; image payloads stay local. Displaying
saved remote images and favicons can contact their original hosts. There is no
developer-operated backend or analytics service.

- [Features, development, and loading from source](docs/README.md)
- [Behavior reference](docs/behavior.md)
- [Privacy policy](docs/PRIVACY.md)
- [Store listing text, artwork, and submission instructions](docs/PUBLISHING.md)

```bash
npm ci --registry=https://registry.npmjs.org
npm test
npm run package
```

Load `src/` unpacked for development. Upload
`release/collection-extension-1.0.0.zip` to the stores; its manifest is at the ZIP
root and its development log transport is disabled. Listing PNGs in
`store/assets/` are separate uploads. Screenshots use fictional data only and
never capture an existing browser profile or deployment.
