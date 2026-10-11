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
  {
    id: "0003_console_review_context",
    sql: `
ALTER TABLE jobs ADD COLUMN review_context TEXT;
`,
  },
  {
    id: "0004_repository_agent_timeout",
    sql: `
ALTER TABLE repositories ADD COLUMN timeout_seconds INTEGER;
`,
  },
  {
    id: "0005_attempt_adopted_workspace",
    sql: `
ALTER TABLE attempts ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: "0006_opencode_agent_profiles",
    sql: `
-- D1: one nullable, versioned dashboard profile per OpenCode repository, in a
-- separate row keyed by repository id (never a column on repositories, so file
-- configuration synchronization cannot touch it). profile_json is the canonical
-- profile JSON, or NULL when the repository has no dashboard profile — a
-- missing profile keeps the existing OpenCode invocation. revision is the
-- compare-and-set counter; a missing row reads as revision 0, and no default
-- profile is ever synthesized by the schema.
CREATE TABLE opencode_agent_profiles (
  repo_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  profile_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);

-- D2: jobs retain the exact profile captured at job-creation time, so queued
-- jobs and their retries are unaffected by a later dashboard save. Both
-- columns are nullable; a job created without a saved profile has no snapshot.
ALTER TABLE jobs ADD COLUMN opencode_profile_json TEXT;
ALTER TABLE jobs ADD COLUMN opencode_profile_revision INTEGER;
`,
  },
  {
    id: "0007_managed_attempt_evidence",
    sql: `
-- Task 4.4: durable diagnostic evidence for managed OpenCode attempts, because
-- job detail is a database projection that must survive restart. Only ids,
-- outcomes, and states are stored -- never the operator's private instruction
-- text. failure_detail keeps the specific configuration or quiescence message
-- (agent labels, session ids, paths); managed_child_sessions records every
-- child the attempt settled with its terminal outcome, or marks an unproven
-- child as unsettled/unknown with its id so the failure stays specific and
-- fail-closed.
ALTER TABLE attempts ADD COLUMN failure_detail TEXT;

CREATE TABLE managed_child_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  session_id TEXT NOT NULL,
  outcome TEXT,
  state TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(attempt_id, session_id)
);

CREATE INDEX idx_managed_child_sessions_attempt ON managed_child_sessions(attempt_id);
`,
  },
  {
    id: "0008_opencode_primary_selection",
    sql: `
-- Task 2.1 (design D1/D2/D4): durable primary-source selection, job capture,
-- and generic per-invocation ownership/identity. This migration is additive:
-- it never edits an existing row, so every profile payload and revision from
-- migration 0006 is preserved byte-for-byte.

-- D1: one selection row per repository. The source alone decides whether a saved
-- managed profile is active; native_agent_id is the retained native choice
-- and is non-null exactly for native source. The revision is the optimistic
-- compare-and-set counter (a missing row reads as default at revision 0). A
-- row can be dormant for a non-OpenCode executor and is preserved for later
-- reuse; activation is gated by the store, not by deleting the row.
CREATE TABLE opencode_primary_selections (
  repo_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  source TEXT NOT NULL CHECK (source IN ('default', 'native', 'managed')),
  native_agent_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (source = 'native' AND native_agent_id IS NOT NULL) OR
    (source != 'native' AND native_agent_id IS NULL)
  )
);

-- Seed every pre-existing repository with its effective source: a repository
-- that already carries a non-null managed profile keeps that team active
-- (managed); every other repository starts on OpenCode default. No profile is
-- synthesized and no profile bytes/revision are touched. A mismatched executor
-- cannot activate the seeded choice, but the row remains for later reuse.
INSERT INTO opencode_primary_selections (repo_id, source, native_agent_id, revision)
SELECT r.id,
       CASE WHEN p.profile_json IS NOT NULL THEN 'managed' ELSE 'default' END,
       NULL,
       0
FROM repositories r
LEFT JOIN opencode_agent_profiles p ON p.repo_id = r.id;

-- D2: jobs capture the primary source/native id/selection revision alongside
-- the existing managed-profile snapshot columns. All three are nullable so
-- legacy jobs (NULL) can derive managed source from their own captured profile
-- and default otherwise. A later repository change never rewrites a job.
ALTER TABLE jobs ADD COLUMN opencode_source TEXT;
ALTER TABLE jobs ADD COLUMN opencode_native_agent_id TEXT;
ALTER TABLE jobs ADD COLUMN opencode_selection_revision INTEGER;

-- D4: one generic ownership/identity record per launched OpenCode parent
-- invocation, journaled before launch. It stores only safe identifiers,
-- states and paths -- never prompts, instructions or credentials. A second
-- invocation in one attempt gets its own ordinal and never overwrites the
-- first record. A NULL parent_session_id with a launched status is the
-- explicit missing-ownership marker; ownership_state records whether the
-- tree was proven quiescent before the workspace was reused.
CREATE TABLE opencode_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  invocation_ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  ownership_state TEXT NOT NULL DEFAULT 'pending',
  requested_source TEXT NOT NULL,
  requested_native_agent_id TEXT,
  requested_profile_revision INTEGER,
  binary TEXT,
  workspace_path TEXT,
  parent_session_id TEXT,
  actual_primary_agent TEXT,
  actual_model TEXT,
  launched_at TEXT,
  settled_at TEXT,
  detail TEXT,
  UNIQUE(attempt_id, invocation_ordinal)
);

CREATE INDEX idx_opencode_invocations_attempt ON opencode_invocations(attempt_id);
`,
  },
  {
    id: "0009_delegation_observations",
    sql: `
-- Tasks 2.1/2.2/2.3/2.4 (design D3/D4): durable, bounded, privacy-safe evidence
-- of actual agent delegation. This is an observation store only: it never
-- writes attempts, opencode_invocations, managed_child_sessions, or any other
-- safety verdict. Every node is keyed by (attempt, invocation ordinal, session)
-- so a repeated invocation of the same agent is a distinct node and a second
-- parent invocation in one attempt never overwrites the first.
--
-- Only whitelisted scalar identity/state facts are stored: ids, source kind,
-- supported actual agent/model, source timestamps when the runtime exposes
-- them, observation bounds, last-known state/outcome and interruption-request
-- metadata. Raw prompts, instructions, tool arguments, config dumps and event
-- bodies are never represented here.

-- Bounded observation nodes. first_observed_at is write-once; the last_*
-- columns advance with each observation. last_outcome preserves the first
-- terminal evidence and is never cleared, so an unresolved later round cannot
-- erase a proven result. limited_uncertainty marks imported/ambiguous evidence
-- whose parent edge, timestamps or identity could not be proven.
CREATE TABLE delegation_observation_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  invocation_ordinal INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  root_session_id TEXT,
  parent_session_id TEXT,
  depth INTEGER,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('session-poll', 'event-stream', 'legacy-managed', 'unknown')),
  evidence_presence TEXT NOT NULL DEFAULT 'observed' CHECK (evidence_presence IN ('observed', 'missing')),
  actual_agent TEXT,
  actual_model TEXT,
  source_created_at TEXT,
  source_updated_at TEXT,
  source_idle_at TEXT,
  first_observed_at TEXT,
  last_observed_at TEXT,
  last_state TEXT NOT NULL DEFAULT 'unknown',
  last_outcome TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('succeeded', 'failed', 'interrupted')),
  last_active INTEGER CHECK (last_active IS NULL OR last_active IN (0, 1)),
  -- Most recent NON-NULL active evidence ever observed, retained only as history
  -- and display context. It never makes a later unknown/absent active map assert
  -- a live state, and it lets the projection distinguish a freshly verified
  -- invoked record (no active evidence has ever been seen) from an unknown
  -- record whose current active evidence was lost.
  last_known_active INTEGER CHECK (last_known_active IS NULL OR last_known_active IN (0, 1)),
  -- The terminal outcome the LATEST observation reported (NULL when that record
  -- carried none). last_outcome is the retained historic terminal evidence
  -- (never cleared); outcome_conflict records that the latest evidence
  -- retracted or contradicted it, so the projection stays unknown until a fresh
  -- record is consistent again.
  current_outcome TEXT CHECK (current_outcome IS NULL OR current_outcome IN ('succeeded', 'failed', 'interrupted')),
  outcome_conflict INTEGER NOT NULL DEFAULT 0,
  cancellation_requested INTEGER NOT NULL DEFAULT 0,
  cancellation_requested_at TEXT,
  observation_generation INTEGER NOT NULL DEFAULT 0,
  history_partial INTEGER NOT NULL DEFAULT 0,
  limited_uncertainty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(attempt_id, invocation_ordinal, session_id)
);

CREATE INDEX idx_delegation_nodes_attempt ON delegation_observation_nodes(attempt_id);
CREATE INDEX idx_delegation_nodes_invocation ON delegation_observation_nodes(attempt_id, invocation_ordinal);

-- Bounded safe state transitions. Not a token/tool event log: only the
-- classified state, terminal outcome, active evidence and cancellation flag at
-- each observed change. The store trims the oldest rows past the per-node and
-- per-invocation caps and marks the node/coverage history partial.
CREATE TABLE delegation_observation_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  invocation_ordinal INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  active INTEGER,
  cancellation_requested INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_delegation_transitions_node
  ON delegation_observation_transitions(attempt_id, invocation_ordinal, session_id, id);
CREATE INDEX idx_delegation_transitions_invocation
  ON delegation_observation_transitions(attempt_id, invocation_ordinal, id);

-- One coverage record per (attempt, invocation ordinal): the reconciliation
-- generation the console keys off, transport kind/state, freshness bounds,
-- explicit gaps and truncation/limit markers. A missing row means coverage is
-- not yet known, never that there were no delegations.
CREATE TABLE delegation_invocation_coverage (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  invocation_ordinal INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  transport TEXT NOT NULL DEFAULT 'unknown' CHECK (transport IN ('polling', 'event-stream', 'legacy-managed', 'none', 'unknown')),
  transport_state TEXT NOT NULL DEFAULT 'unknown' CHECK (transport_state IN ('ok', 'degraded', 'unavailable', 'unknown')),
  last_success_at TEXT,
  last_attempt_at TEXT,
  gap_count INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  history_partial INTEGER NOT NULL DEFAULT 0,
  node_limit_reached INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, invocation_ordinal)
);

-- Explicit, durable observation gaps. A gap is opened when a round loses its
-- source, misses observations or hits a bound, and closed (not deleted) when a
-- later round reconciles successfully, so the historical note survives.
CREATE TABLE delegation_observation_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  invocation_ordinal INTEGER NOT NULL,
  signature TEXT NOT NULL,
  detail TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX idx_delegation_gaps_invocation
  ON delegation_observation_gaps(attempt_id, invocation_ordinal, id);

-- Migration Plan step 1: existing managed child records are imported as
-- explicitly limited legacy evidence by importLegacyManagedChildObservations
-- (called at daemon startup), not by this schema migration. The import reads
-- opencode_invocations, which is an additive prerequisite that a fresh schema
-- may not have applied yet; keeping the seed out of the static migration keeps
-- this migration order-independent and makes the import idempotent and testable
-- on its own.
`,
  },
];
