import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { createRedactor, type Redactor } from "../log/redact.js";
import type { CommandOutcome, JobStatus } from "../types.js";

/**
 * Read-only projections used by the operator console.
 *
 * The console deliberately does not expose persistence rows directly.  These
 * models are the boundary between SQLite and the presentation layer: paths
 * referenced by an output row are used only while reading, and every string
 * that leaves this module has gone through the configured redactor.
 */

export type Redaction = Redactor | readonly string[];

export interface RepositorySummary {
  id: number;
  owner: string;
  name: string;
  enabled: number;
  source_path?: string;
  workspace_root?: string;
  agent?: string;
  model?: string;
  provider?: string;
  effort?: string;
  validation_commands?: string;
  agent_instructions?: string | null;
  allowed_models?: string;
  /** Parsed validation commands for views that do not want to parse JSON. */
  validationCommands?: string[][];
}

export interface JobSummary {
  id: number;
  repo_id: number;
  pr_number: number;
  comment_id: number;
  command: string;
  status: JobStatus | string;
  owner: string;
  name: string;
  thread_id?: string | null;
  created_at?: string;
  finished_at?: string | null;
  current_attempt?: number;
  review_context?: string | null;
}

export interface AttemptDetail {
  id: number;
  job_id: number;
  attempt_number: number;
  agent: string;
  model: string;
  provider: string;
  effort: string;
  workspace_path: string | null;
  head_sha_at_prepare: string | null;
  started_at: string | null;
  ended_at: string | null;
  agent_exit_code: number | null;
  agent_session_id: string | null;
  outcome: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
  commit_sha: string | null;
  pushed: number;
  report_status: string | null;
  has_uncommitted_changes: number;
  output_ref: string | null;
  output: string;
}

export interface StatusTimelineEntry {
  id: number;
  job_id: number;
  attempt_id: number | null;
  status: JobStatus | string;
  at: string;
}

export interface ValidationRun {
  id: number;
  attempt_id: number;
  seq: number;
  command: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_ref: string | null;
  output: string;
}

export interface LogRow {
  id: number;
  at: string;
  level: string;
  event: string;
  job_id: number | null;
  attempt_id: number | null;
  fields: string | null;
}

export interface JobDetail {
  job: JobSummary & {
    review_context: string | null;
    thread_id: string | null;
  };
  attempts: AttemptDetail[];
  timeline: StatusTimelineEntry[];
  validation: ValidationRun[];
  logs: LogRow[];
}

export interface HealthModel {
  /** Latest poll observed across all configured repositories. */
  lastPolledAt: string | null;
  /** Alias retained for views using the shorter name. */
  lastPollAt: string | null;
  /** Age of the latest poll in seconds, or null when no poll exists. */
  pollAgeSec: number | null;
  queueDepth: number;
  /** Alias useful to queue-oriented dashboard components. */
  queuedCount: number;
  inFlight: number;
  /** Alias useful to concurrency-oriented dashboard components. */
  activeCount: number;
  concurrency: number;
  pollIntervalSec: number;
  stale: boolean;
  status: "running" | "stale" | "unknown";
}

export interface DashboardModel {
  repositories: RepositorySummary[];
  jobs: JobSummary[];
  running: JobSummary[];
  queued: JobSummary[];
  recent: JobSummary[];
  health: HealthModel;
}

export interface ProcessedCommandModel {
  id: number;
  repo_id: number;
  owner: string;
  name: string;
  repository: string;
  pr_number: number;
  comment_id: number;
  command: string;
  author_login: string;
  observed_at: string;
  outcome: CommandOutcome | string;
  reason: string | null;
  job_id: number | null;
}

export interface OperatorActionModel {
  id: number;
  at: string;
  action: string;
  target: string;
  effect: string | null;
  detail: string | null;
}

export interface DashboardReadOptions {
  pollIntervalSec?: number;
  concurrency?: number;
  now?: Date | number | string;
}

export interface ConsoleQueries {
  readDashboard(options?: DashboardReadOptions): DashboardModel;
  readHealth(now?: Date | number | string): HealthModel;
  readJobDetail(jobId: number): JobDetail | undefined;
  readJobLog(jobId: number): LogRow[];
  readProcessedCommands(limit?: number): ProcessedCommandModel[];
  readOperatorActions(limit?: number): OperatorActionModel[];
}

const RUNNING_STATUSES = new Set(["preparing", "running", "validating", "publishing", "reporting"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function asRedactor(input: Redaction): Redactor {
  return typeof input === "function" ? input : createRedactor(input);
}

/** Redact every string property in a persistence row without mutating it. */
function redactRow<T extends Record<string, unknown>>(row: T, redact: Redactor): T {
  const result = { ...row } as T;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string") {
      (result as Record<string, unknown>)[key] = redact(value);
    }
  }
  return result;
}

function parseValidationCommands(value: string | null | undefined): string[][] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) =>
      Array.isArray(entry) && entry.every((part) => typeof part === "string")
        ? [entry as string[]]
        : [],
    );
  } catch {
    return [];
  }
}

/** Read a captured output file, treating missing/unreadable files as empty data. */
function readOutput(path: string | null): string {
  if (!path) return "";
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "[output unavailable]";
  }
}

function toMillis(value: Date | number | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Date.now();
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

/**
 * Read the dashboard's repository and job lanes.  The legacy shape (separate
 * `running`, `queued`, and `recent` arrays) is retained so existing routes can
 * adopt the query without changing their rendering contract.
 */
export function readDashboard(
  db: Database.Database,
  redaction: Redaction,
  options: DashboardReadOptions = {},
): DashboardModel {
  const redact = asRedactor(redaction);
  const repositories = db
    .prepare(
      `SELECT id, owner, name, enabled, source_path, workspace_root, agent,
              model, provider, effort, validation_commands, agent_instructions,
              allowed_models
       FROM repositories ORDER BY owner, name`,
    )
    .all()
    .map((row) => {
      const safe = redactRow(
        row as Record<string, unknown>,
        redact,
      ) as unknown as RepositorySummary;
      return {
        ...safe,
        validationCommands: parseValidationCommands(safe.validation_commands),
      };
    });
  const jobs = db
    .prepare(
      `SELECT jobs.*, repositories.owner, repositories.name
       FROM jobs JOIN repositories ON repositories.id = jobs.repo_id
       ORDER BY jobs.id DESC LIMIT 50`,
    )
    .all()
    .map((row) => redactRow(row as Record<string, unknown>, redact) as unknown as JobSummary);
  const running = jobs.filter((job) => RUNNING_STATUSES.has(job.status));
  const queued = jobs.filter((job) => job.status === "queued");
  const recent = jobs.filter((job) => TERMINAL_STATUSES.has(job.status));
  const health = readHealth(
    db,
    options.pollIntervalSec ?? 60,
    options.concurrency ?? 1,
    options.now,
  );
  return { repositories, jobs, running, queued, recent, health };
}

/** Read and redact a complete job diagnostic projection. */
export function readJobDetail(
  db: Database.Database,
  jobId: number,
  redaction: Redaction,
): JobDetail | undefined {
  const redact = asRedactor(redaction);
  const jobRow = db
    .prepare(
      `SELECT jobs.*, repositories.owner, repositories.name
       FROM jobs JOIN repositories ON repositories.id = jobs.repo_id
       WHERE jobs.id = ?`,
    )
    .get(jobId) as Record<string, unknown> | undefined;
  if (!jobRow) return undefined;

  const attempts = db
    .prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number")
    .all(jobId)
    .map((row) => {
      const raw = row as Record<string, unknown>;
      const outputRef = typeof raw.output_ref === "string" ? raw.output_ref : null;
      const safe = redactRow(raw, redact) as unknown as AttemptDetail;
      return { ...safe, output: redact(readOutput(outputRef)) };
    });
  const timeline = db
    .prepare(
      "SELECT id, job_id, attempt_id, status, at FROM status_events WHERE job_id = ? ORDER BY id",
    )
    .all(jobId)
    .map(
      (row) => redactRow(row as Record<string, unknown>, redact) as unknown as StatusTimelineEntry,
    );
  const validation = db
    .prepare(
      `SELECT validation_runs.* FROM validation_runs
       JOIN attempts ON attempts.id = validation_runs.attempt_id
       WHERE attempts.job_id = ? ORDER BY attempts.attempt_number, validation_runs.seq`,
    )
    .all(jobId)
    .map((row) => {
      const raw = row as Record<string, unknown>;
      const outputRef = typeof raw.output_ref === "string" ? raw.output_ref : null;
      const safe = redactRow(raw, redact) as unknown as ValidationRun;
      return { ...safe, output: redact(readOutput(outputRef)) };
    });
  const logs = readJobLog(db, jobId, redact);
  const safeJob = redactRow(jobRow, redact) as unknown as JobDetail["job"];
  return { job: safeJob, attempts, timeline, validation, logs };
}

/** Read only the selected job's structured lifecycle log. */
export function readJobLog(db: Database.Database, jobId: number, redaction: Redaction): LogRow[] {
  const redact = asRedactor(redaction);
  return db
    .prepare("SELECT * FROM log_entries WHERE job_id = ? ORDER BY id")
    .all(jobId)
    .map((row) => {
      const safe = redactRow(row as Record<string, unknown>, redact) as unknown as LogRow;
      // Keep the endpoint's historical contract: absent structured fields are
      // represented by an empty JSON object rather than null.
      return { ...safe, fields: safe.fields ?? "{}" };
    });
}

/**
 * Derive process health from persisted activity and the configured limits.
 * Missing ingestion activity is intentionally not reported as healthy.
 */
export function readHealth(
  db: Database.Database,
  pollIntervalSec: number,
  concurrency: number,
  now?: Date | number | string,
): HealthModel {
  const latest = db
    .prepare("SELECT MAX(last_polled_at) AS last_polled_at FROM ingestion_state")
    .get() as { last_polled_at: string | null };
  const queue = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'").get() as {
    count: number;
  };
  const active = db
    .prepare(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE status IN ('preparing', 'running', 'validating', 'publishing', 'reporting')`,
    )
    .get() as { count: number };
  const lastPolledAt = latest.last_polled_at ?? null;
  const pollTime = lastPolledAt === null ? Number.NaN : Date.parse(lastPolledAt);
  const ageMs = Number.isFinite(pollTime) ? Math.max(0, toMillis(now) - pollTime) : Number.NaN;
  const intervalMs = Math.max(0, pollIntervalSec * 1_000);
  const stale = !Number.isFinite(pollTime) || ageMs > intervalMs;
  const pollAgeSec = Number.isFinite(ageMs) ? Math.floor(ageMs / 1_000) : null;
  return {
    lastPolledAt,
    lastPollAt: lastPolledAt,
    pollAgeSec,
    queueDepth: Number(queue.count),
    queuedCount: Number(queue.count),
    inFlight: Number(active.count),
    activeCount: Number(active.count),
    concurrency,
    pollIntervalSec,
    stale,
    status: lastPolledAt === null ? "unknown" : stale ? "stale" : "running",
  };
}

/** Read observed command outcomes, including refused commands that made no job. */
export function readProcessedCommands(
  db: Database.Database,
  redaction: Redaction,
  limit = 50,
): ProcessedCommandModel[] {
  const redact = asRedactor(redaction);
  return db
    .prepare(
      `SELECT processed_commands.*, repositories.owner, repositories.name
       FROM processed_commands JOIN repositories ON repositories.id = processed_commands.repo_id
       ORDER BY processed_commands.id DESC LIMIT ?`,
    )
    .all(boundedLimit(limit))
    .map((row) => {
      const safe = redactRow(
        row as Record<string, unknown>,
        redact,
      ) as unknown as ProcessedCommandModel;
      return { ...safe, repository: `${safe.owner}/${safe.name}` };
    });
}

/** Read the operator audit trail, redacting free-form detail before return. */
export function readOperatorActions(
  db: Database.Database,
  redaction: Redaction,
  limit = 50,
): OperatorActionModel[] {
  const redact = asRedactor(redaction);
  return db
    .prepare(
      "SELECT id, at, action, target, effect, detail FROM operator_actions ORDER BY id DESC LIMIT ?",
    )
    .all(boundedLimit(limit))
    .map(
      (row) => redactRow(row as Record<string, unknown>, redact) as unknown as OperatorActionModel,
    );
}

/** Build a query facade for route handlers and stream renderers. */
export function createConsoleQueries(input: {
  db: Database.Database;
  secrets: readonly string[];
  pollIntervalSec?: number;
  concurrency?: number;
}): ConsoleQueries;
export function createConsoleQueries(
  db: Database.Database,
  secrets: readonly string[],
  options?: Pick<DashboardReadOptions, "pollIntervalSec" | "concurrency">,
): ConsoleQueries;
export function createConsoleQueries(
  inputOrDb:
    | {
        db: Database.Database;
        secrets: readonly string[];
        pollIntervalSec?: number;
        concurrency?: number;
      }
    | Database.Database,
  secretsOrUndefined?: readonly string[],
  options: Pick<DashboardReadOptions, "pollIntervalSec" | "concurrency"> = {},
): ConsoleQueries {
  const input =
    typeof inputOrDb === "object" && "prepare" in inputOrDb
      ? {
          db: inputOrDb,
          secrets: secretsOrUndefined ?? [],
          ...options,
        }
      : inputOrDb;
  const redact = createRedactor(input.secrets);
  const pollIntervalSec = input.pollIntervalSec ?? 60;
  const concurrency = input.concurrency ?? 1;
  return {
    readDashboard: (readOptions = {}) =>
      readDashboard(input.db, redact, {
        pollIntervalSec,
        concurrency,
        ...readOptions,
      }),
    readHealth: (now) => readHealth(input.db, pollIntervalSec, concurrency, now),
    readJobDetail: (jobId) => readJobDetail(input.db, jobId, redact),
    readJobLog: (jobId) => readJobLog(input.db, jobId, redact),
    readProcessedCommands: (limit) => readProcessedCommands(input.db, redact, limit),
    readOperatorActions: (limit) => readOperatorActions(input.db, redact, limit),
  };
}
