// A derived list index stored atomically on the small JSON record, not the binary.
// No separate aggregate document, TTL, cross-node invalidation, or shared writer.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_INDEX_BYTES = 1800; // Leave room under R2's 2 KiB custom-metadata limit.

export function uploaderRecordMetadata(record) {
  const bytes = encoder.encode(JSON.stringify(record));
  if (Math.ceil(bytes.length / 3) * 4 > MAX_INDEX_BYTES) return {};
  return { recordIndex: "1", recordData: btoa(String.fromCharCode(...bytes)) };
}

export function indexedUploaderRecord(object) {
  const metadata = object.customMetadata;
  if (metadata?.recordIndex !== "1" || typeof metadata.recordData !== "string") return null;
  try {
    const record = JSON.parse(decoder.decode(Uint8Array.from(atob(metadata.recordData), c => c.charCodeAt(0))));
    if (`records/${record.id}` !== object.key || typeof record.name !== "string" || !Number.isSafeInteger(record.size) || record.size < 1) return null;
    return record;
  } catch {
    return null;
  }
}

export function putUploaderRecord(bucket, record) {
  return bucket.put(`records/${record.id}`, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: uploaderRecordMetadata(record),
  });
}

export function backfillUploaderRecord(bucket, object, record, waitUntil) {
  const metadata = uploaderRecordMetadata(record);
  if (!object.etag || !metadata.recordIndex || typeof waitUntil !== "function") return;
  // Never let a background backfill overwrite a newer edit or resurrect a deletion.
  waitUntil(bucket.put(`records/${record.id}`, JSON.stringify(record), {
    onlyIf: { etagMatches: object.etag },
    httpMetadata: object.httpMetadata || { contentType: "application/json; charset=utf-8" },
    customMetadata: { ...object.customMetadata, ...metadata },
  }).catch(() => {
    // Best-effort optimization: the canonical JSON remains readable on failure.
    console.warn("Uploader list metadata backfill deferred.");
  }));
}
