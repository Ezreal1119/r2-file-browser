function getObjectKey(params) {
  const path = params.path;

  if (Array.isArray(path)) {
    return path.join("/");
  }

  return String(path || "");
}

function validateKey(key) {
  if (!key) {
    return "Missing object key.";
  }

  if (key.startsWith("/")) {
    return "Invalid object key.";
  }

  if (key.endsWith("/")) {
    return "Invalid object key.";
  }

  if (key.includes("\\") || key.includes("..")) {
    return "Invalid object key.";
  }

  if (key.split("/").some((segment) => segment.length === 0)) {
    return "Invalid object key.";
  }

  return "";
}

function createSafeFilename(key) {
  const filename = key.split("/").pop() || "download";

  return encodeURIComponent(filename)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}

async function getObject(context, options = {}) {
  const bucket = context.env.FIRMWARE_BUCKET;

  if (!bucket) {
    return new Response("R2 binding FIRMWARE_BUCKET is not configured.", {
      status: 500,
    });
  }

  const key = getObjectKey(context.params);
  const keyError = validateKey(key);

  if (keyError) {
    return new Response(keyError, {
      status: 400,
    });
  }

  const object = options.headOnly
    ? await bucket.head(key)
    : await bucket.get(key);

  if (!object) {
    return new Response("File not found", {
      status: 404,
    });
  }

  return { key, object };
}

function createObjectHeaders(key, object) {
  const headers = new Headers();

  object.writeHttpMetadata(headers);

  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${createSafeFilename(key)}`,
  );

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }

  return headers;
}

export async function onRequestGet(context) {
  try {
    const result = await getObject(context);

    if (result instanceof Response) {
      return result;
    }

    const { key, object } = result;

    return new Response(object.body, {
      status: 200,
      headers: createObjectHeaders(key, object),
    });
  } catch (error) {
    console.error("Failed to read R2 object:", error);

    return new Response("Failed to read file.", {
      status: 500,
    });
  }
}

export async function onRequestHead(context) {
  try {
    const result = await getObject(context, {
      headOnly: true,
    });

    if (result instanceof Response) {
      return new Response(null, {
        status: result.status,
      });
    }

    const { key, object } = result;

    return new Response(null, {
      status: 200,
      headers: createObjectHeaders(key, object),
    });
  } catch (error) {
    console.error("Failed to read R2 object metadata:", error);

    return new Response(null, {
      status: 500,
    });
  }
}
