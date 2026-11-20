import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";

const root = process.cwd();
const source = join(root, "src");
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(manifest.manifest_version, 3, "Expected Manifest V3");
assert.equal(manifest.version, pkg.version, "Package and manifest versions must match");
assert.match(manifest.version, /^\d+(\.\d+){0,3}$/, "Invalid extension version");

const runtimeNames = new Set([
  "manifest.json", "background.js", "db.js", "dev-logger.js", "limits.js",
  "overlay.css", "overlay.html", "overlay.js", "popup-mode.js",
  "repository.js", "sidepanel.css", "sidepanel.html", "sidepanel.js",
  "storage.js", "sync.js",
]);
const files = {};
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.name === "icons" && entry.isDirectory()) {
    for (const icon of await readdir(join(source, "icons"), { withFileTypes: true })) {
      assert.ok(icon.isFile() && /^icon(16|32|48|128)\.png$/.test(icon.name),
        `Unexpected icon entry: ${icon.name}`);
      files[`icons/${icon.name}`] = await readFile(join(source, "icons", icon.name));
    }
  } else {
    assert.ok(entry.isFile() && runtimeNames.has(entry.name),
      `Unexpected source entry: ${entry.name}`);
    files[entry.name] = entry.name === "dev-logger.js"
      ? Buffer.from("// Development log transport is absent from store packages.\nexport function flog() {}\n")
      : await readFile(join(source, entry.name));
  }
}
for (const name of runtimeNames) {
  assert.ok(Object.hasOwn(files, name), `Missing runtime file: ${name}`);
}
const resources = [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  manifest.action.default_popup.split("?")[0],
  ...Object.values(manifest.icons),
];
for (const resource of resources) {
  assert.ok(Object.hasOwn(files, resource), `Missing manifest resource: ${resource}`);
}
for (const [name, data] of Object.entries(files)) {
  if (!name.endsWith(".html")) continue;
  for (const [, reference] of data.toString().matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(Object.hasOwn(files, reference.replace(/^\.\//, "")),
      `Missing or remote HTML resource: ${reference}`);
  }
}

await mkdir(join(root, "release"), { recursive: true });
const output = join(root, "release", `collection-extension-${manifest.version}.zip`);
await writeFile(output, zipSync(files, { level: 9 }));
console.log(`Created ${output} (${Object.keys(files).length} runtime files; no development logging transport).`);
