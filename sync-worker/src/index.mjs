import {
  buildAuditChanges,
  diffRecords,
  mergeRecords,
  parseCatalog,
  parseProductDocuments,
} from "./parser.mjs";
import { pruneDeletedItemPersistence } from "./persistence.mjs";
import { SDK_CRON, SDK_STATUS_KEY, startSdkSync, runSdkSync } from "./sdk-sync.mjs";

const SOURCE_ORIGIN = "https://file.en.urovo.com";
const LOGIN_PAGE_URL = `${SOURCE_ORIGIN}/Login/index.html`;
const LOGIN_URL = `${SOURCE_ORIGIN}/Login/login_submit.html`;
const CATALOG_URL = `${SOURCE_ORIGIN}/Index/index.html`;
const INDEX_KEY = "indexes/urovo-en/files.json";
const STATUS_KEY = "indexes/urovo-en/status.json";
const RUN_PREFIX = "indexes/urovo-en/runs";
const AUDIT_PREFIX = "indexes/urovo-en/audits";
const AUDIT_INDEX_KEY = `${AUDIT_PREFIX}/index.json`;
export const PENDING_CLEANUP_KEY = "settings/pending-sync-cleanup.json";
const PRODUCTS_PER_BATCH = 20;
const RUN_LOCK_MS = 4 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function bearerToken(request) {
  return (request.headers.get("Authorization") || "").match(
    /^Bearer\s+(.+)$/i,
  )?.[1];
}

function requireEnvironment(env) {
  for (const name of [
    "FIRMWARE_BUCKET",
    "SYNC_QUEUE",
    "UROVO_MEMBER",
    "UROVO_PASSWORD",
  ]) {
    if (!env[name]) {
      throw new Error(`${name} is not configured.`);
    }
  }
}

async function readJson(bucket, key, fallback = null) {
  const object = await bucket.get(key);
  return object ? object.json() : fallback;
}

async function writeJson(bucket, key, value) {
  return bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

function auditIndexEntry(audit, auditKey) {
  return {
    runId: audit.runId,
    trigger: audit.trigger,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
    durationMs: audit.durationMs,
    beforeCount: audit.beforeCount,
    afterCount: audit.afterCount,
    summary: audit.summary,
    auditKey,
  };
}

export function splitSetCookieHeader(value) {
  return String(value || "")
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function cookieHeader(response) {
  const explicitValues = response.headers.getSetCookie?.() || [];
  const values = explicitValues.length
    ? explicitValues
    : splitSetCookieHeader(response.headers.get("set-cookie"));

  return values
    .map((value) => value.slice(0, value.indexOf(";") < 0 ? undefined : value.indexOf(";")).trim())
    .filter(Boolean)
    .join("; ");
}

function phpSessionCookie(response) {
  return cookieHeader(response)
    .split(/;\s*/)
    .find((cookie) => cookie.startsWith("PHPSESSID="));
}

function mergeCookies(...headers) {
  const cookies = new Map();

  for (const header of headers) {
    for (const cookie of String(header || "").split(/;\s*/)) {
      const separator = cookie.indexOf("=");

      if (separator <= 0) {
        continue;
      }

      const name = cookie.slice(0, separator).trim();
      const value = cookie.slice(separator + 1).trim();

      if (name && value) {
        cookies.set(name, `${name}=${value}`);
      }
    }
  }

  return [...cookies.values()].join("; ");
}

export async function login(env) {
  const preflightResponse = await fetch(LOGIN_PAGE_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "Urovo-Library-Sync/1.0",
    },
    cache: "no-store",
    redirect: "manual",
  });

  if (!preflightResponse.ok) {
    throw new Error(
      `Login page returned ${preflightResponse.status} during session initialization.`,
    );
  }

  const initialCookie = phpSessionCookie(preflightResponse);

  if (!initialCookie) {
    throw new Error("Login page did not provide a PHP session cookie.");
  }

  await preflightResponse.body?.cancel();

  const body = new URLSearchParams({
    member: env.UROVO_MEMBER,
    password: env.UROVO_PASSWORD,
  });
  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: initialCookie,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Urovo-Library-Sync/1.0",
    },
    body,
    cache: "no-store",
    redirect: "manual",
  });
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Login returned an unexpected response (${response.status}).`);
  }

  if (!response.ok || payload.status !== 1) {
    throw new Error(payload.info || `Login failed (${response.status}).`);
  }

  const cookie = mergeCookies(initialCookie, cookieHeader(response));
  const cookieNames = new Set(
    cookie.split(/;\s*/).map((item) => item.slice(0, item.indexOf("="))),
  );
  const missingCookies = [
    "PHPSESSID",
    "check_user",
    "check_id",
    "check_pass",
    "check_group",
  ].filter((name) => !cookieNames.has(name));

  if (missingCookies.length) {
    throw new Error(
      `Login response omitted authentication cookies: ${missingCookies.join(", ")}.`,
    );
  }

  return cookie;
}

async function fetchAuthenticatedHtml(url, cookie) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Cookie: cookie,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "Urovo-Library-Sync/1.0",
    },
    cache: "no-store",
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Authentication redirect while fetching ${url}.`);
  }

  if (!response.ok) {
    throw new Error(`Upstream returned ${response.status} for ${url}.`);
  }

  return response.text();
}

function chunks(values, size) {
  const result = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

async function setFailure(env, message, runId = null) {
  const previous = await readJson(env.FIRMWARE_BUCKET, STATUS_KEY, {});
  await writeJson(env.FIRMWARE_BUCKET, STATUS_KEY, {
    ...previous,
    state: "failed",
    runId: runId || previous.runId || null,
    failedAt: new Date().toISOString(),
    error: message,
  });
}

export async function retryPendingPersistenceCleanup(env, status) {
  const pending = status?.persistenceCleanup;
  const marker = await readJson(
    env.FIRMWARE_BUCKET,
    PENDING_CLEANUP_KEY,
    null,
  );
  const pendingKeys = Array.isArray(marker?.deletedKeys)
    ? marker.deletedKeys
    : pending?.deletedKeys;

  if (!Array.isArray(pendingKeys) || pendingKeys.length === 0) {
    return status;
  }

  const result = await pruneDeletedItemPersistence(
    env.FIRMWARE_BUCKET,
    pendingKeys,
  );
  const persistenceCleanup = {
    ...result,
    pending: false,
    deletedKeys: pendingKeys,
    resolvedAt: new Date().toISOString(),
    error: null,
  };
  const nextStatus = { ...status, persistenceCleanup };

  if (typeof status?.auditKey === "string") {
    const audit = await readJson(env.FIRMWARE_BUCKET, status.auditKey, null);
    if (audit) {
      await writeJson(env.FIRMWARE_BUCKET, status.auditKey, {
        ...audit,
        persistenceCleanup,
      });
    }
  }

  await env.FIRMWARE_BUCKET.delete(PENDING_CLEANUP_KEY);
  await writeJson(env.FIRMWARE_BUCKET, STATUS_KEY, nextStatus);
  return nextStatus;
}

async function startSync(env, trigger) {
  requireEnvironment(env);
  const now = new Date();
  let status = await readJson(env.FIRMWARE_BUCKET, STATUS_KEY, null);
  const startedAt = status?.startedAt ? new Date(status.startedAt).getTime() : 0;

  if (
    status?.state === "running" &&
    Number.isFinite(startedAt) &&
    now.getTime() - startedAt < RUN_LOCK_MS
  ) {
    return { skipped: true, runId: status.runId, reason: "sync-already-running" };
  }

  status = await retryPendingPersistenceCleanup(env, status);

  const runId = crypto.randomUUID();
  const observedAt = now.toISOString();
  await writeJson(env.FIRMWARE_BUCKET, STATUS_KEY, {
    state: "running",
    runId,
    trigger,
    startedAt: observedAt,
    error: null,
  });

  const cookie = await login(env);
  const catalogUrl = new URL(CATALOG_URL);
  catalogUrl.searchParams.set("_sync", runId);
  const catalogHtml = await fetchAuthenticatedHtml(catalogUrl.href, cookie);
  const catalog = parseCatalog(catalogHtml, SOURCE_ORIGIN);

  if (!catalog.recognized || catalog.products.length === 0) {
    throw new Error("The product catalog structure was not recognized.");
  }

  const productBatches = chunks(catalog.products, PRODUCTS_PER_BATCH);
  const meta = {
    runId,
    trigger,
    observedAt,
    productCount: catalog.products.length,
    totalBatches: productBatches.length,
    previousAuditKey:
      status?.state === "complete" && typeof status.auditKey === "string"
        ? status.auditKey
        : null,
  };

  await writeJson(env.FIRMWARE_BUCKET, `${RUN_PREFIX}/${runId}/meta.json`, meta);
  await env.SYNC_QUEUE.sendBatch(
    productBatches.map((products, batchIndex) => ({
      body: {
        type: "crawl-batch",
        runId,
        batchIndex,
        totalBatches: productBatches.length,
        products,
      },
    })),
  );

  return { runId, productCount: catalog.products.length, batches: productBatches.length };
}

async function fetchProductBatch(env, message) {
  const metaKey = `${RUN_PREFIX}/${message.runId}/meta.json`;
  const meta = await readJson(env.FIRMWARE_BUCKET, metaKey, null);

  if (!meta || meta.runId !== message.runId) {
    throw new Error(`Sync run ${message.runId} is missing its metadata.`);
  }

  const cookie = await login(env);
  const records = [];

  for (const productGroup of chunks(message.products, 4)) {
    const results = await Promise.all(
      productGroup.map(async (product) => {
        const productUrl = new URL(product.sourcePageUrl);
        productUrl.searchParams.set("_sync", message.runId);
        const html = await fetchAuthenticatedHtml(productUrl.href, cookie);
        const parsed = parseProductDocuments(html, product, meta.observedAt);

        if (!parsed.recognized) {
          throw new Error(
            `The document structure was not recognized for ${product.product}.`,
          );
        }

        return parsed.records;
      }),
    );

    records.push(...results.flat());
  }

  await writeJson(
    env.FIRMWARE_BUCKET,
    `${RUN_PREFIX}/${message.runId}/batch-${message.batchIndex}.json`,
    { runId: message.runId, batchIndex: message.batchIndex, records },
  );

  await finalizeIfComplete(env, meta);
}

async function finalizeIfComplete(env, meta) {
  const shardKeys = Array.from(
    { length: meta.totalBatches },
    (_, index) => `${RUN_PREFIX}/${meta.runId}/batch-${index}.json`,
  );
  const shardObjects = await Promise.all(
    shardKeys.map((key) => env.FIRMWARE_BUCKET.get(key)),
  );

  if (shardObjects.some((object) => !object)) {
    return;
  }

  const shards = await Promise.all(shardObjects.map((object) => object.json()));
  const previousManifest = await readJson(env.FIRMWARE_BUCKET, INDEX_KEY, {
    records: [],
  });
  const previousRecords = Array.isArray(previousManifest.records)
    ? previousManifest.records
    : [];
  const nextRecords = mergeRecords(
    shards.flatMap((shard) => shard.records || []),
    previousRecords,
    meta.observedAt,
  );
  const diff = diffRecords(previousRecords, nextRecords);
  const completedAt = new Date().toISOString();
  const auditKey = `${AUDIT_PREFIX}/${meta.runId}.json`;
  const changes = buildAuditChanges(previousRecords, nextRecords);
  const deletedKeys = changes.deleted.map((record) => record.key);
  const previousCleanup = await readJson(
    env.FIRMWARE_BUCKET,
    PENDING_CLEANUP_KEY,
    null,
  );
  const cleanupKeys = [
    ...new Set([
      ...(Array.isArray(previousCleanup?.deletedKeys)
        ? previousCleanup.deletedKeys
        : []),
      ...deletedKeys,
    ]),
  ];
  const audit = {
    version: 1,
    source: "urovo-en",
    runId: meta.runId,
    trigger: meta.trigger,
    startedAt: meta.observedAt,
    completedAt,
    durationMs: Math.max(
      0,
      new Date(completedAt).getTime() - new Date(meta.observedAt).getTime(),
    ),
    beforeCount: previousRecords.length,
    afterCount: nextRecords.length,
    summary: diff,
    changes,
  };

  const auditIndex = await readJson(env.FIRMWARE_BUCKET, AUDIT_INDEX_KEY, {
    version: 1,
    source: "urovo-en",
    reports: [],
  });
  const previousReports = Array.isArray(auditIndex?.reports)
    ? auditIndex.reports
    : [];

  if (
    meta.previousAuditKey &&
    !previousReports.some((report) => report.auditKey === meta.previousAuditKey)
  ) {
    const previousAudit = await readJson(
      env.FIRMWARE_BUCKET,
      meta.previousAuditKey,
      null,
    );

    if (previousAudit?.runId) {
      previousReports.push(
        auditIndexEntry(previousAudit, meta.previousAuditKey),
      );
    }
  }

  const reports = [
    auditIndexEntry(audit, auditKey),
    ...previousReports.filter((report) => report.runId !== meta.runId),
  ].sort((a, b) =>
    String(b.completedAt || "").localeCompare(String(a.completedAt || "")),
  );

  if (cleanupKeys.length > 0) {
    await writeJson(env.FIRMWARE_BUCKET, PENDING_CLEANUP_KEY, {
      version: 1,
      runId: meta.runId,
      deletedKeys: cleanupKeys,
      createdAt: previousCleanup?.createdAt || completedAt,
      updatedAt: completedAt,
    });
  }

  await writeJson(env.FIRMWARE_BUCKET, INDEX_KEY, {
    version: 1,
    source: "urovo-en",
    runId: meta.runId,
    generatedAt: completedAt,
    count: nextRecords.length,
    records: nextRecords,
  });

  let persistenceCleanup;

  try {
    persistenceCleanup = {
      ...(await pruneDeletedItemPersistence(
        env.FIRMWARE_BUCKET,
        cleanupKeys,
      )),
      pending: false,
      deletedKeys: cleanupKeys,
      completedAt: new Date().toISOString(),
      error: null,
    };
    if (cleanupKeys.length > 0) {
      await env.FIRMWARE_BUCKET.delete(PENDING_CLEANUP_KEY);
    }
  } catch (error) {
    console.error(
      "Published sync index but could not clean deleted item persistence:",
      error instanceof Error ? error.message : String(error),
    );
    persistenceCleanup = {
      attempted: cleanupKeys.length,
      labelsRemoved: null,
      descriptionsRemoved: null,
      pending: true,
      deletedKeys: cleanupKeys,
      completedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  audit.persistenceCleanup = persistenceCleanup;
  await writeJson(env.FIRMWARE_BUCKET, auditKey, audit);
  await writeJson(env.FIRMWARE_BUCKET, AUDIT_INDEX_KEY, {
    version: 1,
    source: "urovo-en",
    updatedAt: completedAt,
    count: reports.length,
    reports,
  });
  await writeJson(env.FIRMWARE_BUCKET, STATUS_KEY, {
    state: "complete",
    runId: meta.runId,
    trigger: meta.trigger,
    startedAt: meta.observedAt,
    completedAt,
    productCount: meta.productCount,
    recordCount: nextRecords.length,
    diff,
    auditKey,
    persistenceCleanup,
    error: null,
  });

  await env.FIRMWARE_BUCKET.delete([
    `${RUN_PREFIX}/${meta.runId}/meta.json`,
    ...shardKeys,
  ]);
}

async function handleQueueMessage(env, body) {
  if (body?.type === "start") {
    return startSync(env, body.trigger || "queue");
  }

  if (body?.type === "crawl-batch") {
    return fetchProductBatch(env, body);
  }

  throw new Error("Unknown sync queue message.");
}

export default {
  async scheduled(controller, env, ctx) {
    if (controller.cron === SDK_CRON) {
      ctx.waitUntil(startSdkSync(env, "cron"));
      return;
    }
    requireEnvironment(env);
    ctx.waitUntil(env.SYNC_QUEUE.send({ type: "start", trigger: "cron" }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "urovo-library-sync" });
    }

    if (!["/sync", "/status", "/sdk-sync", "/sdk-status"].includes(url.pathname)) {
      return json({ error: "Not found." }, 404);
    }

    if (!env.SYNC_TOKEN || bearerToken(request) !== env.SYNC_TOKEN) {
      return json({ error: "Unauthorized." }, 401);
    }

    if (request.method === "GET" && url.pathname === "/sdk-status") {
      return json(await readJson(env.FIRMWARE_BUCKET, SDK_STATUS_KEY, { state: "never-run" }));
    }

    if (request.method === "POST" && url.pathname === "/sdk-sync") {
      try {
        return json(await startSdkSync(env), 202);
      } catch (error) {
        return json({ error: "SDK sync could not be started.", detail: error.message }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return json(
        (await readJson(env.FIRMWARE_BUCKET, STATUS_KEY, null)) || {
          state: "never-run",
        },
      );
    }

    if (request.method === "POST" && url.pathname === "/sync") {
      try {
        const result = await startSync(env, "manual");

        return json(
          {
            accepted: !result.skipped,
            alreadyRunning: Boolean(result.skipped),
            ...result,
          },
          202,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await setFailure(env, detail);
        return json({ error: "Sync could not be started.", detail }, 502);
      }
    }

    return json({ error: "Method not allowed." }, 405);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body?.type === "sdk-sync") {
          await runSdkSync(env, message.body.runId, { attempts: message.attempts || 1 });
        } else {
          requireEnvironment(env);
          await handleQueueMessage(env, message.body);
        }
        message.ack();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Urovo sync message failed:", detail);
        if (message.body?.type !== "sdk-sync") await setFailure(env, detail, message.body?.runId);
        if (message.body?.type === "sdk-sync") {
          message.retry({ delaySeconds: Math.min(900, 60 * 2 ** ((message.attempts || 1) - 1)) });
        } else {
          message.retry();
        }
      }
    }
  },
};
