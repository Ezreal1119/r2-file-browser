import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as listFiles } from "../functions/api/files.js";
import {
  onRequestGet as getDescription,
  onRequestPut as putDescription,
} from "../functions/api/description.js";
import { onRequestPost as verifyAdmin } from "../functions/api/admin.js";
import {
  AI_SETTINGS_KEY,
  onRequestGet as getAiSettings,
  onRequestPut as putAiSettings,
} from "../functions/api/ai-settings.js";
import { onRequestGet as getAiConfig } from "../functions/api/ai-config.js";
import {
  onRequestGet as getSyncStatus,
  onRequestPost as startSync,
} from "../functions/api/sync.js";
import { onRequestGet as getSyncReports } from "../functions/api/sync-reports.js";
import {
  onRequestGet as getLabels,
  onRequestPatch as patchLabels,
  onRequestPut as putLabels,
} from "../functions/api/labels.js";
import { onRequest as handleMcp } from "../functions/mcp.js";
import { ADMIN_PASSWORD, TEST_AUTH_ENV } from "./helpers/credentials.mjs";
import {
  EXTERNAL_INDEX_KEY,
  EXTERNAL_STATUS_KEY,
} from "../functions/_lib/files.js";
import { LABELS_KEY } from "../functions/_lib/labels.js";
import { DESCRIPTION_OVERRIDES_KEY } from "../functions/_lib/description-overrides.js";

const externalRecord = {
  key: "urovo-en/114/specs/dt630.pdf",
  name: "DT630 Specs.pdf",
  size: 1024,
  url: "https://downloads.example.com/DT630.pdf",
  description: "Product: DT630; Type: Specs; File: DT630 Specs.pdf.",
  product: "DT630",
  category: "Mobile Computers",
  documentType: "Specs",
  language: "en",
  sourcePageUrl: "https://file.en.urovo.com/Products/info/114.html",
  firstSeenAt: "2026-08-22T00:00:00.000Z",
};

function bucket() {
  const local = {
    key: "tools/local.zip",
    size: 64,
    uploaded: new Date("2026-08-20T00:00:00.000Z"),
    etag: "local-etag",
    customMetadata: { description: "Local package" },
  };

  return {
    async get(key) {
      if (key === EXTERNAL_INDEX_KEY) {
        return { async json() { return { records: [externalRecord] }; } };
      }

      if (key === EXTERNAL_STATUS_KEY) {
        return {
          async json() {
            return {
              state: "complete",
              completedAt: "2026-08-22T06:28:56.310Z",
            };
          },
        };
      }

      return key === local.key ? { ...local, body: new Uint8Array() } : null;
    },
    async head(key) {
      return key === local.key ? local : null;
    },
    async list({ prefix }) {
      return {
        objects: local.key.startsWith(prefix) ? [local] : [],
        truncated: false,
      };
    },
  };
}

function aiEnabledBucket() {
  const base = bucket();
  const get = base.get.bind(base);
  base.get = async (key) => {
    if (key === AI_SETTINGS_KEY) {
      return {
        async json() {
          return {
            baseUrl: "https://api.example.com/v1",
            model: "example-model",
            enabled: true,
          };
        },
      };
    }
    return get(key);
  };
  return base;
}

function bucketWithLabels() {
  const base = bucket();
  const get = base.get.bind(base);
  let labelState = {
    version: 1,
    labels: ["SDK", "POS"],
    assignments: { "tools/local.zip": ["SDK", "POS"] },
  };

  base.get = async (key) => {
    if (key === LABELS_KEY) {
      return { async json() { return structuredClone(labelState); } };
    }
    return get(key);
  };
  base.put = async (key, body) => {
    if (key === LABELS_KEY) labelState = JSON.parse(body);
  };
  base.labelState = () => structuredClone(labelState);
  return base;
}

function bucketWithDescriptionOverrides() {
  const base = bucket();
  const get = base.get.bind(base);
  let overrideState = null;

  base.get = async (key) => {
    if (key === DESCRIPTION_OVERRIDES_KEY && overrideState) {
      return { async json() { return structuredClone(overrideState); } };
    }
    return get(key);
  };
  base.put = async (key, body) => {
    if (key === DESCRIPTION_OVERRIDES_KEY) {
      overrideState = JSON.parse(body);
    }
  };
  base.overrideState = () => structuredClone(overrideState);
  return base;
}

function aiToolResponse(name, args, id = crypto.randomUUID()) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("files API returns a backward-compatible merged list", async () => {
  const response = await listFiles({ env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: bucket() } });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 2);
  assert.equal(payload.sync.state, "complete");
  assert.equal(payload.sync.completedAt, "2026-08-22T06:28:56.310Z");
  assert.equal(payload.files.find((file) => file.external).product, "DT630");
  assert.equal(payload.files.find((file) => !file.external).key, "tools/local.zip");
});

test("files API filters by query and key_word without changing the unfiltered route", async () => {
  const env = { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: bucket() };
  const apkResponse = await listFiles({
    env,
    request: new Request("https://example.com/api/files?key_word=zip"),
  });
  const apkPayload = await apkResponse.json();

  assert.equal(apkPayload.count, 1);
  assert.equal(apkPayload.totalCount, 2);
  assert.equal(apkPayload.query, "zip");
  assert.equal(apkPayload.files[0].key, "tools/local.zip");

  const productResponse = await listFiles({
    env,
    request: new Request(
      "https://example.com/api/files?query=DT630%20Specs&match=and",
    ),
  });
  const productPayload = await productResponse.json();

  assert.equal(productPayload.count, 1);
  assert.equal(productPayload.match, "and");
  assert.equal(productPayload.files[0].product, "DT630");
});

test("labels persist, attach to files, and deleting a label prunes assignments", async () => {
  const labeledBucket = bucketWithLabels();
  const env = { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: labeledBucket };
  const listResponse = await listFiles({ env });
  const listPayload = await listResponse.json();
  assert.deepEqual(
    listPayload.files.find((file) => file.key === "tools/local.zip").labels,
    ["SDK", "POS"],
  );

  const updateResponse = await putLabels({
    env,
    request: new Request("https://example.com/api/labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD, labels: ["SDK"] }),
    }),
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(labeledBucket.labelState().assignments["tools/local.zip"], ["SDK"]);

  const assignResponse = await patchLabels({
    env,
    request: new Request("https://example.com/api/labels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: ADMIN_PASSWORD,
        key: "urovo-en/114/specs/dt630.pdf",
        labels: ["SDK"],
      }),
    }),
  });
  assert.equal(assignResponse.status, 200);
  assert.deepEqual(labeledBucket.labelState().assignments[externalRecord.key], ["SDK"]);

  const publicResponse = await getLabels({ env });
  assert.deepEqual((await publicResponse.json()).labels, ["SDK"]);
});

test("external descriptions support admin overrides and clearing restores the generated fallback", async () => {
  const descriptionBucket = bucketWithDescriptionOverrides();
  const env = { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: descriptionBucket };
  const getResponse = await getDescription({
    env,
    request: new Request(
      `https://example.com/api/description?key=${encodeURIComponent(externalRecord.key)}`,
    ),
  });
  const getPayload = await getResponse.json();

  assert.equal(getPayload.readOnly, false);
  assert.equal(getPayload.overridden, false);
  assert.match(getPayload.description, /DT630/);

  const unauthorizedResponse = await putDescription({
    env,
    request: new Request(
      `https://example.com/api/description?key=${encodeURIComponent(externalRecord.key)}`,
      { method: "PUT", body: JSON.stringify({ description: "changed" }) },
    ),
  });
  assert.equal(unauthorizedResponse.status, 401);

  const putResponse = await putDescription({
    env,
    request: new Request(
      `https://example.com/api/description?key=${encodeURIComponent(externalRecord.key)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          password: ADMIN_PASSWORD,
          description: "Manual DT630 service note",
        }),
      },
    ),
  });
  const putPayload = await putResponse.json();

  assert.equal(putResponse.status, 200);
  assert.equal(putPayload.description, "Manual DT630 service note");
  assert.equal(putPayload.overridden, true);
  assert.equal(
    descriptionBucket.overrideState().overrides[externalRecord.key].description,
    "Manual DT630 service note",
  );

  const listResponse = await listFiles({
    env,
    request: new Request("https://example.com/api/files?query=service%20note"),
  });
  const listPayload = await listResponse.json();
  assert.equal(listPayload.count, 1);
  assert.equal(listPayload.files[0].descriptionOverridden, true);

  const tooLongResponse = await putDescription({
    env,
    request: new Request(
      `https://example.com/api/description?key=${encodeURIComponent(externalRecord.key)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          password: ADMIN_PASSWORD,
          description: "x".repeat(1501),
        }),
      },
    ),
  });
  assert.equal(tooLongResponse.status, 400);

  const clearResponse = await putDescription({
    env,
    request: new Request(
      `https://example.com/api/description?key=${encodeURIComponent(externalRecord.key)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          password: ADMIN_PASSWORD,
          description: "",
        }),
      },
    ),
  });
  const clearPayload = await clearResponse.json();

  assert.equal(clearResponse.status, 200);
  assert.equal(clearPayload.overridden, false);
  assert.equal(clearPayload.description, externalRecord.description);
  assert.equal(
    Object.hasOwn(descriptionBucket.overrideState().overrides, externalRecord.key),
    false,
  );
});

test("admin verification accepts only the configured password", async () => {
  const wrongResponse = await verifyAdmin({
    env: { ...TEST_AUTH_ENV },
    request: new Request("https://example.com/api/admin", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    }),
  });
  const validResponse = await verifyAdmin({
    env: { ...TEST_AUTH_ENV },
    request: new Request("https://example.com/api/admin", {
      method: "POST",
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    }),
  });

  assert.equal(wrongResponse.status, 401);
  assert.equal(validResponse.status, 200);
  assert.deepEqual(await validResponse.json(), { authorized: true });
});

test("R2 description updates require admin verification", async () => {
  const response = await putDescription({
    env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: bucket() },
    request: new Request(
      "https://example.com/api/description?key=tools%2Flocal.zip",
      {
        method: "PUT",
        body: JSON.stringify({ description: "Changed" }),
      },
    ),
  });

  assert.equal(response.status, 401);
});

test("AI settings persist configuration without storing the API key", async () => {
  const objects = new Map();
  const settingsBucket = {
    async get(key) {
      const value = objects.get(key);
      return value
        ? { async json() { return JSON.parse(value); } }
        : null;
    },
    async put(key, value) {
      objects.set(key, value);
    },
  };
  const env = { ...TEST_AUTH_ENV,
    FIRMWARE_BUCKET: settingsBucket,
    AI_API_KEY: "server-secret",
  };
  const saveResponse = await putAiSettings({
    env,
    request: new Request("https://example.com/api/ai-settings", {
      method: "PUT",
      body: JSON.stringify({
        password: ADMIN_PASSWORD,
        baseUrl: "https://api.example.com/v1/",
        model: "example-model",
      }),
    }),
  });
  const readResponse = await getAiSettings({
    env,
    request: new Request("https://example.com/api/ai-settings", {
      headers: { "X-Admin-Password": ADMIN_PASSWORD },
    }),
  });
  const savedObject = JSON.parse(objects.get(AI_SETTINGS_KEY));
  const readPayload = await readResponse.json();

  assert.equal(saveResponse.status, 200);
  assert.equal(savedObject.baseUrl, "https://api.example.com/v1");
  assert.equal(savedObject.model, "example-model");
  assert.equal(savedObject.requireHumanVerification, true);
  assert.equal("apiKey" in savedObject, false);
  assert.equal(readPayload.apiKeyConfigured, true);
  assert.equal("apiKey" in readPayload, false);
});

test("AI defaults disabled and cannot be enabled before infrastructure is ready", async () => {
  const values = new Map();
  const settingsBucket = {
    async get(key) {
      const value = values.get(key);
      return value ? { async json() { return JSON.parse(value); } } : null;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
  const publicResponse = await getAiConfig({
    env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: settingsBucket },
    request: new Request("https://example.com/api/ai-config"),
  });
  const enableResponse = await putAiSettings({
    env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: settingsBucket, AI_API_KEY: "configured" },
    request: new Request("https://example.com/api/ai-settings", {
      method: "PUT",
      body: JSON.stringify({
        password: ADMIN_PASSWORD,
        baseUrl: "https://api.example.com/v1",
        model: "model",
        enabled: true,
      }),
    }),
  });

  assert.deepEqual(await publicResponse.json(), {
    enabled: false,
    ready: false,
    requireHumanVerification: true,
    turnstileSiteKey: "",
  });
  assert.equal(enableResponse.status, 409);
  assert.equal(values.has(AI_SETTINGS_KEY), false);

  const verificationOptionalEnv = {
    ...TEST_AUTH_ENV,
    FIRMWARE_BUCKET: settingsBucket,
    AI_API_KEY: "configured",
    AI_SESSION_SECRET: "session-secret",
    AI_DB: {},
  };
  const optionalEnableResponse = await putAiSettings({
    env: verificationOptionalEnv,
    request: new Request("https://example.com/api/ai-settings", {
      method: "PUT",
      body: JSON.stringify({
        password: ADMIN_PASSWORD,
        baseUrl: "https://api.example.com/v1",
        model: "model",
        enabled: true,
        requireHumanVerification: false,
      }),
    }),
  });
  const optionalPublicResponse = await getAiConfig({
    env: verificationOptionalEnv,
    request: new Request("https://example.com/api/ai-config"),
  });

  assert.equal(optionalEnableResponse.status, 200);
  assert.deepEqual(await optionalPublicResponse.json(), {
    enabled: true,
    ready: true,
    requireHumanVerification: false,
    turnstileSiteKey: "",
  });
});

test("manual sync proxy requires Admin and keeps the Worker token server-side", async () => {
  const originalFetch = globalThis.fetch;
  let workerRequest;

  globalThis.fetch = async (url, options) => {
    workerRequest = { url, options };
    return new Response(
      JSON.stringify({
        accepted: true,
        runId: "run-123",
        productCount: 80,
        batches: 4,
      }),
      { status: 202, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const unauthorized = await startSync({
      env: { ...TEST_AUTH_ENV, SYNC_TOKEN: "worker-secret" },
      request: new Request("https://example.com/api/sync", {
        method: "POST",
        body: JSON.stringify({ password: "wrong" }),
      }),
    });
    const response = await startSync({
      env: { ...TEST_AUTH_ENV, SYNC_TOKEN: "worker-secret" },
      request: new Request("https://example.com/api/sync", {
        method: "POST",
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      }),
    });
    const payload = await response.json();

    assert.equal(unauthorized.status, 401);
    assert.equal(response.status, 202);
    assert.equal(payload.runId, "run-123");
    assert.equal(
      workerRequest.url,
      "https://urovo-library-sync.18807737955-70f.workers.dev/sync",
    );
    assert.equal(
      workerRequest.options.headers.Authorization,
      "Bearer worker-secret",
    );
    assert.equal(JSON.stringify(payload).includes("worker-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual sync status returns the completed run audit", async () => {
  const auditKey = "indexes/urovo-en/audits/run-123.json";
  const values = new Map([
    [
      EXTERNAL_STATUS_KEY,
      {
        state: "complete",
        runId: "run-123",
        completedAt: "2026-08-22T07:00:00.000Z",
        auditKey,
      },
    ],
    [
      auditKey,
      {
        runId: "run-123",
        summary: { added: 1, updated: 2, deleted: 3, unchanged: 4 },
      },
    ],
  ]);
  const response = await getSyncStatus({
    env: { ...TEST_AUTH_ENV,
      FIRMWARE_BUCKET: {
        async get(key) {
          const value = values.get(key);
          return value ? { async json() { return value; } } : null;
        },
      },
    },
    request: new Request("https://example.com/api/sync", {
      headers: { "X-Admin-Password": ADMIN_PASSWORD },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status.runId, "run-123");
  assert.equal(payload.audit.summary.updated, 2);
});

test("Sync Reports list persisted audits and load a selected Delta", async () => {
  const runId = "run-123";
  const auditKey = `indexes/urovo-en/audits/${runId}.json`;
  const audit = {
    runId,
    completedAt: "2026-08-22T07:00:00.000Z",
    beforeCount: 440,
    afterCount: 443,
    summary: { added: 4, updated: 2, deleted: 1, unchanged: 436 },
    changes: { added: [], updated: [], deleted: [] },
  };
  const values = new Map([
    [
      "indexes/urovo-en/audits/index.json",
      { reports: [{ ...audit, auditKey, changes: undefined }] },
    ],
    [auditKey, audit],
  ]);
  const env = { ...TEST_AUTH_ENV,
    FIRMWARE_BUCKET: {
      async get(key) {
        const value = values.get(key);
        return value ? { async json() { return value; } } : null;
      },
    },
  };
  const headers = { "X-Admin-Password": ADMIN_PASSWORD };
  const listResponse = await getSyncReports({
    env,
    request: new Request("https://example.com/api/sync-reports", { headers }),
  });
  const detailResponse = await getSyncReports({
    env,
    request: new Request(
      `https://example.com/api/sync-reports?runId=${runId}`,
      { headers },
    ),
  });
  const listPayload = await listResponse.json();
  const detailPayload = await detailResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.count, 1);
  assert.equal(listPayload.reports[0].summary.deleted, 1);
  assert.equal(detailResponse.status, 200);
  assert.equal(detailPayload.audit.runId, runId);
});

test("MCP searches synchronized product metadata with AND", async () => {
  const request = new Request("https://example.com/ai-powered/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_files",
        arguments: { query: ["DT630", "Specs"], match: "and" },
      },
    }),
  });
  const response = await handleMcp({
    request,
    env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: bucket() },
  });
  const payload = await response.json();
  const result = payload.result.structuredContent;

  assert.equal(result.count, 1);
  assert.equal(result.files[0].source, "urovo-en");
  assert.equal(result.files[0].product, "DT630");
});

test("MCP search_files requires a non-empty query at runtime", async () => {
  for (const argumentsValue of [{}, { query: "   " }, { query: [] }]) {
    const request = new Request("https://example.com/ai-powered/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search_files",
          arguments: argumentsValue,
        },
      }),
    });
    const response = await handleMcp({
      request,
      env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: bucket() },
    });
    const payload = await response.json();

    assert.equal(payload.result.isError, true);
    assert.equal(
      payload.result.structuredContent.error,
      "A non-empty query is required.",
    );
  }
});

test("MCP advertises query as required in the search_files schema", async () => {
  const request = new Request("https://example.com/ai-powered/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    }),
  });
  const response = await handleMcp({
    request,
    env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: bucket() },
  });
  const payload = await response.json();
  const searchTool = payload.result.tools.find(
    (tool) => tool.name === "search_files",
  );

  assert.deepEqual(searchTool.inputSchema.required, ["query"]);
  assert.match(searchTool.description, /non-empty query is required/i);
});

test("MCP exposes only search_with_prompt when AI is enabled", async () => {
  const request = new Request("https://example.com/ai-powered/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
    }),
  });
  const response = await handleMcp({
    request,
    env: { ...TEST_AUTH_ENV,
      FIRMWARE_BUCKET: aiEnabledBucket(),
      AI_API_KEY: "server-secret",
    },
  });
  const payload = await response.json();

  assert.deepEqual(payload.result.tools.map((tool) => tool.name), [
    "search_with_prompt",
  ]);
  assert.deepEqual(payload.result.tools[0].inputSchema.required, ["prompt"]);
  assert.match(payload.result.tools[0].description, /PC tools/i);
  assert.match(payload.result.tools[0].description, /remote R2/i);
  assert.match(payload.result.tools[0].description, /firmware/i);
});

test("MCP search_with_prompt shares the AI path and returns LLM comments", async () => {
  const responses = [
    aiToolResponse("search_library", {
      query: "DT630 Specs",
      match: "and",
      limit: 20,
    }, "search-1"),
    aiToolResponse("finish", {
      outcome: "matched",
      message: "Found the DT630 specification.",
      matches: [{
        id: externalRecord.key,
        relevance: 99,
        comment: "Exact DT630 specification document.",
      }],
    }, "finish-1"),
  ];
  const request = new Request("https://example.com/ai-powered/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "search_with_prompt",
        arguments: { prompt: "我要DT630的规格书" },
      },
    }),
  });
  const response = await handleMcp({
    request,
    env: { ...TEST_AUTH_ENV,
      FIRMWARE_BUCKET: aiEnabledBucket(),
      AI_API_KEY: "server-secret",
      AI_FETCH: async () => responses.shift(),
    },
  });
  const payload = await response.json();
  const result = payload.result.structuredContent;

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].key, externalRecord.key);
  assert.equal(result.matches[0].comment, "Exact DT630 specification document.");
});

test("the old MCP route is closed", async () => {
  const response = await handleMcp({
    request: new Request("https://example.com/mcp"),
    env: { ...TEST_AUTH_ENV, FIRMWARE_BUCKET: bucket() },
  });

  assert.equal(response.status, 404);
});
