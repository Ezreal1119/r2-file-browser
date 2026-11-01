import assert from "node:assert/strict";
import test from "node:test";
import {
  DESCRIPTION_OVERRIDES_KEY,
  LABELS_KEY,
  pruneDeletedItemPersistence,
} from "../sync-worker/src/persistence.mjs";
import {
  PENDING_CLEANUP_KEY,
  retryPendingPersistenceCleanup,
} from "../sync-worker/src/index.mjs";

function memoryBucket(initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
  );

  return {
    async get(key) {
      const value = values.get(key);
      return value
        ? { async json() { return JSON.parse(value); } }
        : null;
    },
    async put(key, value) {
      values.set(key, String(value));
    },
    async delete(key) {
      values.delete(key);
    },
    value(key) {
      const value = values.get(key);
      return value ? JSON.parse(value) : null;
    },
  };
}

const deletedKey = "urovo-en/114/specs/deleted.pdf";
const keptKey = "urovo-en/114/specs/kept.pdf";

test("sync persistence cleanup removes only deleted Delta keys and is idempotent", async () => {
  const bucket = memoryBucket({
    [LABELS_KEY]: {
      version: 1,
      labels: ["Specs"],
      assignments: {
        [deletedKey]: ["Specs"],
        [keptKey]: ["Specs"],
      },
    },
    [DESCRIPTION_OVERRIDES_KEY]: {
      version: 1,
      overrides: {
        [deletedKey]: { description: "Delete me" },
        [keptKey]: { description: "Keep me" },
      },
    },
  });

  const first = await pruneDeletedItemPersistence(bucket, [
    deletedKey,
    deletedKey,
    "tools/local.zip",
  ]);
  assert.deepEqual(first, {
    attempted: 1,
    labelsRemoved: 1,
    descriptionsRemoved: 1,
  });
  assert.deepEqual(bucket.value(LABELS_KEY).assignments, {
    [keptKey]: ["Specs"],
  });
  assert.deepEqual(bucket.value(DESCRIPTION_OVERRIDES_KEY).overrides, {
    [keptKey]: { description: "Keep me" },
  });

  const second = await pruneDeletedItemPersistence(bucket, [deletedKey]);
  assert.deepEqual(second, {
    attempted: 1,
    labelsRemoved: 0,
    descriptionsRemoved: 0,
  });
});

test("pending cleanup retries update both sync status and its audit", async () => {
  const auditKey = "indexes/urovo-en/audits/run-1.json";
  const statusKey = "indexes/urovo-en/status.json";
  const bucket = memoryBucket({
    [LABELS_KEY]: {
      labels: ["Specs"],
      assignments: { [deletedKey]: ["Specs"] },
    },
    [DESCRIPTION_OVERRIDES_KEY]: {
      overrides: { [deletedKey]: { description: "Delete me" } },
    },
    [auditKey]: { runId: "run-1", persistenceCleanup: { pending: true } },
    [PENDING_CLEANUP_KEY]: {
      runId: "run-1",
      deletedKeys: [deletedKey],
    },
  });
  const status = {
    state: "complete",
    runId: "run-1",
    auditKey,
    persistenceCleanup: { pending: true, deletedKeys: [deletedKey] },
  };

  const next = await retryPendingPersistenceCleanup(
    { FIRMWARE_BUCKET: bucket },
    status,
  );

  assert.equal(next.persistenceCleanup.pending, false);
  assert.equal(next.persistenceCleanup.labelsRemoved, 1);
  assert.equal(next.persistenceCleanup.descriptionsRemoved, 1);
  assert.equal(bucket.value(statusKey).persistenceCleanup.pending, false);
  assert.equal(bucket.value(auditKey).persistenceCleanup.pending, false);
  assert.equal(bucket.value(PENDING_CLEANUP_KEY), null);
});
