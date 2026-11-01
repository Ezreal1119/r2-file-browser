import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAutoLabels,
  normalizeLabelSuggestions,
  previewAutoLabels,
} from "../functions/_lib/auto-labeling.js";
import { LABELS_KEY } from "../functions/_lib/labels.js";

function makeBucket() {
  const objects = new Map([[
    LABELS_KEY,
    { labels: ["SDK", "APK"], assignments: { "tools/already.apk": ["APK"] } },
  ]]);
  const files = ["tools/sdk-release.zip", "tools/unknown.bin", "tools/already.apk"];
  return {
    objects,
    async get(key) {
      const value = objects.get(key);
      return value ? { async json() { return structuredClone(value); } } : null;
    },
    async put(key, body) {
      objects.set(key, JSON.parse(body));
    },
    async list({ prefix }) {
      return {
        objects: files.filter((key) => key.startsWith(prefix)).map((key) => ({
          key,
          size: 1,
          uploaded: new Date("2026-09-15T00:00:00.000Z"),
          etag: key,
          customMetadata: {},
        })),
        truncated: false,
      };
    },
  };
}

function providerResponse(suggestions) {
  return new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{
      function: { name: "propose_labels", arguments: JSON.stringify({ suggestions }) },
    }] } }],
  }), { status: 200 });
}

test("Auto Labeling ignores fabricated IDs, nonexistent labels, and weak guesses", () => {
  const candidates = [
    { key: "tools/sdk-release.zip", name: "sdk-release.zip" },
    { key: "tools/unknown.bin", name: "unknown.bin" },
  ];
  const result = normalizeLabelSuggestions({ suggestions: [
    { key: "tools/sdk-release.zip", label: "SDK", confidence: 96, reason: "SDK in filename" },
    { key: "tools/unknown.bin", label: "APK", confidence: 70, reason: "Maybe an app" },
    { key: "tools/fabricated.zip", label: "SDK", confidence: 100, reason: "Invented" },
  ] }, candidates, ["SDK", "APK"]);
  assert.equal(result.length, 2);
  assert.equal(result[0].label, "SDK");
  assert.equal(result[1].label, null);
});

test("Auto Labeling previews only uploaded files without existing labels", async () => {
  const bucket = makeBucket();
  let providerCalls = 0;
  const suggestions = await previewAutoLabels({
    bucket,
    settings: { baseUrl: "https://api.example.com/v1", model: "test-model" },
    env: { FIRMWARE_BUCKET: bucket, AI_API_KEY: "test-secret" },
    keys: ["tools/sdk-release.zip", "tools/unknown.bin", "tools/already.apk"],
    fetchImpl: async (url, options) => {
      providerCalls += 1;
      assert.equal(url, "https://api.example.com/v1/chat/completions");
      const request = JSON.parse(options.body);
      assert.equal(request.messages[1].content.includes("already.apk"), false);
      return providerResponse([
        { key: "tools/sdk-release.zip", label: "SDK", confidence: 95, reason: "SDK in filename" },
        { key: "tools/unknown.bin", label: null, confidence: 0, reason: "Unknown" },
      ]);
    },
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(suggestions.map(({ key, label }) => ({ key, label })), [
    { key: "tools/sdk-release.zip", label: "SDK" },
    { key: "tools/unknown.bin", label: null },
  ]);
});

test("Auto Labeling apply rechecks existing assignments and available labels", async () => {
  const bucket = makeBucket();
  const result = await applyAutoLabels(bucket, [
    { key: "tools/sdk-release.zip", label: "SDK" },
    { key: "tools/already.apk", label: "SDK" },
    { key: "tools/unknown.bin", label: "Not-a-label" },
    { key: "tools/deleted.zip", label: "SDK" },
  ]);
  assert.deepEqual(result.applied, [{ key: "tools/sdk-release.zip", label: "SDK" }]);
  assert.equal(result.skipped.length, 3);
  assert.deepEqual(bucket.objects.get(LABELS_KEY).assignments["tools/already.apk"], ["APK"]);
  assert.deepEqual(bucket.objects.get(LABELS_KEY).assignments["tools/sdk-release.zip"], ["SDK"]);
  await assert.rejects(
    applyAutoLabels(bucket, [{ key: "urovo-en/1", label: "SDK" }]),
    /Invalid labeling batch/,
  );
});
