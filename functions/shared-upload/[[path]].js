import { validUploadId } from "../_lib/uploader.js";
import { firmwareObjectLocation } from "../_lib/firmware.js";

export async function onRequest(context) {
  if (!["GET", "HEAD"].includes(context.request.method)) return new Response(null, { status: 405 });
  const path = context.params.path;
  const id = Array.isArray(path) ? path[0] : String(path || "").split("/")[0];
  const bucket = context.env.UPLOADER_BUCKET;
  if (!validUploadId(id) || !bucket) return new Response("Not found", { status: 404 });
  const stored = await bucket.get(`records/${id}`);
  if (!stored) return new Response("Not found", { status: 404 });
  const record = await stored.json();
  const location = firmwareObjectLocation(context.env, record);
  const object = context.request.method === "HEAD"
    ? await location.bucket.head(location.key)
    : await location.bucket.get(location.key, { range: context.request.headers });
  if (!object) return new Response("Not found", { status: 404 });
  // R2 may expose range metadata even on HEAD; only an explicit GET range is partial.
  const range = context.request.method === "GET" && context.request.headers.has("Range") ? object.range : null;
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "ETag": object.httpEtag,
    "Content-Length": String(range?.length ?? object.size),
  });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  return new Response(object.body || null, { status: range ? 206 : 200, headers });
}
