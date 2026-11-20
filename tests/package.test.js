import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";

const script = resolve("scripts", "package-extension.mjs");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "collection-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "icons"), { recursive: true });
  const source = resolve("src");
  // Use only known source files, never a browser profile or diagnostic export.
  for (const name of [
    "manifest.json", "background.js", "db.js", "dev-logger.js", "limits.js",
    "overlay.css", "overlay.html", "overlay.js", "popup-mode.js", "repository.js",
    "sidepanel.css", "sidepanel.html", "sidepanel.js", "storage.js", "sync.js",
  ]) writeFileSync(join(root, "src", name), readFileSync(join(source, name)));
  for (const size of [16, 48, 128]) {
    const name = `icon${size}.png`;
    writeFileSync(join(root, "src", "icons", name), readFileSync(join(source, "icons", name)));
  }
  writeFileSync(join(root, "package.json"), readFileSync("package.json"));
  return root;
}
function pack(root) {
  execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });
  return unzipSync(readFileSync(join(root, "release", "collection-extension-1.0.0.zip")));
}

test("store ZIP contains runtime files only and removes the dev log transport", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "collection-debug.ndjson"), "private-fixture");
  const archive = pack(root);
  assert.ok(archive["manifest.json"]);
  assert.ok(archive["sidepanel.html"]);
  assert.equal(Object.keys(archive).length, 18);
  assert.ok(!archive["collection-debug.ndjson"]);
  const code = Buffer.from(archive["dev-logger.js"]).toString();
  assert.ok(!code.includes("fetch") && !code.includes("7700"));
  const { flog } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  assert.equal(flog("fixture", { tabUrl: "https://example.com" }), undefined);
});

test("store packaging rejects unexpected files and mismatched versions", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "src", "capture.log"), "private-fixture");
  assert.throws(() => pack(root), /Unexpected source entry: capture.log/);
  rmSync(join(root, "src", "capture.log"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
  assert.throws(() => pack(root), /Package and manifest versions must match/);
});
