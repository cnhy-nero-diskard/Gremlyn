import type Database from "better-sqlite3";
import { formatJsonRecord, type LogRecord, type LogSink } from "../log/logger.js";
import { createPlainSink, formatPlainRecord } from "../log/presentation.js";
import { createRedactor, redactStructuredFields } from "../log/redact.js";
import { AnchoredRenderer, type PresentationStream } from "./renderer.js";
import { readTerminalSnapshot, sanitizeTerminalText, type TerminalSnapshot } from "./projection.js";
import { resolvePresentation, type TerminalOptions } from "./options.js";
import { formatStartupDiagnostic, type StartupStage } from "./diagnostics.js";

export function snapshotLines(
  snapshot: TerminalSnapshot,
  sound: string,
  rowBudget: number,
): string[] {
  const header = [
    `Gremlyn | ${snapshot.readiness} | connection: ${snapshot.connection}`,
    `Repositories: ${snapshot.enabled}/${snapshot.configured} enabled | Active: ${snapshot.activeCount} | Queued: ${snapshot.queuedCount}`,
    `Last poll: ${snapshot.lastPollAt ?? "not observed"}${snapshot.pollAgeSec === null ? "" : ` (${snapshot.pollAgeSec}s ago)`}`,
    `Sound: ${sound} | Details: npm run logs -- --data-dir <directory>`,
  ];
  if (rowBudget <= header.length) return header.slice(0, rowBudget);
  const available = Math.max(0, rowBudget - header.length - 1);
  const visible = snapshot.rows.slice(0, available);
  const rows = visible.map(
    (job) =>
      `#${job.id} ${job.repository} PR #${job.pr} | ${job.stage} | ${job.elapsedSec}s${job.outcome ? ` | last: ${job.outcome}` : ""}`,
  );
  const overflow = snapshot.overflow + snapshot.rows.length - visible.length;
  return [
    ...header,
    ...rows,
    overflow
      ? `... ${overflow} more jobs (active/queued/recent)`
      : rows.length
        ? ""
        : "No jobs yet. Waiting for authorized review commands.",
  ];
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
        [`Gremlyn | ${readiness} | connection: unknown`, `Sound: ${this.soundLabel()}`],
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
          rowLimit: 16,
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
