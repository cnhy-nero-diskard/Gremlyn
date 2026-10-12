import type Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Committed outcome dispatch and bounded Windows outcome audio (design D4/D5).
 *
 * Two deliberately independent pieces:
 *
 * - {@link OutcomeObserver} consumes newly committed `status_events` rows and
 *   claims each one before requesting a cue. It knows nothing about job
 *   execution, so an in-flight audio helper can never hold the database open.
 * - {@link AudioQueue} owns the single best-effort playback lane. Unsupported
 *   platforms degrade to a no-op; overloading, failure, timeout and mute never
 *   block or change a job result.
 *
 * No test in the automated suite plays real audio: the process launcher and
 * clock are injectable seams.
 */

export type Cue = "success" | "failure";

/** Closed enum of packaged cue files. Never derived from dynamic input. */
const CUE_AUDIO_FILES: Record<Cue, string> = {
  success: "success.wav",
  failure: "failure.wav",
};

/**
 * Runtime guard for the closed cue enum. TypeScript types are erased, so a
 * JavaScript caller could otherwise pass an arbitrary string into a helper
 * invocation; every entry point re-validates here.
 */
export function isCue(value: unknown): value is Cue {
  return value === "success" || value === "failure";
}

function assertCue(value: unknown): asserts value is Cue {
  if (!isCue(value)) throw new TypeError(`invalid audio cue: ${JSON.stringify(value)}`);
}

/** The one fixed PowerShell helper asset. */
const SOUND_HELPER_FILE = "play-sound.ps1";

/**
 * The packaged asset directory relative to this module. The same relative
 * offset is correct for the TypeScript source (`src/terminal/`) and the compiled
 * output (`dist/terminal/`), because both live one directory below the repo
 * root, so a single resolution covers source and built launches.
 */
export function terminalAssetsDir(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../assets/terminal/", moduleUrl));
}

export interface TerminalAssetOptions {
  /** Explicit override; primarily for injected tests. */
  assetsDir?: string;
  /** Module URL to resolve from; override to prove built-output resolution. */
  moduleUrl?: string;
}

/**
 * Resolve the packaged terminal asset directory. An explicit directory wins;
 * otherwise only the module-relative packaged location is used. Resolution is observational and never
 * depends on a job, repository or operator string.
 */
export function resolveTerminalAssetsDir(options: TerminalAssetOptions = {}): string {
  if (options.assetsDir !== undefined) return options.assetsDir;
  return terminalAssetsDir(options.moduleUrl ?? import.meta.url);
}

/** Resolve a cue's packaged WAV path within the terminal asset directory. */
export function cueAssetPath(cue: Cue, options: TerminalAssetOptions = {}): string {
  assertCue(cue);
  return join(resolveTerminalAssetsDir(options), CUE_AUDIO_FILES[cue]);
}

/** Resolve the fixed SoundPlayer helper path within the terminal asset directory. */
export function soundHelperPath(options: TerminalAssetOptions = {}): string {
  return join(resolveTerminalAssetsDir(options), SOUND_HELPER_FILE);
}

/**
 * Fixed PowerShell invocation for one cue. The argument vector contains only
 * literal flags, the closed cue enum, the resolved helper path and the resolved
 * asset directory. No job/repository string is ever interpolated, and the
 * caller passes the vector directly to the process launcher (no shell).
 */
export function soundHelperArgs(cue: Cue, assetsDir: string): string[] {
  assertCue(cue);
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(assetsDir, SOUND_HELPER_FILE),
    "-Cue",
    cue,
    "-AssetDir",
    assetsDir,
  ];
}

/** Resolve the Windows PowerShell executable, matching the credential helper. */
export function resolvePowerShell(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "powershell.exe";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return systemRoot
    ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/* ------------------------------------------------------------------ *
 * Outcome observation
 * ------------------------------------------------------------------ */

export type CueDispatch = (cue: Cue) => void;

export interface OutcomeObserverOptions {
  /**
   * Maximum rows processed per scan. Defaults to {@link MAX_SCAN_BATCH}; values
   * are clamped into `[1, MAX_SCAN_BATCH]` so injected knobs cannot make one
   * scan do unbounded observational work.
   */
  batchSize?: number;
}

/** Hard ceiling on rows processed by a single scan. */
export const MAX_SCAN_BATCH = 500;
const DEFAULT_BATCH_SIZE = MAX_SCAN_BATCH;

/**
 * Consume newly committed job outcome transitions and request at most one cue
 * per transition.
 *
 * The constructor records the current `status_events` high-water mark, so
 * constructing it after startup recovery establishes a baseline that never
 * replays history. Each `scan` reads at most one ordered, capped batch, advances
 * the cursor over every row it reads and only then dispatches, so a duplicate
 * observation, a restart or a muted/disabled period can never replay a consumed
 * event. A suppressed scan also records the then-current maximum event id as
 * `suppressedThrough`, so every row that existed during a disabled/muted state
 * is permanently ineligible even while the backlog drains across bounded ticks.
 * Rows observed inside an open transaction on this connection are skipped: they
 * may yet roll back.
 */
export class OutcomeObserver {
  private readonly batchSize: number;
  private lastEventId: number;
  private suppressedThrough: number;

  constructor(
    private readonly db: Database.Database,
    private readonly dispatch: CueDispatch,
    options: OutcomeObserverOptions = {},
  ) {
    const requested = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const finite = Number.isFinite(requested) ? Math.trunc(requested) : DEFAULT_BATCH_SIZE;
    this.batchSize = Math.min(MAX_SCAN_BATCH, Math.max(1, finite));
    this.lastEventId = this.highWaterMark();
    this.suppressedThrough = 0;
  }

  /** Current baseline/cursor; exposed for tests and status feedback. */
  get lastConsumedEventId(): number {
    return this.lastEventId;
  }

  /** Highest event id permanently suppressed by a disabled/muted scan. */
  get suppressedThroughEventId(): number {
    return this.suppressedThrough;
  }

  /**
   * Advance over one bounded ordered batch of committed transitions. Rows are
   * always claimed, even while muted or disabled, so muting suppresses future
   * dispatch without saving sound for later. Only `succeeded`/`failed` rows
   * request a cue, and only while sound is both enabled and unmuted; the
   * backlog is drained across successive scans rather than in one call.
   */
  scan(enabled: boolean, muted: boolean): void {
    // A scan that ran inside this connection's transaction could observe rows
    // that later roll back. Never claim those.
    if (this.db.inTransaction) return;
    const suppressed = !enabled || muted;
    if (suppressed) {
      // Remember everything that exists during suppression so a later unmute
      // cannot replay it, regardless of how the backlog drains.
      const maxId = this.highWaterMark();
      if (maxId > this.suppressedThrough) this.suppressedThrough = maxId;
    }
    const rows = this.db
      .prepare("SELECT id, status FROM status_events WHERE id > ? ORDER BY id LIMIT ?")
      .all(this.lastEventId, this.batchSize) as { id: number; status: string }[];
    for (const row of rows) {
      // Claim before dispatch: a crash or dispatch failure after this point must
      // not replay the event, matching the at-most-once request contract.
      this.lastEventId = row.id;
      if (suppressed || row.id <= this.suppressedThrough) continue;
      const cue = cueForStatus(row.status);
      if (cue === null) continue;
      try {
        this.dispatch(cue);
      } catch {
        // Audio/dispatch failure is observational and must not stop scanning.
      }
    }
  }

  private highWaterMark(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM status_events").get() as {
      id: number;
    };
    return row.id;
  }
}

/** Map a job status to its cue; every non-terminal state is silent. */
function cueForStatus(status: string): Cue | null {
  if (status === "succeeded") return "success";
  if (status === "failed") return "failure";
  return null;
}

/* ------------------------------------------------------------------ *
 * Bounded playback queue
 * ------------------------------------------------------------------ */

/** Injected clock seam so pending expiry and helper timeouts are testable. */
export interface AudioClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemAudioClock: AudioClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The minimal child-process surface the queue relies on. */
export interface PlaybackChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Injected process seam. Arguments arrive as a vector; no shell is used. */
export type ProcessLauncher = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean },
) => PlaybackChild;

const defaultProcessLauncher: ProcessLauncher = (file, args, options) =>
  spawn(file, [...args], { windowsHide: options.windowsHide, stdio: "ignore" });

export interface AudioQueueOptions {
  platform?: NodeJS.Platform;
  process?: ProcessLauncher;
  clock?: AudioClock;
  /** Safe diagnostic sink; failures are swallowed. */
  warn?: (message: string) => void;
  assetsDir?: string;
  moduleUrl?: string;
  /** Pending request bound; defaults to 16. */
  maxPending?: number;
  /** Pending request expiry in ms; defaults to 10s. */
  pendingExpiryMs?: number;
  /** Helper timeout in ms; defaults to 3s. */
  timeoutMs?: number;
  /** Minimum spacing between warnings; defaults to 10s. */
  warnIntervalMs?: number;
  /** Initial mute state; defaults to unmuted. */
  muted?: boolean;
}

const DEFAULT_MAX_PENDING = 16;
const DEFAULT_PENDING_EXPIRY_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_WARN_INTERVAL_MS = 10_000;

/**
 * Hard finite ceilings for the queue knobs. Injected non-finite or oversized
 * values are clamped here so a caller (including a JS caller bypassing the
 * types) cannot disable the bounds or make the queue unbounded.
 */
export const AUDIO_QUEUE_CEILINGS = {
  maxPending: 256,
  pendingExpiryMs: 60_000,
  timeoutMs: 30_000,
  warnIntervalMs: 3_600_000,
} as const;

export interface AudioQueueLimits {
  maxPending: number;
  pendingExpiryMs: number;
  timeoutMs: number;
  warnIntervalMs: number;
}

/** Clamp one knob into `[0, ceiling]`; a non-finite value is saturated. */
function clampKnob(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (Number.isNaN(value)) return fallback;
  if (!Number.isFinite(value)) return value > 0 ? ceiling : 0;
  return Math.min(ceiling, Math.max(0, Math.trunc(value)));
}

/** Resolve the queue's bounded knobs, clamping injected values to hard ceilings. */
export function resolveAudioQueueLimits(options: AudioQueueOptions = {}): AudioQueueLimits {
  return {
    maxPending: clampKnob(options.maxPending, DEFAULT_MAX_PENDING, AUDIO_QUEUE_CEILINGS.maxPending),
    pendingExpiryMs: clampKnob(
      options.pendingExpiryMs,
      DEFAULT_PENDING_EXPIRY_MS,
      AUDIO_QUEUE_CEILINGS.pendingExpiryMs,
    ),
    timeoutMs: clampKnob(options.timeoutMs, DEFAULT_TIMEOUT_MS, AUDIO_QUEUE_CEILINGS.timeoutMs),
    warnIntervalMs: clampKnob(
      options.warnIntervalMs,
      DEFAULT_WARN_INTERVAL_MS,
      AUDIO_QUEUE_CEILINGS.warnIntervalMs,
    ),
  };
}

interface PendingRequest {
  cue: Cue;
  requestedAt: number;
}

/**
 * A best-effort, at-most-once playback lane with a bounded queue.
 *
 * At most one helper runs at a time; pending requests are capped, expire, and
 * are dropped while muted. Unsupported platforms are a no-op. Every failure
 * path consumes the request and rate-limits a safe warning rather than
 * retrying or blocking the daemon. It never touches job state.
 */
export class AudioQueue {
  private readonly platform: NodeJS.Platform;
  private readonly launcher: ProcessLauncher;
  private readonly clock: AudioClock;
  private readonly warn: (message: string) => void;
  private readonly assetsDir: string;
  private readonly maxPending: number;
  private readonly pendingExpiryMs: number;
  private readonly timeoutMs: number;
  private readonly warnIntervalMs: number;

  private readonly pending: PendingRequest[] = [];
  private active = false;
  private muted: boolean;
  private disposed = false;
  private lastWarnAt: number | null = null;
  private activeTimer: unknown;
  private activeChild: PlaybackChild | null = null;

  constructor(options: AudioQueueOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.launcher = options.process ?? defaultProcessLauncher;
    this.clock = options.clock ?? systemAudioClock;
    this.warn = options.warn ?? ((): void => undefined);
    this.assetsDir = resolveTerminalAssetsDir({
      ...(options.assetsDir === undefined ? {} : { assetsDir: options.assetsDir }),
      ...(options.moduleUrl === undefined ? {} : { moduleUrl: options.moduleUrl }),
    });
    const limits = resolveAudioQueueLimits(options);
    this.maxPending = limits.maxPending;
    this.pendingExpiryMs = limits.pendingExpiryMs;
    this.timeoutMs = limits.timeoutMs;
    this.warnIntervalMs = limits.warnIntervalMs;
    this.muted = options.muted ?? false;
  }

  /** True when this platform has a supported playback mechanism. */
  get supported(): boolean {
    return this.platform === "win32";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Number of requests waiting behind the active helper. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Request one cue. Muted requests are dropped here (never stored for later);
   * an unsupported platform and an over-full queue are silent no-ops beyond a
   * rate-limited diagnostic.
   */
  request(cue: Cue): void {
    if (!isCue(cue)) {
      // A JS caller can bypass the TypeScript enum; reject malformed values
      // before they can reach a helper invocation.
      this.warnOnce("ignoring invalid audio cue");
      return;
    }
    if (this.disposed || !this.supported || this.muted) return;
    this.dropExpired();
    if (this.pending.length >= this.maxPending) {
      this.warnOnce("audio queue is full; dropping outcome cue");
      return;
    }
    this.pending.push({ cue, requestedAt: this.clock.now() });
    this.pump();
  }

  /**
   * Set mute. Muting drops every pending request immediately, so re-enabling
   * never replays suppressed cues. An in-flight helper is left to finish.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.pending.length = 0;
  }

  /** Release all resources; idempotent and safe after partial startup. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.length = 0;
    this.clearActiveTimer();
    const child = this.activeChild;
    this.activeChild = null;
    this.active = false;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // A helper that already exited or cannot be killed is best-effort.
      }
    }
  }

  private pump(): void {
    if (this.disposed || this.active || !this.supported || this.pending.length === 0) return;
    this.dropExpired();
    const next = this.pending.shift();
    if (next === undefined) return;
    this.active = true;
    this.play(next.cue);
  }

  /** Drop pending requests older than the expiry bound. Never retries them. */
  private dropExpired(): void {
    const now = this.clock.now();
    while (this.pending.length > 0 && now - this.pending[0]!.requestedAt >= this.pendingExpiryMs) {
      this.pending.shift();
    }
  }

  private play(cue: Cue): void {
    let child: PlaybackChild;
    try {
      child = this.launcher(
        resolvePowerShell(this.platform),
        soundHelperArgs(cue, this.assetsDir),
        {
          windowsHide: true,
        },
      );
    } catch {
      this.warnOnce("audio helper could not be launched");
      this.active = false;
      this.pump();
      return;
    }
    this.activeChild = child;
    let settled = false;
    let timedOut = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      this.clearActiveTimer();
      this.activeChild = null;
      this.active = false;
      if (!this.disposed) this.pump();
    };
    // Deadlines are soft: a timeout kills the helper but never frees the lane.
    // Only the child's own close/error confirms it exited, so a kill that
    // returns false, throws, or races a late close can never overlap a second
    // helper. No stale request is retried.
    this.activeTimer = this.clock.setTimeout(() => {
      if (settled || this.disposed) return;
      timedOut = true;
      this.warnOnce("audio helper timed out");
      try {
        child.kill();
      } catch {
        // Best-effort termination; the lane stays occupied until close/error.
      }
    }, this.timeoutMs);
    child.once("error", () => {
      if (settled) return;
      if (!this.disposed) this.warnOnce("audio helper failed");
      if (timedOut && !this.disposed) return; // A failed kill is not proof of exit.
      settle();
    });
    child.once("close", (code) => {
      if (settled) return;
      // A non-zero (or signal) close is a best-effort failure; a normal exit is
      // silent. Late closes after disposal never emit a diagnostic.
      if (!this.disposed && code !== 0) this.warnOnce("audio helper failed");
      settle();
    });
  }

  private clearActiveTimer(): void {
    if (this.activeTimer !== undefined) {
      this.clock.clearTimeout(this.activeTimer);
      this.activeTimer = undefined;
    }
  }

  private warnOnce(message: string): void {
    const now = this.clock.now();
    if (this.lastWarnAt !== null && now - this.lastWarnAt < this.warnIntervalMs) return;
    this.lastWarnAt = now;
    try {
      this.warn(message);
    } catch {
      // A diagnostic sink failure must never affect processing.
    }
  }
}
