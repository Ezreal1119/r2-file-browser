import { isUploader, MAX_UPLOAD_SIZE, PART_SIZE, validUploadId, uploaderJson as json } from "../_lib/uploader.js";

export async function onRequest(context) {
  if (!(await isUploader(context.request, context.env))) return json({ error: "Uploader session expired. Unlock again." }, 401);
  const bucket = context.env.UPLOADER_BUCKET;
  if (!bucket) return json({ error: "Uploader storage is unavailable." }, 503);
  const request = context.request;
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.searchParams.get("action") === "start") {
      const payload = await request.json();
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!name || name.length > 240 || /[\x00-\x1f/\\]/.test(name) || !Number.isSafeInteger(payload.size) || payload.size < 1 || payload.size > MAX_UPLOAD_SIZE) return json({ error: "Choose a valid file between 1 byte and 5 GiB." }, 400);
      const id = crypto.randomUUID();
      const multipart = await bucket.createMultipartUpload(`objects/${id}`, { httpMetadata: { contentType: "application/octet-stream" } });
      const session = { id, name, size: payload.size, uploadId: multipart.uploadId, createdAt: Date.now() };
      try {
        await bucket.put(`sessions/${id}`, JSON.stringify(session));
      } catch (error) {
        await multipart.abort();
        throw error;
      }
      return json({ id, partSize: PART_SIZE });
    }
    const id = url.searchParams.get("id");
    if (!validUploadId(id)) return json({ error: "Invalid upload ID." }, 400);
    const sessionObject = await bucket.get(`sessions/${id}`);
    if (!sessionObject) return json({ error: "Upload session not found." }, 404);
    const session = await sessionObject.json();
    const multipart = bucket.resumeMultipartUpload(`objects/${id}`, session.uploadId);
    if (request.method === "DELETE") {
      // Never remove a successfully published upload through the abort endpoint.
      if (!(await bucket.head(`records/${id}`))) {
        if (await bucket.head(`objects/${id}`)) await bucket.delete(`objects/${id}`);
        else await multipart.abort();
      }
      await bucket.delete(`sessions/${id}`);
      return json({ aborted: true });
    }
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) return json({ error: "Upload expired. Start again." }, 410);
    if (request.method === "PUT") {
      const partNumber = Number(url.searchParams.get("part"));
      const count = Math.ceil(session.size / PART_SIZE);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count || !request.body) return json({ error: "Invalid part." }, 400);
      const expectedSize = partNumber === count ? session.size - (count - 1) * PART_SIZE : PART_SIZE;
      if (Number(request.headers.get("Content-Length")) !== expectedSize) return json({ error: "Incorrect part size." }, 400);
      return json(await multipart.uploadPart(partNumber, request.body));
    }
    if (request.method === "POST" && url.searchParams.get("action") === "complete") {
      const existing = await bucket.get(`records/${id}`);
      if (existing) return json({ completed: true, id });
      const { parts, description = "" } = await request.json();
      if (typeof description !== "string" || description.trim().length > 1500) return json({ error: "Description must be at most 1500 characters." }, 400);
      const count = Math.ceil(session.size / PART_SIZE);
      if (!Array.isArray(parts) || parts.length !== count || parts.some((p, i) => p?.partNumber !== i + 1 || typeof p.etag !== "string" || p.etag.length > 128)) return json({ error: "Incomplete upload parts." }, 400);
      // A previous completion may have succeeded even if its HTTP response was lost.
      const object = await bucket.head(`objects/${id}`) || await multipart.complete(parts);
      if (object.size !== session.size) return json({ error: "Uploaded size does not match. Cancel and retry." }, 409);
      await bucket.put(`records/${id}`, JSON.stringify({ id, name: session.name, size: object.size, etag: object.etag, uploaded: object.uploaded.toISOString(), description: description.trim() }));
      return json({ completed: true, id });
    }
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    console.error("Uploader operation failed:", error);
    return json({ error: "Upload could not be completed. Please retry." }, 503);
  }
}
