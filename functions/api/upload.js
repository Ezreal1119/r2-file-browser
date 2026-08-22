function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1] : "";
}

function validateKey(key) {
  if (!key) {
    return "Missing key.";
  }

  if (key.startsWith("/")) {
    return "Object key must not start with '/'.";
  }

  if (key.endsWith("/")) {
    return "Object key must not end with '/'.";
  }

  if (key.includes("\\")) {
    return "Object key must not contain backslashes.";
  }

  if (key.includes("..")) {
    return "Object key must not contain '..'.";
  }

  if (key.split("/").some((segment) => segment.length === 0)) {
    return "Object key must not contain empty path segments.";
  }

  return "";
}

function createPublicUrl(request, key) {
  const url = new URL(request.url);
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${url.origin}/file/${encodedKey}`;
}

async function authorize(context) {
  const expectedToken = context.env.UPLOAD_TOKEN;

  if (!expectedToken) {
    return jsonResponse(
      {
        error: "UPLOAD_TOKEN is not configured.",
      },
      500,
    );
  }

  const token = getBearerToken(context.request);

  if (!token || token !== expectedToken) {
    return jsonResponse(
      {
        error: "Unauthorized.",
      },
      401,
    );
  }

  return null;
}

export async function onRequestPut(context) {
  try {
    const authError = await authorize(context);

    if (authError) {
      return authError;
    }

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
    const keyError = validateKey(key);

    if (keyError) {
      return jsonResponse(
        {
          error: keyError,
        },
        400,
      );
    }

    if (!context.request.body) {
      return jsonResponse(
        {
          error: "Request body is required.",
        },
        400,
      );
    }

    const shouldOverwrite = requestUrl.searchParams.get("overwrite") === "1";

    if (!shouldOverwrite) {
      const existingObject = await bucket.head(key);

      if (existingObject) {
        return jsonResponse(
          {
            error: "Object already exists.",
            key,
          },
          409,
        );
      }
    }

    const contentType =
      context.request.headers.get("Content-Type") || "application/octet-stream";

    const object = await bucket.put(key, context.request.body, {
      httpMetadata: {
        contentType,
      },
    });

    return jsonResponse(
      {
        key,
        size: object.size,
        etag: object.etag,
        url: createPublicUrl(context.request, key),
      },
      201,
    );
  } catch (error) {
    console.error("Failed to upload R2 object:", error);

    return jsonResponse(
      {
        error: "Failed to upload file.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
