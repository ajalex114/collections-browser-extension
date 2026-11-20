import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { unzipSync } from "fflate";

const temporary = await mkdtemp(join(tmpdir(), "collection-store-smoke-"));
try {
  const extension = join(temporary, "extension");
  const archive = unzipSync(await readFile("release/collection-extension-1.0.0.zip"));
  for (const [name, data] of Object.entries(archive)) {
    const parts = name.split("/");
    assert.ok(!parts.includes("..") && !name.startsWith("/"));
    await mkdir(join(extension, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(extension, ...parts), data);
  }
  const channels = process.argv.includes("--edge") ? ["chromium", "msedge"] : ["chromium"];
  for (const channel of channels) {
    const context = await chromium.launchPersistentContext(join(temporary, channel), {
      channel,
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const diagnostics = [];
    const external = [];
    context.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) diagnostics.push(message.text());
    });
    context.on("page", (page) => page.on("pageerror", (error) => diagnostics.push(error.message)));
    try {
      await context.route(/^https?:\/\//, (route) => {
        external.push(route.request().url());
        return route.abort("blockedbyclient");
      });
      const worker = context.serviceWorkers()[0]
        ?? await context.waitForEvent("serviceworker", { timeout: 20000 });
      const id = new URL(worker.url()).host;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/sidepanel.html?mode=popup`);
      await page.getByText("No collections yet.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "New collection", exact: false }).click();
      await page.getByRole("textbox", { name: "Collection name", exact: true }).waitFor();
      await page.waitForFunction(async () => {
        const values = await chrome.storage.sync.get(null);
        return Object.keys(values).some((key) => key.startsWith("c:"));
      }, null, { timeout: 15000 });
      const col = await page.evaluate(async () => {
        const { CollectionStore } = await import("./storage.js");
        return (await CollectionStore.getCollections())[0];
      });
      assert.ok(col?.id, "Collection mutation did not persist");
      const result = await page.evaluate(async (collectionId) => {
        return chrome.runtime.sendMessage({ type: "mutate", method: "addItem", args: [
          collectionId, { type: "note", note: "Fictional browser regression fixture" },
        ] });
      }, col.id);
      assert.ok(result.result?.id && !result.error, "Adding a note failed");
      await page.waitForFunction(async (id) => {
        const key = `c:${id}`;
        const values = await chrome.storage.sync.get(key);
        return values[key]?.items?.some((item) => item.note === "Fictional browser regression fixture");
      }, col.id, { timeout: 15000 });
      assert.deepEqual(diagnostics, [], "Browser startup or mutation errors");
      assert.deepEqual(external, [], "Unexpected network requests");
      console.log(`${channel}: actual ZIP boots, saves a collection/note and writes the browser-sync projection without errors.`);
    } finally {
      await context.close();
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
