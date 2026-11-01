import { isAdminPassword } from "../_lib/admin.js";
import { EXTERNAL_STATUS_KEY } from "../_lib/files.js";

const DEFAULT_SYNC_WORKER_URL =
  "https://urovo-library-sync.18807737955-70f.workers.dev";
const AUDIT_PREFIX = "indexes/urovo-en/audits/";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function adminPassword(context, payload) {
  return context.request.headers.get("X-Admin-Password") || payload?.password;
}

async function readPayload(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function onRequestPost(context) {
  const payload = await readPayload(context.request);

  if (!isAdminPassword(adminPassword(context, payload), context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  if (!context.env.SYNC_TOKEN) {
    return jsonResponse(
      { error: "The Pages Secret SYNC_TOKEN is not configured." },
      503,
    );
  }

  const workerOrigin = String(
    context.env.SYNC_WORKER_URL || DEFAULT_SYNC_WORKER_URL,
  ).replace(/\/$/, "");
  let response;

  try {
    response = await fetch(`${workerOrigin}/sync`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${context.env.SYNC_TOKEN}`,
      },
    });
  } catch {
    return jsonResponse({ error: "Could not reach the Sync Worker." }, 502);
  }

  let result = {};

  try {
    result = await response.json();
  } catch {
    result = {};
  }

  if (!response.ok) {
    return jsonResponse(
      {
        error: result.error || "Sync Worker rejected the request.",
        detail: result.detail || null,
      },
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }

  return jsonResponse({
    accepted: result.accepted !== false,
    alreadyRunning: Boolean(result.alreadyRunning),
    runId: typeof result.runId === "string" ? result.runId : null,
    productCount:
      Number.isFinite(result.productCount) ? result.productCount : null,
    batches: Number.isFinite(result.batches) ? result.batches : null,
  }, 202);
}

export async function onRequestGet(context) {
  if (!isAdminPassword(adminPassword(context), context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const bucket = context.env.FIRMWARE_BUCKET;

  if (!bucket) {
    return jsonResponse(
      { error: "R2 binding FIRMWARE_BUCKET is not configured." },
      500,
    );
  }

  const statusObject = await bucket.get(EXTERNAL_STATUS_KEY);

  if (!statusObject) {
    return jsonResponse({ status: { state: "never-run" }, audit: null });
  }

  let status;

  try {
    status = await statusObject.json();
  } catch {
    return jsonResponse({ error: "Stored sync status is invalid." }, 500);
  }

  let audit = null;

  if (
    status.state === "complete" &&
    typeof status.auditKey === "string" &&
    status.auditKey.startsWith(AUDIT_PREFIX)
  ) {
    const auditObject = await bucket.get(status.auditKey);

    if (auditObject) {
      try {
        audit = await auditObject.json();
      } catch {
        audit = null;
      }
    }
  }

  return jsonResponse({ status, audit });
}
