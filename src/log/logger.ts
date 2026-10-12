import type Database from "better-sqlite3";
import { createRedactor, type Redactor } from "./redact.js";

/**
 * Structured logging (operator-console spec: structured operational log;
 * terminal-operator-experience design D2).
 *
 * Every entry is built once as a single redacted {@link LogRecord}. The record
 * is persisted to `log_entries` at the configured level first; the injectable
 * {@link LogSink} (legacy default: one JSON line on stderr) then receives its
 * own independent redacted copy. Configured secret values are redacted before
 * anything is emitted or persisted, so every consumer observes exactly one
 * redacted representation.
 *
 * A sink is a presentation seam, not a data path: it must never be able to
 * change the persisted fields. Persisting first and handing the sink an
 * independent copy guarantees a malicious or defective sink cannot mutate the
 * durable record or fail a caller's logging call.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** A single redacted operational record, independent of any presentation. */
export interface LogRecord {
  at: string;
  level: LogLevel;
  event: string;
  jobId?: number;
  attemptId?: number;
  fields: Record<string, unknown>;
}

/** Receives each emitted record; implementations must not throw. */
export type LogSink = (record: LogRecord) => void;

export interface LogFields {
  jobId?: number;
  attemptId?: number;
  [key: string]: unknown;
}

/**
 * Serialize a record to the legacy single-line JSON shape. Correlation fields
 * are hoisted only when present and dynamic fields are spread last, matching
 * the historical stderr contract byte-for-byte.
 */
export function formatJsonRecord(record: LogRecord): string {
  return JSON.stringify({
    at: record.at,
    level: record.level,
    event: record.event,
    ...(record.jobId !== undefined ? { jobId: record.jobId } : {}),
    ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
    ...record.fields,
  });
}

/** Default console sink: one JSON line per record on the given stream. */
export function createJsonStderrSink(
  stream: { write(chunk: string): unknown } = process.stderr,
): LogSink {
  return (record: LogRecord): void => {
    stream.write(`${formatJsonRecord(record)}\n`);
  };
}

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly redact: Redactor;
  private readonly db: Database.Database | undefined;
  private readonly sink: LogSink;

  constructor(options: {
    level: LogLevel;
    secrets: readonly string[];
    db?: Database.Database;
    /** Defaults to the legacy JSON-on-stderr sink. */
    sink?: LogSink;
  }) {
    this.minLevel = options.level;
    this.redact = createRedactor(options.secrets);
    this.db = options.db;
    this.sink = options.sink ?? createJsonStderrSink();
  }

  /** Build the one redacted record shared by every consumer. */
  private buildRecord(level: LogLevel, event: string, fields: LogFields): LogRecord {
    const { jobId, attemptId, ...rest } = fields;
    const sanitized = JSON.parse(this.redact(JSON.stringify(rest))) as Record<string, unknown>;
    return {
      at: new Date().toISOString(),
      level,
      event: this.redact(event),
      ...(jobId !== undefined ? { jobId } : {}),
      ...(attemptId !== undefined ? { attemptId } : {}),
      fields: sanitized,
    };
  }

  /** A shallow independent copy: sink mutations cannot reach the persisted row. */
  private independentCopy(record: LogRecord): LogRecord {
    return {
      ...record,
      fields: { ...record.fields },
    };
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const record = this.buildRecord(level, event, fields);
    // Durability before presentation, each step independently guarded: a sink
    // that throws (or mutates its copy) must not change the persisted record,
    // and a store closed by a racing shutdown must not turn a log call into a
    // thrown exception.
    try {
      this.db
        ?.prepare(
          "INSERT INTO log_entries (at, level, event, job_id, attempt_id, fields) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.at,
          record.level,
          record.event,
          record.jobId ?? null,
          record.attemptId ?? null,
          JSON.stringify(record.fields),
        );
    } catch {
      // Best-effort: a store closed by a racing shutdown must not turn a log
      // call into a thrown exception.
    }
    try {
      this.sink(this.independentCopy(record));
    } catch {
      // A presentation defect is contained; processing and persistence continue.
    }
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }
}
