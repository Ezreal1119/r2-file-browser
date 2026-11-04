import { listLibraryFiles } from "./files.js";
import { readLabelState, assignLabelsToFiles } from "./labels.js";
import { indexedUploaderRecord, backfillUploaderRecord } from "./uploader-records.js";

export function isUploaderPassword(value, env) {
  const expected = env?.UPLOADER_PASSWORD;
  return typeof expected === "string" && expected.length > 0 && typeof value === "string" && value === expected;
}
export const PART_SIZE = 16 * 1024 * 1024;
export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;
const encoder = new TextEncoder();

async function signingKey(secret) {
  if (!secret) throw new Error("Uploader signing secret is not configured.");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueUploaderToken(secret) {
  const payload = `${Date.now() + 24 * 60 * 60 * 1000}.${crypto.randomUUID()}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload)));
  return `${payload}.${Array.from(signature, b => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function isUploader(request, env) {
  const token = request?.headers?.get("X-Uploader-Token") || "";
  const [expires, nonce, signature, extra] = token.split(".");
  if (extra || !/^\d+$/.test(expires || "") || Number(expires) <= Date.now() || !validUploadId(nonce) || !/^[a-f0-9]{64}$/.test(signature || "") || !env.AI_SESSION_SECRET) return false;
  return crypto.subtle.verify("HMAC", await signingKey(env.AI_SESSION_SECRET), Uint8Array.from(signature.match(/../g), b => parseInt(b, 16)), encoder.encode(`${expires}.${nonce}`));
}

export function validUploadId(id) {
  return typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
}

export function uploaderId(key) {
  const id = typeof key === "string" ? key.replace(/^uploader\//, "") : "";
  return key?.startsWith("uploader/") && validUploadId(id) ? id : null;
}

export function uploadRecord(record, origin) {
  return {
    key: `uploader/${record.id}`, name: record.name, size: record.size,
    uploaded: record.uploaded, etag: record.etag, source: "uploader", external: false,
    description: record.description || "", hasDescription: Boolean(record.description), labels: [],
    displayPath: `Uploader / ${record.storage === "firmware" ? "Firmware / " : ""}${record.name}`,
    ...(record.storage === "firmware" ? { originType: "firmware", product: record.product, category: record.category, documentType: record.documentType } : {}),
    url: `${origin}/shared-upload/${record.id}/${encodeURIComponent(record.name)}`,
  };
}

export async function listUploaderFiles(bucket, origin, waitUntil) {
  if (!bucket) throw new Error("Uploader storage is unavailable.");
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: "records/", cursor, include: ["customMetadata"] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const records = new Map();
  const fallback = [];
  for (const object of objects) {
    const indexed = indexedUploaderRecord(object);
    if (indexed) records.set(object.key, indexed);
    else fallback.push(object);
  }
  // Only legacy/oversized records need bounded individual reads.
  for (let i = 0; i < fallback.length; i += 10) {
    const batch = await Promise.all(fallback.slice(i, i + 10).map(async object => {
      const value = await bucket.get(object.key);
      if (!value) return null;
      const record = await value.json();
      if (`records/${record.id}` === object.key) backfillUploaderRecord(bucket, value, record, waitUntil);
      return { key: object.key, record };
    }));
    for (const entry of batch.filter(Boolean)) records.set(entry.key, entry.record);
  }
  return objects.map(object => records.get(object.key)).filter(Boolean).map(record => uploadRecord(record, origin));
}

export async function librarySnapshot(context) {
  const labelStatePromise = readLabelState(context.env.FIRMWARE_BUCKET);
  const [files, uploads, labelState] = await Promise.all([
    listLibraryFiles(context.env.FIRMWARE_BUCKET, { labelState: labelStatePromise }),
    context.env.UPLOADER_BUCKET
      ? listUploaderFiles(context.env.UPLOADER_BUCKET, new URL(context.request.url).origin, typeof context.waitUntil === "function" ? context.waitUntil.bind(context) : undefined)
      : [],
    labelStatePromise,
  ]);
  return { files: files.concat(assignLabelsToFiles(uploads, labelState)), labels: labelState.labels };
}

export async function scopedLibraryFiles(context) {
  return (await librarySnapshot(context)).files;
}

export function uploaderJson(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}
