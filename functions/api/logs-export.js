import { isAdminPassword } from "../_lib/admin.js";
import {
  eventLogsToCsv,
  readRecentEventLogs,
} from "../_lib/event-logs.js";

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

  if (!isAdminPassword(payload?.password, context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  try {
    const rows = await readRecentEventLogs(context.env.AI_DB);
    const csv = eventLogsToCsv(rows);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="urovo-activity-logs-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(
      "Failed to export activity logs:",
      error instanceof Error ? error.message : String(error),
    );
    return jsonResponse({ error: "Could not export activity logs." }, 500);
  }
}
