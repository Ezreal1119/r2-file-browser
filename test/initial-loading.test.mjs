import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes("const PAGE_SIZE"));

function browser(search = "") {
  const nodes = new Map();
  let dynamicIds = [];
  const calls = [];
  let finishFiles;
  let finishConfig;
  const document = {
    activeElement: null,
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => node(), createDocumentFragment: () => node(),
  };
  function node(id = "") {
    const classes = new Set();
    let markup = "";
    return {
      handlers: {}, value: "", textContent: "", style: {}, dataset: {}, disabled: false, children: [],
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle(c, on) { on ? classes.add(c) : classes.delete(c); } },
      setAttribute() {}, removeAttribute() {},
      focus() { document.activeElement = this; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.innerHTML = ""; this.children = children; },
      get innerHTML() { return markup; },
      set innerHTML(value) {
        markup = value;
        if (id === "fileList") {
          for (const old of dynamicIds) nodes.delete(old);
          dynamicIds = [...value.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
          for (const key of dynamicIds) nodes.set(key, node(key));
        }
      },
    };
  }
  for (const id of [...html.split("<script>")[0].matchAll(/id="([^"]+)"/g)].map(m => m[1])) nodes.set(id, node(id));
  const scope = {
    document, window: { location: { search }, setTimeout, clearTimeout },
    URLSearchParams, URL, Date, Intl, console: { error() {} }, setTimeout, clearTimeout,
    fetch: (url) => {
      calls.push(url);
      if (url === "/api/files") return new Promise(resolve => { finishFiles = resolve; });
      if (url === "/api/ai-config") return new Promise(resolve => { finishConfig = resolve; });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };
  vm.createContext(scope);
  vm.runInContext(script, scope);
  return {
    nodes, calls, document,
    config: () => finishConfig(Response.json({ enabled: true, ready: true, requireHumanVerification: false })),
    files: (payload = { files: [], labels: [] }, status = 200) => finishFiles(Response.json(payload, { status })),
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("AI composer appears before the directory response and a background completion preserves typing and focus", async () => {
  const h = browser();
  h.config();
  await tick();
  const input = h.nodes.get("aiPromptInput");
  assert.ok(input, "the file request is still pending but AI can be used");
  assert.equal(h.nodes.get("summaryCount").textContent, "Loading directory…");
  input.value = "正在输入 DT66 SDK";
  input.handlers.input();
  input.focus();
  h.files({ files: [{ key: "tools/example.zip", description: "SDK" }], labels: ["SDK"] });
  await tick();
  assert.equal(h.nodes.get("aiPromptInput"), input, "do not recreate a focused/IME textarea");
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, "正在输入 DT66 SDK");
  assert.equal(h.nodes.get("summaryCount").textContent, "1 indexed");
  assert.equal(h.nodes.get("labelFilterButton").disabled, false);
  assert.equal(h.calls.includes("/api/labels"), false);
});

test("a URL keyword search waits for real files instead of flashing false empty results", async () => {
  const h = browser("?search=missing");
  h.config();
  await tick();
  assert.match(h.nodes.get("fileList").innerHTML, /Loading files/);
  assert.doesNotMatch(h.nodes.get("fileList").innerHTML, /No matching files/);
  h.files({ files: [{ key: "tools/sdk.zip", name: "sdk.zip", description: "SDK" }], labels: [] });
  await tick();
  assert.match(h.nodes.get("fileList").innerHTML, /No matching files/);
});

test("directory failure preserves the usable AI composer and normal search reports the directory error", async () => {
  const h = browser();
  h.config();
  await tick();
  const input = h.nodes.get("aiPromptInput");
  h.files({ error: "Directory read failed" }, 503);
  await tick();
  assert.equal(h.nodes.get("aiPromptInput"), input);
  assert.equal(h.nodes.get("summaryCount").textContent, "Directory unavailable");
  const search = h.nodes.get("searchInput");
  search.value = "SDK";
  search.handlers.input();
  assert.match(h.nodes.get("fileList").innerHTML, /Directory read failed/);
  assert.doesNotMatch(h.nodes.get("fileList").innerHTML, /No matching files/);
});
