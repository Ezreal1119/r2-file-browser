function getObjectKey(params) {
  const path = params.path;

  if (Array.isArray(path)) {
    return path.join("/");
  }

  return String(path || "");
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

  // 只允许访问 tools/ 下面的文件
  if (!key.startsWith("tools/")) {
    return new Response("Forbidden", {
      status: 403,
    });
  }

  if (key.includes("..")) {
    return new Response("Invalid object key", {
      status: 400,
    });
  }

  const object = await bucket.get(key, options);

  if (!object) {
    return new Response("File not found", {
      status: 404,
    });
  }

  return { key, object };
}

export async function onRequestGet(context) {
  try {
    const result = await getObject(context);

    if (result instanceof Response) {
      return result;
    }

    const { key, object } = result;
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

    return new Response(object.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Failed to download R2 object:", error);

    return new Response("Failed to download file.", {
      status: 500,
    });
  }
}

export async function onRequestHead(context) {
  try {
    const bucket = context.env.FIRMWARE_BUCKET;

    if (!bucket) {
      return new Response(null, { status: 500 });
    }

    const key = getObjectKey(context.params);

    if (!key.startsWith("tools/") || key.includes("..")) {
      return new Response(null, { status: 403 });
    }

    const object = await bucket.head(key);

    if (!object) {
      return new Response(null, { status: 404 });
    }

    const headers = new Headers();

    object.writeHttpMetadata(headers);

    headers.set("ETag", object.httpEtag);
    headers.set("Content-Length", String(object.size));
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${createSafeFilename(key)}`,
    );

    return new Response(null, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Failed to read R2 metadata:", error);

    return new Response(null, { status: 500 });
  }
}
