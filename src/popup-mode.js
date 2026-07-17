// Popup vs docked side panel: the popup entry uses ?mode=popup so we can give
// it fixed dimensions. Applied before paint (loaded synchronously in <head>)
// to avoid a resize flash. Kept as a separate file because MV3's default CSP
// (script-src 'self') forbids inline scripts.
if (new URLSearchParams(location.search).get("mode") === "popup") {
  document.documentElement.classList.add("popup");
}
