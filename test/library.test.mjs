import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_INDEX_KEY,
  findLibraryFile,
  listLibraryFiles,
  searchLibraryFiles,
  searchAgentLibraryFiles,
  toExternalFile,
} from "../functions/_lib/files.js";

function fakeBucket({ objects = [], manifest = null } = {}) {
  const byKey = new Map(objects.map((object) => [object.key, object]));

  return {
    async get(key) {
      if (key === EXTERNAL_INDEX_KEY && manifest) {
        return { async json() { return manifest; } };
      }

      return byKey.has(key)
        ? { ...byKey.get(key), body: new Uint8Array() }
        : null;
    },
    async head(key) {
      return byKey.get(key) || null;
    },
    async list({ prefix }) {
      return {
        objects: objects.filter((object) => object.key.startsWith(prefix)),
        truncated: false,
      };
    },
  };
}

const externalRecord = {
  key: "urovo-en/114/specs/dt630.pdf",
  name: "DT630 Specs.pdf",
  size: null,
  url: "https://downloads.example.com/DT630.pdf",
  description: "Product: DT630; Type: Specs; File: DT630 Specs.pdf.",
  product: "DT630",
  category: "Mobile Computers",
  documentType: "Specs",
  language: "en",
  sourcePageUrl: "https://file.en.urovo.com/Products/info/114.html",
  firstSeenAt: "2026-08-22T00:00:00.000Z",
};

test("normalizes valid external records and rejects invalid records", () => {
  assert.equal(toExternalFile(externalRecord).external, true);
  assert.equal(toExternalFile({ ...externalRecord, url: "javascript:x" }), null);
  assert.equal(toExternalFile({ ...externalRecord, key: "tools/not-external" }), null);
});

test("merges R2 files with synchronized links", async () => {
  const bucket = fakeBucket({
    objects: [
      {
        key: "tools/local.zip",
        size: 42,
        uploaded: new Date("2026-08-20T00:00:00.000Z"),
        etag: "abc",
        customMetadata: { description: "Local utility" },
      },
    ],
    manifest: { version: 1, records: [externalRecord] },
  });
  const files = await listLibraryFiles(bucket);

  assert.equal(files.length, 2);
  assert.deepEqual(
    new Set(files.map((file) => file.source)),
    new Set(["r2", "urovo-en"]),
  );
});

test("searches structured metadata with AND and backward-compatible OR", () => {
  const files = [toExternalFile(externalRecord)];

  assert.equal(searchLibraryFiles(files, ["DT630", "Specs"], 50, "and").count, 1);
  assert.equal(searchLibraryFiles(files, ["DT630", "Brochure"], 50, "and").count, 0);
  assert.equal(searchLibraryFiles(files, ["DT630", "Brochure"], 50).count, 1);
});

test("agent search normalizes product spaces, hyphens, underscores, and case", () => {
  const files = [
    toExternalFile({
      ...externalRecord,
      key: "urovo-en/114/specs/k388-pro.pdf",
      name: "K388-Pro Specifications.pdf",
      product: "K388 Pro",
    }),
  ];

  for (const query of ["K388Pro", "k388 pro", "K388-Pro", "K388_Pro"]) {
    assert.equal(searchAgentLibraryFiles(files, query, 20, "and").count, 1);
  }
});

test("finds external records by stable key", async () => {
  const bucket = fakeBucket({ manifest: { records: [externalRecord] } });
  const found = await findLibraryFile(bucket, { key: externalRecord.key });

  assert.equal(found.file.url, externalRecord.url);
});
