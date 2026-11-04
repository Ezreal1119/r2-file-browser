import { uploadRecord, validUploadId } from "./uploader.js";
import { putUploaderRecord } from "./uploader-records.js";

export class FirmwareError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function firmwareConfig(env) {
  try {
    const base = new URL(String(env.FIRMWARE_API_BASE_URL || "").trim());
    const token = String(env.FIRMWARE_API_TOKEN || "").trim();
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !token || !env.UPLOADER_BUCKET || !env.FIRMWARE_BUCKET) return null;
    return { base: base.href.replace(/\/+$/, ""), token };
  } catch { return null; }
}

export function firmwareQuery(input) {
  const model = typeof input.internal_model === "string" ? input.internal_model.trim() : "";
  const date = String(input.date || "").trim();
  const index = Number(input.index);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(model)) throw new FirmwareError("Enter a valid internal model, for example SQ68.", 400);
  if (!/^\d{6}$/.test(date)) throw new FirmwareError("Select a valid firmware date.", 400);
  const year = 2000 + Number(date.slice(0, 2)), month = Number(date.slice(2, 4)), day = Number(date.slice(4, 6));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new FirmwareError("Select a valid firmware date.", 400);
  if (!/^\d{1,2}$/.test(String(input.index || "")) || !Number.isInteger(index) || index < 1 || index > 10) throw new FirmwareError("Index must be between 1 and 10.", 400);
  return { internal_model: model, date, index: String(index).padStart(2, "0") };
}

export function validFirmwareName(name) {
  return typeof name === "string" && name.length <= 240 && !/[\x00-\x1f/\\]/.test(name) && !name.includes("..") && /^.+\.zip$/i.test(name);
}

export async function callFirmware(env, path, { body, timeout = 60000 } = {}) {
  const config = firmwareConfig(env);
  if (!config) throw new FirmwareError("Firmware service is not configured.", 503);
  let response;
  let data;
  try {
    response = await (env.FIRMWARE_FETCH || fetch)(config.base + path, {
      method: body ? "POST" : "GET", redirect: "error",
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
    });
    data = await response.json();
  } catch {
    throw new FirmwareError("Could not reach the firmware service. Please try again.", 503);
  }
  if (!response.ok && response.status !== 409) {
    const message = response.status === 401 || response.status === 403
      ? "Firmware service credentials were rejected. Ask the administrator to check the configuration."
      : response.status === 404 ? "The firmware task is no longer available. Please search again."
      : "The firmware service could not complete this request. Please try again.";
    throw new FirmwareError(message, response.status === 404 ? 404 : response.status === 429 ? 429 : 503);
  }
  if (!data || typeof data !== "object") throw new FirmwareError("Invalid firmware service response.");
  return { data, conflict: response.status === 409 };
}

function metric(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : null;
}

export function firmwareProgress(job) {
  const stages = ["queued", "finding", "downloading", "uploading", "succeeded", "failed"];
  const state = job.status;
  if (!["queued", "running", "succeeded", "failed"].includes(state)) throw new FirmwareError("The firmware service returned an unknown task state.");
  const stage = state === "succeeded" || state === "failed" ? state : stages.includes(job.progress?.stage) ? job.progress.stage : "queued";
  const detail = job.progress?.detail || {};
  const transfer = Array.isArray(detail.transferring) ? detail.transferring[0] || {} : {};
  return {
    state, stage,
    bytes: metric(detail.bytes ?? transfer.bytes), totalBytes: metric(detail.totalBytes ?? transfer.size),
    percentage: metric(detail.percentage ?? transfer.percentage, 100),
    speed: metric(detail.speed ?? transfer.speed), eta: metric(detail.eta ?? transfer.eta),
    error: state === "failed" ? "The firmware task failed. Please retry, or ask the administrator to check the firmware service." : null,
  };
}

export function firmwareObjectLocation(env, record) {
  if (record.storage !== "firmware") return { bucket: env.UPLOADER_BUCKET, key: `objects/${record.id}` };
  if (!validFirmwareName(record.name) || record.objectKey !== `firmware/${record.name}` || !env.FIRMWARE_BUCKET) throw new FirmwareError("Invalid firmware record.");
  return { bucket: env.FIRMWARE_BUCKET, key: record.objectKey };
}

export async function registerFirmware(context, filename, query) {
  if (!validFirmwareName(filename)) throw new FirmwareError("Invalid firmware filename.");
  const objectKey = `firmware/${filename}`;
  const object = await context.env.FIRMWARE_BUCKET.head(objectKey);
  if (!object) throw new FirmwareError("The firmware is not yet available in storage. Resume checking shortly.", 503);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`firmware:${filename}`))), b => b.toString(16).padStart(2, "0")).join("");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const stored = await context.env.UPLOADER_BUCKET.get(`records/${id}`);
  const existing = stored ? await stored.json() : null;
  if (existing && (existing.storage !== "firmware" || existing.objectKey !== objectKey)) throw new FirmwareError("Conflicting firmware record.");
  const record = {
    id, name: filename, storage: "firmware", objectKey,
    size: object.size, etag: object.etag, uploaded: object.uploaded.toISOString(),
    product: query.internal_model, category: "Firmware", documentType: "OS",
    description: existing ? existing.description : `Product: ${query.internal_model}; Type: RD PRO OS firmware; File: ${filename}; Firmware date: 20${query.date.slice(0, 2)}-${query.date.slice(2, 4)}-${query.date.slice(4, 6)}; Index: ${query.index}.`,
  };
  if (!existing || existing.etag !== record.etag || existing.size !== record.size) {
    await putUploaderRecord(context.env.UPLOADER_BUCKET, record);
  }
  return uploadRecord(record, new URL(context.request.url).origin);
}

export async function findFirmware(context, input) {
  const query = firmwareQuery(input);
  const params = new URLSearchParams({ internal_model: query.internal_model, Date: query.date, Index: query.index });
  const { data, conflict } = await callFirmware(context.env, `/api/mobile/firmware/internal/rd/find?${params}`, { timeout: 180000 });
  if (conflict || !Array.isArray(data.firmware)) throw new FirmwareError("Invalid firmware search response.");
  const files = [...new Set(data.firmware.map(file => file.filename).filter(name => validFirmwareName(name) && name.toLowerCase().includes(query.internal_model.toLowerCase()) && name.includes(`${query.date}_${query.index}`)))];
  if (files.length > 100) throw new FirmwareError("Too many firmware matches. Refine the search.");
  const searchId = crypto.randomUUID();
  if (files.length) await context.env.UPLOADER_BUCKET.put(`firmware-queries/${searchId}`, JSON.stringify({ query, files, createdAt: Date.now() }));
  return { searchId, files: files.map(filename => ({ filename })) };
}

const validJobId = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

export async function startFirmware(context, input) {
  if (!validUploadId(input.searchId) || !validFirmwareName(input.filename)) throw new FirmwareError("Search for the firmware again before starting a task.", 400);
  const searchObject = await context.env.UPLOADER_BUCKET.get(`firmware-queries/${input.searchId}`);
  const search = searchObject ? await searchObject.json() : null;
  if (!search || Date.now() - search.createdAt > 3600000 || !search.files.includes(input.filename)) throw new FirmwareError("The search has expired. Please search again.", 400);
  if (await context.env.FIRMWARE_BUCKET.head(`firmware/${input.filename}`)) {
    return { state: "succeeded", stage: "succeeded", file: await registerFirmware(context, input.filename, search.query), reused: true };
  }
  const { data, conflict } = await callFirmware(context.env, "/api/mobile/firmware/internal/rd/upload", { body: { filename: input.filename } });
  const job = conflict ? data.activeJob : data.job;
  const activeName = job?.progress?.detail?.filename || job?.result?.filename;
  if (conflict && (typeof activeName !== "string" || activeName.toLowerCase() !== input.filename.toLowerCase())) throw new FirmwareError("Another firmware task is running. Please try again after it finishes.", 409);
  if (!job || !validJobId(job.id) || (job.type && job.type !== "mobile-firmware-upload")) throw new FirmwareError("Invalid firmware task response.");
  const progress = firmwareProgress(job);
  await context.env.UPLOADER_BUCKET.put(`firmware-jobs/${job.id}`, JSON.stringify({ filename: input.filename, query: search.query, createdAt: Date.now() }));
  if (progress.state === "succeeded") return getFirmwareJob(context, job.id);
  return { ...progress, jobId: job.id, filename: input.filename, reused: conflict };
}

export async function getFirmwareJob(context, jobId) {
  if (!validJobId(jobId)) throw new FirmwareError("Invalid firmware task ID.", 400);
  const stored = await context.env.UPLOADER_BUCKET.get(`firmware-jobs/${jobId}`);
  const receipt = stored ? await stored.json() : null;
  if (!receipt || Date.now() - receipt.createdAt > 86400000) throw new FirmwareError("This firmware task has expired. Please search again.", 404);
  let upstream;
  try { upstream = await callFirmware(context.env, `/api/mobile/jobs/${encodeURIComponent(jobId)}`); }
  catch (error) {
    // A service restart can lose the in-memory job after its file reached R2.
    if (error.status === 404 && await context.env.FIRMWARE_BUCKET.head(`firmware/${receipt.filename}`)) {
      return { state: "succeeded", stage: "succeeded", jobId, filename: receipt.filename, file: await registerFirmware(context, receipt.filename, receipt.query) };
    }
    throw error;
  }
  const { data, conflict } = upstream;
  const job = data.job;
  if (conflict || !job || job.id !== jobId || (job.type && job.type !== "mobile-firmware-upload")) throw new FirmwareError("Invalid firmware task response.");
  const progress = firmwareProgress(job);
  let file;
  if (progress.state === "succeeded") {
    if (!validFirmwareName(job.result?.filename) || job.result.filename.toLowerCase() !== receipt.filename.toLowerCase()) throw new FirmwareError("The completed firmware does not match the requested file.");
    file = await registerFirmware(context, job.result.filename, receipt.query);
  }
  return { ...progress, jobId, filename: receipt.filename, file };
}
