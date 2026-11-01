import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildAuditChanges,
  diffRecords,
  mergeRecords,
  parseCatalog,
  parseDate,
  parseProductDocuments,
  parseSize,
} from "../sync-worker/src/parser.mjs";
import {
  login,
  splitSetCookieHeader,
} from "../sync-worker/src/index.mjs";

const catalogHtml = await readFile(
  new URL("./fixtures/catalog.html", import.meta.url),
  "utf8",
);
const productHtml = await readFile(
  new URL("./fixtures/product.html", import.meta.url),
  "utf8",
);

test("parses categorized product links", () => {
  const result = parseCatalog(catalogHtml);

  assert.equal(result.recognized, true);
  assert.deepEqual(result.products, [
    {
      product: "DT630",
      category: "Mobile Computers",
      sourcePageUrl: "https://file.en.urovo.com/Products/info/114.html",
    },
    {
      product: "DT66",
      category: "Mobile Computers",
      sourcePageUrl: "https://file.en.urovo.com/Products/info/87.html",
    },
    {
      product: "PDA SDK",
      category: "SDK",
      sourcePageUrl: "https://file.en.urovo.com/Products/info/77.html",
    },
  ]);
});

test("catalog structure remains authoritative when shared login text is present", () => {
  const result = parseCatalog(
    catalogHtml.replace("</body>", '<a href="/Login/index.html">Sign in</a></body>'),
  );

  assert.equal(result.recognized, true);
  assert.equal(result.products.length, 3);
});

test("parses product documents and ignores non-download links", () => {
  const observedAt = "2026-08-22T00:00:00.000Z";
  const result = parseProductDocuments(
    productHtml,
    {
      product: "DT630",
      category: "Mobile Computers",
      sourcePageUrl: "https://file.en.urovo.com/Products/info/114.html",
    },
    observedAt,
  );

  assert.equal(result.recognized, true);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].documentType, "Specs");
  assert.equal(result.records[0].name, "DT630_Specs.pdf");
  assert.equal(result.records[0].size, 1572864);
  assert.equal(result.records[0].sourceUpdatedAt, "2026-08-19T16:00:00.000Z");
  assert.match(result.records[0].description, /Product: DT630/);
  assert.equal(
    result.records[1].url,
    "https://file.en.urovo.com/uploads/DT630_Brochure.pdf",
  );
  assert.equal(result.records[1].name, "DT630_Brochure.pdf");
  assert.equal(result.records[1].size, null);
});

test("uses the actual URL filename instead of the product button label", () => {
  const html = productHtml.replace(
    "https://downloads.example.com/DT630_Specs.pdf",
    "https://downloads.example.com/12123rBYC.docx",
  );
  const result = parseProductDocuments(html, {
    product: "DT50Q",
    category: "Mobile Computers",
    sourcePageUrl: "https://file.en.urovo.com/Products/info/72.html",
  });

  assert.equal(result.records[0].name, "12123rBYC.docx");
  assert.match(result.records[0].description, /File: 12123rBYC\.docx/);
});

test("honors an explicit download filename", () => {
  const html = productHtml.replace(
    'href="https://downloads.example.com/DT630_Specs.pdf"',
    'href="https://downloads.example.com/opaque.pdf" download="DT630 Product Specs.pdf"',
  );
  const result = parseProductDocuments(html, {
    product: "DT630",
    category: "Mobile Computers",
    sourcePageUrl: "https://file.en.urovo.com/Products/info/114.html",
  });

  assert.equal(result.records[0].name, "DT630 Product Specs.pdf");
});

test("parses sizes and source dates without inventing missing metadata", () => {
  assert.equal(parseSize(" 2 GB "), 2147483648);
  assert.equal(parseSize("unknown"), null);
  assert.equal(parseDate("updated 2026/8/2 09:30"), "2026-08-02T01:30:00.000Z");
  assert.equal(parseDate("no date"), null);
});

test("merge preserves first seen time and diff detects add update delete", () => {
  const oldRecords = [
    {
      key: "urovo-en/114/specs/a.pdf",
      name: "A.pdf",
      url: "https://old.example/A.pdf",
      product: "DT630",
      documentType: "Specs",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      description: "old",
    },
    {
      key: "urovo-en/114/specs/removed.pdf",
      name: "Removed.pdf",
      url: "https://example.com/removed.pdf",
      product: "DT630",
      documentType: "Specs",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      description: "old",
    },
  ];
  const incoming = [
    {
      ...oldRecords[0],
      url: "https://new.example/A.pdf",
      firstSeenAt: "2026-08-22T00:00:00.000Z",
    },
    {
      key: "urovo-en/114/brochure/new.pdf",
      name: "New.pdf",
      url: "https://example.com/new.pdf",
      product: "DT630",
      documentType: "Brochure",
      firstSeenAt: "2026-08-22T00:00:00.000Z",
    },
  ];

  const merged = mergeRecords(
    incoming,
    oldRecords,
    "2026-08-22T00:00:00.000Z",
  );
  const existing = merged.find((record) => record.name === "A.pdf");

  assert.equal(existing.firstSeenAt, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(diffRecords(oldRecords, merged), {
    added: 1,
    updated: 1,
    deleted: 1,
    unchanged: 0,
  });

  const audit = buildAuditChanges(oldRecords, merged);

  assert.equal(audit.added.length, 1);
  assert.equal(audit.added[0].name, "New.pdf");
  assert.equal(audit.updated.length, 1);
  assert.deepEqual(
    audit.updated[0].changes.find((change) => change.field === "url"),
    {
      field: "url",
      before: "https://old.example/A.pdf",
      after: "https://new.example/A.pdf",
    },
  );
  assert.match(
    audit.updated[0].changes.find(
      (change) => change.field === "description",
    ).after,
    /Product: DT630/,
  );
  assert.equal(audit.deleted.length, 1);
  assert.equal(audit.deleted[0].name, "Removed.pdf");
});

test("unrecognized pages fail closed", () => {
  assert.deepEqual(parseCatalog("<html>login</html>"), {
    recognized: false,
    products: [],
  });
  assert.deepEqual(
    parseProductDocuments("<html>login</html>", {
      product: "DT630",
      category: "Mobile Computers",
      sourcePageUrl: "https://file.en.urovo.com/Products/info/114.html",
    }),
    { recognized: false, records: [] },
  );
});

test("login initializes and reuses the PHP session cookie", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });

    if (requests.length === 1) {
      return new Response("<html>login</html>", {
        headers: { "Set-Cookie": "PHPSESSID=initial-session; Path=/" },
      });
    }

    const response = new Response(
      JSON.stringify({ info: "sign in successfully", status: 1, url: "" }),
      { headers: { "Content-Type": "application/json" } },
    );
    response.headers.append("Set-Cookie", "check_user=test-member; Path=/");
    response.headers.append("Set-Cookie", "check_id=123; Path=/");
    response.headers.append("Set-Cookie", "check_pass=encoded; Path=/");
    response.headers.append("Set-Cookie", "check_group=2; Path=/");
    return response;
  };

  try {
    const cookie = await login({
      UROVO_MEMBER: "test-member",
      UROVO_PASSWORD: "test-password",
    });

    assert.match(cookie, /PHPSESSID=initial-session/);
    assert.match(cookie, /check_user=test-member/);
    assert.match(cookie, /check_id=123/);
    assert.match(cookie, /check_pass=encoded/);
    assert.match(cookie, /check_group=2/);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.headers.Cookie, "PHPSESSID=initial-session");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("splits combined Set-Cookie headers without splitting Expires dates", () => {
  const combined = [
    "check_user=test-member; expires=Sun, 23-Aug-2026 06:00:00 GMT; path=/",
    "check_id=1336; expires=Sun, 23-Aug-2026 06:00:00 GMT; path=/",
    "check_pass=encoded; expires=Sun, 23-Aug-2026 06:00:00 GMT; path=/",
    "check_group=2; expires=Sun, 23-Aug-2026 06:00:00 GMT; path=/",
  ].join(", ");

  assert.deepEqual(
    splitSetCookieHeader(combined).map((value) => value.split(";", 1)[0]),
    [
      "check_user=test-member",
      "check_id=1336",
      "check_pass=encoded",
      "check_group=2",
    ],
  );
});
