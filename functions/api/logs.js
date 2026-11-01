import { getVisitor } from "../_lib/ai-security.js";
import {
  normalizePublicFileEvent,
  writeEventLog,
} from "../_lib/event-logs.js";

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
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

  const event = normalizePublicFileEvent(payload);
  if (!event) {
    return jsonResponse({ error: "Invalid activity event." }, 400);
  }
  if (!context.env.AI_DB || !context.env.AI_SESSION_SECRET) {
    return jsonResponse({ error: "Activity logging is unavailable." }, 503);
  }

  const visitor = await getVisitor(
    context.request,
    context.env.AI_SESSION_SECRET,
  );
  const task = writeEventLog(context.env.AI_DB, event, {
    visitorId: visitor.id,
    rateLimitPublic: true,
  }).catch((error) => {
    console.error(
      "Failed to write activity log:",
      error instanceof Error ? error.message : String(error),
    );
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(task);
  } else {
    await task;
  }

  return jsonResponse(
    { accepted: true },
    202,
    visitor.setCookie ? { "Set-Cookie": visitor.setCookie } : {},
  );
}
