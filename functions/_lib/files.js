export const PREFIX = "tools/";
export const MAX_FILES = 10000;
export const DOWNLOAD_BASE_URL = "https://temp.patrick-shenzhen.org/tools";

export function createDownloadUrl(key) {
  const relativePath = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;

  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${DOWNLOAD_BASE_URL}/${encodedPath}`;
}

export function formatSize(bytes) {
  const size = Number(bytes) || 0;

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function toFileRecord(object) {
  const relativeName = object.key.startsWith(PREFIX)
    ? object.key.slice(PREFIX.length)
    : object.key;

  return {
    key: object.key,
    name: relativeName,
    size: object.size,
    sizeLabel: formatSize(object.size),
    uploaded: object.uploaded ? new Date(object.uploaded).toISOString() : null,
    etag: object.etag,
    url: createDownloadUrl(object.key),
    hasDescription: getDescriptionFromMetadata(object.customMetadata).length > 0,
  };
}

export function toMcpFile(file) {
  return {
    key: file.key,
    name: file.name,
    size: file.size,
    sizeLabel: file.sizeLabel || formatSize(file.size),
    uploaded: file.uploaded,
    url: file.url,
  };
}

export function getDescriptionFromMetadata(customMetadata) {
  if (!customMetadata || typeof customMetadata.description !== "string") {
    return "";
  }

  return customMetadata.description;
}

export function validateToolKey(key) {
  if (!key) {
    return "Missing key.";
  }

  if (!key.startsWith(PREFIX)) {
    return "Object key must be under the configured prefix.";
  }

  if (key.startsWith("/")) {
    return "Object key must not start with '/'.";
  }

  if (key.endsWith("/")) {
    return "Object key must not end with '/'.";
  }

  if (key.includes("\\") || key.includes("..")) {
    return "Invalid object key.";
  }

  if (key.split("/").some((segment) => segment.length === 0)) {
    return "Object key must not contain empty path segments.";
  }

  return "";
}

export function normalizeToolKey(value) {
  const trimmed = String(value || "").trim().replace(/^\/+/, "");

  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith(PREFIX) ? trimmed : `${PREFIX}${trimmed}`;
}

export async function listToolFiles(bucket) {
  const files = [];
  let cursor;

  do {
    const result = await bucket.list({
      prefix: PREFIX,
      cursor,
      include: ["customMetadata"],
      limit: 1000,
    });

    for (const object of result.objects) {
      if (object.key.endsWith("/")) {
        continue;
      }

      files.push(toFileRecord(object));

      if (files.length >= MAX_FILES) {
        break;
      }
    }

    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor && files.length < MAX_FILES);

  files.sort((a, b) => {
    const dateA = a.uploaded ? new Date(a.uploaded).getTime() : 0;
    const dateB = b.uploaded ? new Date(b.uploaded).getTime() : 0;
    return dateB - dateA;
  });

  return files;
}

function normalizeQueryTerms(query) {
  const values = Array.isArray(query) ? query : [query];

  return [
    ...new Set(
      values
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function searchToolFiles(files, query, limit) {
  const terms = normalizeQueryTerms(query);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 50);

  const matches =
    terms.length === 0
      ? files
      : files.filter((file) => {
          const name = file.name.toLowerCase();
          const key = file.key.toLowerCase();

          return terms.some(
            (term) => name.includes(term) || key.includes(term),
          );
        });

  return {
    query: Array.isArray(query)
      ? query.map((value) => String(value || "").trim()).filter(Boolean)
      : String(query || "").trim(),
    terms,
    match: terms.length > 1 ? "or" : "substring",
    count: matches.length,
    files: matches.slice(0, safeLimit).map(toMcpFile),
  };
}

export async function findToolFile(bucket, { key, name } = {}) {
  const keyValue = String(key || "").trim();
  const nameValue = String(name || "").trim();

  const directKeys = [];

  if (keyValue) {
    directKeys.push(normalizeToolKey(keyValue));
  }

  if (nameValue) {
    directKeys.push(normalizeToolKey(nameValue));
  }

  const seen = new Set();

  for (const candidate of directKeys) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);

    if (validateToolKey(candidate)) {
      continue;
    }

    const object = await bucket.head(candidate);

    if (object && !object.key.endsWith("/")) {
      return { file: toFileRecord(object) };
    }
  }

  if (!nameValue) {
    return { error: "File not found." };
  }

  const files = await listToolFiles(bucket);
  const needle = nameValue.toLowerCase();
  const exact = files.filter(
    (file) =>
      file.name.toLowerCase() === needle || file.key.toLowerCase() === needle,
  );

  if (exact.length === 1) {
    return { file: exact[0] };
  }

  if (exact.length > 1) {
    return {
      error: "Multiple files match this name. Pass key instead.",
      matches: exact.slice(0, 10).map(toMcpFile),
    };
  }

  const partial = files.filter((file) => file.name.toLowerCase().includes(needle));

  if (partial.length === 1) {
    return { file: partial[0] };
  }

  if (partial.length > 1) {
    return {
      error: "Multiple files match this name. Pass key instead.",
      matches: partial.slice(0, 10).map(toMcpFile),
    };
  }

  return { error: "File not found." };
}
