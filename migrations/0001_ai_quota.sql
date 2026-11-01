CREATE TABLE IF NOT EXISTS ai_requests (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  minute_bucket INTEGER NOT NULL,
  day_bucket TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_requests_visitor_minute
  ON ai_requests(visitor_id, minute_bucket);

CREATE INDEX IF NOT EXISTS ai_requests_visitor_day
  ON ai_requests(visitor_id, day_bucket);

CREATE INDEX IF NOT EXISTS ai_requests_global_day
  ON ai_requests(day_bucket);

CREATE TABLE IF NOT EXISTS ai_active_tasks (
  visitor_id TEXT PRIMARY KEY,
  lock_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_active_tasks_expiry
  ON ai_active_tasks(expires_at);
