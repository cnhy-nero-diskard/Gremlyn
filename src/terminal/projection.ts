import type Database from "better-sqlite3";
import { createRedactor, type Redactor } from "../log/redact.js";

/**
 * Safe read-only terminal projections (design D3, task 3.1).
 *
 * The terminal surface must be useful without a browser while never becoming a
 * second write path or a way to smuggle untrusted text onto the operator's
 * console. This module narrows SQLite to a whitelist of operational columns —
 * repository counts/owner/name/enabled and job status/PR plus the latest
 * attempt's `started_at`/`outcome` and the job's `created_at`/`finished_at` —
 * and never selects instruction text, prompts, review context or profile JSON.
 *
 * Every dynamic string is redacted against the configured secrets and then
 * sanitized (control/ANSI/OSC stripped, ASCII fallback) before it leaves this
 * module, so the renderer can print it verbatim. All statements are SELECT-only;
 * nothing here mutates job, queue or repository state.
 */

/** Observed connection health, derived only from polling observations. */
export type TerminalConnection = "unknown" | "healthy" | "stale" | "failed";

/** One bounded lifecycle row for the operator surface. */
export interface TerminalJobRow {
  id: number;
  /** `owner/name`, redacted and sanitized; never instruction text. */
  repository: string;
  pr: number;
  /** The job's current lifecycle stage (`queued`, `running`, `succeeded`, ...). */
  stage: string;
  /** Whole seconds since the row's start reference; always a non-negative integer. */
  elapsedSec: number;
  /** The latest attempt's recorded outcome, or null when none is recorded. */
  outcome: string | null;
}

/** A complete, bounded, observational terminal snapshot. */
export interface TerminalSnapshot {
  /** Caller-supplied bootstrap readiness label (e.g. `starting`, `ready`). */
  readiness: string;
  connection: TerminalConnection;
  /** Total configured repositories, across all enabled states. */
  configured: number;
  /** Configured repositories that are currently enabled. */
  enabled: number;
  /** ISO timestamp of the last successful poll, or null when none is observed. */
  lastPollAt: string | null;
  /** Age of the last successful poll in whole seconds, or null. */
  pollAgeSec: number | null;
  /** Full-database count of active jobs (`preparing`..`reporting`). */
  activeCount: number;
  /** Full-database count of queued jobs. */
  queuedCount: number;
  /** Full-database count of terminal jobs. */
  recentCount: number;
  /** Bounded active-then-queued-then-recent rows, at most `rowLimit`. */
  rows: TerminalJobRow[];
  /** Displayable jobs omitted from `rows`, so a backlog is never silently hidden. */
  overflow: number;
}

/** A successful/failed polling observation, supplied by the daemon bootstrap. */
export interface TerminalPollObservation {
  /** Epoch milliseconds of the most recent successful poll, or null. */
  lastSuccessAt: number | null;
  /** Whether the most recent poll attempt failed. */
  failed: boolean;
}

export interface TerminalSnapshotOptions {
  /** Reference clock in epoch milliseconds; defaults to `Date.now()`. */
  now?: number;
  /** Configured poll interval, used to judge freshness. */
  pollIntervalSec: number;
  /** Bootstrap readiness label shown alongside connection health. */
  readiness: string;
  /** Observed polling evidence. Absent observation never reads as healthy. */
  pollObservation?: TerminalPollObservation;
  /** Known secret values to redact before sanitizing display strings. */
  secrets: readonly string[];
  /** Maximum number of job rows to project. Defaults to {@link DEFAULT_TERMINAL_ROW_LIMIT}. */
  rowLimit?: number;
  /** Runtime configuration ids; omit only when projecting the entire durable registry. */
  configuredRepositoryIds?: readonly number[];
}

/** Default bound applied to a single projected label. */
export const DEFAULT_TERMINAL_TEXT_LENGTH = 200;
/** Default number of job rows a snapshot carries. */
export const DEFAULT_TERMINAL_ROW_LIMIT = 15;
/** Hard ceiling for a caller-supplied row limit. */
export const MAX_TERMINAL_ROW_LIMIT = 500;

/** Active lifecycle stages, ordered only as a set for counting and lane selection. */
const ACTIVE_STATUS_SQL = "('preparing', 'running', 'validating', 'publishing', 'reporting')";
/** Terminal lifecycle stages. */
const TERMINAL_STATUS_SQL = "('succeeded', 'failed', 'cancelled', 'interrupted')";

/*
 * Escape-sequence grammars. Applied before whitespace/ASCII normalization so an
 * OSC hyperlink or CSI cursor command is removed whole rather than leaking its
 * payload as text. Matching literal control characters is the point of these
 * patterns.
 */
/* eslint-disable no-control-regex */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE = /\u001b[@-Z\\-_]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const NON_ASCII = /[^\u0020-\u007e]/g;
/* eslint-enable no-control-regex */

/**
 * Sanitize untrusted text for single-line terminal display and bound its length.
 *
 * ANSI CSI, OSC (including hyperlink payloads) and lone escape sequences are
 * removed; remaining C0/C1 controls become spaces; every non-ASCII code point is
 * replaced with `?` as an ASCII fallback; whitespace runs collapse and the
 * result is trimmed. The returned string is never longer than `maxLength` and
 * contains only printable ASCII, so a renderer can emit it without re-checking.
 */
export function sanitizeTerminalText(
  text: string,
  maxLength: number = DEFAULT_TERMINAL_TEXT_LENGTH,
): string {
  const bound =
    Number.isFinite(maxLength) && maxLength >= 0
      ? Math.trunc(maxLength)
      : DEFAULT_TERMINAL_TEXT_LENGTH;
  let out = String(text);
  out = out.replace(OSC_SEQUENCE, "");
  out = out.replace(CSI_SEQUENCE, "");
  out = out.replace(SINGLE_ESCAPE, "");
  out = out.replace(CONTROL_CHARACTERS, " ");
  out = out.replace(NON_ASCII, "?");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > bound ? out.slice(0, bound) : out;
}

/** Clamp a caller-supplied row limit into a bounded, usable integer. */
function boundedRowLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_TERMINAL_ROW_LIMIT;
  return Math.max(1, Math.min(MAX_TERMINAL_ROW_LIMIT, Math.trunc(limit)));
}

/** Parse an ISO timestamp, returning null for absent or unparseable values. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Resolve a finite reference clock, falling back to the wall clock. */
function resolveNow(now: number | undefined): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

/**
 * Derive connection health strictly from observed polling. Healthy requires an
 * explicit, fresh successful observation: startup with no evidence stays
 * `unknown`, and a failed latest attempt is reported as `failed` rather than
 * optimistically healthy.
 */
function deriveConnection(
  observation: TerminalPollObservation | undefined,
  pollIntervalSec: number,
  nowMs: number,
): { connection: TerminalConnection; lastPollAt: string | null; pollAgeSec: number | null } {
  if (observation === undefined) {
    return { connection: "unknown", lastPollAt: null, pollAgeSec: null };
  }
  const lastSuccess = observation.lastSuccessAt;
  const hasSuccess =
    typeof lastSuccess === "number" &&
    Number.isFinite(lastSuccess) &&
    Math.abs(lastSuccess) <= 8.64e15;
  const lastPollAt = hasSuccess ? new Date(lastSuccess).toISOString() : null;
  const pollAgeSec = hasSuccess ? Math.max(0, Math.floor((nowMs - lastSuccess) / 1000)) : null;
  if (observation.failed) {
    return { connection: "failed", lastPollAt, pollAgeSec };
  }
  if (!hasSuccess) {
    return { connection: "unknown", lastPollAt: null, pollAgeSec: null };
  }
  const intervalSec =
    typeof pollIntervalSec === "number" && Number.isFinite(pollIntervalSec)
      ? Math.max(0, pollIntervalSec)
      : 0;
  const ageMs = Math.max(0, nowMs - lastSuccess);
  return {
    connection: ageMs <= intervalSec * 1000 ? "healthy" : "stale",
    lastPollAt,
    pollAgeSec,
  };
}

/**
 * Compute a row's elapsed duration. The start reference prefers the latest
 * attempt's `started_at` (so a retry measures the new attempt), then the most
 * recent `queued` status event (so a requeued job measures from requeue), then
 * the job's `created_at`. Terminal jobs measure to `finished_at`; live jobs
 * measure to the reference clock. Unparseable references never yield NaN.
 */
function elapsedSeconds(
  row: Pick<
    JobLaneRow,
    "attempt_started_at" | "queued_at" | "created_at" | "finished_at" | "stage"
  >,
  nowMs: number,
): number {
  const startCandidates = [row.attempt_started_at, row.queued_at, row.created_at];
  let startMs: number | null = null;
  for (const candidate of startCandidates) {
    const parsed = parseTimestamp(candidate);
    if (parsed !== null) {
      startMs = parsed;
      break;
    }
  }
  if (startMs === null) return 0;
  const finishedMs = parseTimestamp(row.finished_at);
  const endMs = finishedMs ?? nowMs;
  if (!Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

/** One raw lane row as selected from the whitelisted columns. */
interface JobLaneRow {
  id: number;
  pr_number: number;
  stage: string;
  created_at: string | null;
  finished_at: string | null;
  owner: string;
  name: string;
  attempt_started_at: string | null;
  attempt_outcome: string | null;
  queued_at: string | null;
}

/**
 * The shared lane projection. `whereClause` and `orderDirection` are built only
 * from module constants, never from caller input, so the statement stays a
 * fixed whitelist. Each lane is individually `LIMIT`-bounded so a large backlog
 * can never materialize unbounded rows.
 */
function readLane(
  db: Database.Database,
  whereClause: string,
  orderDirection: "ASC" | "DESC",
  limit: number,
): JobLaneRow[] {
  return db
    .prepare(
      `WITH lane AS (
         SELECT id, repo_id, pr_number, status, created_at, finished_at FROM jobs
         WHERE ${whereClause}
         ORDER BY jobs.id ${orderDirection} LIMIT ?
       )
       SELECT lane.id, lane.pr_number, lane.status AS stage,
              lane.created_at, lane.finished_at,
              repositories.owner, repositories.name,
              attempt.started_at AS attempt_started_at,
              attempt.outcome AS attempt_outcome,
              (SELECT at FROM status_events WHERE job_id = lane.id AND status = 'queued' ORDER BY id DESC LIMIT 1) AS queued_at
       FROM lane
       JOIN repositories ON repositories.id = lane.repo_id
       LEFT JOIN attempts AS attempt ON attempt.id = (
         SELECT id FROM attempts WHERE job_id = lane.id ORDER BY attempt_number DESC, id DESC LIMIT 1
       )
       ORDER BY lane.id ${orderDirection}`,
    )
    .all(limit) as JobLaneRow[];
}

/**
 * Build a bounded, read-only terminal snapshot.
 *
 * Counts are computed over the whole database (never over the previous
 * 50-row dashboard window) while rows are drawn from three individually
 * bounded lanes and assembled active-first, then queued, then recent. Anything
 * omitted is summarized by {@link TerminalSnapshot.overflow}. No statement
 * writes, and every display string is redacted before being sanitized and
 * truncated.
 */
export function readTerminalSnapshot(
  db: Database.Database,
  options: TerminalSnapshotOptions,
): TerminalSnapshot {
  const nowMs = resolveNow(options.now);
  const rowLimit = boundedRowLimit(options.rowLimit);
  const redact: Redactor = createRedactor(options.secrets);

  const repositoryFilter =
    options.configuredRepositoryIds === undefined
      ? ""
      : " WHERE id IN (SELECT value FROM json_each(?))";
  const repositoryCounts = db
    .prepare(
      "SELECT COUNT(*) AS configured, COALESCE(SUM(enabled), 0) AS enabled FROM repositories" +
        repositoryFilter,
    )
    .get(
      ...(options.configuredRepositoryIds === undefined
        ? []
        : [JSON.stringify(options.configuredRepositoryIds)]),
    ) as { configured: number; enabled: number };
  const jobCounts = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ${ACTIVE_STATUS_SQL} THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
         COALESCE(SUM(CASE WHEN status IN ${TERMINAL_STATUS_SQL} THEN 1 ELSE 0 END), 0) AS recent
       FROM jobs`,
    )
    .get() as { active: number; queued: number; recent: number };

  const activeRows = readLane(db, `jobs.status IN ${ACTIVE_STATUS_SQL}`, "DESC", rowLimit);
  const queuedRows = readLane(db, `jobs.status = 'queued'`, "ASC", rowLimit);
  const recentRows = readLane(db, `jobs.status IN ${TERMINAL_STATUS_SQL}`, "DESC", rowLimit);

  const selected = [...activeRows, ...queuedRows, ...recentRows].slice(0, rowLimit);
  const rows: TerminalJobRow[] = selected.map((row) => ({
    id: row.id,
    repository: sanitizeTerminalText(redact(`${row.owner}/${row.name}`)),
    pr: row.pr_number,
    stage: sanitizeTerminalText(redact(row.stage)),
    elapsedSec: elapsedSeconds(row, nowMs),
    outcome:
      row.attempt_outcome === null ? null : sanitizeTerminalText(redact(row.attempt_outcome)),
  }));

  const activeCount = Number(jobCounts.active);
  const queuedCount = Number(jobCounts.queued);
  const recentCount = Number(jobCounts.recent);
  const displayable = activeCount + queuedCount + recentCount;
  const overflow = Math.max(0, displayable - rows.length);

  const connection = deriveConnection(options.pollObservation, options.pollIntervalSec, nowMs);

  return {
    readiness: sanitizeTerminalText(redact(options.readiness)),
    connection: connection.connection,
    configured: Number(repositoryCounts.configured),
    enabled: Number(repositoryCounts.enabled),
    lastPollAt: connection.lastPollAt,
    pollAgeSec: connection.pollAgeSec,
    activeCount,
    queuedCount,
    recentCount,
    rows,
    overflow,
  };
}
