import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/uploader-ui.js", import.meta.url), "utf8");
function logic() {
  const scope = { document: { addEventListener() {} }, performance, Date };
  vm.createContext(scope);
  vm.runInContext(source, scope);
  return scope;
}

test("upload concurrency probes a fourth request and rolls back without a throughput gain", () => {
  const { createUploadTuning } = logic();
  let time = 0;
  const tuner = createUploadTuning(() => time);
  tuner.sample(0, 20);
  tuner.completedPart(); tuner.completedPart();
  time = 10000; tuner.sample(1000000, 20);
  assert.equal(tuner.limit, 4);
  time = 20000; tuner.sample(2050000, 20);
  assert.equal(tuner.limit, 3);
  tuner.completedPart(); tuner.completedPart();
  time = 60000; tuner.sample(6000000, 20);
  time = 70000; tuner.sample(7000000, 20);
  assert.equal(tuner.limit, 3, "do not repeatedly probe a concurrency that was unhelpful");
});

test("upload concurrency keeps a useful fourth request and drops on retry within 2–4 bounds", () => {
  const { createUploadTuning } = logic();
  let time = 0;
  const tuner = createUploadTuning(() => time);
  tuner.sample(0, 20);
  tuner.completedPart(); tuner.completedPart();
  time = 10000; tuner.sample(1000000, 20);
  time = 20000; tuner.sample(2400000, 20);
  assert.equal(tuner.limit, 4);
  tuner.retried();
  assert.equal(tuner.limit, 3);
  tuner.retried(); tuner.retried();
  assert.equal(tuner.limit, 2);
  tuner.completedPart(); tuner.completedPart();
  tuner.sample(2400000, 20);
  time = 30000; tuner.sample(3400000, 20);
  assert.equal(tuner.limit, 2, "retry cooldown must prevent immediately reopening connections");
  time = 50000; tuner.sample(5400000, 20);
  assert.equal(tuner.limit, 3);
});

test("a draining queue and suspended tab do not trigger a misleading concurrency probe", () => {
  const { createUploadTuning } = logic();
  let time = 0;
  const tuner = createUploadTuning(() => time);
  tuner.completedPart(); tuner.completedPart();
  tuner.sample(0, 4);
  time = 10000; tuner.sample(1000000, 4);
  assert.equal(tuner.limit, 3);
  time = 60000; tuner.sample(6000000, 20);
  assert.equal(tuner.limit, 3);
});

test("upload speed uses recent bytes, falls to zero when stalled, and never becomes negative", () => {
  const { createUploadSpeedMeter } = logic();
  let time = 0;
  const meter = createUploadSpeedMeter(() => time);
  assert.equal(meter.sample(0), 0);
  time = 1000;
  assert.equal(meter.sample(2000), 2000);
  time = 9000;
  assert.equal(meter.sample(2000), 0);
  time = 10000;
  assert.equal(meter.sample(1000), 0);
});

test("retry waits use backoff and Retry-After, and permanent HTTP failures stop immediately", () => {
  const { uploadRetryDelay } = logic();
  assert.equal(uploadRetryDelay({ status: 401 }, 0), null);
  assert.equal(uploadRetryDelay({ status: 413 }, 0), null);
  assert.equal(uploadRetryDelay({ status: 429, retryAfter: "10" }, 0, () => 0.5), 10000);
  assert.equal(uploadRetryDelay({ status: 503 }, 2, () => 0.5), 4000);
  assert.equal(uploadRetryDelay(new Error("offline"), 0, () => 0.5), 1000);
});

function browserHarness() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        handlers: {}, disabled: false, value: "", textContent: "", files: [],
        classList: { add: v => classes.add(v), remove: v => classes.delete(v), toggle(v, on) { if (on) classes.add(v); else classes.delete(v); }, contains: v => classes.has(v) },
        addEventListener(event, fn) { this.handlers[event] = fn; }, click() {},
      });
    }
    return nodes.get(id);
  };
  const pending = [];
  let peak = 0;
  const calls = [];
  const xhrs = new Set();
  let initialize;
  const scope = {
    document: { getElementById: node, addEventListener(event, fn) { if (event === "DOMContentLoaded") initialize = fn; } },
    window: { addEventListener() {}, uploaderBusy: false },
    state: { uploaderToken: "test" }, formatBytes: n => String(n), uploaderHeaders: () => ({}),
    loadFiles: async () => {}, showToast() {}, confirm: () => true,
    AbortController, AbortSignal, Date, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return Response.json(url.includes("action=start") ? { id: "test", partSize: 16 } : { completed: true });
    },
    XMLHttpRequest: class {
      constructor() { this.upload = {}; }
      open(method, url) { this.url = url; }
      setRequestHeader() {}
      getResponseHeader() { return null; }
      send(body) { this.body = body; pending.push(this); xhrs.add(this); peak = Math.max(peak, xhrs.size); }
      finish(status = 200) {
        if (!xhrs.delete(this)) return;
        const partNumber = Number(new URL(this.url, "https://test.invalid").searchParams.get("part"));
        this.status = status;
        this.responseText = JSON.stringify({ partNumber, etag: `etag-${partNumber}` });
        this.upload.onprogress?.({ loaded: this.body.size });
        this.onload();
      }
      abort() { if (xhrs.delete(this)) this.onabort?.(); }
    },
  };
  vm.createContext(scope);
  vm.runInContext(source, scope);
  initialize();
  node("uploaderFile").files = [{ name: "file.zip", size: 160, slice: (start, end) => ({ size: end - start }) }];
  node("uploaderFile").handlers.change();
  return { scope, node, pending, xhrs, calls, get peak() { return peak; } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function drain(harness) {
  for (let i = 0; harness.scope.window.uploaderBusy && i < 200; i++) {
    if (harness.xhrs.size) [...harness.xhrs][0].finish();
    else await new Promise(resolve => setTimeout(resolve, 10));
    await tick();
  }
  assert.equal(harness.scope.window.uploaderBusy, false);
}

test("adaptive queue completes each part exactly once and keeps the normal path bounded", async () => {
  const h = browserHarness();
  const running = h.node("uploaderStart").handlers.click();
  await tick();
  assert.equal(h.xhrs.size, 3);
  await drain(h);
  await running;
  assert.equal(h.peak, 3);
  const completed = h.calls.find(call => call.url.includes("action=complete"));
  assert.deepEqual(JSON.parse(completed.body).parts.map(p => p.partNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(JSON.parse(completed.body).description, "");
  assert.equal(h.scope.window.uploaderBusy, false);
});

test("fatal part errors abort the queue and manual retry retains confirmed parts", async () => {
  const h = browserHarness();
  h.node("uploaderDescription").value = "Keep this draft after failure";
  const running = h.node("uploaderStart").handlers.click();
  await tick();
  h.pending[0].finish();
  await tick();
  [...h.xhrs][0].finish(401);
  await running;
  assert.equal(h.xhrs.size, 0);
  assert.equal(h.calls.some(call => call.url.includes("action=complete")), false);
  assert.equal(h.node("uploaderStart").textContent, "Retry upload");
  assert.equal(h.node("uploaderDescription").disabled, false);
  assert.equal(h.node("uploaderDescription").value, "Keep this draft after failure");
  const before = h.pending.length;
  const retrying = h.node("uploaderStart").handlers.click();
  await tick();
  await drain(h);
  await retrying;
  assert.equal(h.pending.slice(before).some(xhr => xhr.url.endsWith("part=1")), false);
  assert.equal(JSON.parse(h.calls.find(call => call.url.includes("action=complete")).body).description, "Keep this draft after failure");
});

test("upload description is counted, locked during transfer, and sent only in completion before dialog resets", async () => {
  const h = browserHarness();
  h.node("uploaderDialog").classList.add("visible");
  const description = h.node("uploaderDescription");
  description.value = "  DT66 SDK\n使用说明  ";
  description.handlers.input();
  assert.equal(h.node("uploaderDescriptionCount").textContent, `${description.value.length} / 1500`);
  const running = h.node("uploaderStart").handlers.click();
  await tick();
  assert.equal(description.disabled, true);
  assert.equal(h.node("uploaderStart").disabled, true);
  assert.equal(JSON.parse(h.calls[0].body).description, undefined, "no extra metadata save/start work during transfer");
  await drain(h);
  await running;
  assert.equal(JSON.parse(h.calls.find(call => call.url.includes("action=complete")).body).description, "DT66 SDK\n使用说明");
  assert.equal(description.disabled, false);
  assert.equal(description.value, "");
  assert.equal(h.node("uploaderDescriptionCount").textContent, "0 / 1500");
  assert.equal(h.node("uploaderDialog").classList.contains("visible"), false);
  assert.equal(h.calls.some(call => call.url.includes("uploader-item")), false);
});

test("cancelling during retry backoff immediately stops requests and cleans the upload session", async () => {
  const h = browserHarness();
  const running = h.node("uploaderStart").handlers.click();
  await tick();
  h.pending[0].finish(503);
  await tick();
  await h.node("uploaderClose").handlers.click();
  await running;
  assert.equal(h.xhrs.size, 0);
  assert.equal(h.calls.some(call => call.method === "DELETE"), true);
  assert.equal(h.calls.some(call => call.url.includes("action=complete")), false);
  assert.equal(h.scope.window.uploaderBusy, false);
});
