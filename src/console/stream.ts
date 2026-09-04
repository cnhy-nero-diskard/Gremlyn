import type { IncomingMessage, ServerResponse } from "node:http";
import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { activityPath } from "../agent/activity.js";

export type StreamChange = { sequence: number };
export type StreamListener = (change: StreamChange) => void;
export type StreamEnd = () => void;
export type StreamRegistrar = (end: StreamEnd) => () => void;

export class SharedChangeTicker {
  private readonly listeners = new Set<StreamListener>();
  private timer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private lastSignature: string;
  constructor(
    private readonly db: Database.Database,
    private readonly intervalMs = 250,
    private readonly dataDir = ".gremlyn",
  ) {
    this.lastSignature = this.signature();
  }
  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }
  get subscriberCount(): number {
    return this.listeners.size;
  }
  get isRunning(): boolean {
    return this.timer !== undefined;
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }
  private start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  private tick(): void {
    const current = this.signature();
    if (current === this.lastSignature) return;
    this.lastSignature = current;
    const change = { sequence: ++this.sequence };
    for (const listener of [...this.listeners]) listener(change);
  }
  private signature(): string {
    try {
      const row = this.db
        .prepare(
          `SELECT (SELECT COALESCE(MAX(id), 0) FROM jobs) AS jobs, (SELECT GROUP_CONCAT(id || ':' || status || ':' || COALESCE(finished_at, ''), '|') FROM jobs) AS job_states, (SELECT COALESCE(MAX(id), 0) FROM attempts) AS attempts, (SELECT GROUP_CONCAT(id || ':' || COALESCE(outcome, '') || ':' || COALESCE(started_at, '') || ':' || COALESCE(ended_at, ''), '|') FROM attempts) AS attempt_states, (SELECT COALESCE(MAX(id), 0) FROM status_events) AS statuses, (SELECT COALESCE(MAX(id), 0) FROM log_entries) AS logs, (SELECT COALESCE(MAX(id), 0) FROM operator_actions) AS actions, (SELECT GROUP_CONCAT(id || ':' || enabled, '|') FROM repositories) AS repository_states, (SELECT GROUP_CONCAT(output_ref, '|') FROM attempts WHERE output_ref IS NOT NULL) AS attempt_outputs, (SELECT GROUP_CONCAT(output_ref, '|') FROM validation_runs WHERE output_ref IS NOT NULL) AS validation_outputs, (SELECT GROUP_CONCAT(id, '|') FROM attempts WHERE ended_at IS NULL) AS live_attempts`,
        )
        .get() as Record<string, unknown>;
      const paths = [row.attempt_outputs, row.validation_outputs]
        .filter((value): value is string => typeof value === "string")
        .flatMap((value) => value.split("|"));
      // A running agent writes only its activity snapshot: no row changes, so
      // without this the log would sit still for the whole attempt.
      if (typeof row.live_attempts === "string") {
        for (const id of row.live_attempts.split("|")) {
          const attemptId = Number(id);
          if (Number.isInteger(attemptId)) paths.push(activityPath(this.dataDir, attemptId));
        }
      }
      const files = paths.map((path) => {
        try {
          const stat = statSync(path);
          return `${path}:${stat.size}:${stat.mtimeMs}`;
        } catch {
          return `${path}:missing`;
        }
      });
      return JSON.stringify({ ...row, files });
    } catch {
      return "closed";
    }
  }
}

export function sseEvent(event: string, fragments: Record<string, string>): string {
  return `event: ${event}\ndata: ${JSON.stringify(fragments)}\n\n`;
}

export interface HeldOpenStreamOptions {
  request: IncomingMessage;
  response: ServerResponse;
  ticker: SharedChangeTicker;
  event: string;
  initial: Record<string, string>;
  render: () => Record<string, string>;
  snapshot?: boolean;
  keepaliveMs?: number;
  register?: StreamRegistrar;
}

export function openSseStream(options: HeldOpenStreamOptions): void {
  const { request, response, ticker, event, initial, render } = options;
  response.statusCode = 200;
  response.setHeader("cache-control", "no-cache");
  response.setHeader("connection", "keep-alive");
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.write(sseEvent(event, initial));
  if (options.snapshot) {
    response.end();
    return;
  }
  let closed = false;
  let unsubscribe = (): void => undefined;
  let unregister = (): void => undefined;
  const keepalive = setInterval(() => {
    if (!closed) {
      try {
        response.write(": keepalive\n\n");
      } catch {
        cleanup();
      }
    }
  }, options.keepaliveMs ?? 15_000);
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
    unregister();
    if (!response.writableEnded) response.end();
  };
  unregister = options.register?.(cleanup) ?? unregister;
  unsubscribe = ticker.subscribe(() => {
    if (closed) return;
    try {
      response.write(sseEvent(event, render()));
    } catch {
      cleanup();
    }
  });
  request.once("close", cleanup);
  request.once("error", cleanup);
}
