import { isAdminPassword } from "../_lib/admin.js";

const PREFIX = "indexes/github-sdk/";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const authorized = (context) => isAdminPassword(context.request.headers.get("X-Admin-Password"), context.env);

export async function onRequestPost(context) {
  if (!authorized(context)) return json({ error: "Unauthorized." }, 401);
  if (!context.env.SYNC_TOKEN) return json({ error: "SYNC_TOKEN is not configured." }, 503);
  try {
    const origin = String(context.env.SYNC_WORKER_URL || "https://urovo-library-sync.18807737955-70f.workers.dev").replace(/\/$/, "");
    const response = await fetch(`${origin}/sdk-sync`, {
      method: "POST", headers: { Authorization: `Bearer ${context.env.SYNC_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    return json(await response.json(), response.status);
  } catch {
    return json({ error: "Could not reach the SDK Sync Worker." }, 502);
  }
}

export async function onRequestGet(context) {
  if (!authorized(context)) return json({ error: "Unauthorized." }, 401);
  const bucket = context.env.FIRMWARE_BUCKET;
  if (!bucket) return json({ error: "FIRMWARE_BUCKET is not configured." }, 503);
  const object = await bucket.get(`${PREFIX}status.json`);
  const status = object ? await object.json() : { state: "never-run" };
  let audit = null;
  if (typeof status.auditKey === "string" && status.auditKey.startsWith(`${PREFIX}audits/`)) {
    const report = await bucket.get(status.auditKey);
    audit = report ? await report.json() : null;
  }
  return json({ status, audit });
}
