export const EVENT_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const PUBLIC_EVENT_LIMIT_PER_MINUTE = 120;

const EVENT_TYPES = new Set(["copy", "download", "ai_search"]);
const STATUSES = new Set(["success", "error"]);

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function normalizePublicFileEvent(payload) {
  const eventType = cleanText(payload?.eventType, 20);
  if (eventType !== "copy" && eventType !== "download") return null;

  const fileKey = cleanText(payload?.fileKey, 1024).trim();
  const fileName = cleanText(payload?.fileName, 512).trim();
  if (!fileKey || !fileName) return null;

  const source = payload?.fileSource === "official" ? "official" : "uploaded";
  return {
    eventType,
    status: "success",
    fileKey,
    fileName,
    fileSource: source,
  };
}

export function normalizeEvent(event) {
  const eventType = cleanText(event?.eventType, 20);
  const status = cleanText(event?.status, 20);
  if (!EVENT_TYPES.has(eventType) || !STATUSES.has(status)) return null;

  return {
    eventType,
    status,
    fileKey: cleanText(event?.fileKey, 1024),
    fileName: cleanText(event?.fileName, 512),
    fileSource: cleanText(event?.fileSource, 32),
    aiPrompt: cleanText(event?.aiPrompt, 500),
    aiResponse: cleanText(event?.aiResponse, 4000),
    errorMessage: cleanText(event?.errorMessage, 2000),
  };
}

export async function writeEventLog(
  database,
  event,
  { visitorId = "", now = Date.now(), rateLimitPublic = false } = {},
) {
  if (!database) throw new Error("D1 binding AI_DB is not configured.");
  const normalized = normalizeEvent(event);
  if (!normalized) throw new Error("Invalid event log.");

  const createdAt = Math.floor(now / 1000);
  const cutoff = createdAt - EVENT_LOG_RETENTION_SECONDS;
  const id = crypto.randomUUID();
  const safeVisitorId = cleanText(visitorId, 128);
  const insertSql = rateLimitPublic
    ? `INSERT INTO event_logs (
         id, created_at, event_type, status, visitor_id,
         file_key, file_name, file_source, ai_prompt, ai_response, error_message
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM event_logs
         WHERE visitor_id = ? AND created_at >= ?
       ) < ?`
    : `INSERT INTO event_logs (
         id, created_at, event_type, status, visitor_id,
         file_key, file_name, file_source, ai_prompt, ai_response, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [
    id,
    createdAt,
    normalized.eventType,
    normalized.status,
    safeVisitorId,
    normalized.fileKey,
    normalized.fileName,
    normalized.fileSource,
    normalized.aiPrompt,
    normalized.aiResponse,
    normalized.errorMessage,
  ];
  if (rateLimitPublic) {
    values.push(
      safeVisitorId,
      createdAt - 60,
      PUBLIC_EVENT_LIMIT_PER_MINUTE,
    );
  }

  await database.batch([
    database
      .prepare("DELETE FROM event_logs WHERE created_at < ?")
      .bind(cutoff),
    database.prepare(insertSql).bind(...values),
  ]);

  return id;
}

export async function readRecentEventLogs(database, now = Date.now()) {
  if (!database) throw new Error("D1 binding AI_DB is not configured.");
  const cutoff = Math.floor(now / 1000) - EVENT_LOG_RETENTION_SECONDS;
  await database
    .prepare("DELETE FROM event_logs WHERE created_at < ?")
    .bind(cutoff)
    .run();
  const result = await database
    .prepare(
      `SELECT
         id, created_at, event_type, status, visitor_id,
         file_key, file_name, file_source, ai_prompt, ai_response, error_message
       FROM event_logs
       WHERE created_at >= ?
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(cutoff)
    .all();
  return Array.isArray(result?.results) ? result.results : [];
}

function csvCell(value) {
  const text = String(value ?? "")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/"/g, '""');
  return `"${text}"`;
}

export function eventLogsToCsv(rows) {
  const headers = [
    "time",
    "event",
    "status",
    "file_key",
    "file_name",
    "file_source",
    "ai_prompt",
    "ai_response",
    "error",
    "visitor_id",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    const time = Number.isFinite(Number(row.created_at))
      ? new Date(Number(row.created_at) * 1000).toISOString()
      : "";
    lines.push([
      time,
      row.event_type,
      row.status,
      row.file_key,
      row.file_name,
      row.file_source,
      row.ai_prompt,
      row.ai_response,
      row.error_message,
      row.visitor_id,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
