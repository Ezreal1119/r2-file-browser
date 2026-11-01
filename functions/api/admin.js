import { isAdminPassword } from "../_lib/admin.js";
import { isUploaderPassword, issueUploaderToken } from "../_lib/uploader.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost(context) {
  let payload;

  try {
    payload = await context.request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  if (isUploaderPassword(payload?.password, context.env)) {
    if (!context.env.UPLOADER_BUCKET || !context.env.AI_SESSION_SECRET) return jsonResponse({ error: "Uploader is not configured." }, 503);
    return jsonResponse({ authorized: true, role: "uploader", token: await issueUploaderToken(context.env.AI_SESSION_SECRET) });
  }
  if (!isAdminPassword(payload?.password, context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  return jsonResponse({ authorized: true, ...(context.env?.UPLOADER_BUCKET && context.env?.AI_SESSION_SECRET ? { token: await issueUploaderToken(context.env.AI_SESSION_SECRET) } : {}) });
}
