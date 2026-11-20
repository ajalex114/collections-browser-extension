import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, loadUi } from "./helpers/ui.js";

const collections = [{
  id: "learning",
  name: "Learning Platform",
  sections: [{ id: "pipelines", title: "Pipelines Folder" }],
  items: [{
    id: "link", type: "page", title: "Learning Platform Pipelines Folder",
    url: "https://example.com/build", sectionId: "pipelines",
  }, {
    id: "other", type: "page", title: "Other", url: "https://other.test",
  }],
}];

test("Spotlight keeps input clicks open and closes only on backdrop clicks", async () => {
  const ctx = await loadUi("background.js");
  assert.equal(ctx.spotlightOverlay(collections, "light"), true);
  const host = ctx.document.getElementById("__collection_spotlight_host__");
  const input = host.shadowRoot.querySelector("input");
  await host.fire("click", { target: host, composedPath: () => [input, host.shadowRoot, host] });
  assert.equal(ctx.document.getElementById(host.id), host);
  await host.fire("click", { target: host, composedPath: () => [host] });
  assert.equal(ctx.document.getElementById(host.id), null);
  assert.equal(ctx.window.listeners.keydown.size, 0);
});

test("Spotlight cleans up when browser chrome owns focus, including an existing overlay", async () => {
  const ctx = await loadUi("background.js");
  ctx.document.focused = false;
  assert.equal(ctx.spotlightOverlay(collections, "light"), false);
  assert.equal(ctx.document.getElementById("__collection_spotlight_host__"), null);
  assert.equal(ctx.window.listeners.keydown.size, 0);

  ctx.document.focused = true;
  ctx.spotlightOverlay(collections, "light");
  ctx.document.focused = false;
  assert.equal(ctx.spotlightOverlay(collections, "light"), false);
  assert.equal(ctx.document.getElementById("__collection_spotlight_host__"), null);
});

for (const focused of [true, false]) {
  test(`Spotlight ${focused ? "retains in-page focus" : "uses a focused-window fallback"}`, async () => {
    const calls = [];
    const ctx = await loadUi("background.js", {
      CollectionStore: {
        getSettings: async () => ({ theme: "light" }),
        getSnapshot: async () => ({ collections }),
      },
    });
    const tab = { id: 7, windowId: 3, url: "https://example.com" };
    ctx.chrome.tabs = { query: async () => [tab] };
    ctx.chrome.windows = {
      getLastFocused: async () => ({ width: 1200, height: 900, left: 0, top: 0 }),
      create: async (opts) => calls.push({ window: opts }),
    };
    ctx.chrome.storage.session = { set: async (data) => calls.push({ session: data }) };
    ctx.chrome.scripting = {
      executeScript: async (opts) => {
        calls.push({ script: opts });
        return [{ result: focused }];
      },
    };
    await ctx.openOverlay("spotlight");
    assert.equal(calls.filter((c) => c.script).length, focused ? 2 : 1);
    assert.equal(calls.filter((c) => c.window).length, focused ? 0 : 1);
    if (!focused) {
      assert.equal(calls.find((c) => c.window).window.focused, true);
      assert.equal(calls.find((c) => c.session).session.overlay_ctx.tab.id, tab.id);
    }
  });
}

for (const file of ["background.js", "overlay.js"]) {
  test(`${file} Spotlight matches separated words, partial words and labels`, async () => {
    const ctx = await loadUi(file);
    let root;
    if (file === "background.js") {
      ctx.spotlightOverlay(null, "light");
      root = ctx.document.getElementById("__collection_spotlight_host__").shadowRoot;
    } else {
      const app = ctx.document.createElement("main");
      app.id = "app";
      ctx.document.body.appendChild(app);
      // overlay.js captures #app at module evaluation, so reload with this document.
      const overlay = await loadUi(file, {
        document: ctx.document, testCollections: collections,
      });
      evaluate(overlay, "collections = testCollections; renderSpotlight();");
      root = app;
    }
    const input = root.querySelector("input");
    const list = root.querySelector("ul");
    if (file === "background.js") {
      input.value = "learning pipeline";
      await input.fire("input");
      assert.equal(list.children.length, 0);
      ctx.document.getElementById("__collection_spotlight_host__").__collHydrate(collections);
    }
    for (const query of ["learning pipeline", " PIPELINE  learning ", "platform build"]) {
      input.value = query;
      await input.fire("input");
      assert.equal(list.children.length, 1, query);
      assert.equal(list.children[0].children[0].textContent, collections[0].items[0].title);
    }
    input.value = "learning missing";
    await input.fire("input");
    assert.equal(list.children.length, 0);
  });
}

test("list search matches all terms across item, collection and section fields", async () => {
  const ctx = await loadUi("sidepanel.js", {
    CollectionStore: { MUTATION_METHODS: [], getCollections: async () => collections },
  });
  for (const query of ["learning pipeline", "pipeline learning", "platform build"]) {
    const matches = await ctx.findMatches(query);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].item.id, "link");
  }
  assert.equal((await ctx.findMatches("learning missing")).length, 0);
  assert.equal((await ctx.findMatches("   ")).length, 0);
});

async function editorContext(updateItem = async () => ({ id: "item" })) {
  const calls = [];
  const ctx = await loadUi("sidepanel.js", {
    CollectionStore: {
      MUTATION_METHODS: [],
      updateItem: async (...args) => { calls.push(args); return updateItem(...args); },
    },
    messages: [],
    renders: 0,
  });
  evaluate(ctx, `
    state.currentCollectionId = "collection";
    renderDetail = () => { renders++; };
    toast = (message) => messages.push(message);
  `);
  const li = ctx.document.createElement("li");
  const body = ctx.document.createElement("div");
  body.className = "item-body";
  li.appendChild(body);
  ctx.startEdit(li, {
    id: "item", type: "page", title: "Old title", url: "https://old.test",
  });
  const editor = body.children[0];
  return {
    ctx, calls, editor,
    title: editor.children[0].children[0],
    url: editor.children[1].children[0],
  };
}

test("item editor saves title and URL together, without saving between fields", async () => {
  const { ctx, calls, editor, title, url } = await editorContext();
  title.value = "New title";
  await editor.fire("focusout", { relatedTarget: url });
  assert.equal(calls.length, 0);
  url.value = "https://new.test/page";
  await editor.fire("keydown", { key: "Enter" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "collection");
  assert.equal(calls[0][1], "item");
  assert.deepEqual({ ...calls[0][2] }, {
    title: "New title", url: "https://new.test/page", favIconUrl: "https://new.test/favicon.ico",
  });
  assert.equal(ctx.renders, 1);
  await editor.fire("focusout", { relatedTarget: null });
  assert.equal(calls.length, 1);
});

test("item editor cancels on Escape and blocks invalid URLs", async () => {
  const { ctx, calls, editor, url } = await editorContext();
  url.valid = false;
  await editor.fire("keydown", { key: "Enter" });
  assert.equal(calls.length, 0);
  await editor.fire("keydown", { key: "Escape" });
  await editor.fire("focusout", { relatedTarget: null });
  assert.equal(calls.length, 0);
  assert.equal(ctx.renders, 1);
});

test("item editor reports duplicates and allows correction", async () => {
  let duplicate = true;
  const { ctx, calls, editor, url } = await editorContext(async () =>
    duplicate ? { duplicate: true } : { id: "item" });
  url.value = "https://duplicate.test";
  await editor.fire("keydown", { key: "Enter" });
  assert.equal(ctx.renders, 0);
  assert.equal(url.validationMessage, "Already in this collection");
  duplicate = false;
  url.value = "https://corrected.test";
  await url.fire("input");
  await editor.fire("focusout", { relatedTarget: null });
  assert.equal(calls.length, 2);
  assert.equal(ctx.renders, 1);
});

test("item editor keeps failed saves editable and reports the error", async () => {
  const { ctx, editor } = await editorContext(async () => { throw new Error("storage offline"); });
  await editor.fire("keydown", { key: "Enter" });
  assert.equal(ctx.renders, 0);
  assert.equal(ctx.messages[0], "Could not save item: storage offline");
});
