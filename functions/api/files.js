import { listToolFiles, PREFIX } from "../_lib/files.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
    },
  });
}

export async function onRequestGet(context) {
  try {
    const bucket = context.env.FIRMWARE_BUCKET;

    if (!bucket) {
      return jsonResponse(
        {
          error: "R2 binding FIRMWARE_BUCKET is not configured.",
        },
        500,
      );
    }

    const files = await listToolFiles(bucket);

    return jsonResponse({
      prefix: PREFIX,
      count: files.length,
      files: files.map(
        ({ key, name, size, uploaded, etag, url, hasDescription }) => ({
          key,
          name,
          size,
          uploaded,
          etag,
          url,
          hasDescription: Boolean(hasDescription),
        }),
      ),
    });
  } catch (error) {
    console.error("Failed to list R2 files:", error);

    return jsonResponse(
      {
        error: "Failed to load files from R2.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
