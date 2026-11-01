import { isAdminPassword } from "../_lib/admin.js";
import { validateToolKey } from "../_lib/files.js";
import { readLabelState, writeLabelState } from "../_lib/labels.js";

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

    if (!isAdminPassword(password, context.env)) {
      return jsonResponse(
        {
          error: "Unauthorized.",
        },
        401,
      );
    }

    const key = new URL(context.request.url).searchParams.get("key") || "";

    if (key.startsWith("urovo-en/")) {
      return jsonResponse(
        { error: "Synchronized links are managed automatically." },
        405,
      );
    }

    const keyError = validateToolKey(key);

    if (keyError) {
      return jsonResponse({ error: keyError }, 400);
    }

    const existingObject = await bucket.head(key);

    if (!existingObject) {
      return jsonResponse({ error: "File not found." }, 404);
    }

    await bucket.delete(key);

    try {
      const labels = await readLabelState(bucket);
      if (labels.assignments[key]) {
        const assignments = { ...labels.assignments };
        delete assignments[key];
        await writeLabelState(bucket, { labels: labels.labels, assignments });
      }
    } catch (error) {
      console.error(
        "Deleted file but could not clean its label assignment:",
        error instanceof Error ? error.message : String(error),
      );
    }

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
