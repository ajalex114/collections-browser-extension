import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const source = resolve(root, "src");
const output = join(root, "store", "assets");
const origin = "https://collection-preview.invalid";
const icon = await readFile(join(root, "store", "branding", "icon.svg"), "utf8");
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    serviceWorkers: "block",
  });
  const unexpected = [];
  const errors = [];
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpected.push(`${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    const file = resolve(source, decodeURIComponent(url.pathname).slice(1));
    assert.ok(file.startsWith(source + sep), "Preview path escaped src");
    const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
  });
  await context.addInitScript(() => {
    function area(initial) {
      const values = { ...initial };
      return {
        async get(keys) {
          if (keys == null) return { ...values };
          if (typeof keys === "string") return { [keys]: values[keys] };
          return Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys))
            .map((key) => [key, values[key] ?? keys[key]]));
        },
        async set(patch) { Object.assign(values, patch); },
        async remove(keys) { for (const key of [keys].flat()) delete values[key]; },
      };
    }
    globalThis.chrome = {
      storage: {
        local: area({ app_settings: { theme: location.hash === "#light" ? "light" : "dark", pinned: false } }),
        session: area({}),
        sync: area({}),
        onChanged: { addListener() {} },
      },
      runtime: {
        async sendMessage(message) {
          if (message.type !== "mutate") throw new Error("Unexpected preview message");
          const { CollectionStore } = await import("/storage.js");
          return { result: await CollectionStore[message.method](...message.args) };
        },
      },
    };
  });
  const page = await context.newPage();
  async function save(name, png, width, height) {
    assert.equal(png.readUInt32BE(16), width, `${name}: incorrect width`);
    assert.equal(png.readUInt32BE(20), height, `${name}: incorrect height`);
    await writeFile(join(output, name), png);
  }
  for (const size of [16, 32, 48, 128, 300]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${icon}`);
    const png = await page.screenshot({ omitBackground: true });
    await save(`logo_${size}x${size}.png`, png, size, size);
    if (size !== 32 && size !== 300) {
      await writeFile(join(source, "icons", `icon${size}.png`), png);
    }
  }
  for (const [name, width, height] of [
    ["promo_small_440x280.png", 440, 280],
    ["promo_large_1400x560.png", 1400, 560],
  ]) {
    await page.setViewportSize({ width, height });
    await page.setContent(`<style>
      *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 30% 10%,#164e55,#081c2c 80%);height:100vh;display:flex;align-items:center;justify-content:center;gap:7vw}
      .brand{width:24vh;height:24vh}svg{width:100%;height:100%;display:block}
      .stack{position:relative;width:38vh;height:42vh}.card{position:absolute;width:100%;height:75%;border-radius:3vh;border:1px solid #6de0be66;background:#16424c;transform:rotate(-12deg)}
      .card:nth-child(2){transform:translate(3vh,3vh) rotate(4deg);background:#205967}.card:last-child{transform:translate(6vh,6vh) rotate(14deg);background:#70e1bf;display:flex;flex-direction:column;justify-content:center;gap:3vh;padding:5vh}
      i{display:block;height:2vh;background:#153b48;border-radius:1vh}i:last-child{width:65%}
    </style><div class="brand">${icon}</div><div class="stack"><div class="card"></div><div class="card"></div><div class="card"><i></i><i></i><i></i></div></div>`);
    await save(name, await page.screenshot(), width, height);
  }

  await page.goto(`${origin}/sidepanel.html`);
  await page.locator("#collections-list").waitFor();
  await page.evaluate(async () => {
    const { CollectionStore: store } = await import("/storage.js");
    function tile(color, label) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><rect width="180" height="120" rx="12" fill="${color}"/><circle cx="145" cy="15" r="70" fill="#ffffff20"/><text x="20" y="78" font-family="Arial" font-weight="bold" font-size="32" fill="white">${label}</text></svg>`;
      return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }
    const design = await store.createCollection("Design notebook");
    const section = await store.addSection(design.id, "Try next");
    await store.addItem(design.id, { type: "page", title: "Design systems field notes", url: "https://example.com/design", favIconUrl: tile("#267f77", "UX") });
    await store.addItem(design.id, { type: "page", title: "A guide to color and contrast", url: "https://example.com/color", favIconUrl: tile("#416fc4", "Aa") });
    await store.addItem(design.id, { type: "note", note: "Keep useful references together.\nTry one small idea this week.", color: "#fef3c7", sectionId: section.id });
    await store.addItem(design.id, { type: "image", title: "Palette inspiration", imageUrl: tile("#8b5eab", "CREATE"), sectionId: section.id });
    for (const [name, color, label] of [
      ["Weekend inspiration", "#c06c48", "GO"],
      ["Reading queue", "#456cb7", "READ"],
      ["Build better habits", "#2e8b79", "IDEAS"],
    ]) {
      const col = await store.createCollection(name);
      await store.addItem(col.id, { type: "page", title: `${name} - sample guide`, url: "https://example.com/guide", favIconUrl: tile(color, label) });
      await store.addItem(col.id, { type: "note", note: "A fictional example for the store preview." });
    }
  });
  const scenes = [
    { key: "collections", title: "A home for\nyour good finds.", detail: "Save links, images, and notes.\nKeep every idea within reach.", path: "/sidepanel.html?mode=popup", width: 420, height: 600 },
    { key: "organize", title: "Less tab clutter.\nMore clarity.", detail: "Group references into sections\nand add a note for later.", path: "/sidepanel.html?mode=popup#light", width: 420, height: 600 },
    { key: "spotlight", title: "Find it.\nKeep moving.", detail: "Search across your collections\nwith Spotlight.", path: "/overlay.html?mode=spotlight", width: 640, height: 430 },
  ];
  for (const scene of scenes) {
    await page.setViewportSize({ width: scene.width, height: scene.height });
    await page.goto(origin + scene.path);
    if (scene.key === "spotlight") {
      await page.locator("#app input").fill("design");
      await page.getByText("Design systems field notes", { exact: true }).waitFor();
    } else {
      const collection = page.getByRole("button", { name: "Open collection Design notebook", exact: true });
      await collection.waitFor();
      if (scene.key === "organize") {
        await collection.click();
        await page.getByText("Design systems field notes", { exact: true }).waitFor();
      }
    }
    await page.evaluate(() => document.fonts.ready);
    const capture = await page.screenshot();
    await page.goto("about:blank");
    await page.setViewportSize({ width: 1280, height: 800 });
    const spotlight = scene.key === "spotlight";
    await page.setContent(`<style>
      *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 10% 0%,#164e55,#081c2c 80%);color:#e9fff7;font-family:Arial,Helvetica,sans-serif;height:800px;overflow:hidden}
      main{position:absolute;left:72px;top:104px;width:${spotlight ? 450 : 600}px}
      .brand{display:flex;align-items:center;gap:14px;font-size:23px;font-weight:bold}.brand svg{width:56px;height:56px}
      h1{font-size:${spotlight ? 64 : 66}px;line-height:1.08;letter-spacing:-2px;margin:68px 0 30px;white-space:pre-line}
      p{font-size:23px;line-height:1.55;color:#b1d8d0;white-space:pre-line}
      .preview{position:absolute;right:${spotlight ? 40 : 80}px;top:${spotlight ? 185 : 70}px;width:${spotlight ? 650 : 441}px;border-radius:14px;box-shadow:0 24px 70px #0008;overflow:hidden}
      img{width:100%;display:block}.note{position:absolute;bottom:32px;left:72px;color:#91b9b1;font-size:14px}
    </style><main><div class="brand">${icon}<span>Collection</span></div><h1>${scene.title}</h1><p>${scene.detail}</p></main>
    <div class="preview"><img src="data:image/png;base64,${capture.toString("base64")}" alt="Actual extension UI with fictional collections"></div>
    <div class="note">Actual extension interface. Fictional collections. No live browsing data.</div>`);
    await page.locator("img").evaluate((image) => image.decode());
    await save(`screenshot_${scene.key}_1280x800.png`, await page.screenshot(), 1280, 800);
  }
  assert.deepEqual(unexpected, [], "External requests were blocked during artwork generation");
  assert.deepEqual(errors, [], "UI errors occurred during artwork generation");
  console.log("Generated Collection artwork from fictional fixtures; no existing profiles or external requests used.");
} finally {
  await browser.close();
}
