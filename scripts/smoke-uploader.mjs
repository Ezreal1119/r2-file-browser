// Explicit live smoke test. Creates only its own temporary file and removes it.
import assert from "node:assert/strict";
const { ADMIN_PASSWORD, UPLOADER_PASSWORD } = process.env;
if (!ADMIN_PASSWORD || !UPLOADER_PASSWORD) throw new Error("Set ADMIN_PASSWORD and UPLOADER_PASSWORD in your local environment before running this live smoke test.");
const origin = "https://tool-files.patrick-shenzhen.org";
let id;
let token;
let completed = false;
let name;
async function request(path, { method = "GET", json, bytes, auth = token, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method, signal: AbortSignal.timeout(120000),
    headers: { ...(auth ? { "X-Uploader-Token": auth } : {}), ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
    body: bytes || (json ? JSON.stringify(json) : undefined),
  });
  return response;
}
async function jsonRequest(path, options) {
  const response = await request(path, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${path}: ${response.status} ${body.error || ""}`);
  return body;
}
try {
  const uploader = await jsonRequest("/api/admin", { method: "POST", json: { password: UPLOADER_PASSWORD } });
  assert.equal(uploader.role, "uploader");
  token = uploader.token;
  assert.ok(token);
  name = `codex-uploader-smoke-${crypto.randomUUID()}.bin`;
  const description = `上传说明 smoke-description-${crypto.randomUUID()}\nTemporary description integration test.`;
  const size = 17 * 1024 * 1024;
  const session = await jsonRequest("/api/uploader-upload?action=start", { method: "POST", json: { name, size } });
  id = session.id;
  const parts = [];
  for (let offset = 0; offset < size; offset += session.partSize) {
    const part = parts.length + 1;
    const bytes = new Uint8Array(Math.min(session.partSize, size - offset)).fill(65);
    parts.push(await jsonRequest(`/api/uploader-upload?id=${id}&part=${part}`, { method: "PUT", bytes }));
  }
  await jsonRequest(`/api/uploader-upload?action=complete&id=${id}`, { method: "POST", json: { parts, description } });
  completed = true;
  await jsonRequest(`/api/uploader-upload?action=complete&id=${id}`, { method: "POST", json: { parts, description: "Must not overwrite the original description" } });
  const publicList = await jsonRequest(`/api/files?query=${name}`, { auth: "" });
  assert.equal(publicList.count, 1);
  assert.equal(publicList.files[0].source, "uploader");
  assert.equal(publicList.files[0].size, size);
  assert.equal(publicList.files[0].description, description);
  assert.equal((await jsonRequest(`/api/files?query=${encodeURIComponent(description.split("\n")[0])}`, { auth: "" })).count, 1);
  const itemPath = `/api/uploader-item?key=${encodeURIComponent(`uploader/${id}`)}`;
  assert.equal((await request(itemPath, { method: "PUT", auth: "", json: { description: "forbidden" } })).status, 401);
  const admin = await jsonRequest("/api/admin", { method: "POST", json: { password: ADMIN_PASSWORD }, auth: "" });
  assert.ok(admin.token);
  await jsonRequest(itemPath, { method: "PUT", auth: admin.token, json: { description: "Temporary upload integration smoke test." } });
  assert.equal((await jsonRequest(itemPath, { auth: "" })).description, "Temporary upload integration smoke test.");
  assert.equal((await jsonRequest(`/api/files?query=${name}`, { auth: "" })).files[0].description, "Temporary upload integration smoke test.");
  const path = new URL(publicList.files[0].url).pathname;
  const head = await request(path, { method: "HEAD", auth: "" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("Content-Length")), size);
  const range = await request(path, { auth: "", headers: { Range: "bytes=0-2" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "AAA");
  console.log("PASS: Uploader login, 17 MiB / two-part upload with Description, repeated completion preserves Description, public description search, mutation denial, Admin editing, anonymous HEAD and range download.");
} finally {
  if (id && token) {
    await jsonRequest(completed ? `/api/uploader-item?key=${encodeURIComponent(`uploader/${id}`)}` : `/api/uploader-upload?id=${id}`, { method: "DELETE" });
    if (completed) assert.equal((await jsonRequest(`/api/files?query=${name}`, { auth: "" })).count, 0);
    console.log("Temporary smoke-test upload removed.");
  }
}
