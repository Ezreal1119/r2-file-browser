import { validateToolKey } from "../_lib/files.js";

const DELETE_PASSWORD = "Patrick1119";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost(context) {
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

    let payload;

    try {
      payload = await context.request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    const password =
      payload && typeof payload.password === "string" ? payload.password : "";

    if (password !== DELETE_PASSWORD) {
      return jsonResponse(
        {
          error: "Unauthorized.",
        },
        401,
      );
    }

    const key = new URL(context.request.url).searchParams.get("key") || "";
    const keyError = validateToolKey(key);

    if (keyError) {
      return jsonResponse({ error: keyError }, 400);
    }

    const existingObject = await bucket.head(key);

    if (!existingObject) {
      return jsonResponse({ error: "File not found." }, 404);
    }

    await bucket.delete(key);

    return jsonResponse({
      key,
      deleted: true,
    });
  } catch (error) {
    console.error("Failed to delete R2 object:", error);

    return jsonResponse(
      {
        error: "Failed to delete file.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
