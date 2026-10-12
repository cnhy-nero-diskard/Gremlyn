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

/** Human-readable durations keep the status useful without growing without bound. */
function formatDuration(seconds: number): string {
  const duration = Math.max(0, Math.trunc(seconds));
  if (duration < 60) return `${duration}s`;
  const minutes = Math.floor(duration / 60);
  const remainder = duration % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

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
function workLine(job: TerminalJobRow, columns: number): string {
  if (columns >= 80) {
    const suffix = ` PR #${job.pr} | ${stateLabel(job)} | ${formatDuration(job.elapsedSec)} elapsed`;
    // Reserve the status suffix and renderer margin before truncating the repository.
    const repositoryWidth = Math.max(1, columns - 1 - 2 - suffix.length);
    return `  ${fitText(job.repository, repositoryWidth)}${suffix}`;
  }

  const width = Math.max(1, columns - 1);
  const state = stateLabel(job);
  const full = `${state} #${job.pr}`;
  const stage = `${job.stage} #${job.pr}`;
  const line = full.length <= width ? full : stage.length <= width ? stage : `#${job.pr}`;
  return `${line} | ${job.repository} | ${formatDuration(job.elapsedSec)} elapsed`;
}

function fitText(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  const contentWidth = width - 3;
  const prefixWidth = Math.ceil(contentWidth / 2);
  const suffixWidth = Math.floor(contentWidth / 2);
  return `${text.slice(0, prefixWidth)}...${suffixWidth > 0 ? text.slice(-suffixWidth) : ""}`;
}

/** The single most recent completion. */
function completionLine(job: TerminalJobRow, columns: number): string {
  const completionAge =
    job.completionAgeSec === null ? "" : ` | completed ${formatDuration(job.completionAgeSec)} ago`;
  const prefix = "Latest outcome: ";
  const suffix = ` PR #${job.pr} | ${stateLabel(job)} | job ${formatDuration(job.elapsedSec)}${completionAge}`;
  if (columns < 80) {
    const width = Math.max(1, columns - 1);
    const state = stateLabel(job);
    const shortState = `${job.stage}`;
    const status = `#${job.pr} ${state}`;
    const compactStatus = `#${job.pr} ${shortState}`;
    let line = status.length <= width ? status : compactStatus;
    if (job.completionAgeSec !== null) {
      const age = formatDuration(job.completionAgeSec);
      const withAge = `${line} ${age} ago`;
      const withShortAge = `${line} ${age}`;
      const compactAge = age.replace(/ \d{2}(?:s|m)$/, "");
      const withCompactAge = `${line} ${compactAge}`;
      if (withAge.length <= width) line = withAge;
      else if (withShortAge.length <= width) line = withShortAge;
      else if (withCompactAge.length <= width) line = withCompactAge;
    }
    const labeled = `Result ${line}`;
    if (labeled.length <= width) line = labeled;
    if (`${line} | ${job.repository}`.length <= width) line += ` | ${job.repository}`;
    return line;
  }
  const repositoryWidth = Math.max(1, columns - 1 - prefix.length - suffix.length);
  return `${prefix}${fitText(job.repository, repositoryWidth)}${suffix}`;
}

/** Word-wrap fixed help text so the long detail command is never header-truncated. */
function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word.length > safeWidth) {
      if (line) lines.push(line);
      line = "";
      for (let offset = 0; offset < word.length; offset += safeWidth) {
        const part = word.slice(offset, offset + safeWidth);
        if (part.length === safeWidth) lines.push(part);
        else line = part;
      }
    } else if (!line) line = word;
    else if (line.length + word.length + 1 <= safeWidth) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function helpLines(columns: number, rowBudget: number): string[] {
  const width = Math.max(1, columns - 1);
  const budget = Math.max(0, Math.trunc(rowBudget));
  const details = wrapText("Details: npm run logs -- --data-dir <directory>", width);
  const helpControl = wrapText("? / h Return to dashboard", width);
  const quitControl = wrapText("q Graceful shutdown", width);
  const compactControls = wrapText("? / h back | q quit", width);
  const fullControls = [...helpControl, ...quitControl];
  const controls = details.length + fullControls.length <= budget ? fullControls : compactControls;
  // Keep the detail command and both navigation actions ahead of optional guidance.
  const essential = [...details, ...controls];
  let spare = Math.max(0, budget - essential.length);
  const optional = [
    wrapText("Gremlyn | Help", width),
    wrapText("Read-only display; no job actions are available here.", width),
    wrapText("m Enable sound or toggle mute", width),
    wrapText("Ctrl+C Stop; repeat requests retain escalation", width),
  ];
  const included: boolean[] = [];
  for (const [index, group] of optional.entries()) {
    if (group.length > spare) continue;
    included[index] = true;
    spare -= group.length;
  }

  return [
    ...(included[0] ? (optional[0] ?? []) : []),
    ...details,
    ...(included[1] ? (optional[1] ?? []) : []),
    ...controls,
    ...(included[2] ? (optional[2] ?? []) : []),
    ...(included[3] ? (optional[3] ?? []) : []),
  ];
}

/** Scan-friendly status groups; compact labels keep health and keys visible when narrow. */
function headerLines(
  snapshot: TerminalSnapshot,
  sound: string,
  columns: number,
  controlsAvailable: boolean,
  controlsReady: boolean,
): string[] {
  const poll =
    snapshot.pollAgeSec === null ? "not observed" : `${formatDuration(snapshot.pollAgeSec)} ago`;
  const wide = columns >= 52;
  const keys = shortcutLines(columns, controlsAvailable);
  const lines = [
    `Gremlyn | ${snapshot.readiness}`,
    `Health: ${snapshot.connection.toUpperCase()}`,
    ...(wide
      ? [
          `Repositories: ${snapshot.enabled} enabled / ${snapshot.configured} configured`,
          `Work: ${snapshot.activeCount} active | ${snapshot.queuedCount} queued`,
        ]
      : [
          `Repos ${snapshot.enabled}/${snapshot.configured}`,
          `A:${snapshot.activeCount} Q:${snapshot.queuedCount}`,
        ]),
    `Poll: ${poll}`,
    `Sound: ${sound}`,
  ];
  if (controlsReady) lines.push(...keys);
  return lines;
}

function shortcutLines(columns: number, controlsAvailable: boolean): string[] {
  if (!controlsAvailable) return ["Ctrl+C to stop"];
  if (columns < 28) return ["? help", "m sound / q quit"];
  return [columns < 38 ? "? help  m sound  q quit" : "Keys: ? help  m sound  q quit"];
}

/** One-line current-work summary for a short, ready interactive surface. */
function compactWorkLine(snapshot: TerminalSnapshot, columns: number): string {
  const currentCount = snapshot.activeCount + snapshot.queuedCount;
  const job = snapshot.rows[0];
  if (job === undefined) {
    if (currentCount > 0) return `+${currentCount} active/queued`;
    if (snapshot.latestCompletion !== null)
      return completionLine(snapshot.latestCompletion, columns);
    return "Idle. Waiting.";
  }

  const width = Math.max(1, columns - 1);
  const full = `${stateLabel(job)} #${job.pr}`;
  const stage = `${job.stage} #${job.pr}`;
  let line = full.length <= width ? full : stage.length <= width ? stage : `#${job.pr}`;
  const omitted = Math.max(0, currentCount - 1);
  if (omitted > 0) {
    const detailed = `${line} +${omitted} more`;
    const compact = `${line} +${omitted}`;
    if (detailed.length <= width) line = detailed;
    else if (compact.length <= width) line = compact;
  }
  return line;
}

/** Keep work and the shortcut hint visible before optional status detail. */
function compactSnapshotLines(
  snapshot: TerminalSnapshot,
  sound: string,
  budget: number,
  columns: number,
  controlsAvailable: boolean,
): string[] {
  const keys = shortcutLines(columns, controlsAvailable);
  const primary = compactWorkLine(snapshot, columns);
  const lines = [`Gremlyn | ${snapshot.readiness}`, primary];
  const optional = [
    `Health: ${snapshot.connection.toUpperCase()}`,
    ...(snapshot.latestCompletion !== null && snapshot.rows.length > 0
      ? [completionLine(snapshot.latestCompletion, columns)]
      : []),
    `Work: ${snapshot.activeCount} active | ${snapshot.queuedCount} queued`,
    `Poll: ${snapshot.pollAgeSec === null ? "not observed" : `${formatDuration(snapshot.pollAgeSec)} ago`}`,
    `Sound: ${sound}`,
  ];
  const spare = Math.max(0, budget - lines.length - keys.length);
  lines.push(...optional.slice(0, spare));
  lines.push(...keys);
  return lines.slice(0, budget);
}

export function snapshotLines(
  snapshot: TerminalSnapshot,
  sound: string,
  rowBudget: number,
  columns = 80,
  controlsAvailable = false,
  controlsReady = true,
): string[] {
  const budget = Math.max(0, Math.trunc(rowBudget));
  const header = headerLines(snapshot, sound, columns, controlsAvailable, controlsReady);
  const active = snapshot.rows.filter((job) => job.lane === "active");
  const queued = snapshot.rows.filter((job) => job.lane === "queued");
  const totalRows = snapshot.rows.length;
  const minimumWorkCost =
    totalRows === 0 ? 1 : 1 + (snapshot.activeCount + snapshot.queuedCount > 1 ? 2 : 1);
  if (controlsReady && budget < header.length + minimumWorkCost)
    return compactSnapshotLines(snapshot, sound, budget, columns, controlsAvailable);
  if (budget <= header.length) return header.slice(0, budget);

  const available = budget - header.length;
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
        body.push(workLine(job, columns));
        emitted += 1;
      }
    }
    if (shown > 0 && emitted < shown && queued.length > 0) {
      body.push(`Queued (${snapshot.queuedCount})`);
      for (const job of queued) {
        if (emitted >= shown) break;
        body.push(workLine(job, columns));
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
  if (completion !== null && body.length < available)
    body.push(completionLine(completion, columns));

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
  private inputSetupComplete = false;
  private helpVisible = false;
  private pendingReason: string | undefined;
  private observe: (() => void) | undefined;
  private refresh: (() => void) | undefined;
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
          `Gremlyn | ${readiness}`,
          "Health: UNKNOWN",
          `Sound: ${this.soundLabel()}`,
          ...(this.inputSetupComplete
            ? [this.soundControlAvailable ? "Keys: ? help  m sound  q quit" : "Ctrl+C to stop"]
            : []),
        ],
        this.color,
      );
  }

  setSoundControlAvailable(available: boolean): void {
    const supported = available && this.interactive;
    if (this.inputSetupComplete && this.soundControlAvailable === supported) return;
    this.inputSetupComplete = true;
    this.soundControlAvailable = supported;
    this.refresh?.();
  }

  toggleHelp(): void {
    if (!this.soundControlAvailable || this.stopped) return;
    this.helpVisible = !this.helpVisible;
    this.refresh?.();
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
        const { columns, rows } = this.renderer?.dimensions ?? { columns: 80, rows: 24 };
        const lines = this.helpVisible
          ? helpLines(columns, rows - 2)
          : snapshotLines(
              snapshot,
              this.soundLabel(),
              rows - 2,
              columns,
              this.soundControlAvailable,
              this.inputSetupComplete,
            );
        this.renderer?.render(lines, this.color);
      } catch {
        this.degrade();
      }
    };
    this.refresh = refresh;
    this.timer = setInterval(refresh, 250);
    refresh();
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.observe = undefined;
    this.refresh = undefined;
    try {
      this.renderer?.dispose();
    } finally {
      this.stream.removeListener?.("error", this.streamError);
    }
  }

  private soundLabel(): string {
    return !this.enabled ? "disabled" : this.muted ? "muted" : "enabled";
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
