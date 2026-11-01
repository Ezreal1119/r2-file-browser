import { isAdminPassword } from "../_lib/admin.js";
import { EXTERNAL_STATUS_KEY } from "../_lib/files.js";

const AUDIT_PREFIX = "indexes/urovo-en/audits";
const AUDIT_INDEX_KEY = `${AUDIT_PREFIX}/index.json`;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJson(bucket, key, fallback = null) {
  const object = await bucket.get(key);
  return object ? object.json() : fallback;
}

function summaryEntry(audit, auditKey) {
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

export async function onRequestGet(context) {
  if (!isAdminPassword(context.request.headers.get("X-Admin-Password"), context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const bucket = context.env.FIRMWARE_BUCKET;

  if (!bucket) {
    return jsonResponse(
      { error: "R2 binding FIRMWARE_BUCKET is not configured." },
      500,
    );
  }

  const url = new URL(context.request.url);
  const runId = url.searchParams.get("runId");

  if (runId) {
    if (!/^[0-9a-z-]{1,100}$/i.test(runId)) {
      return jsonResponse({ error: "Invalid sync run ID." }, 400);
    }

    const audit = await readJson(
      bucket,
      `${AUDIT_PREFIX}/${runId}.json`,
      null,
    );

    return audit
      ? jsonResponse({ audit })
      : jsonResponse({ error: "Sync report not found." }, 404);
  }

  const [auditIndex, status] = await Promise.all([
    readJson(bucket, AUDIT_INDEX_KEY, { reports: [] }),
    readJson(bucket, EXTERNAL_STATUS_KEY, null),
  ]);
  const reports = Array.isArray(auditIndex?.reports)
    ? [...auditIndex.reports]
    : [];

  if (
    status?.state === "complete" &&
    typeof status.auditKey === "string" &&
    !reports.some((report) => report.runId === status.runId)
  ) {
    const latestAudit = await readJson(bucket, status.auditKey, null);

    if (latestAudit?.runId) {
      reports.push(summaryEntry(latestAudit, status.auditKey));
    }
  }

  reports.sort((a, b) =>
    String(b.completedAt || "").localeCompare(String(a.completedAt || "")),
  );

  return jsonResponse({ count: reports.length, reports });
}
