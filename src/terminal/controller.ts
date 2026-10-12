import type Database from "better-sqlite3";
import { formatJsonRecord, type LogRecord, type LogSink } from "../log/logger.js";
import { createPlainSink, formatPlainRecord } from "../log/presentation.js";
import { createRedactor, redactStructuredFields } from "../log/redact.js";
import { AnchoredRenderer, type PresentationStream } from "./renderer.js";
import {
  DEFAULT_TERMINAL_ROW_LIMIT,
  readTerminalSnapshot,
  sanitizeTerminalText,
  type TerminalJobRow,
  type TerminalSnapshot,
} from "./projection.js";
import { resolvePresentation, type TerminalOptions } from "./options.js";
import { formatStartupDiagnostic, type StartupStage } from "./diagnostics.js";

/** Idle indicator shown while no active or queued work exists. */
const IDLE_LINE = "Idle. Waiting for authorized review commands.";

/**
 * One display token for a job state. The recorded attempt outcome is appended
 * only when it differs from the lifecycle stage, so a `succeeded`/`failed` row
 * is never repeated as `succeeded | last: succeeded`.
 */
function stateLabel(job: TerminalJobRow): string {
  return job.outcome !== null && job.outcome.toLowerCase() !== job.stage.toLowerCase()
    ? `${job.stage} (${job.outcome})`
    : job.stage;
}

/** A current-work row, indented under its lane label. No internal ids. */
function workLine(job: TerminalJobRow): string {
  return `  ${job.repository} PR #${job.pr} | ${stateLabel(job)} | ${job.elapsedSec}s`;
}

/** The single most recent completion. */
function completionLine(job: TerminalJobRow): string {
  return `Latest: ${job.repository} PR #${job.pr} | ${stateLabel(job)} | ${job.elapsedSec}s`;
}

/** Compact fixed status header: readiness, observed health, repos, poll, sound. */
function headerLines(snapshot: TerminalSnapshot, sound: string): string[] {
  const poll = snapshot.pollAgeSec === null ? "not observed" : `${snapshot.pollAgeSec}s ago`;
  return [
    `Gremlyn | ${snapshot.readiness} | connection: ${snapshot.connection}`,
    `Repos: ${snapshot.enabled}/${snapshot.configured} enabled | Active: ${snapshot.activeCount} | Queued: ${snapshot.queuedCount}`,
    `Poll: ${poll} | Sound: ${sound} | Details: npm run logs -- --data-dir <directory>`,
  ];
}

export function snapshotLines(
  snapshot: TerminalSnapshot,
  sound: string,
  rowBudget: number,
): string[] {
  const budget = Math.max(0, Math.trunc(rowBudget));
  const header = headerLines(snapshot, sound);
  if (budget <= header.length) return header.slice(0, budget);

  const available = budget - header.length;
  const totalRows = snapshot.rows.length;
  const active = snapshot.rows.filter((job) => job.lane === "active");
  const queued = snapshot.rows.filter((job) => job.lane === "queued");
  const completion = snapshot.latestCompletion;
  const body: string[] = [];

  // Exact layout cost of showing `shown` current rows: one label per lane that
  // contributes a row, the rows themselves, and the current-work overflow
  // summary line when any current job is omitted. The summary slot is reserved
  // up front, so it can never be fabricated by replacing a rendered row.
  const workCost = (shown: number): number => {
    const activeShown = Math.min(shown, active.length);
    const queuedShown = Math.max(0, shown - active.length);
    const labels = (activeShown > 0 ? 1 : 0) + (queuedShown > 0 ? 1 : 0);
    const omitted = snapshot.overflow + (totalRows - shown);
    return labels + shown + (omitted > 0 ? 1 : 0);
  };

  if (totalRows > 0) {
    // Priority: maximize current work rows first; the single completion is
    // appended only when it fits afterward.
    let shown = totalRows;
    while (shown > 0 && workCost(shown) > available) shown -= 1;

    let emitted = 0;
    if (shown > 0 && active.length > 0) {
      body.push(`Active (${snapshot.activeCount})`);
      for (const job of active) {
        if (emitted >= shown) break;
        body.push(workLine(job));
        emitted += 1;
      }
    }
    if (shown > 0 && emitted < shown && queued.length > 0) {
      body.push(`Queued (${snapshot.queuedCount})`);
      for (const job of queued) {
        if (emitted >= shown) break;
        body.push(workLine(job));
        emitted += 1;
      }
    }
    // Exact: the full current counts minus the rows actually rendered. Terminal
    // history never contributes to this number.
    const omitted = snapshot.activeCount + snapshot.queuedCount - emitted;
    if (omitted > 0) body.push(`... ${omitted} more active/queued`);
  } else {
    body.push(IDLE_LINE);
  }

  // At most one latest completion, and only when the row budget allows it.
  if (completion !== null && body.length < available) body.push(completionLine(completion));

  return [...header, ...body];
}

/** Single stderr owner. All methods are observational, synchronous and best effort. */
export class TerminalPresentation {
  readonly sink: LogSink;
  private mode: "terminal" | "plain" | "json";
  private readonly color: boolean;
  readonly interactive: boolean;
  private renderer: AnchoredRenderer | undefined;
  private readonly plain: LogSink;
  private secrets: readonly string[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readiness = "starting";
  private lastSuccessAt: number | null = null;
  private failed = false;
  private enabled: boolean;
  private muted: boolean;
  private soundControlAvailable = false;
  private pendingReason: string | undefined;
  private observe: (() => void) | undefined;
  private readonly streamError = (): void => {
    this.degrade();
  };

  constructor(
    options: TerminalOptions,
    private readonly stream: PresentationStream = process.stderr,
    env: NodeJS.ProcessEnv = process.env,
    secrets: readonly string[] = [],
    private readonly now: () => number = Date.now,
  ) {
    const resolved = resolvePresentation(options, stream, env);
    this.mode = resolved.mode;
    this.color = resolved.color;
    this.interactive = resolved.interactive;
    this.secrets = secrets;
    this.enabled = options.sound;
    this.muted = options.mute;
    this.plain = createPlainSink((line) => this.write(line));
    this.sink = (record) => this.present(record);
    // Remain subscribed through plain fallback to absorb asynchronous EPIPE/errors.
    stream.on?.("error", this.streamError);
    if (this.mode === "terminal")
      this.renderer = new AnchoredRenderer(stream, () => this.degrade(), now);
    this.pendingReason = resolved.reason;
  }

  setSecrets(secrets: readonly string[]): void {
    this.secrets = secrets;
  }

  diagnostic(error: unknown, stage: StartupStage): void {
    const { event, nextAction } = formatStartupDiagnostic(error, stage, this.secrets);
    this.sink({
      at: new Date(this.now()).toISOString(),
      level: "error",
      event,
      fields: { nextAction },
    });
  }

  setReadiness(readiness: string): void {
    this.readiness = readiness;
    this.reportReason();
    if (!this.timer)
      this.renderer?.render(
        [
          `Gremlyn | ${readiness} | connection: unknown`,
          `Active: 0 | Queued: 0 | Sound: ${this.soundLabel()}`,
        ],
        this.color,
      );
  }

  setSoundControlAvailable(available: boolean): void {
    this.soundControlAvailable = available && this.interactive;
  }

  recordPoll(success: boolean): void {
    this.failed = !success;
    if (success) this.lastSuccessAt = this.now();
  }

  setSound(enabled: boolean, muted: boolean): void {
    this.enabled = enabled;
    this.muted = muted;
    this.sink({
      at: new Date(this.now()).toISOString(),
      level: "info",
      event: `sound ${this.soundLabel()}`,
      fields: {},
    });
  }

  attach(
    db: Database.Database,
    pollIntervalSec: number,
    observe?: () => void,
    configuredRepositoryIds?: readonly number[],
  ): void {
    if (this.stopped || this.timer) return;
    this.observe = observe;
    const refresh = (): void => {
      if (this.stopped) return;
      try {
        this.observe?.();
      } catch {
        /* Observation has no execution authority. */
      }
      if (this.mode !== "terminal") return;
      try {
        const snapshot = readTerminalSnapshot(db, {
          now: this.now(),
          pollIntervalSec,
          readiness: this.readiness,
          pollObservation: { lastSuccessAt: this.lastSuccessAt, failed: this.failed },
          secrets: this.secrets,
          rowLimit: DEFAULT_TERMINAL_ROW_LIMIT,
          ...(configuredRepositoryIds === undefined ? {} : { configuredRepositoryIds }),
        });
        this.renderer?.render(
          snapshotLines(snapshot, this.soundLabel(), (this.renderer?.dimensions.rows ?? 24) - 2),
          this.color,
        );
      } catch {
        this.degrade();
      }
    };
    this.timer = setInterval(refresh, 250);
    refresh();
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.observe = undefined;
    try {
      this.renderer?.dispose();
    } finally {
      this.stream.removeListener?.("error", this.streamError);
    }
  }

  private soundLabel(): string {
    const state = !this.enabled ? "disabled" : this.muted ? "muted" : "enabled";
    return (
      state +
      (this.soundControlAvailable
        ? ` [m: ${!this.enabled ? "enable" : this.muted ? "unmute" : "mute"}]`
        : "")
    );
  }

  private present(record: LogRecord): void {
    if (this.stopped) return;
    this.reportReason();
    try {
      const redact = createRedactor(this.secrets);
      const safe: LogRecord = {
        ...record,
        at: redact(record.at),
        event: redact(record.event),
        fields: redactStructuredFields(record.fields, redact),
      };
      if (this.mode === "json") this.write(`${formatJsonRecord(safe)}\n`);
      else if (this.mode === "plain") this.plain(safe);
      else if (safe.level === "warn" || safe.level === "error" || safe.event.startsWith("sound ")) {
        this.renderer?.diagnostic(formatPlainRecord(safe));
        // A failed diagnostic write may have degraded the renderer mid-call.
        if ((this.mode as string) === "plain") this.plain(safe);
      }
    } catch {
      /* A bad sink never changes a job or startup outcome. */
    }
  }

  private reportReason(): void {
    if (!this.pendingReason) return;
    const reason = this.pendingReason;
    this.pendingReason = undefined;
    this.plain({
      at: new Date(this.now()).toISOString(),
      level: "warn",
      event: reason,
      fields: {},
    });
  }

  private degrade(): void {
    if (this.stopped || this.mode !== "terminal") return;
    this.mode = "plain";
    try {
      this.renderer?.dispose();
    } catch {
      /* Best effort. */
    }
    this.renderer = undefined;
    this.write(
      "WARN Terminal display unavailable; using plain output. Inspect details with npm run logs.\n",
    );
  }

  private write(line: string): void {
    try {
      this.stream.write(
        this.mode === "json" ? line : sanitizeTerminalText(line.replace(/\n$/, ""), 1_000) + "\n",
      );
    } catch {
      /* Even stderr may be permanently closed. */
    }
  }
}
