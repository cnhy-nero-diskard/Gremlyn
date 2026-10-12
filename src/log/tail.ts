import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { formatJsonRecord, LOG_LEVELS, type LogLevel, type LogRecord } from "./logger.js";
import { formatPlainRecord, sanitizePlainText } from "./presentation.js";

/**
 * Read-only log inspector (terminal-operator-experience task 2.3).
 *
 * `npm run logs -- --data-dir <dir> [--tail N] [--follow] [--format plain|json]`
 * opens `gremlyn.db` read-only and prints bounded redacted persisted records.
 * It deliberately imports neither `Store` (which migrates) nor the
 * ownership/auth modules: it cannot create or migrate a database, claim the
 * data-directory lock or authenticate to GitHub. Missing, unreadable or busy
 * stores produce a bounded safe error instead of a new database.
 *
 * Follow mode takes a consistent read-only snapshot: the high-water id is
 * computed first, the initial tail reads only at-or-below that baseline, and
 * follow resumes from the same baseline — so a record committed while the
 * initial tail is being written is neither dropped nor replayed. Every limit is
 * clamped to a hard finite bound before reaching SQLite; follow read failures
 * produce bounded rate-limited diagnostics instead of silent forever; a broken
 * output stream (EPIPE) stops the session, disposes listeners/store and exits
 * nonzero without hanging.
 */

export const DEFAULT_DATA_DIR = ".gremlyn";
export const DEFAULT_TAIL = 100;
/** Upper bound on a single tail read, regardless of the requested count. */
export const MAX_TAIL = 10_000;
/** Rows fetched per follow poll; keeps each read bounded. */
export const FOLLOW_BATCH_LIMIT = 500;
export const DEFAULT_FOLLOW_INTERVAL_MS = 250;
/** Cap on sanitized CLI/diagnostic error text. */
const MAX_ERROR_TEXT = 300;
/** Window in which repeated identical follow errors are suppressed. */
const FOLLOW_ERROR_RATE_LIMIT_MS = 5_000;

export type LogFormat = "plain" | "json";

export const LOGS_HELP = `Gremlyn read-only log inspector

Usage:
  npm run logs -- [--data-dir <directory>] [--tail <count>] [--follow] [--format plain|json]
  npm run logs -- --help

Options:
  --data-dir <directory>  Data directory holding gremlyn.db (default: ${DEFAULT_DATA_DIR}).
  --tail <count>          Most recent records to print first (default: ${DEFAULT_TAIL}, max: ${MAX_TAIL}).
  --follow                Continue printing newly appended records until stopped.
  --format <plain|json>   Output format (default: plain).
  -h, --help              Show this help.

The store is opened read-only: it is never created, migrated, locked or
authenticated. Pass --data-dir explicitly when the daemon uses a custom
directory. Stop a --follow session with Ctrl+C.
`;

export interface TailOptions {
  dataDir: string;
  tail: number;
  follow: boolean;
  format: LogFormat;
}

export type TailParseResult =
  { ok: true; options: TailOptions } | { ok: false; help: boolean; message: string };

/** Strip control/bidi characters and cap any diagnostic text. */
function capErrorText(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value);
  const sanitized = sanitizePlainText(raw).replace(/\s+/gu, " ").trim();
  return sanitized.length > MAX_ERROR_TEXT ? `${sanitized.slice(0, MAX_ERROR_TEXT)}...` : sanitized;
}

/** Clamp any limit to a hard finite non-negative integer with an upper cap. */
function clampLimit(value: number, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(fallback, max);
  const truncated = Math.trunc(n);
  if (truncated < 0) return 0;
  return Math.min(truncated, max);
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

/** Parse inspector arguments strictly; unknown options are rejected safely. */
export function parseTailArgs(argv: readonly string[]): TailParseResult {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        "data-dir": { type: "string" },
        tail: { type: "string" },
        follow: { type: "boolean" },
        format: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      help: false,
      message: capErrorText(error instanceof Error ? error.message : String(error)),
    };
  }

  if (values.help === true) return { ok: false, help: true, message: "" };

  const format = values.format;
  if (format !== undefined && format !== "plain" && format !== "json") {
    return {
      ok: false,
      help: false,
      message: `--format must be plain or json (got "${capErrorText(String(format))}")`,
    };
  }

  const tailRaw = values.tail;
  let tail = DEFAULT_TAIL;
  if (tailRaw !== undefined) {
    const parsed = positiveInteger(String(tailRaw));
    if (parsed === undefined) {
      return {
        ok: false,
        help: false,
        message: `--tail must be a positive integer (got "${capErrorText(String(tailRaw))}")`,
      };
    }
    tail = Math.min(parsed, MAX_TAIL);
  }

  const dataDirRaw = values["data-dir"];
  if (dataDirRaw !== undefined && String(dataDirRaw).length === 0) {
    return { ok: false, help: false, message: "--data-dir must not be empty" };
  }

  return {
    ok: true,
    options: {
      dataDir: dataDirRaw === undefined ? DEFAULT_DATA_DIR : String(dataDirRaw),
      tail,
      follow: values.follow === true,
      format: format === "json" ? "json" : "plain",
    },
  };
}

interface LogRow {
  id: number;
  at: string;
  level: string;
  event: string;
  job_id: number | null;
  attempt_id: number | null;
  fields: string | null;
}

const SELECT_COLUMNS = "id, at, level, event, job_id, attempt_id, fields";

/** Rebuild a redacted record from a persisted row (already redacted at write). */
export function rowToLogRecord(row: LogRow): LogRecord {
  let fields: Record<string, unknown> = {};
  if (row.fields !== null) {
    try {
      const parsed: unknown = JSON.parse(row.fields);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        fields = parsed as Record<string, unknown>;
      }
    } catch {
      fields = {};
    }
  }
  const level = (LOG_LEVELS as readonly string[]).includes(row.level)
    ? (row.level as LogLevel)
    : "info";
  return {
    at: row.at,
    level,
    event: row.event,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    fields,
  };
}

export function formatTailRecord(record: LogRecord, format: LogFormat): string {
  return format === "json" ? formatJsonRecord(record) : formatPlainRecord(record);
}

/**
 * Open the log store read-only. `fileMustExist` guarantees a missing store is
 * reported rather than created; WAL is left untouched.
 */
export function openReadOnlyLogDatabase(dataDir: string): Database.Database {
  const file = join(dataDir, "gremlyn.db");
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2_000 });
  try {
    db.pragma("busy_timeout = 2000");
  } catch {
    // Older builds may reject the pragma while still serving read-only queries.
  }
  return db;
}

/** Highest committed log id; the follow baseline. */
export function highWatermark(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(id) AS id FROM log_entries").get() as { id: number | null };
  return row.id ?? 0;
}

/**
 * Bounded tail read: the newest `limit` records in ascending order. When a
 * `baseline` is supplied it reads only ids at or below the baseline, keeping
 * the snapshot consistent with the follow high-water that follows.
 */
export function readTailRecords(
  db: Database.Database,
  limit: number,
  baseline?: number,
): LogRecord[] {
  const safe = clampLimit(limit, MAX_TAIL, MAX_TAIL);
  if (safe === 0) return [];
  let rows: LogRow[];
  if (baseline === undefined || !Number.isFinite(baseline)) {
    rows = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM log_entries ORDER BY id DESC LIMIT ?`)
      .all(safe) as LogRow[];
  } else {
    const snapshot = Math.max(0, Math.trunc(baseline));
    rows = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM log_entries WHERE id <= ? ORDER BY id DESC LIMIT ?`)
      .all(snapshot, safe) as LogRow[];
  }
  return rows.reverse().map(rowToLogRecord);
}

/** Bounded forward read for follow mode; limits are hard-clamped. */
export function readRecordsAfter(
  db: Database.Database,
  afterId: number,
  limit = FOLLOW_BATCH_LIMIT,
): { records: LogRecord[]; lastId: number } {
  const batches = clampLimit(limit, FOLLOW_BATCH_LIMIT, FOLLOW_BATCH_LIMIT);
  const after = Number.isFinite(afterId) ? Math.max(0, Math.trunc(afterId)) : 0;
  let lastId = after;
  if (batches === 0) return { records: [], lastId };
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM log_entries WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .all(after, batches) as LogRow[];
  const records: LogRecord[] = [];
  for (const row of rows) {
    records.push(rowToLogRecord(row));
    if (row.id > lastId) lastId = row.id;
  }
  return { records, lastId };
}

export interface FollowDependencies {
  /** Follow baseline; defaults to the current high-water at session creation. */
  initialBaseline?: number;
  intervalMs?: number;
  /** Injectable scheduler/clearer so tests never wait on a real timer. */
  schedule?: (tick: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  batchLimit?: number;
  /** Bounded rate-limited feedback for read/output failures. */
  onError?: (message: string) => void;
}

export interface LogFollowSession {
  /** Read any records appended since the last read; exposed for tests. */
  poll(): void;
  /** Idempotent: cancels the polling timer exactly once. */
  dispose(): void;
}

/**
 * Follow newly appended records from a baseline (no history replay). Each poll
 * is bounded; read failures surface capped, rate-limited diagnostics instead
 * of silent silence; disposal is idempotent.
 */
export function followLogRecords(
  db: Database.Database,
  format: LogFormat,
  out: (line: string) => void,
  dependencies: FollowDependencies = {},
): LogFollowSession {
  let lastId =
    dependencies.initialBaseline !== undefined && Number.isFinite(dependencies.initialBaseline)
      ? Math.max(0, Math.trunc(dependencies.initialBaseline))
      : highWatermark(db);
  let disposed = false;
  const schedule = dependencies.schedule ?? ((tick, ms) => setInterval(tick, ms));
  const cancel =
    dependencies.cancelSchedule ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

  let lastErrorText = "";
  let lastErrorAt = -Infinity;
  const reportError = (message: string): void => {
    if (dependencies.onError === undefined) return;
    const now = Date.now();
    if (message === lastErrorText && now - lastErrorAt < FOLLOW_ERROR_RATE_LIMIT_MS) return;
    lastErrorText = message;
    lastErrorAt = now;
    try {
      dependencies.onError(message);
    } catch {
      // Feedback must never tear down follow mode.
    }
  };

  const poll = (): void => {
    if (disposed) return;
    let result: { records: LogRecord[]; lastId: number };
    try {
      result = readRecordsAfter(db, lastId, dependencies.batchLimit ?? FOLLOW_BATCH_LIMIT);
    } catch (error) {
      reportError(
        `logs: follow read failed: ${capErrorText(error instanceof Error ? error.message : String(error))}`,
      );
      return;
    }
    lastId = result.lastId;
    for (const record of result.records) {
      try {
        out(`${formatTailRecord(record, format)}\n`);
      } catch {
        reportError("logs: follow output failed");
      }
    }
  };

  const handle = schedule(poll, dependencies.intervalMs ?? DEFAULT_FOLLOW_INTERVAL_MS);

  return {
    poll,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      cancel(handle);
    },
  };
}

export interface ErrorStreamLike {
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
}

export interface TailIo {
  out: (chunk: string) => void;
  err: (chunk: string) => void;
  /** Stream watched for asynchronous `error` (e.g. stdout EPIPE). */
  outputStream?: ErrorStreamLike;
  /** Wait for buffered output/errors before removing the stream listener. */
  flush?: () => Promise<void>;
  /** Test seam: resolves when the caller wants a follow session to stop. */
  waitForStop?: () => Promise<void>;
  /** Follow scheduling seams for tests. */
  followIntervalMs?: number;
  followBatchLimit?: number;
  followSchedule?: FollowDependencies["schedule"];
  followCancelSchedule?: FollowDependencies["cancelSchedule"];
}

const defaultIo: TailIo = {
  out: (chunk) => process.stdout.write(chunk),
  err: (chunk) => process.stderr.write(chunk),
  outputStream: process.stdout,
  flush: () =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write("", (error) => (error ? reject(error) : resolve())),
    ),
};

function describeStoreError(file: string, error: unknown): string {
  const safeFile = capErrorText(sanitizePlainText(file));
  const code = (error as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return `logs: log store is busy (${safeFile}); retry once the daemon is idle`;
  }
  if (code === "SQLITE_CANTOPEN" || code === "ENOENT") {
    return `logs: cannot open log store ${safeFile}`;
  }
  return `logs: cannot read ${safeFile}: ${capErrorText(error instanceof Error ? error.message : String(error))}`;
}

/** Signal-backed stop promise for a follow session; listeners are removed once. */
function signalStop(): { promise: Promise<void>; dispose: () => void } {
  const installed: NodeJS.Signals[] = [];
  let onSignal: () => void;
  const dispose = (): void => {
    for (const signal of installed) process.removeListener(signal, onSignal);
  };
  const promise = new Promise<void>((resolve) => {
    onSignal = (): void => {
      dispose();
      resolve();
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as NodeJS.Signals[]) {
      try {
        process.once(signal, onSignal);
        installed.push(signal);
      } catch {
        /* Platform-specific signal. */
      }
    }
  });
  return { promise, dispose };
}

export async function runTail(argv: readonly string[], io: TailIo = defaultIo): Promise<number> {
  const parsed = parseTailArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      io.out(LOGS_HELP);
      return 0;
    }
    io.err(`${capErrorText(parsed.message)}\n\n${LOGS_HELP}`);
    return 2;
  }

  const { options } = parsed;
  const file = join(options.dataDir, "gremlyn.db");
  let db: Database.Database;
  try {
    db = openReadOnlyLogDatabase(options.dataDir);
  } catch (error) {
    io.err(`${capErrorText(describeStoreError(file, error))}\n`);
    return 1;
  }

  let session: LogFollowSession | undefined;
  let disposeSignals: () => void = () => undefined;
  let closed = false;
  let outputFailed = false;
  let stoppedResolved = false;
  let resolveStop!: () => void;
  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const stop = (): void => {
    if (stoppedResolved) return;
    stoppedResolved = true;
    resolveStop();
  };

  const outputStream = io.outputStream;
  const onOutputError = (error: Error): void => {
    outputFailed = true;
    const detail = capErrorText(error instanceof Error ? error.message : String(error));
    try {
      io.err(`logs: log output failed (${detail})\n`);
    } catch {
      /* Both pipes may be closed. */
    }
    stop();
  };
  if (outputStream?.on !== undefined && outputStream.removeListener !== undefined) {
    outputStream.on("error", onOutputError);
  }

  const dispose = (): void => {
    disposeSignals();
    try {
      session?.dispose();
    } catch {
      // Timers are best-effort during teardown.
    }
    if (!closed) {
      closed = true;
      try {
        db.close();
      } catch {
        // A racing close must not mask the exit status.
      }
    }
    if (outputStream?.removeListener !== undefined) {
      try {
        outputStream.removeListener("error", onOutputError);
      } catch {
        // Best-effort listener cleanup.
      }
    }
  };

  const writeInitial = (records: LogRecord[]): void => {
    for (const record of records) {
      io.out(`${formatTailRecord(record, options.format)}\n`);
    }
  };

  try {
    if (options.follow) {
      // Consistent snapshot: baseline first, tail only ids <= baseline, then
      // resume follow from that same baseline.
      const baseline = highWatermark(db);
      writeInitial(readTailRecords(db, options.tail, baseline));
      const followDependencies: FollowDependencies = {
        initialBaseline: baseline,
        onError: (message) => io.err(`${capErrorText(message)}\n`),
      };
      if (io.followIntervalMs !== undefined) followDependencies.intervalMs = io.followIntervalMs;
      if (io.followBatchLimit !== undefined) followDependencies.batchLimit = io.followBatchLimit;
      if (io.followSchedule !== undefined) followDependencies.schedule = io.followSchedule;
      if (io.followCancelSchedule !== undefined) {
        followDependencies.cancelSchedule = io.followCancelSchedule;
      }
      session = followLogRecords(db, options.format, io.out, followDependencies);
      let wait: Promise<void>;
      if (io.waitForStop) wait = io.waitForStop();
      else {
        const signals = signalStop();
        disposeSignals = signals.dispose;
        wait = signals.promise;
      }
      await Promise.race([wait, stopPromise]);
      return outputFailed ? 1 : 0;
    }
    writeInitial(readTailRecords(db, options.tail));
    await io.flush?.();
    return outputFailed ? 1 : 0;
  } catch (error) {
    if (outputFailed) {
      io.err(`logs: log output failed\n`);
    } else {
      io.err(`${capErrorText(describeStoreError(file, error))}\n`);
    }
    return 1;
  } finally {
    dispose();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runTail(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${capErrorText(error instanceof Error ? error.message : String(error))}\n`,
      );
      process.exitCode = 1;
    });
}
