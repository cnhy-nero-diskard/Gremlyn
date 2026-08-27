/**
 * Ordered startup migrations (design D6, Migration Plan).
 *
 * Each entry is applied once, in order, inside a transaction. The runner is
 * idempotent: already-applied migrations are skipped on subsequent starts.
 * New schema changes are appended as new entries; existing entries are never
 * edited.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_initial",
    sql: `
CREATE TABLE repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  validation_commands TEXT NOT NULL DEFAULT '[]',
  agent_instructions TEXT,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  UNIQUE(owner, name)
);

CREATE TABLE processed_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  command TEXT NOT NULL,
  author_login TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  job_id INTEGER,
  UNIQUE(repo_id, pr_number, comment_id, command)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repositories(id),
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  command TEXT NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  current_attempt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  attempt_number INTEGER NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL,
  workspace_path TEXT,
  head_sha_at_prepare TEXT,
  started_at TEXT,
  ended_at TEXT,
  agent_exit_code INTEGER,
  agent_session_id TEXT,
  outcome TEXT,
  failure_stage TEXT,
  failure_reason TEXT,
  commit_sha TEXT,
  pushed INTEGER NOT NULL DEFAULT 0,
  report_status TEXT,
  has_uncommitted_changes INTEGER NOT NULL DEFAULT 0,
  output_ref TEXT,
  UNIQUE(job_id, attempt_number)
);

CREATE TABLE status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  attempt_id INTEGER,
  status TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE validation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  seq INTEGER NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_ref TEXT
);

CREATE TABLE log_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  job_id INTEGER,
  attempt_id INTEGER,
  fields TEXT
);

CREATE TABLE ingestion_state (
  repo_id INTEGER PRIMARY KEY,
  etag TEXT,
  since TEXT,
  last_polled_at TEXT
);

CREATE INDEX idx_jobs_repo_pr ON jobs(repo_id, pr_number);
CREATE INDEX idx_status_events_job ON status_events(job_id);
CREATE INDEX idx_log_entries_job ON log_entries(job_id);
CREATE INDEX idx_attempts_job ON attempts(job_id);
`,
  },
  {
    id: "0002_operator_actions",
    sql: `
CREATE TABLE operator_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  effect TEXT,
  detail TEXT
);
`,
  },
];
