import { assignLabelsToFiles, readLabelState } from "./labels.js";
import {
  applyDescriptionOverrides,
  readDescriptionOverrideState,
} from "./description-overrides.js";

export const PREFIX = "tools/";
export const MAX_FILES = 10000;
export const DOWNLOAD_BASE_URL = "https://temp.patrick-shenzhen.org/tools";
export const EXTERNAL_INDEX_KEY = "indexes/urovo-en/files.json";
export const EXTERNAL_STATUS_KEY = "indexes/urovo-en/status.json";

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

  const description = getDescriptionFromMetadata(object.customMetadata);
  const sdk = object.customMetadata?.autoSdk === "1" ? object.customMetadata : null;

  return {
    key: object.key,
    name: sdk?.originalFilename || relativeName,
    size: object.size,
    sizeLabel: formatSize(object.size),
    uploaded: object.uploaded ? new Date(object.uploaded).toISOString() : null,
    etag: object.etag,
    url: createDownloadUrl(object.key),
    hasDescription: description.length > 0,
    description,
    source: "r2",
    external: false,
    displayPath: object.key,
    product: sdk?.product || null,
    category: sdk ? "SDK" : null,
    documentType: sdk ? "SDK" : null,
    language: null,
    sourcePageUrl: sdk?.sdkSourcePage || null,
    sourceUpdatedAt: sdk?.sdkDownloadedAt || null,
    labels: [],
  };
}

export function toMcpFile(file) {
  const result = {
    key: file.key,
    name: file.name,
    size: file.size,
    sizeLabel:
      file.size === null || file.size === undefined
        ? null
        : file.sizeLabel || formatSize(file.size),
    uploaded: file.uploaded,
    url: file.url,
    source: file.source || "r2",
    description: file.description || "",
  };

  for (const field of [
    "product",
    "category",
    "documentType",
    "language",
    "sourcePageUrl",
    "sourceUpdatedAt",
  ]) {
    if (file[field]) {
      result[field] = file[field];
    }
  }

  if (Array.isArray(file.labels) && file.labels.length > 0) {
    result.labels = file.labels;
  }

  return result;
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

function nullableString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function nullableSize(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

export function toExternalFile(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const key = nullableString(record.key);
  const name = nullableString(record.name);
  const url = nullableString(record.url);

  if (!key || !key.startsWith("urovo-en/") || !name || !url) {
    return null;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(parsedUrl.protocol)) {
    return null;
  }

  const description = nullableString(record.description) || "";
  const sourceUpdatedAt = nullableString(record.sourceUpdatedAt);
  const firstSeenAt = nullableString(record.firstSeenAt);
  const uploaded = sourceUpdatedAt || firstSeenAt;
  const size = nullableSize(record.size);
  const product = nullableString(record.product);
  const documentType = nullableString(record.documentType);

  return {
    key,
    name,
    size,
    sizeLabel: size === null ? null : formatSize(size),
    uploaded,
    etag: null,
    url: parsedUrl.href,
    hasDescription: description.length > 0,
    description,
    source: "urovo-en",
    external: true,
    displayPath:
      nullableString(record.displayPath) ||
      [product, documentType, name].filter(Boolean).join(" / "),
    product,
    category: nullableString(record.category),
    documentType,
    language: nullableString(record.language) || "en",
    sourcePageUrl: nullableString(record.sourcePageUrl),
    sourceUpdatedAt,
    firstSeenAt,
    lastSeenAt: nullableString(record.lastSeenAt),
    labels: [],
  };
}

export async function listExternalFiles(bucket) {
  const object = await bucket.get(EXTERNAL_INDEX_KEY);

  if (!object) {
    return [];
  }

  let manifest;

  try {
    manifest = await object.json();
  } catch (error) {
    throw new Error(
      `External index is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const records = Array.isArray(manifest?.records) ? manifest.records : [];
  const files = records.map(toExternalFile).filter(Boolean);

  files.sort((a, b) => {
    const dateA = a.uploaded ? new Date(a.uploaded).getTime() : 0;
    const dateB = b.uploaded ? new Date(b.uploaded).getTime() : 0;
    return dateB - dateA;
  });

  return files;
}

export async function listLibraryFiles(bucket, options = {}) {
  const [toolFiles, externalFiles, labelState, descriptionOverrideState] = await Promise.all([
    listToolFiles(bucket),
    listExternalFiles(bucket),
    options.labelState || readLabelState(bucket),
    readDescriptionOverrideState(bucket),
  ]);

  const files = [
    ...toolFiles,
    ...applyDescriptionOverrides(externalFiles, descriptionOverrideState),
  ].sort((a, b) => {
    const dateA = a.uploaded ? new Date(a.uploaded).getTime() : 0;
    const dateB = b.uploaded ? new Date(b.uploaded).getTime() : 0;
    return dateB - dateA;
  });

  return assignLabelsToFiles(files, labelState);
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

export function normalizeSearchIdentifier(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function agentQueryTerms(query) {
  const values = Array.isArray(query) ? query : [query];
  const terms = [];

  for (const value of values) {
    const text = String(value || "").trim();

    for (const match of text.matchAll(/"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|(\S+)/g)) {
      const term = (match[1] || match[2] || match[3] || match[4] || match[5] || "")
        .trim()
        .toLowerCase();

      if (term && !terms.includes(term)) {
        terms.push(term);
      }
    }
  }

  return terms;
}

function fileSearchFields(file) {
  return [
    file.name,
    file.key,
    file.displayPath,
    file.description,
    file.product,
    file.category,
    file.documentType,
    file.language,
    ...(Array.isArray(file.labels) ? file.labels : []),
  ].map((value) => String(value || "").toLowerCase());
}

export function filterLibraryFiles(files, query, match = "or") {
  const terms = agentQueryTerms(query);
  const matchMode = match === "and" ? "and" : "or";

  if (terms.length === 0) {
    return [...files];
  }

  return files.filter((file) => {
    const fields = fileSearchFields(file);
    const compactFields = fields.map(normalizeSearchIdentifier);
    const termMatches = terms.map((term) => {
      const compactTerm = normalizeSearchIdentifier(term);

      return fields.some((field) => field.includes(term)) ||
        (compactTerm.length >= 2 && compactFields.some(
          (field) => field.includes(compactTerm),
        ));
    });

    return matchMode === "and"
      ? termMatches.every(Boolean)
      : termMatches.some(Boolean);
  });
}

export function searchAgentLibraryFiles(files, query, limit = 20, match = "or") {
  const terms = agentQueryTerms(query);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 20);
  const matchMode = match === "and" ? "and" : "or";
  const scored = [];

  for (const file of files) {
    const fields = fileSearchFields(file);
    const compactFields = fields.map(normalizeSearchIdentifier);
    let score = 0;
    const termMatches = terms.map((term) => {
      const compactTerm = normalizeSearchIdentifier(term);
      const exactField = fields.some((field) => field === term);
      const substring = fields.some((field) => field.includes(term));
      const compact = compactTerm.length >= 2 && compactFields.some(
        (field) => field.includes(compactTerm),
      );

      if (exactField) score += 12;
      else if (substring) score += 7;
      else if (compact) score += 5;

      if (String(file.product || "").toLowerCase() === term) score += 10;
      if (normalizeSearchIdentifier(file.product) === compactTerm) score += 8;

      return exactField || substring || compact;
    });
    const matched = matchMode === "and"
      ? termMatches.every(Boolean)
      : termMatches.some(Boolean);

    if (terms.length > 0 && matched) {
      scored.push({ file, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const dateA = a.file.uploaded ? new Date(a.file.uploaded).getTime() : 0;
    const dateB = b.file.uploaded ? new Date(b.file.uploaded).getTime() : 0;
    return dateB - dateA;
  });

  return {
    query: String(query || "").trim(),
    terms,
    match: terms.length > 1 ? matchMode : "substring",
    count: scored.length,
    files: scored.slice(0, safeLimit).map(({ file }) => file),
  };
}

export function searchToolFiles(files, query, limit, match = "or") {
  const terms = normalizeQueryTerms(query);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 50);
  const matchMode = match === "and" ? "and" : "or";

  const matches =
    terms.length === 0
      ? files
      : files.filter((file) => {
          const fields = [
            file.name,
            file.key,
            file.displayPath,
            file.description,
            file.product,
            file.category,
            file.documentType,
            file.language,
            ...(Array.isArray(file.labels) ? file.labels : []),
          ].map((value) => String(value || "").toLowerCase());
          const matchesTerm = (term) =>
            fields.some((field) => field.includes(term));

          return matchMode === "and"
            ? terms.every(matchesTerm)
            : terms.some(matchesTerm);
        });

  return {
    query: Array.isArray(query)
      ? query.map((value) => String(value || "").trim()).filter(Boolean)
      : String(query || "").trim(),
    terms,
    match: terms.length > 1 ? matchMode : "substring",
    count: matches.length,
    files: matches.slice(0, safeLimit).map(toMcpFile),
  };
}

export const searchLibraryFiles = searchToolFiles;

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

export async function findLibraryFile(bucket, { key, name } = {}, loadLibrary = () => listLibraryFiles(bucket)) {
  const keyValue = String(key || "").trim();
  const nameValue = String(name || "").trim();
  const files = await loadLibrary();

  if (keyValue) {
    const normalizedKey = keyValue.startsWith("urovo-en/") || keyValue.startsWith("uploader/")
      ? keyValue
      : normalizeToolKey(keyValue);
    const exactKey = files.find((file) => file.key === normalizedKey);

    if (exactKey) {
      return { file: exactKey };
    }
  }

  if (!nameValue) {
    return { error: "File not found." };
  }

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

  const partial = files.filter((file) =>
    [file.name, file.key, file.product, file.documentType].some((value) =>
      String(value || "").toLowerCase().includes(needle),
    ),
  );

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
