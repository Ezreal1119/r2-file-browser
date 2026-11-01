const PRODUCT_PATH_PATTERN = /^\/Products\/info\/\d+\.html$/i;

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function stripHtml(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function classPattern(className) {
  return new RegExp(
    `<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
    "gi",
  );
}

function sliceAtClass(html, className) {
  const matcher = classPattern(className);
  const match = matcher.exec(html);
  return match ? html.slice(match.index) : "";
}

function splitAtClass(html, className) {
  const matcher = classPattern(className);
  const indexes = [];
  let match;

  while ((match = matcher.exec(html)) !== null) {
    indexes.push(match.index);
  }

  return indexes.map((start, index) =>
    html.slice(start, indexes[index + 1] ?? html.length),
  );
}

function extractTextByClass(html, className) {
  const matcher = new RegExp(
    `<([a-z0-9]+)[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  const match = matcher.exec(html);
  return match ? stripHtml(match[2]) : "";
}

function getAttribute(attributes, name) {
  const matcher = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = matcher.exec(attributes);
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function extractLinks(html) {
  const links = [];
  const matcher = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = matcher.exec(html)) !== null) {
    const href = getAttribute(match[1], "href");

    if (!href) {
      continue;
    }

    links.push({
      href,
      text: stripHtml(match[2]),
      className: getAttribute(match[1], "class"),
      download: getAttribute(match[1], "download"),
      rawText: stripHtml(match[0]),
    });
  }

  return links;
}

function safeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function productIdFromUrl(url) {
  const match = url.pathname.match(/\/Products\/info\/(\d+)\.html/i);
  return match?.[1] || "product";
}

function keySegment(value) {
  return encodeURIComponent(
    String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase(),
  );
}

function fileNameFromLink(link, url) {
  if (link.download && !/^download$/i.test(link.download)) {
    return link.download.trim();
  }

  const lastSegment = url.pathname.split("/").filter(Boolean).pop() || "download";

  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

export function parseSize(value) {
  const match = String(value || "").match(
    /(?:^|\s)(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)(?:\s|$)/i,
  );

  if (!match) {
    return null;
  }

  const units = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Math.round(Number(match[1]) * 1024 ** units[match[2].toUpperCase()]);
}

export function parseDate(value) {
  const match = String(value || "").match(
    /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour = "00", minute = "00", second = "00"] =
    match;
  const date = new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`,
  );

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseCatalog(html, baseUrl = "https://file.en.urovo.com/") {
  const section = sliceAtClass(html, "down-list");

  if (!section) {
    return { recognized: false, products: [] };
  }

  const products = [];
  const seen = new Set();

  for (const column of splitAtClass(section, "column")) {
    const category = extractTextByClass(column, "name") || "Product Documents";

    for (const link of extractLinks(column)) {
      const url = safeUrl(link.href, baseUrl);

      if (!url || !PRODUCT_PATH_PATTERN.test(url.pathname) || seen.has(url.href)) {
        continue;
      }

      const product = link.text.trim();

      if (!product) {
        continue;
      }

      seen.add(url.href);
      products.push({ product, category, sourcePageUrl: url.href });
    }
  }

  return { recognized: true, products };
}

export function buildDescription(record) {
  const parts = [
    `Product: ${record.product}`,
    record.category ? `Category: ${record.category}` : null,
    record.documentType ? `Type: ${record.documentType}` : null,
    `File: ${record.name}`,
    record.sourceUpdatedAt
      ? `Updated: ${record.sourceUpdatedAt.slice(0, 10)}`
      : record.firstSeenAt
        ? `First indexed: ${record.firstSeenAt.slice(0, 10)}`
        : null,
    "Language: English",
  ];

  return `${parts.filter(Boolean).join("; ")}.`;
}

export function parseProductDocuments(
  html,
  productInfo,
  observedAt = new Date().toISOString(),
) {
  const section = sliceAtClass(html, "down-list2");

  if (!section) {
    return { recognized: false, records: [] };
  }

  const sourcePage = new URL(productInfo.sourcePageUrl);
  const productId = productIdFromUrl(sourcePage);
  const records = [];
  const seen = new Set();

  for (const column of splitAtClass(section, "column")) {
    const documentType = extractTextByClass(column, "name") || "Document";

    for (const link of extractLinks(column)) {
      if (link.className && !link.className.split(/\s+/).includes("item")) {
        continue;
      }

      const url = safeUrl(link.href, sourcePage);

      if (
        !url ||
        PRODUCT_PATH_PATTERN.test(url.pathname) ||
        /^javascript:/i.test(link.href) ||
        link.href.startsWith("#")
      ) {
        continue;
      }

      const name = fileNameFromLink(link, url);

      if (!name) {
        continue;
      }

      const key = `urovo-en/${productId}/${keySegment(documentType)}/${keySegment(name)}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      const record = {
        key,
        name,
        size: parseSize(link.rawText),
        url: url.href,
        source: "urovo-en",
        product: productInfo.product,
        category: productInfo.category,
        documentType,
        language: "en",
        sourcePageUrl: sourcePage.href,
        sourceUpdatedAt: parseDate(link.rawText),
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        displayPath: [productInfo.product, documentType, name].join(" / "),
      };

      record.description = buildDescription(record);
      records.push(record);
    }
  }

  return { recognized: true, records };
}

export function mergeRecords(records, previousRecords = [], observedAt) {
  const previous = new Map(previousRecords.map((record) => [record.key, record]));
  const merged = new Map();

  for (const record of records) {
    const old = previous.get(record.key);
    const next = {
      ...record,
      firstSeenAt: old?.firstSeenAt || record.firstSeenAt || observedAt,
      lastSeenAt: observedAt,
    };

    next.description = buildDescription(next);
    merged.set(next.key, next);
  }

  return [...merged.values()].sort((a, b) =>
    `${a.product}\u0000${a.documentType}\u0000${a.name}`.localeCompare(
      `${b.product}\u0000${b.documentType}\u0000${b.name}`,
      "en",
      { sensitivity: "base" },
    ),
  );
}

export function diffRecords(previousRecords, nextRecords) {
  const previous = new Map(previousRecords.map((record) => [record.key, record]));
  const next = new Map(nextRecords.map((record) => [record.key, record]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  const comparable = (record) =>
    JSON.stringify({
      name: record.name,
      size: record.size ?? null,
      url: record.url,
      product: record.product,
      category: record.category,
      documentType: record.documentType,
      sourceUpdatedAt: record.sourceUpdatedAt ?? null,
      description: record.description,
    });

  for (const [key, record] of next) {
    const old = previous.get(key);

    if (!old) {
      added += 1;
    } else if (comparable(old) !== comparable(record)) {
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  return {
    added,
    updated,
    deleted: [...previous.keys()].filter((key) => !next.has(key)).length,
    unchanged,
  };
}

const AUDIT_FIELDS = [
  "name",
  "product",
  "category",
  "documentType",
  "url",
  "size",
  "sourceUpdatedAt",
  "description",
];

function auditSnapshot(record) {
  return {
    key: record.key,
    name: record.name,
    product: record.product || null,
    category: record.category || null,
    documentType: record.documentType || null,
    url: record.url,
    size: record.size ?? null,
    sourceUpdatedAt: record.sourceUpdatedAt ?? null,
    description: record.description || "",
  };
}

export function buildAuditChanges(previousRecords, nextRecords) {
  const previous = new Map(previousRecords.map((record) => [record.key, record]));
  const next = new Map(nextRecords.map((record) => [record.key, record]));
  const added = [];
  const updated = [];
  const deleted = [];

  for (const [key, record] of next) {
    const old = previous.get(key);

    if (!old) {
      added.push(auditSnapshot(record));
      continue;
    }

    const changes = [];

    for (const field of AUDIT_FIELDS) {
      const before = old[field] ?? null;
      const after = record[field] ?? null;

      if (before !== after) {
        changes.push({ field, before, after });
      }
    }

    if (changes.length) {
      updated.push({
        key,
        name: record.name,
        product: record.product || null,
        documentType: record.documentType || null,
        changes,
      });
    }
  }

  for (const [key, record] of previous) {
    if (!next.has(key)) {
      deleted.push(auditSnapshot(record));
    }
  }

  const byIdentity = (a, b) =>
    `${a.product || ""}\u0000${a.documentType || ""}\u0000${a.name || ""}`.localeCompare(
      `${b.product || ""}\u0000${b.documentType || ""}\u0000${b.name || ""}`,
      "en",
      { sensitivity: "base" },
    );

  added.sort(byIdentity);
  updated.sort(byIdentity);
  deleted.sort(byIdentity);

  return { added, updated, deleted };
}
