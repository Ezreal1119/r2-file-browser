import { isUploader, uploaderId, uploaderJson as json } from "../_lib/uploader.js";
import { readLabelState, writeLabelState } from "../_lib/labels.js";
import { firmwareObjectLocation } from "../_lib/firmware.js";
import { putUploaderRecord } from "../_lib/uploader-records.js";

export async function onRequest(context) {
  if (context.request.method !== "GET" && !(await isUploader(context.request, context.env))) return json({ error: "Uploader session expired. Unlock again." }, 401);
  const bucket = context.env.UPLOADER_BUCKET;
  if (!bucket) return json({ error: "Uploader storage is unavailable." }, 503);
  const id = uploaderId(new URL(context.request.url).searchParams.get("key"));
  if (!id) return json({ error: "Invalid uploader file." }, 400);
  try {
    const stored = await bucket.get(`records/${id}`);
    if (!stored) return json({ error: "File not found." }, 404);
    const record = await stored.json();
    if (context.request.method === "GET") return json({ description: record.description, readOnly: false });
    if (context.request.method === "PUT") {
      const { description } = await context.request.json();
      if (typeof description !== "string" || description.trim().length > 1500) return json({ error: "Description must be at most 1500 characters." }, 400);
      record.description = description.trim();
      await putUploaderRecord(bucket, record);
      return json({ description: record.description });
    }
    if (context.request.method === "DELETE") {
      const labels = await readLabelState(context.env.FIRMWARE_BUCKET);
      const key = `uploader/${id}`;
      if (labels.assignments[key]) {
        delete labels.assignments[key];
        await writeLabelState(context.env.FIRMWARE_BUCKET, labels);
      }
      const location = firmwareObjectLocation(context.env, record);
      // Firmware is also used by the mobile app: removing this reference must not
      // delete its shared source artifact. Local uploads retain their existing behavior.
      if (record.storage !== "firmware") await location.bucket.delete(location.key);
      await bucket.delete([`records/${id}`, `sessions/${id}`]);
      return json({ deleted: true });
    }
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    console.error("Uploader item failed:", error);
    return json({ error: "Could not update uploader file." }, 503);
  }
}
