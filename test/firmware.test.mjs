import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as firmware } from "../functions/api/firmware.js";
import { onRequest as download } from "../functions/shared-upload/[[path]].js";
import { onRequest as item } from "../functions/api/uploader-item.js";
import { firmwareQuery, firmwareProgress } from "../functions/_lib/firmware.js";
import { issueUploaderToken, scopedLibraryFiles } from "../functions/_lib/uploader.js";

const filename = "SQ68_EN_XX_261016_01_rel.zip";
const queryUrl = "/api/firmware?action=find&internal_model=SQ68&date=261016&index=1";
function bucket() {
  const data = new Map();
  return {
    data,
    async put(key, value) { data.set(key, value); },
    async get(key) { const value = data.get(key); return value === undefined ? null : typeof value === "string" ? { json: async () => JSON.parse(value) } : value; },
    async head(key) { return data.get(key) || null; },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
    async list({ prefix }) { return { objects: [...data.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
  };
}

async function setup() {
  const env = { FIRMWARE_API_BASE_URL: "https://mobile.example.test", FIRMWARE_API_TOKEN: "private-test-token", AI_SESSION_SECRET: "test-signing-secret", UPLOADER_BUCKET: bucket(), FIRMWARE_BUCKET: bucket() };
  const token = await issueUploaderToken(env.AI_SESSION_SECRET);
  const calls = [];
  const responses = [];
  env.FIRMWARE_FETCH = async (url, options) => {
    calls.push({ url, options });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected upstream request");
    return response;
  };
  const context = (path, method = "GET", body, authorized = true) => ({ env, request: new Request(`https://files.example.test${path}`, {
    method, headers: { "Content-Type": "application/json", ...(authorized ? { "X-Uploader-Token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }) });
  const request = async (path, method, body, auth) => {
    const response = await firmware(context(path, method, body, auth));
    return { status: response.status, body: await response.json() };
  };
  async function find() {
    responses.push(Response.json({ firmware: [{ filename }] }));
    const found = await request(queryUrl);
    assert.equal(found.status, 200);
    return found.body.searchId;
  }
  function uploadedFile() {
    env.FIRMWARE_BUCKET.data.set(`firmware/${filename}`, { size: 3, etag: "etag", httpEtag: '"etag"', uploaded: new Date("2026-10-16T00:00:00Z"), body: new Uint8Array([65, 66, 67]) });
  }
  return { env, calls, responses, context, request, find, uploadedFile };
}

test("firmware inputs normalize Index and validate actual calendar dates", () => {
  assert.deepEqual(firmwareQuery({ internal_model: " SQ68 ", date: "261016", index: "1" }), { internal_model: "SQ68", date: "261016", index: "01" });
  for (const values of [{ date: "260230" }, { date: "250229" }, { index: "11" }, { internal_model: "../../x" }]) {
    assert.throws(() => firmwareQuery({ internal_model: "SQ68", date: "261016", index: "1", ...values }));
  }
  assert.equal(firmwareQuery({ internal_model: "SQ68", date: "240229", index: "10" }).date, "240229");
});

test("firmware is hidden when unconfigured; access requires a management session and never returns secrets", async () => {
  const h = await setup();
  assert.equal((await h.request("/api/firmware?action=config", "GET", undefined, false)).status, 401);
  assert.deepEqual((await h.request("/api/firmware?action=config")).body, { available: true });
  delete h.env.FIRMWARE_API_TOKEN;
  assert.deepEqual((await h.request("/api/firmware?action=config")).body, { available: false });
  assert.equal((await h.request(queryUrl)).status, 503);
  assert.equal(h.calls.length, 0);
});

test("firmware search uses the mobile RD API and limits starts to verified search candidates", async () => {
  const h = await setup();
  h.responses.push(Response.json({ firmware: [{ filename }, { filename: "SQ68_261016_02.zip" }, { filename: "../SQ68_261016_01.zip" }] }));
  const found = await h.request(queryUrl);
  assert.deepEqual(found.body.files, [{ filename }]);
  assert.match(h.calls[0].url, /internal_model=SQ68&Date=261016&Index=01/);
  assert.equal(h.calls[0].options.headers.Authorization, "Bearer private-test-token");
  assert.equal(h.calls[0].options.redirect, "error");
  const denied = await h.request("/api/firmware?action=start", "POST", { searchId: found.body.searchId, filename: "other.zip" });
  assert.equal(denied.status, 400);
  assert.equal(h.calls.length, 1);
  const status = await h.request("/api/firmware?action=status&id=unrelated-job");
  assert.equal(status.status, 404);
  assert.equal(h.calls.length, 1);
});

test("409 follows only the same firmware job, never another user's different file", async () => {
  const h = await setup();
  const searchId = await h.find();
  h.responses.push(Response.json({ activeJob: { id: "other", status: "running", progress: { detail: { filename: "other.zip" } } } }, { status: 409 }));
  assert.equal((await h.request("/api/firmware?action=start", "POST", { searchId, filename })).status, 409);
  h.responses.push(Response.json({ activeJob: { id: "same", status: "running", progress: { stage: "downloading", detail: { filename } } } }, { status: 409 }));
  const resumed = await h.request("/api/firmware?action=start", "POST", { searchId, filename });
  assert.equal(resumed.body.jobId, "same");
  assert.equal(resumed.body.reused, true);
  assert.equal(resumed.body.stage, "downloading");
});

test("job completion publishes one authoritative record, preserves description, and enables normal search/download/edit", async () => {
  const h = await setup();
  const searchId = await h.find();
  h.responses.push(Response.json({ job: { id: "job-1", type: "mobile-firmware-upload", status: "queued" } }));
  assert.equal((await h.request("/api/firmware?action=start", "POST", { searchId, filename })).status, 200);
  h.responses.push(Response.json({ job: { id: "job-1", status: "running", progress: { stage: "uploading", detail: { bytes: 1, totalBytes: 3, percentage: 33.3, speed: 2, eta: 1, localPath: "private/server/path" } } } }));
  const progress = await h.request("/api/firmware?action=status&id=job-1");
  assert.equal(progress.body.percentage, 33.3);
  assert.equal(JSON.stringify(progress.body).includes("private/server/path"), false);
  h.uploadedFile();
  const success = () => Response.json({ job: { id: "job-1", status: "succeeded", result: { filename, downloadUrl: "https://untrusted.example/file", localPath: "private/server/path" } } });
  h.responses.push(success());
  const finished = await h.request("/api/firmware?action=status&id=job-1");
  assert.equal(finished.status, 200);
  assert.equal(finished.body.state, "succeeded");
  assert.match(finished.body.file.url, /^https:\/\/files.example.test\/shared-upload\//);
  assert.equal(JSON.stringify(finished.body).includes("private-test-token"), false);
  const file = finished.body.file;
  const itemPath = `/api/uploader-item?key=${encodeURIComponent(file.key)}`;
  await item(h.context(itemPath, "PUT", { description: "Manually updated OS note" }));
  h.responses.push(success());
  await h.request("/api/firmware?action=status&id=job-1");
  const files = await scopedLibraryFiles(h.context("/", "GET", undefined, false));
  assert.equal(files.length, 1);
  assert.equal(files[0].description, "Manually updated OS note");
  assert.equal(files[0].product, "SQ68");
  const response = await download({ ...h.context("/", "GET", undefined, false), params: { path: [file.key.split("/")[1], filename] } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ABC");
  assert.equal((await item(h.context(itemPath, "DELETE"))).status, 200);
  assert.equal((await scopedLibraryFiles(h.context("/"))).length, 0);
  assert.ok(await h.env.FIRMWARE_BUCKET.head(`firmware/${filename}`), "removing a library reference must preserve the mobile app's shared firmware");
});

test("already uploaded firmware is reused without creating an upstream job", async () => {
  const h = await setup();
  const searchId = await h.find();
  h.uploadedFile();
  const result = await h.request("/api/firmware?action=start", "POST", { searchId, filename });
  assert.equal(result.body.state, "succeeded");
  assert.equal(result.body.reused, true);
  assert.equal(h.calls.length, 1);
});

test("mismatched completed firmware and missing storage fail closed without publishing files", async () => {
  const h = await setup();
  const searchId = await h.find();
  h.responses.push(Response.json({ job: { id: "job", status: "queued" } }));
  await h.request("/api/firmware?action=start", "POST", { searchId, filename });
  h.responses.push(Response.json({ job: { id: "job", status: "succeeded", result: { filename: "other.zip" } } }));
  assert.equal((await h.request("/api/firmware?action=status&id=job")).status, 502);
  h.responses.push(Response.json({ job: { id: "job", status: "succeeded", result: { filename } } }));
  assert.equal((await h.request("/api/firmware?action=status&id=job")).status, 503);
  assert.equal((await scopedLibraryFiles(h.context("/"))).length, 0);
});

test("remote failures never leak API secrets or raw error bodies", async () => {
  const h = await setup();
  h.responses.push(Response.json({ error: "private-test-token /server/private/path" }, { status: 401 }));
  const response = await h.request(queryUrl);
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.body).includes("private-test-token"), false);
  assert.equal(JSON.stringify(response.body).includes("/server/private/path"), false);
  assert.throws(() => firmwareProgress({ status: "unknown" }));
  assert.deepEqual(firmwareProgress({ status: "running", progress: { stage: "downloading", detail: { transferring: [{ bytes: 5, size: 10, percentage: 50, speed: 1, eta: 5 }] } } }).percentage, 50);
});
