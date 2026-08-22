import {
  getDescriptionFromMetadata,
  validateToolKey,
} from "../_lib/files.js";

const MAX_DESCRIPTION_LENGTH = 1500;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
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

    const key = new URL(context.request.url).searchParams.get("key") || "";
    const keyError = validateToolKey(key);

    if (keyError) {
      return jsonResponse({ error: keyError }, 400);
    }

    const object = await bucket.head(key);

    if (!object) {
      return jsonResponse({ error: "File not found." }, 404);
    }

    return jsonResponse({
      key,
      description: getDescriptionFromMetadata(object.customMetadata),
    });
  } catch (error) {
    console.error("Failed to read description:", error);

    return jsonResponse(
      {
        error: "Failed to read description.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}

export async function onRequestPut(context) {
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

    const requestUrl = new URL(context.request.url);
    const key = requestUrl.searchParams.get("key") || "";
    const keyError = validateToolKey(key);

    if (keyError) {
      return jsonResponse({ error: keyError }, 400);
    }

    let payload;

    try {
      payload = await context.request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    if (!payload || typeof payload.description !== "string") {
      return jsonResponse(
        {
          error: "Missing description field.",
        },
        400,
      );
    }

    const description = payload.description.trim();

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return jsonResponse(
        {
          error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
        },
        400,
      );
    }

    const object = await bucket.get(key);

    if (!object) {
      return jsonResponse({ error: "File not found." }, 404);
    }

    const customMetadata = {
      ...(object.customMetadata || {}),
      description,
    };

    if (!description) {
      delete customMetadata.description;
    }

    await bucket.put(key, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata,
    });

    return jsonResponse({
      key,
      description,
    });
  } catch (error) {
    console.error("Failed to update description:", error);

    return jsonResponse(
      {
        error: "Failed to update description.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
