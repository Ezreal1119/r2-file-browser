import test from "node:test";
import assert from "node:assert/strict";
import { issueUploaderToken, isUploader, scopedLibraryFiles, PART_SIZE, MAX_UPLOAD_SIZE } from "../functions/_lib/uploader.js";
import { onRequest as upload } from "../functions/api/uploader-upload.js";
import { onRequest as item } from "../functions/api/uploader-item.js";
import { onRequest as download } from "../functions/shared-upload/[[path]].js";
import { onRequestGet as filesApi } from "../functions/api/files.js";
import { onRequestPost as login } from "../functions/api/admin.js";
import { onRequest as mcp } from "../functions/mcp.js";
import { ADMIN_PASSWORD, UPLOADER_PASSWORD, TEST_AUTH_ENV } from "./helpers/credentials.mjs";
import { searchLibraryWithPrompt } from "../functions/_lib/ai-agent.js";

function memoryBucket() {
  const data = new Map();
  const parts = new Map();
  let completions = 0;
  return {
    data, parts, get completions() { return completions; },
    async put(key, body) { data.set(key, typeof body === "string" ? body : body); },
    async get(key) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return typeof value === "string" ? { json: async () => JSON.parse(value) } : value;
    },
    async head(key) { return data.has(key) ? (typeof data.get(key) === "string" ? {} : data.get(key)) : null; },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
    async list({ prefix }) { return { objects: [...data.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async createMultipartUpload(key) { parts.set(key, new Map()); return { uploadId: "test-upload", abort: async () => parts.delete(key) }; },
    resumeMultipartUpload(key) {
      return {
        async uploadPart(number, body) { const bytes = new Uint8Array(await new Response(body).arrayBuffer()); parts.get(key).set(number, bytes); return { partNumber: number, etag: `part-${number}` }; },
        async complete(list) {
          completions++;
          const size = list.reduce((sum, p) => sum + parts.get(key).get(p.partNumber).length, 0);
          const object = { size, uploaded: new Date(), etag: "etag", httpEtag: '"etag"', body: new Uint8Array(size) };
          data.set(key, object); return object;
        },
        async abort() { parts.delete(key); },
      };
    },
  };
}

async function setup() {
  const env = { ...TEST_AUTH_ENV, AI_SESSION_SECRET: "test-secret", UPLOADER_BUCKET: memoryBucket(), FIRMWARE_BUCKET: memoryBucket() };
  const token = await issueUploaderToken(env.AI_SESSION_SECRET);
  const context = (path, method = "GET", body, authorized = true) => ({ env, request: new Request(`https://example.com${path}`, {
    method, headers: { ...(authorized ? { "X-Uploader-Token": token } : {}), ...(body instanceof Uint8Array ? { "Content-Length": String(body.length) } : { "Content-Type": "application/json" }) },
    body: body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body),
  }) });
  return { env, token, context };
}

test("uploader token rejects missing, tampered and wrong-secret sessions", async () => {
  const { env, context, token } = await setup();
  assert.equal(await isUploader(context("/").request, env), true);
  assert.equal(await isUploader(context("/", "GET", undefined, false).request, env), false);
  assert.equal(await isUploader(new Request("https://example.com", { headers: { "X-Uploader-Token": token + "0" } }), env), false);
  assert.equal(await isUploader(context("/").request, { ...env, AI_SESSION_SECRET: "other" }), false);
});

test("uploader files are publicly searchable; mutations require authorization and descriptions stay in sidecars", async () => {
  const { env, context } = await setup();
  const id = crypto.randomUUID();
  await env.UPLOADER_BUCKET.put(`records/${id}`, JSON.stringify({ id, name: "private-sdk.zip", size: 3, description: "PDA SDK" }));
  assert.equal((await scopedLibraryFiles(context("/"))).length, 1);
  assert.equal((await scopedLibraryFiles(context("/", "GET", undefined, false))).length, 1);
  assert.equal((await (await filesApi(context("/api/files?query=PDA"))).json()).count, 1);
  assert.equal((await (await filesApi(context("/api/files?query=PDA", "GET", undefined, false))).json()).count, 1);
  assert.equal((await item(context(`/api/uploader-item?key=uploader/${id}`, "PUT", { description: "Updated" }, false))).status, 401);
  assert.equal((await item(context(`/api/uploader-item?key=tools/test`, "PUT", { description: "Updated" }))).status, 400);
  assert.equal((await item(context(`/api/uploader-item?key=uploader/${id}`, "PUT", { description: "x".repeat(1501) }))).status, 400);
  assert.equal((await item(context(`/api/uploader-item?key=uploader/${id}`, "PUT", { description: "Updated" }))).status, 200);
  assert.equal(JSON.parse(env.UPLOADER_BUCKET.data.get(`records/${id}`)).description, "Updated");
  assert.equal(env.UPLOADER_BUCKET.data.has(`objects/${id}`), false);
});

test("multipart publishes only on complete, safely retries completion, and supports shared download/delete", async () => {
  const { env, context } = await setup();
  assert.equal((await upload(context("/api/uploader-upload?action=start", "POST", { name: "test.zip", size: 3 }, false))).status, 401);
  const session = await (await upload(context("/api/uploader-upload?action=start", "POST", { name: "test.zip", size: 3 }))).json();
  assert.equal(session.partSize, PART_SIZE);
  const part = await (await upload(context(`/api/uploader-upload?id=${session.id}&part=1`, "PUT", new Uint8Array([1, 2, 3])))).json();
  assert.equal((await scopedLibraryFiles(context("/"))).length, 0);
  const complete = () => upload(context(`/api/uploader-upload?action=complete&id=${session.id}`, "POST", { parts: [part] }));
  assert.equal((await complete()).status, 200);
  assert.equal((await complete()).status, 200);
  assert.equal(env.UPLOADER_BUCKET.completions, 1);
  const record = (await scopedLibraryFiles(context("/")))[0];
  assert.equal(record.source, "uploader");
  assert.equal(record.description, "");
  const response = await download({ ...context(`/shared-upload/${session.id}/test.zip`, "GET", undefined, false), params: { path: [session.id, "test.zip"] } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Disposition"), /attachment/);
  assert.equal((await response.arrayBuffer()).byteLength, 3);
  env.UPLOADER_BUCKET.data.get(`objects/${session.id}`).range = { offset: 0, length: 3 };
  const head = await download({ ...context(`/shared-upload/${session.id}/test.zip`, "HEAD", undefined, false), params: { path: [session.id, "test.zip"] } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Range"), null);
  assert.equal((await item(context(`/api/uploader-item?key=uploader/${session.id}`, "DELETE"))).status, 200);
  assert.equal((await scopedLibraryFiles(context("/"))).length, 0);
});

test("upload completion publishes Description with the file and retries never overwrite a saved description", async () => {
  const { env, context } = await setup();
  const session = await (await upload(context("/api/uploader-upload?action=start", "POST", { name: "unnamed.zip", size: 3 }))).json();
  const part = await (await upload(context(`/api/uploader-upload?id=${session.id}&part=1`, "PUT", new Uint8Array([1, 2, 3])))).json();
  const path = `/api/uploader-upload?action=complete&id=${session.id}`;
  const complete = description => upload(context(path, "POST", { parts: [part], description }));
  const description = "SDK说明：用于DT66集成\nIncludes examples.";
  assert.equal((await complete(`  ${description}  `)).status, 200);
  assert.equal((await complete("Do not replace saved text")).status, 200);
  assert.equal(env.UPLOADER_BUCKET.completions, 1);
  assert.equal(JSON.parse(env.UPLOADER_BUCKET.data.get(`records/${session.id}`)).description, description);
  const publicFiles = await (await filesApi(context("/api/files?query=DT66", "GET", undefined, false))).json();
  assert.equal(publicFiles.count, 1);
  assert.equal(publicFiles.files[0].description, description);
  assert.equal((await (await item(context(`/api/uploader-item?key=uploader/${session.id}`, "GET", undefined, false))).json()).description, description);
});

test("invalid upload descriptions are rejected before completing multipart; exactly 1500 characters succeeds", async () => {
  const { env, context } = await setup();
  const session = await (await upload(context("/api/uploader-upload?action=start", "POST", { name: "limits.zip", size: 3 }))).json();
  const part = await (await upload(context(`/api/uploader-upload?id=${session.id}&part=1`, "PUT", new Uint8Array([1, 2, 3])))).json();
  const complete = description => upload(context(`/api/uploader-upload?action=complete&id=${session.id}`, "POST", { parts: [part], description }));
  for (const description of [null, 42, [], "x".repeat(1501)]) {
    assert.equal((await complete(description)).status, 400);
    assert.equal(env.UPLOADER_BUCKET.completions, 0);
    assert.equal(env.UPLOADER_BUCKET.data.has(`records/${session.id}`), false);
  }
  assert.equal((await complete("x".repeat(1500))).status, 200);
  assert.equal(JSON.parse(env.UPLOADER_BUCKET.data.get(`records/${session.id}`)).description.length, 1500);
});

test("completion retry after record-write failure retains the description without resending the binary", async () => {
  const { env, context } = await setup();
  const session = await (await upload(context("/api/uploader-upload?action=start", "POST", { name: "retry.zip", size: 3 }))).json();
  const part = await (await upload(context(`/api/uploader-upload?id=${session.id}&part=1`, "PUT", new Uint8Array([1, 2, 3])))).json();
  const put = env.UPLOADER_BUCKET.put.bind(env.UPLOADER_BUCKET);
  let failOnce = true;
  env.UPLOADER_BUCKET.put = async (key, body) => {
    if (key.startsWith("records/") && failOnce) { failOnce = false; throw new Error("simulated record write failure"); }
    return put(key, body);
  };
  const complete = () => upload(context(`/api/uploader-upload?action=complete&id=${session.id}`, "POST", { parts: [part], description: "Retain this description" }));
  assert.equal((await complete()).status, 503);
  assert.equal((await scopedLibraryFiles(context("/"))).length, 0);
  assert.equal((await complete()).status, 200);
  assert.equal(env.UPLOADER_BUCKET.completions, 1);
  assert.equal((await scopedLibraryFiles(context("/")))[0].description, "Retain this description");
});

test("large files use multipart without allocating entire file; oversized/path names rejected", async () => {
  const { context } = await setup();
  for (const size of [2 * 1024 ** 3, 3 * 1024 ** 3, MAX_UPLOAD_SIZE]) {
    assert.equal((await upload(context("/api/uploader-upload?action=start", "POST", { name: "large.zip", size }))).status, 200);
  }
  for (const input of [{ name: "too-large.zip", size: MAX_UPLOAD_SIZE + 1 }, { name: "../file", size: 3 }]) {
    assert.equal((await upload(context("/api/uploader-upload?action=start", "POST", input))).status, 400);
  }
});

test("Admin and Uploader receive upload management tokens; wrong passwords do not", async () => {
  const { context, env } = await setup();
  for (const password of [ADMIN_PASSWORD, UPLOADER_PASSWORD]) {
    const result = await (await login(context("/api/admin", "POST", { password }, false))).json();
    assert.equal(result.authorized, true);
    assert.equal(result.role === "uploader", password === UPLOADER_PASSWORD);
    assert.equal(await isUploader(new Request("https://example.com", { headers: { "X-Uploader-Token": result.token } }), env), true);
  }
  assert.equal((await login(context("/api/admin", "POST", { password: "wrong" }, false))).status, 401);
});

test("legacy MCP searches and retrieves uploader file metadata and description without credentials", async () => {
  const { env, context } = await setup();
  const id = crypto.randomUUID();
  await env.UPLOADER_BUCKET.put(`records/${id}`, JSON.stringify({ id, name: "Uploader-PDA-SDK.zip", size: 3, description: "PDA integration SDK" }));
  for (const [name, args] of [["search_files", { query: "PDA" }], ["get_file", { key: `uploader/${id}` }], ["get_description", { key: `uploader/${id}` }]]) {
    const response = await mcp(context("/ai-powered/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, false));
    const result = await response.json();
    assert.notEqual(result.result?.isError, true);
    assert.match(JSON.stringify(result), /PDA integration SDK/);
    assert.match(JSON.stringify(result), /shared-upload/);
  }
});

test("shared AI corpus returns authoritative uploader metadata and comment", async () => {
  const { env, context } = await setup();
  const id = crypto.randomUUID();
  await env.UPLOADER_BUCKET.put(`records/${id}`, JSON.stringify({ id, name: "PDA-SDK.zip", size: 3, description: "PDA integration SDK" }));
  let round = 0;
  const result = await searchLibraryWithPrompt({
    prompt: "PDA SDK", bucket: env.FIRMWARE_BUCKET,
    settings: { baseUrl: "https://example.com", model: "test" }, apiKey: "test",
    loadLibrary: () => scopedLibraryFiles(context("/")),
    fetchImpl: async () => Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: `call-${round}`, type: "function", function: round++ === 0 ? { name: "search_library", arguments: JSON.stringify({ query: "PDA", limit: 20 }) } : { name: "finish", arguments: JSON.stringify({ outcome: "matched", message: "Found SDK", matches: [{ id: `uploader/${id}`, relevance: 95, comment: "PDA SDK package" }] }) } }] } }] }),
  });
  assert.equal(result.matches[0].source, "uploader");
  assert.match(result.matches[0].url, /shared-upload/);
  assert.equal(result.matches[0].description, "PDA integration SDK");
});
