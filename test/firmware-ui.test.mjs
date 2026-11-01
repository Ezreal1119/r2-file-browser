import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/firmware-ui.js", import.meta.url), "utf8");
function harness(configured = true) {
  const elements = new Map();
  const progressValues = [];
  function node() {
    const classes = new Set(["is-hidden"]);
    let value = "";
    return {
      handlers: {}, children: [], style: {}, textContent: "", disabled: false,
      get value() { return value; }, set value(v) { value = v; if (this === el("firmwareProgress")) progressValues.push(v); },
      classList: { add(v) { classes.add(v); }, remove(v) { classes.delete(v); }, toggle(v, show) { show ? classes.add(v) : classes.delete(v); }, contains: v => classes.has(v) },
      appendChild(v) { this.children.push(v); }, append(...v) { this.children.push(...v); },
      replaceChildren(...v) { this.children = v; },
      querySelectorAll() { return this.children.flatMap(v => v.children || []).filter(v => v.type === "radio"); },
      removeAttribute(key) { if (key === "value") value = null; }, focus() {},
      addEventListener(event, fn) { this.handlers[event] = fn; },
    };
  }
  function el(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); }
  let initialize;
  let refreshes = 0;
  let pollCalls = 0;
  const calls = [];
  const stored = new Map();
  const finalFile = { name: "SQ68_261016_01.zip", url: "https://files.example/shared-upload/test/file.zip", size: 3 };
  const scope = {
    document: { getElementById: el, createElement: node, addEventListener(event, fn) { initialize = fn; } },
    window: { uploaderBusy: false }, state: { uploaderToken: "management-token" },
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    uploaderHeaders: () => ({ "X-Uploader-Token": "management-token" }),
    formatBytes: String, copyText() {}, showToast() {}, loadFiles: async () => { refreshes++; },
    AbortController, AbortSignal, Date, Intl, URLSearchParams, confirm: () => true,
    setTimeout(fn, ms) { if (ms < 60000) queueMicrotask(fn); return 1; }, clearTimeout() {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("action=config")) return Response.json({ available: configured });
      if (url.includes("action=find")) return Response.json({ searchId: "search", files: [{ filename: finalFile.name }] });
      if (url.includes("action=start")) return Response.json({ state: "queued", stage: "queued", jobId: "job", filename: finalFile.name });
      return Response.json(pollCalls++ === 0 ? { state: "running", stage: "uploading", percentage: 50, bytes: 1, totalBytes: 3, speed: 1, eta: 2 } : { state: "succeeded", stage: "succeeded", file: finalFile });
    },
  };
  vm.createContext(scope);
  vm.runInContext(source, scope);
  initialize();
  return { el, calls, scope, stored, progressValues, get refreshes() { return refreshes; } };
}

test("firmware entry stays hidden unless the authenticated configuration is ready", async () => {
  const h = harness(false);
  await h.el("uploaderUploadButton").handlers.click();
  assert.equal(h.el("firmwareOpen").classList.contains("is-hidden"), true);
  h.el("firmwareOpen").handlers.click();
  assert.equal(h.el("firmwareDialog").classList.contains("visible"), false);
});

test("firmware dialog searches, selects, shows server progress and publishes the result without local upload", async () => {
  const h = harness();
  await h.el("uploaderUploadButton").handlers.click();
  assert.equal(h.el("firmwareOpen").classList.contains("is-hidden"), false);
  h.el("firmwareOpen").handlers.click();
  h.el("firmwareModel").value = "SQ68";
  h.el("firmwareDate").value = "2026-10-16";
  h.el("firmwareIndex").value = "01";
  await h.el("firmwareForm").handlers.submit({ preventDefault() {} });
  assert.match(h.calls.find(call => call.url.includes("action=find")).url, /date=261016/);
  assert.equal(h.el("firmwareGet").disabled, false);
  await h.el("firmwareGet").handlers.click();
  assert.equal(h.refreshes, 1);
  assert.equal(h.el("firmwareResult").classList.contains("is-hidden"), false);
  assert.match(h.el("firmwareDownload").href, /shared-upload/);
  assert.equal(h.progressValues.includes(50), true);
  assert.equal(h.progressValues.includes(100), true);
  assert.equal(h.stored.size, 0, "completed job must not be resumed again on refresh");
  assert.equal(h.calls.some(call => call.url.includes("uploader-upload")), false);
});
