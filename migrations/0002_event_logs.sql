CREATE TABLE IF NOT EXISTS event_logs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('copy', 'download', 'ai_search')),
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  visitor_id TEXT NOT NULL DEFAULT '',
  file_key TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  file_source TEXT NOT NULL DEFAULT '',
  ai_prompt TEXT NOT NULL DEFAULT '',
  ai_response TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS event_logs_created_at
  ON event_logs(created_at);

CREATE INDEX IF NOT EXISTS event_logs_visitor_recent
  ON event_logs(visitor_id, created_at);
