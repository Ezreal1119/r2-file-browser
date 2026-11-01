import assert from "node:assert/strict";
import test from "node:test";
import worker from "../sync-worker/src/index.mjs";
import {
  SDK_CRON, SDK_SOURCES, SDK_MANIFEST_KEY, SDK_STATUS_KEY,
  discoverSdkPlan, parseSdkLink, parseLfsPointer, runSdkSync, shanghaiDate, startSdkSync,
} from "../sync-worker/src/sdk-sync.mjs";
import { toFileRecord, searchAgentLibraryFiles, toMcpFile } from "../functions/_lib/files.js";
import { onRequestGet, onRequestPost } from "../functions/api/sdk-sync.js";

const REV = "a".repeat(40);
const TREE = "b".repeat(40);
const OID = "c".repeat(64);
const DATE = new Date("2026-10-21T17:30:00Z");
const fixtureName = (source) => source.id === "pos-printer" ? "printer.7z" : `${source.id}.zip`;

function setup() {
  const objects = new Map();
  const puts = [];
  const messages = [];
  const bucket = {
    async get(key) {
      const object = objects.get(key);
      return object ? { ...object, json: async () => JSON.parse(object.data.toString()) } : null;
    },
    async head(key) { return objects.get(key) || null; },
    async put(key, body, options = {}) {
      const data = Buffer.from(typeof body === "string" ? body : await new Response(body).arrayBuffer());
      const object = { key, data, size: data.length, uploaded: DATE, etag: "test", ...options };
      objects.set(key, object);
      puts.push(key);
      return object;
    },
    async delete(key) { objects.delete(key); },
  };
  const env = { FIRMWARE_BUCKET: bucket, SYNC_QUEUE: { send: async (message) => messages.push(message) } };
  const requests = [];
  let fail = null;
  let changed = null;
  let renamed = null;
  const nameFor = (source) => source.id === renamed ? `${source.id}-v2.zip` : fixtureName(source);
  const fetchImpl = async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url.includes("/commits/main")) return Response.json({ sha: REV, commit: { tree: { sha: TREE } } });
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: SDK_SOURCES.map((source, index) => ({
      path: `downloads/${source.folder}/${nameFor(source)}`, type: "blob",
      sha: (source.id === changed ? "e" : String(index + 1)).repeat(40),
      size: index === 4 ? 133 : 2048,
    })) });
    if (url.includes("/docs/")) {
      const source = SDK_SOURCES.find((source) => url.endsWith(`${source.page}.md`));
      return new Response(`[SDK](https://github.com/UrovoSdkCenter/docs-site/raw/main/downloads/${source.folder}/${nameFor(source)})\n[Offline API](https://github.com/UrovoSdkCenter/docs-site/raw/main/downloads/${source.folder}/ignore.zip)`);
    }
    if (url.includes("/git/blobs/")) return Response.json({ encoding: "base64", content: Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 2048\n`).toString("base64") });
    if (url.includes("/downloads/")) {
      if (fail && url.includes(fail)) return new Response("Unavailable", { status: 503 });
      return new Response(Buffer.alloc(2048), { headers: { "Content-Length": "2048", "Content-Type": "application/octet-stream" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { env, bucket, objects, puts, messages, requests, fetchImpl,
    fail: (value) => { fail = value; }, change: (value) => { changed = value; }, rename: (value) => { renamed = value; } };
}

test("SDK discovery pins all five main packages and resolves LFS rather than its 133-byte pointer", async () => {
  const s = setup();
  s.env.GITHUB_TOKEN = "private-test-token";
  const plan = await discoverSdkPlan(s.env, s.fetchImpl);
  assert.equal(plan.items.length, 5);
  assert.equal(plan.items[4].size, 2048);
  assert.equal(plan.items[4].sha256, OID);
  assert.equal(plan.items[4].fingerprint, `sha256:${OID}`);
  assert.match(plan.items[4].downloadUrl, new RegExp(`/raw/${REV}/downloads/`));
  assert.ok(plan.items.every((item) => !item.downloadUrl.includes("ignore.zip")));
  assert.ok(s.requests.filter((r) => r.url.includes("/docs/")).every((r) => r.url.includes(REV) && !r.headers.Authorization));
  assert.ok(s.requests.filter((r) => r.url.includes("api.github.com")).every((r) => r.headers.Authorization === "Bearer private-test-token"));
  assert.equal(shanghaiDate(DATE), "2026-10-22");
  assert.throws(() => parseSdkLink("[SDK](https://evil.example/a.zip)", SDK_SOURCES[0]), /Missing/);
  assert.throws(() => parseSdkLink("[SDK](https://github.com/UrovoSdkCenter/docs-site/raw/main/downloads/rfid/a.zip)", SDK_SOURCES[0]), /unexpected/);
  assert.throws(() => parseLfsPointer("version https://git-lfs.github.com/spec/v1\nsize 4\n"), /Invalid/);
});

test("SDK first sync streams five archives; second sync performs zero binary downloads or file rewrites", async () => {
  const s = setup();
  const first = await startSdkSync(s.env, "manual", DATE);
  const duplicate = await startSdkSync(s.env, "manual", DATE);
  assert.equal(duplicate.alreadyRunning, true);
  const report = await runSdkSync(s.env, first.runId, { fetchImpl: s.fetchImpl, now: () => DATE });
  assert.deepEqual(report.summary, { downloaded: 5, unchanged: 0, failed: 0 });
  const lfsObject = [...s.objects.values()].find((o) => o.key.startsWith("tools/auto-sdk/k388pro"));
  assert.equal(lfsObject.sha256, OID);
  assert.equal(lfsObject.size, 2048);
  const description = "Urovo K388Pro Printer SDK - Last Sync: 2026-10-22";
  assert.equal(lfsObject.customMetadata.description, description);
  const file = toFileRecord(lfsObject);
  assert.equal(file.name, "k388pro-printer.zip");
  assert.equal(searchAgentLibraryFiles([file], ["K388Pro", "SDK"], 10, "and").count, 1);
  assert.equal(toMcpFile(file).description, description);

  s.requests.length = 0;
  s.puts.length = 0;
  const later = new Date("2026-10-25T00:00:00Z");
  const second = await startSdkSync(s.env, "manual", later);
  const secondReport = await runSdkSync(s.env, second.runId, { fetchImpl: s.fetchImpl, now: () => later });
  assert.deepEqual(secondReport.summary, { downloaded: 0, unchanged: 5, failed: 0 });
  assert.equal(s.requests.filter((r) => r.url.includes("/downloads/")).length, 0);
  assert.equal(s.puts.filter((key) => key.startsWith("tools/")).length, 0);
  assert.equal(s.objects.get(lfsObject.key).customMetadata.description, description);
  assert.equal(s.objects.has("indexes/urovo-en/status.json"), false);
});

test("one failed SDK preserves old content while other items finish; retry downloads only the failed item", async () => {
  const s = setup();
  const first = await startSdkSync(s.env, "manual", DATE);
  await runSdkSync(s.env, first.runId, { fetchImpl: s.fetchImpl, now: () => DATE });
  const previous = structuredClone(await (await s.bucket.get(SDK_MANIFEST_KEY)).json());
  const oldObject = s.objects.get(previous.items["pda-rfid"].key);
  s.change("pda-rfid");
  s.fail("pda-rfid.zip");
  const next = await startSdkSync(s.env, "manual", new Date("2026-10-23T00:00:00Z"));
  await assert.rejects(runSdkSync(s.env, next.runId, { fetchImpl: s.fetchImpl, now: () => DATE }), /503/);
  assert.equal(s.objects.get(oldObject.key), oldObject);
  assert.deepEqual((await (await s.bucket.get(SDK_MANIFEST_KEY)).json()).items["pda-rfid"], previous.items["pda-rfid"]);
  assert.equal((await (await s.bucket.get(SDK_STATUS_KEY)).json()).state, "retrying");
  s.requests.length = 0;
  s.fail(null);
  const report = await runSdkSync(s.env, next.runId, { fetchImpl: s.fetchImpl, now: () => DATE, attempts: 2 });
  assert.deepEqual(report.summary, { downloaded: 1, unchanged: 4, failed: 0 });
  assert.equal(s.requests.filter((r) => r.url.includes("/downloads/")).length, 1);
  assert.equal(report.state, "complete");
});

test("SDK retry recovers a successful R2 put when manifest write failed, without fetching binary again", async () => {
  const s = setup();
  const put = s.bucket.put.bind(s.bucket);
  let failOnce = true;
  s.bucket.put = async (key, ...args) => {
    if (key === SDK_MANIFEST_KEY && failOnce) { failOnce = false; throw new Error("storage temporary error"); }
    return put(key, ...args);
  };
  const run = await startSdkSync(s.env, "manual", DATE);
  await assert.rejects(runSdkSync(s.env, run.runId, { fetchImpl: s.fetchImpl, now: () => DATE }), /temporary/);
  s.requests.length = 0;
  const report = await runSdkSync(s.env, run.runId, { fetchImpl: s.fetchImpl, now: () => DATE, attempts: 2 });
  assert.equal(report.state, "complete");
  assert.equal(s.requests.filter((r) => r.url.includes("/downloads/")).length, 0);
});

test("SDK filename replacement retries pending retirement and never deletes unrelated tools", async () => {
  const s = setup();
  const first = await startSdkSync(s.env, "manual", DATE);
  await runSdkSync(s.env, first.runId, { fetchImpl: s.fetchImpl, now: () => DATE });
  const oldKey = "tools/auto-sdk/pda-rfid/pda-rfid.zip";
  await s.bucket.put("tools/manual-sdk.zip", "manually uploaded");
  const originalDelete = s.bucket.delete.bind(s.bucket);
  let failOnce = true;
  s.bucket.delete = async (key) => {
    if (key === oldKey && failOnce) { failOnce = false; throw new Error("retirement failed"); }
    return originalDelete(key);
  };
  s.change("pda-rfid");
  s.rename("pda-rfid");
  const second = await startSdkSync(s.env, "manual", new Date("2026-10-23T00:00:00Z"));
  await assert.rejects(runSdkSync(s.env, second.runId, { fetchImpl: s.fetchImpl, now: () => DATE }), /retirement failed/);
  assert.ok(s.objects.has(oldKey));
  assert.ok(s.objects.has("tools/auto-sdk/pda-rfid/pda-rfid-v2.zip"));
  s.requests.length = 0;
  await runSdkSync(s.env, second.runId, { fetchImpl: s.fetchImpl, now: () => DATE, attempts: 2 });
  assert.equal(s.objects.has(oldKey), false);
  assert.ok(s.objects.has("tools/manual-sdk.zip"));
  assert.equal(s.requests.filter((r) => r.url.includes("/downloads/")).length, 0);
});

test("SDK schedule and API are isolated from catalog credentials, status and admin secrets", async () => {
  const s = setup();
  let pending;
  await worker.scheduled({ cron: SDK_CRON }, s.env, { waitUntil: (p) => { pending = p; } });
  await pending;
  assert.equal(s.messages[0].type, "sdk-sync");
  assert.equal(s.objects.has("indexes/urovo-en/status.json"), false);
  const context = { env: s.env, request: new Request("https://example.com/api/sdk-sync") };
  assert.equal((await onRequestGet(context)).status, 401);
  assert.equal((await onRequestPost(context)).status, 401);
  const response = await worker.fetch(new Request("https://worker.example/sdk-sync", { method: "POST" }), { ...s.env, SYNC_TOKEN: "secret" });
  assert.equal(response.status, 401);
});
