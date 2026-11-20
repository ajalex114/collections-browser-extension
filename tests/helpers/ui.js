import { readFile } from "node:fs/promises";
import vm from "node:vm";

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.style = {};
    this.className = "";
    this.value = "";
    this.valid = true;
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      },
    };
  }

  set innerHTML(html) {
    this.children = [];
    // Only the Spotlight shell needs HTML parsing in these tests.
    for (const match of html.matchAll(/<(input|ul|div)\b([^>]+)>/g)) {
      const el = this.document.createElement(match[1]);
      for (const attr of match[2].matchAll(/([\w-]+)=['"]([^'"]*)['"]/g)) {
        el.setAttribute(attr[1], attr[2]);
      }
      this.appendChild(el);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === "class") this.className = value;
    if (name === "id") this.id = value;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(el) { this.children.push(el); el.parentNode = this; return el; }
  append(...els) { els.forEach((el) => this.appendChild(el)); }
  contains(el) { return el === this || this.children.some((c) => c.contains(el)); }
  remove() {
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
  }
  querySelector(selector) {
    for (const child of this.children) {
      const matches = selector[0] === "."
        ? child.classList.contains(selector.slice(1))
        : selector[0] === "#"
          ? child.id === selector.slice(1)
          : child.tagName.toLowerCase() === selector;
      if (matches) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  attachShadow() {
    this.shadowRoot = new Element("shadow", this.document);
    return this.shadowRoot;
  }
  focus() {
    this.document.activeElement = this;
    let root = this;
    while (root.parentNode) root = root.parentNode;
    root.activeElement = this;
  }
  select() {}
  scrollIntoView() {}
  reportValidity() { return this.valid && !this.validationMessage; }
  setCustomValidity(message) { this.validationMessage = message; }
  addEventListener(type, fn) { (this.listeners[type] ||= new Set()).add(fn); }
  removeEventListener(type, fn) { this.listeners[type]?.delete(fn); }
  async fire(type, data = {}) {
    const event = { target: this, preventDefault() {}, ...data };
    for (const fn of this.listeners[type] || []) await fn(event);
    await new Promise(setImmediate);
  }
}

export async function loadUi(file, globals = {}) {
  const document = {
    focused: true,
    hasFocus() { return this.focused; },
    createElement(tag) { return new Element(tag, this); },
    getElementById(id) { return this.body.querySelector(`#${id}`); },
    addEventListener() {},
  };
  document.body = document.createElement("body");
  document.documentElement = document.createElement("html");
  const window = document.createElement("window");
  const event = { addListener() {} };
  const context = vm.createContext({
    document, window, URL, URLSearchParams, performance, setTimeout, clearTimeout,
    location: { search: "" },
    console: { log() {}, warn() {} },
    CollectionStore: { MUTATION_METHODS: [] },
    flog() {},
    chrome: {
      alarms: { create() {}, onAlarm: event },
      runtime: {
        onInstalled: event, onStartup: event, onMessage: event,
        getURL: (path) => `chrome-extension://test/${path}`,
      },
      storage: { onChanged: event },
      contextMenus: { onClicked: event },
      commands: { onCommand: event },
    },
    ...globals,
  });
  let source = await readFile(new URL(`../../src/${file}`, import.meta.url), "utf8");
  source = source.replace(/^import .+;\r?$/gm, "");
  source = source.replace(/^(?:init|boot)\(\);\r?$/gm, "");
  vm.runInContext(source, context, { filename: file });
  return context;
}

export function evaluate(context, code) {
  return vm.runInContext(code, context);
}
