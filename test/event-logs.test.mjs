import assert from "node:assert/strict";
import test from "node:test";
import {
  eventLogsToCsv,
  normalizeEvent,
  normalizePublicFileEvent,
  writeEventLog,
} from "../functions/_lib/event-logs.js";

function recordingDatabase() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          return { sql, values };
        },
      };
    },
    async batch(statements) {
      calls.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

test("public activity logs accept only validated copy and download events", () => {
  assert.deepEqual(
    normalizePublicFileEvent({
      eventType: "copy",
      fileKey: "tools/demo.zip",
      fileName: "demo.zip",
      fileSource: "uploaded",
      aiPrompt: "must not be accepted",
    }),
    {
      eventType: "copy",
      status: "success",
      fileKey: "tools/demo.zip",
      fileName: "demo.zip",
      fileSource: "uploaded",
    },
  );
  assert.equal(
    normalizePublicFileEvent({
      eventType: "ai_search",
      fileKey: "fake",
      fileName: "fake",
    }),
    null,
  );
});

test("event logs are length-limited and written with retention cleanup", async () => {
  const database = recordingDatabase();
  const normalized = normalizeEvent({
    eventType: "ai_search",
    status: "error",
    aiPrompt: "p".repeat(700),
    errorMessage: "provider error",
  });
  assert.equal(normalized.aiPrompt.length, 500);

  await writeEventLog(database, normalized, {
    visitorId: "visitor",
    now: Date.parse("2026-09-12T00:00:00.000Z"),
  });
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].length, 2);
  assert.match(database.calls[0][0].sql, /DELETE FROM event_logs/);
  assert.match(database.calls[0][1].sql, /INSERT INTO event_logs/);
});

test("CSV export keeps every event on one physical line", () => {
  const csv = eventLogsToCsv([
    {
      created_at: Date.parse("2026-09-12T08:00:00.000Z") / 1000,
      event_type: "ai_search",
      status: "success",
      ai_prompt: "line one\nline two",
      ai_response: 'answer with "quotes"\nand a newline',
    },
  ]);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /line one\\nline two/);
  assert.match(lines[1], /""quotes""\\nand a newline/);
});
