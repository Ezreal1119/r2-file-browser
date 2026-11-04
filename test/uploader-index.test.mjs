import assert from "node:assert/strict";
import test from "node:test";
import { putUploaderRecord, uploaderRecordMetadata } from "../functions/_lib/uploader-records.js";
import { listUploaderFiles, issueUploaderToken } from "../functions/_lib/uploader.js";
import { onRequestGet as filesApi } from "../functions/api/files.js";
import { onRequest as updateItem } from "../functions/api/uploader-item.js";

function bucket(pageSize = 1000) {
  const objects = new Map();
  const calls = [];
  let version = 0;
  const api = {
    objects, calls,
    beforeConditionalPut: null,
    async put(key, body, options = {}) {
      if (options.onlyIf) await api.beforeConditionalPut?.();
      if (options.onlyIf?.etagMatches && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      const object = { key, body, etag: String(++version), customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata };
      objects.set(key, object);
      return object;
    },
    async get(key) {
      calls.push(`get:${key}`);
      const object = objects.get(key);
      return object ? { ...object, json: async () => JSON.parse(object.body) } : null;
    },
    async head(key) { return objects.get(key) || null; },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    async list(options) {
      calls.push(`list:${options.prefix}`);
      const all = [...objects.values()].filter(o => o.key.startsWith(options.prefix));
      const offset = Number(options.cursor || 0);
      return { objects: all.slice(offset, offset + pageSize).map(o => ({ key: o.key, ...(options.include?.includes("customMetadata") ? { customMetadata: o.customMetadata } : {}) })), truncated: offset + pageSize < all.length, cursor: String(offset + pageSize) };
    },
  };
  return api;
}
const record = (id = crypto.randomUUID()) => ({ id, name: "SDK.zip", size: 42, description: "PDA SDK 使用说明", uploaded: "2026-11-04T00:00:00Z" });
const mainBucket = () => ({
  async list() { return { objects: [], truncated: false }; },
  async get(key) { return key === "settings/labels.json" ? { json: async () => ({ labels: ["Unused label"], assignments: {} }) } : null; },
});

test("49 indexed uploads are returned by one list and zero per-record reads; API shares one labels read", async () => {
  const uploads = bucket();
  const originals = Array.from({ length: 49 }, () => record());
  for (const r of originals) await putUploaderRecord(uploads, r);
  const main = mainBucket();
  const get = main.get.bind(main);
  let labelsReads = 0;
  main.get = key => { if (key === "settings/labels.json") labelsReads++; return get(key); };
  const response = await filesApi({ env: { UPLOADER_BUCKET: uploads, FIRMWARE_BUCKET: main }, request: new Request("https://example.com/api/files") });
  const data = await response.json();
  assert.equal(data.count, 49);
  assert.deepEqual(data.labels, ["Unused label"]);
  assert.equal(labelsReads, 1);
  assert.deepEqual(uploads.calls, ["list:records/"]);
  assert.deepEqual(data.files.map(f => f.description), originals.map(r => r.description));
  assert.match(response.headers.get("server-timing"), /library;dur=/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("legacy records backfill only their small sidecars and the next list needs no body reads", async () => {
  const uploads = bucket();
  const r = record();
  await uploads.put(`records/${r.id}`, JSON.stringify(r));
  const tasks = [];
  const first = await listUploaderFiles(uploads, "https://a.example", task => tasks.push(task));
  await Promise.all(tasks);
  uploads.calls.length = 0;
  const next = await listUploaderFiles(uploads, "https://b.example");
  assert.deepEqual(uploads.calls, ["list:records/"]);
  assert.equal(next[0].description, r.description);
  assert.match(next[0].url, /^https:\/\/b.example\/shared-upload\//, "never cache another request's origin");
  assert.equal(first[0].key, next[0].key);
  assert.deepEqual(JSON.parse(uploads.objects.get(`records/${r.id}`).body), r);
  assert.equal([...uploads.objects.keys()].some(key => key.startsWith("objects/")), false);
});

test("a delayed legacy backfill cannot overwrite a newer edit or resurrect a deleted item", async () => {
  for (const deleted of [false, true]) {
    const uploads = bucket();
    const r = record();
    await uploads.put(`records/${r.id}`, JSON.stringify(r));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    uploads.beforeConditionalPut = () => gate;
    const tasks = [];
    await listUploaderFiles(uploads, "https://example.com", task => tasks.push(task));
    if (deleted) await uploads.delete(`records/${r.id}`);
    else await putUploaderRecord(uploads, { ...r, description: "New description" });
    release();
    await Promise.all(tasks);
    const files = await listUploaderFiles(uploads, "https://example.com");
    if (deleted) assert.equal(files.length, 0);
    else assert.equal(files[0].description, "New description");
  }
});

test("oversized unicode descriptions and corrupt metadata retain the canonical-read fallback and pagination", async () => {
  const uploads = bucket(2);
  const large = { ...record(), description: "😀".repeat(750) };
  assert.deepEqual(uploaderRecordMetadata(large), {});
  const first = record(), corrupt = record();
  await putUploaderRecord(uploads, first);
  await putUploaderRecord(uploads, large);
  await uploads.put(`records/${corrupt.id}`, JSON.stringify(corrupt), { customMetadata: { recordIndex: "1", recordData: "invalid" } });
  const files = await listUploaderFiles(uploads, "https://example.com");
  assert.deepEqual(files.map(f => f.key), [first, large, corrupt].map(r => `uploader/${r.id}`));
  assert.equal(files[1].description, large.description);
  assert.equal(uploads.calls.filter(c => c.startsWith("list:")).length, 2);
  assert.equal(uploads.calls.filter(c => c.startsWith("get:")).length, 2);
});

test("authorized description edits and deletion immediately update anonymous indexed search", async () => {
  const uploads = bucket();
  const r = record();
  await putUploaderRecord(uploads, r);
  const env = { UPLOADER_BUCKET: uploads, FIRMWARE_BUCKET: mainBucket(), AI_SESSION_SECRET: "test-session" };
  const token = await issueUploaderToken(env.AI_SESSION_SECRET);
  const request = (method, body) => ({ env, request: new Request(`https://example.com/api/uploader-item?key=uploader/${r.id}`, { method, headers: { "X-Uploader-Token": token }, body: body && JSON.stringify(body) }) });
  assert.equal((await updateItem(request("PUT", { description: "RFID note changed" }))).status, 200);
  uploads.calls.length = 0;
  const response = await filesApi({ env, request: new Request("https://example.com/api/files?query=RFID") });
  assert.equal((await response.json()).count, 1);
  assert.deepEqual(uploads.calls, ["list:records/"]);
  assert.equal((await updateItem(request("DELETE"))).status, 200);
  assert.equal((await listUploaderFiles(uploads, "https://example.com")).length, 0);
});

test("failed metadata backfill never breaks reads of existing records", async (t) => {
  t.mock.method(console, "warn", () => {});
  const uploads = bucket();
  const r = record();
  await uploads.put(`records/${r.id}`, JSON.stringify(r));
  uploads.beforeConditionalPut = () => { throw new Error("temporary metadata-write failure"); };
  const tasks = [];
  const files = await listUploaderFiles(uploads, "https://example.com", task => tasks.push(task));
  await Promise.all(tasks);
  assert.equal(files[0].description, r.description);
  assert.deepEqual(JSON.parse(uploads.objects.get(`records/${r.id}`).body), r);
});
