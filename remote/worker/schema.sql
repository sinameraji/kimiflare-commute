-- D1 schema for commute.kimiflare.com telemetry and billing

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  github_avatar TEXT,
  plan TEXT DEFAULT 'free',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  branch TEXT,
  status TEXT NOT NULL,
  sandbox_instance_type TEXT DEFAULT 'standard-1',
  started_at INTEGER,
  ended_at INTEGER,
  sandbox_active_seconds INTEGER DEFAULT 0,
  ai_input_tokens INTEGER DEFAULT 0,
  ai_output_tokens INTEGER DEFAULT 0,
  tool_calls_count INTEGER DEFAULT 0,
  pr_url TEXT,
  error_message TEXT,
  error_category TEXT,
  cost_estimate_usd REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_number INTEGER,
  event_type TEXT NOT NULL,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  latency_ms INTEGER,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_session_id ON usage_events(session_id);

CREATE TABLE IF NOT EXISTS daily_usage (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  sessions_count INTEGER DEFAULT 0,
  total_active_seconds INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
