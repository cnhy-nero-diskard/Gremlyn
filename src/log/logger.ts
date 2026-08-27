import type Database from "better-sqlite3";
import { createRedactor, type Redactor } from "./redact.js";

/**
 * Structured logging (operator-console spec: structured operational log).
 *
 * Every entry is a JSON line on stderr and a row in `log_entries`, carrying
 * job/attempt correlation fields when present. Configured secret values are
 * redacted before anything is emitted or persisted.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  jobId?: number;
  attemptId?: number;
  [key: string]: unknown;
}

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly redact: Redactor;
  private readonly db: Database.Database | undefined;

  constructor(options: { level: LogLevel; secrets: readonly string[]; db?: Database.Database }) {
    this.minLevel = options.level;
    this.redact = createRedactor(options.secrets);
    this.db = options.db;
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const at = new Date().toISOString();
    const { jobId, attemptId, ...rest } = fields;
    const sanitized = JSON.parse(this.redact(JSON.stringify(rest))) as Record<string, unknown>;
    const line = JSON.stringify({
      at,
      level,
      event: this.redact(event),
      ...(jobId !== undefined ? { jobId } : {}),
      ...(attemptId !== undefined ? { attemptId } : {}),
      ...sanitized,
    });
    process.stderr.write(line + "\n");
    this.db
      ?.prepare(
        "INSERT INTO log_entries (at, level, event, job_id, attempt_id, fields) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        at,
        level,
        this.redact(event),
        jobId ?? null,
        attemptId ?? null,
        JSON.stringify(sanitized),
      );
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
