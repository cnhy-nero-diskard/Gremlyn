/**
 * Bounded, strictly attributed, read-only delegation observer (tasks 3.1-3.4;
 * design D1/D2/D4; capability `agent-delegation-observability`).
 *
 * The safety settlement in {@link ./managed-sessions.ts} answers one fail-closed
 * question — "is every descendant provably quiescent?" — and refuses to
 * continue when it cannot. This module answers a different one: "what
 * attributable parent/child execution can we *show* an operator, live and after
 * settlement?". It shares the pinned session transport but delegates every
 * privacy decision to {@link ./delegation-observation.ts}: that module's safe
 * record/listing/active parsers and presentation projector are the only way a
 * raw runtime body becomes an observation, so prompts, instructions, tool
 * arguments and credentials cannot ride along.
 *
 * Observational only, failure-isolated, bounded:
 *
 * - It issues `GET` reads and never `POST`s, so it can never interrupt a
 *   session, and it never writes the ownership journal, `managed_child_sessions`
 *   or any other safety record.
 * - Every transport/parser/storage/diagnostic failure is caught, downgraded to
 *   a coverage gap, and never propagated. An observation error can therefore
 *   never set an invocation's `persistenceFailure`, abort a job, change a safety
 *   proof/gate, or alter an attempted outcome.
 * - Enumeration is capped at {@link DELEGATION_OBSERVER_NODE_LIMIT} nodes, eight
 *   levels and {@link DELEGATION_OBSERVER_PAGE_LIMIT} pages per listing; every
 *   transport call is capped by a per-call timeout and a process-wide
 *   concurrency limiter, and both queueing and whole rounds are time-bounded so
 *   a hung call can never stall reconciliation or finalization.
 *
 * ## Attribution
 *
 * An invocation's root only attaches when its own record proves it: the id
 * echoed back, NO `parentID` (a root cannot itself be a child), and the exact
 * resolved attempt workspace directory. Every descendant edge is likewise
 * proven from the `parentID`-filtered listing AND the child's own echoed
 * `parentID` AND the child's directory, and EVERY individual read is checked
 * against the requested id, so a sibling returned by a misbehaving endpoint can
 * never be recorded as another session's state. A record that fails any check is
 * rejected with an `unattributed-record` gap; it is never attached to this job.
 * Each invocation gets its own observer, so a retried parent never overwrites an
 * earlier root's evidence.
 *
 * ## Persistence boundary
 *
 * The module has no database dependency. It emits safe snapshots to an injected
 * {@link DelegationObservationSink} (`begin` → `upsert`/`coverage` → `end`). Each
 * node carries an explicit `presence` marker, so a failed refresh or a vanished
 * session is persisted as *missing current evidence* (never as a resurrected
 * running/succeeded state) while last-known identity/outcome history is
 * retained by the sink.
 *
 * ## Delivery
 *
 * One coalesced timer per observer polls at
 * {@link DELEGATION_OBSERVER_POLL_INTERVAL_MS} with at most one in-flight round
 * per root. Event acceleration is intentionally NOT wired: until a pinned
 * runtime probe proves a safe event subscription this is the polling-only
 * fallback and coverage reports `transport: "polling"`. Cancellation-requested
 * is a flag independent of the observed terminal outcome, and a cancellation
 * request never stops observation — the confirmed interruption is what we want
 * to see.
 */

import { resolve } from "node:path";
import {
  parseDelegationActiveSessions,
  parseDelegationSessionListing,
  parseDelegationSessionRecord,
  projectDelegationObservation,
  type DelegationActualIdentity,
  type DelegationObservationState,
  type DelegationSessionRecord,
} from "./delegation-observation.js";
import {
  sessionActivePath,
  sessionChildListQuery,
  sessionRecordPath,
  type ManagedHttpResult,
  type ManagedSessionHttp,
  type OpenCodeSessionOutcome,
} from "./managed-sessions.js";

/* ------------------------------------------------------------------ *
 * Bounds (tasks 3.2/3.3) — presentation bounds, separate from safety
 * ------------------------------------------------------------------ */

/** Hard cap on observed nodes per invocation, including the root. */
export const DELEGATION_OBSERVER_NODE_LIMIT = 256;

/** Hard cap on observed depth: the root is level 0, its children level 1. */
export const DELEGATION_OBSERVER_DEPTH_LIMIT = 8;

/** Hard cap on pages followed for a single `GET /api/session` listing. */
export const DELEGATION_OBSERVER_PAGE_LIMIT = 50;

/** Coalesced polling cadence while a root is active or settling. */
export const DELEGATION_OBSERVER_POLL_INTERVAL_MS = 1_000;

/** Per-call transport bound; a hung read cannot outlive one observation round. */
export const DELEGATION_OBSERVER_CALL_TIMEOUT_MS = 5_000;

/** Default process-wide cap on concurrent observation reads across every root. */
export const DELEGATION_OBSERVER_GLOBAL_CONCURRENCY = 4;

/* ------------------------------------------------------------------ *
 * Observable evidence (safe, whitelisted fields only)
 * ------------------------------------------------------------------ */

/** Presentation-only observation state (from the dedicated projector). */
export type DelegationObservedState = DelegationObservationState;

/** Actual runtime identity a record exposed, or nothing. */
export type DelegationObservedIdentity = DelegationActualIdentity;

/** Whether current supported evidence exists for a node in this round. */
export type DelegationEvidencePresence = "observed" | "missing";

/** One safe, bounded observation of a session in an invocation's tree. */
export interface DelegationObservedNode {
  readonly sessionId: string;
  readonly rootSessionId: string;
  /** The verified parent edge; absent only for the root. */
  readonly parentSessionId?: string;
  /** 0 for the root, 1 for its direct children, and so on. */
  readonly depth: number;
  readonly role: "root" | "child";
  /**
   * `missing` when this round could not read fresh current evidence (a failed
   * refresh or a vanished session). A missing node is never a live state; the
   * sink retains the last-known identity/outcome as history only.
   */
  readonly presence: DelegationEvidencePresence;
  readonly state: DelegationObservedState;
  /** True when terminal evidence contradicted a still-active session. */
  readonly contradiction: boolean;
  /** The terminal outcome the latest observation reported, when any. */
  readonly outcome?: OpenCodeSessionOutcome;
  /** Fresh active-map presence (present only when presence is `observed`). */
  readonly active?: boolean;
  readonly identity: DelegationObservedIdentity;
  /** Source-declared creation time (ms since epoch) when valid. */
  readonly sourceCreatedAt?: number;
  /** Source-declared last-update time (ms since epoch) when valid. */
  readonly sourceUpdatedAt?: number;
  /** Source-declared idle time (ms since epoch) when valid. */
  readonly sourceIdleAt?: number;
  /** First moment Gremlyn observed this session. */
  readonly firstObservedAt: number;
  /** Most recent moment Gremlyn observed this session. */
  readonly lastObservedAt: number;
  /** Independent of `outcome`: was cancellation requested but not confirmed? */
  readonly cancellationRequested: boolean;
}

/** Explicit reasons an observation round was incomplete or unavailable. */
export type DelegationGapReason =
  | "root-missing"
  | "root-lost"
  | "root-unverified"
  | "listing-failed"
  | "listing-unusable"
  | "listing-partial"
  | "page-cap"
  | "depth-cap"
  | "node-cap"
  | "cycle"
  | "node-lost"
  | "unattributed-record"
  | "active-unavailable"
  | "active-map-scope-limited"
  | "call-timeout"
  | "transport-error";

/** How complete the most recent observation round was. */
export type DelegationCoverageStatus = "unavailable" | "partial" | "healthy";

/** Invocation identity handed to the sink when observation begins. */
export interface DelegationInvocationRecord {
  readonly attemptId: number;
  readonly ordinal: number;
  readonly workspacePath: string;
  readonly rootSessionId?: string;
  readonly startedAt: number;
}

/** One round's / the invocation's coverage snapshot. */
export interface DelegationCoverageRecord {
  readonly attemptId: number;
  readonly ordinal: number;
  readonly rootSessionId?: string;
  readonly observedAt: number;
  readonly status: DelegationCoverageStatus;
  /** True when this round (or truncation) could not present the full tree. */
  readonly partial: boolean;
  /** Every gap ever observed for this invocation, retained for history. */
  readonly gaps: readonly DelegationGapReason[];
  /**
   * The gaps of THIS round only (a subset of `gaps`). The durable sink opens
   * gaps from here, so a gap already reconciled by a later healthy round is not
   * reopened merely because it remains in the historical `gaps` list.
   */
  readonly currentGaps: readonly DelegationGapReason[];
  readonly nodeCount: number;
  readonly truncated: boolean;
  /** The delivery mechanism actually in force; polling-only today. */
  readonly transport: "polling";
}

/** Final coverage when observation ends. */
export interface DelegationInvocationEnd {
  readonly attemptId: number;
  readonly ordinal: number;
  readonly rootSessionId?: string;
  readonly endedAt: number;
  readonly status: DelegationCoverageStatus;
  readonly gaps: readonly DelegationGapReason[];
}

/**
 * The injectable persistence boundary. Every method is best-effort from the
 * observer's perspective: a throw (sync or async) or a never-settling promise
 * is bounded and swallowed, never propagated, so a broken store cannot affect
 * the job. Implementations must whitelist before persisting; the observer only
 * supplies the safe fields above.
 */
export interface DelegationObservationSink {
  begin(record: DelegationInvocationRecord): void | Promise<void>;
  upsert(node: DelegationObservedNode): void | Promise<void>;
  coverage(record: DelegationCoverageRecord): void | Promise<void>;
  end(record: DelegationInvocationEnd): void | Promise<void>;
}

/** Minimal diagnostic seam; never used for control flow, never throws. */
export type DelegationObserverWarn = (event: string, fields?: Record<string, unknown>) => void;

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/**
 * Case-insensitive comparison of two absolute paths after `path.resolve`, so a
 * symlinked/relative/separator-different alias cannot slip past an attribution
 * check.
 */
export function sameObservedDirectory(left: string, right: string): boolean {
  let a: string;
  let b: string;
  try {
    a = resolve(left);
    b = resolve(right);
  } catch {
    return false;
  }
  if (a.length === 0 || b.length === 0) return false;
  if (process.platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b;
}

/** The pinned session id shape; only ids matching it may ever be attached. */
function isSessionId(value: string): boolean {
  return /^ses[A-Za-z0-9_-]+$/u.test(value);
}

/* ------------------------------------------------------------------ *
 * Process-wide concurrency limiter (bounded, cancellable waiters)
 * ------------------------------------------------------------------ */

/**
 * A FIFO semaphore bounding concurrent observation reads across every root in
 * the process. Waiters are bounded by an explicit timeout and/or an abort
 * signal, so a saturated limiter (for example four calls that never settle)
 * can never hang a caller. A slot is released only when the underlying call
 * settles; a timed-out waiter does not free the occupied slot, so a still
 * in-flight call cannot be double-counted.
 */
export class DelegationConcurrencyLimiter {
  private readonly max: number;
  private active = 0;
  private readonly waiters = new Set<(granted: boolean) => void>();

  constructor(max: number) {
    this.max = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 1;
  }

  /**
   * Acquire one slot. Resolves `true` when a slot is held, `false` when the
   * queue wait timed out or the signal aborted before a slot was granted.
   */
  acquire(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    if (options.signal?.aborted === true) return Promise.resolve(false);
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolveAcquire) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => done(false);
      const done = (granted: boolean): void => {
        if (settled) return;
        settled = true;
        this.waiters.delete(done);
        if (timer !== undefined) clearTimeout(timer);
        if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
        resolveAcquire(granted);
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => done(false), Math.max(1, options.timeoutMs));
      }
      if (options.signal !== undefined) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.add(done);
    });
  }

  release(): void {
    const next = this.waiters.values().next().value;
    if (next !== undefined) {
      this.waiters.delete(next);
      next(true); // the slot is transferred, so `active` is unchanged.
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.size;
  }
}

/* ------------------------------------------------------------------ *
 * Observer
 * ------------------------------------------------------------------ */

export interface DelegationObserverOptions {
  readonly attemptId: number;
  readonly ordinal: number;
  /** The exact resolved attempt workspace every edge must match. */
  readonly workspacePath: string;
  /** The pinned session transport, built from the exact worker descriptor. */
  readonly http: ManagedSessionHttp;
  readonly sink: DelegationObservationSink;
  readonly pollIntervalMs?: number;
  readonly perCallTimeoutMs?: number;
  /**
   * Overall bound for one reconciliation round. A hung call cannot exceed the
   * per-call bound, but this additionally caps a pathologically large/slow
   * round so the observer keeps making progress.
   */
  readonly roundBudgetMs?: number;
  /** Shared limiter; when omitted the observer creates its own. */
  readonly limiter?: DelegationConcurrencyLimiter;
  readonly globalConcurrencyLimit?: number;
  readonly nodeLimit?: number;
  readonly depthLimit?: number;
  readonly pageLimit?: number;
  readonly now?: () => number;
  readonly warn?: DelegationObserverWarn;
}

/** A node discovered by the listing walk, before its individual refresh. */
interface DiscoveredNode {
  readonly id: string;
  readonly parentSessionId?: string;
  readonly depth: number;
  readonly record: DelegationSessionRecord;
}

/** Retained per-session state across rounds, so first-observation is stable. */
interface KnownNode {
  parentSessionId?: string;
  depth: number;
  readonly role: "root" | "child";
  readonly firstObservedAt: number;
  lastObservedAt: number;
  last: DelegationObservedNode | undefined;
}

type SessionRead =
  | { readonly status: "ok"; readonly record: DelegationSessionRecord }
  | { readonly status: "missing" }
  | { readonly status: "unusable" }
  | { readonly status: "glitch"; readonly gap: DelegationGapReason };

type ActiveRead =
  | { readonly status: "ok"; readonly active: ReadonlySet<string> }
  | { readonly status: "unavailable" };

interface ListingResult {
  readonly children: readonly DelegationSessionRecord[];
  readonly truncated: boolean;
  /** False when a page could not establish a complete child enumeration. */
  readonly complete: boolean;
  readonly error?: DelegationGapReason;
}

export class DelegationObserver {
  private readonly attemptId: number;
  private readonly ordinal: number;
  private readonly workspacePath: string;
  private readonly http: ManagedSessionHttp;
  private readonly sink: DelegationObservationSink;
  private readonly pollIntervalMs: number;
  private readonly perCallTimeoutMs: number;
  private readonly roundBudgetMs: number;
  private readonly limiter: DelegationConcurrencyLimiter;
  private readonly nodeLimit: number;
  private readonly depthLimit: number;
  private readonly pageLimit: number;
  private readonly now: () => number;
  private readonly warn: DelegationObserverWarn;
  /** Aborted on `dispose`, cancelling queued limiter waiters for this observer. */
  private readonly closed = new AbortController();

  private rootSessionId: string | undefined;
  /** Set only after a round runtime-verified the root; cleared on root loss. */
  private verifiedRootId: string | undefined;
  private cancellationRequested = false;
  private started = false;
  private stopped = false;
  private disposed = false;

  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The in-flight round. This is the single-flight gate and is cleared only
   * when the round BODY has fully settled, so a timed-out round can never
   * overlap the next one.
   */
  private currentRound: Promise<void> | undefined;
  /** Set by the active round's deadline; the body checks it between awaits. */
  private roundTimedOut = false;
  private roundTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingReconcile = false;
  private truncatedLastRound = false;

  private readonly knownNodes = new Map<string, KnownNode>();
  private readonly currentGaps = new Set<DelegationGapReason>();
  private readonly historicalGaps = new Set<DelegationGapReason>();

  constructor(options: DelegationObserverOptions) {
    this.attemptId = options.attemptId;
    this.ordinal = options.ordinal;
    this.workspacePath = options.workspacePath;
    this.http = options.http;
    this.sink = options.sink;
    this.pollIntervalMs = clampPositive(
      options.pollIntervalMs,
      DELEGATION_OBSERVER_POLL_INTERVAL_MS,
    );
    this.perCallTimeoutMs = clampPositive(
      options.perCallTimeoutMs,
      DELEGATION_OBSERVER_CALL_TIMEOUT_MS,
    );
    this.roundBudgetMs = clampPositive(options.roundBudgetMs, this.perCallTimeoutMs);
    this.limiter =
      options.limiter ??
      new DelegationConcurrencyLimiter(
        options.globalConcurrencyLimit ?? DELEGATION_OBSERVER_GLOBAL_CONCURRENCY,
      );
    this.nodeLimit = clampCount(options.nodeLimit, DELEGATION_OBSERVER_NODE_LIMIT);
    this.depthLimit = clampCount(options.depthLimit, DELEGATION_OBSERVER_DEPTH_LIMIT);
    this.pageLimit = clampCount(options.pageLimit, DELEGATION_OBSERVER_PAGE_LIMIT);
    this.now = options.now ?? (() => Date.now());
    this.warn = options.warn ?? (() => {});
  }

  /**
   * The runtime-verified root session id, or `undefined` when the root has not
   * been verified this run or verification was revoked by a root loss. It is
   * the ONLY source callers may use to attribute parent activity — never a raw
   * journal id.
   */
  get verifiedRootSessionId(): string | undefined {
    return this.verifiedRootId;
  }

  /** Begin observation: emit the invocation record and arm the poll timer. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const startedAt = this.now();
    void this.emitSink(() =>
      this.sink.begin({
        attemptId: this.attemptId,
        ordinal: this.ordinal,
        workspacePath: this.workspacePath,
        ...(this.rootSessionId === undefined ? {} : { rootSessionId: this.rootSessionId }),
        startedAt,
      }),
    );
    this.scheduleNext(this.pollIntervalMs);
  }

  /**
   * The early root callback (task 3.1). Idempotent for a repeated id; a second,
   * different id within one invocation is a contradiction and is recorded as a
   * gap while the first root is retained — the tree is never switched.
   */
  attachRoot(sessionId: string): void {
    if (this.disposed) return;
    if (!isSessionId(sessionId)) {
      this.noteGap("root-unverified");
      return;
    }
    if (this.rootSessionId === sessionId) return;
    if (this.rootSessionId !== undefined) {
      this.noteGap("root-unverified");
      return;
    }
    this.rootSessionId = sessionId;
    this.kick();
  }

  /** Mark that Gremlyn requested cancellation, independent of any outcome. */
  requestCancellation(): void {
    if (this.disposed || this.cancellationRequested) return;
    this.cancellationRequested = true;
    this.kick();
  }

  /**
   * Finalize: stop scheduling, wait for any in-flight round to truly settle,
   * run one deadline-bounded final reconcile, then emit the final coverage.
   *
   * The in-flight round and the final reconcile are each bounded internally
   * (their body checks the round deadline between awaits, and every transport
   * and sink await is per-call bounded), so this returns within a finite budget
   * even if a call never settles. It deliberately does NOT race a timeout: the
   * round body must finish before `end`, so no late round output can be emitted
   * after the terminal record.
   */
  async finalize(): Promise<void> {
    if (this.disposed) return;
    this.stopped = true;
    this.clearTimer();
    await this.finalizeOnce();
  }

  private async finalizeOnce(): Promise<void> {
    const inFlight = this.currentRound;
    if (inFlight !== undefined) {
      try {
        await inFlight;
      } catch {
        // reconcileSafely swallows its own faults; this guards the await.
      }
    }
    this.currentGaps.clear();
    await this.reconcileSafely();
    const endedAt = this.now();
    const everObserved = this.knownNodes.size > 0;
    const partial = this.currentGaps.size > 0 || this.truncatedLastRound;
    const status: DelegationCoverageStatus = !everObserved
      ? "unavailable"
      : partial
        ? "partial"
        : "healthy";
    await this.emitSink(() =>
      this.sink.end({
        attemptId: this.attemptId,
        ordinal: this.ordinal,
        ...(this.rootSessionId === undefined ? {} : { rootSessionId: this.rootSessionId }),
        endedAt,
        status,
        gaps: [...this.historicalGaps],
      }),
    );
  }

  /**
   * Teardown without a final reconcile: clears the scheduling and round-deadline
   * timers and cancels any queued limiter waiters this observer owns. The
   * in-flight body observes `disposed` at its next await boundary and stops, so
   * no timer or waiter outlives the attempt. Always safe to call.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.roundTimedOut = true;
    if (this.roundTimer !== undefined) {
      clearTimeout(this.roundTimer);
      this.roundTimer = undefined;
    }
    this.closed.abort();
  }

  /** Run one observation round immediately (single-flight with any active round). */
  async observeOnce(): Promise<void> {
    await this.ensureRound();
  }

  /* ---------------------------------------------------------------- *
   * Scheduling — coalesced, single-flight, promptly disposed
   * ---------------------------------------------------------------- */

  private kick(): void {
    if (!this.started || this.disposed || this.stopped) return;
    if (this.currentRound !== undefined) {
      this.pendingReconcile = true;
      return;
    }
    this.clearTimer();
    this.scheduleNext(0);
  }

  private scheduleNext(delay: number): void {
    if (this.disposed || this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.runScheduledRound();
      },
      Math.max(0, delay),
    );
  }

  /**
   * Single-flight entry point: return the in-flight round when one exists,
   * otherwise start exactly one. The gate is the round BODY, so it clears only
   * after the body (and its bounded timeout bookkeeping) has fully settled —
   * a timed-out round can therefore never overlap the next one or share the
   * mutable round state (`currentGaps`, `knownNodes`) with it.
   */
  private ensureRound(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.currentRound !== undefined) return this.currentRound;
    const round = this.reconcileSafely();
    this.currentRound = round;
    const clear = (): void => {
      if (this.currentRound === round) this.currentRound = undefined;
    };
    void round.then(clear, clear);
    return round;
  }

  private async runScheduledRound(): Promise<void> {
    if (this.disposed || this.stopped) return;
    try {
      await this.ensureRound();
    } finally {
      if (!this.disposed && !this.stopped) {
        if (this.pendingReconcile) {
          this.pendingReconcile = false;
          this.scheduleNext(0);
        } else {
          this.scheduleNext(this.pollIntervalMs);
        }
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one round to completion under a deadline. The deadline flips
   * `roundTimedOut` — a boolean the body checks between awaits, so the body
   * stops promptly without any concurrent mutation — and this method resolves
   * only once the body has truly settled. That keeps the single-flight gate
   * honest: nothing can begin while late work from an over-budget round runs.
   */
  private async reconcileSafely(): Promise<void> {
    this.roundTimedOut = false;
    this.roundTimer = setTimeout(
      () => {
        this.roundTimedOut = true;
      },
      Math.max(1, this.roundBudgetMs),
    );
    try {
      await this.reconcile();
    } catch {
      this.safeWarn("delegation observation round failed", this.safeFields());
    } finally {
      if (this.roundTimer !== undefined) {
        clearTimeout(this.roundTimer);
        this.roundTimer = undefined;
      }
    }
    if (this.roundTimedOut && !this.disposed) {
      this.noteGap("call-timeout");
      await this.publishCoverage(this.now(), this.knownNodes.size);
    }
  }

  /* ---------------------------------------------------------------- *
   * One bounded reconciliation round
   * ---------------------------------------------------------------- */

  /**
   * True when the current round must stop walking/emitting: the observer is
   * being torn down, or the round deadline has passed. Checked between awaits so
   * an over-budget round unwinds promptly.
   */
  private roundStopped(): boolean {
    return this.disposed || this.roundTimedOut;
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    this.currentGaps.clear();
    this.truncatedLastRound = false;

    const root = this.rootSessionId;
    if (root === undefined) {
      this.noteGap("root-missing");
      await this.publishIfRoundActive(now, 0);
      return;
    }

    const rootRead = await this.readSession(root);
    if (this.roundStopped()) return;
    if (rootRead.status !== "ok") {
      this.revokeRootVerification();
      this.noteGap(
        rootRead.status === "missing"
          ? "root-lost"
          : rootRead.status === "glitch"
            ? rootRead.gap
            : "root-unverified",
      );
      await this.publishIfRoundActive(now, 0);
      return;
    }
    if (!this.isVerifiedRoot(root, rootRead.record)) {
      this.revokeRootVerification();
      this.noteGap("root-unverified");
      await this.publishIfRoundActive(now, 0);
      return;
    }
    // Runtime verification succeeded: the root is now attributable.
    this.verifiedRootId = root;

    // Enumerate the whole verified tree BEFORE any active-map use. Every edge
    // is checked for echoed parentID and exact directory as it is discovered.
    const walk = await this.walk(root, rootRead.record);
    if (this.roundStopped()) return;
    this.truncatedLastRound = walk.truncated;

    const activeRead = await this.readActive();
    if (this.roundStopped()) return;
    if (activeRead.status !== "ok") this.noteGap("active-unavailable");
    const active = activeRead.status === "ok" ? activeRead.active : undefined;

    let observed = 0;
    for (const [id, discovered] of walk.nodes) {
      if (this.roundStopped()) return;
      // The node cap is an INVOCATION-wide bound, not a per-walk one: knownNodes
      // is retained across rounds, so a tree that churns session ids between
      // rounds could otherwise accumulate more than the cap over the run. A new
      // session past the cap is dropped (and disclosed) rather than attached;
      // an already-known one is always allowed through.
      if (!this.knownNodes.has(id) && this.knownNodes.size >= this.nodeLimit) {
        this.noteGap("node-cap");
        this.truncatedLastRound = true;
        continue;
      }
      const node = await this.projectNode(id, discovered, root, rootRead.record, active, now);
      observed += 1;
      if (this.roundStopped()) return;
      await this.emitSink(() => this.sink.upsert(node));
    }

    // Retain last-known evidence for nodes missing from a COMPLETE enumeration.
    // A round with a listing fault or a reached bound cannot conclude a node is
    // gone; only a complete, untruncated walk may. The retained node is emitted
    // as `missing` current evidence, so the sink never resurrects it as live.
    for (const [id, known] of this.knownNodes) {
      if (this.roundStopped()) return;
      if (walk.nodes.has(id)) continue;
      if (!walk.complete || walk.truncated) continue;
      const retained = known.last;
      if (retained === undefined) continue;
      this.noteGap("node-lost");
      const { active: _active, ...rest } = retained;
      const lost: DelegationObservedNode = {
        ...rest,
        presence: "missing",
        state: "unknown",
        contradiction: false,
        lastObservedAt: known.lastObservedAt,
      };
      known.last = lost;
      await this.emitSink(() => this.sink.upsert(lost));
    }

    await this.publishIfRoundActive(now, observed);
  }

  /**
   * Publish coverage unless this round was stopped (deadline/dispose). A stopped
   * round publishes a single timeout snapshot from `reconcileSafely` instead, so
   * the body never leaves a half-observed round advertised as current coverage.
   */
  private async publishIfRoundActive(now: number, nodeCount: number): Promise<void> {
    if (this.roundStopped()) return;
    await this.publishCoverage(now, nodeCount);
  }

  /**
   * Refresh ONE node's own record and project it. The root reuses the record
   * already read for verification; every child is individually refreshed so a
   * possibly-stale listing snapshot is never classified as current state.
   *
   * A refresh that yields no trustworthy attributed record — a transport/parse
   * glitch, a 404, an echoed-id mismatch, or a record whose parent/directory
   * does not prove the discovered edge — does NOT leave the node's prior
   * running/terminal evidence asserted. It is projected as `missing` current
   * evidence (`unknown`, no active, no current outcome), retaining the
   * previously verified identity/source times as history only. A mismatched
   * record is never used to supply identity or state.
   */
  private async projectNode(
    id: string,
    discovered: DiscoveredNode,
    root: string,
    rootRecord: DelegationSessionRecord,
    active: ReadonlySet<string> | undefined,
    now: number,
  ): Promise<DelegationObservedNode> {
    let record: DelegationSessionRecord | undefined;
    let presence: DelegationEvidencePresence = "observed";

    if (id === root) {
      record = rootRecord;
    } else {
      const read = await this.readSession(id);
      if (read.status === "ok") {
        if (
          read.record.parentIdUnrecognized ||
          read.record.parentId !== discovered.parentSessionId ||
          read.record.directory === undefined ||
          !sameObservedDirectory(read.record.directory, this.workspacePath)
        ) {
          // Real record, but it does not prove this verified edge/directory:
          // never attribute it, and revoke any prior current evidence.
          this.noteGap("unattributed-record");
          presence = "missing";
        } else {
          record = read.record;
        }
      } else {
        // `glitch` (transport/parse), `missing` (404) or `unusable` (echoed-id
        // mismatch): no trustworthy fresh record, so revoke current evidence
        // rather than leaving a stale running/terminal assertion in place.
        this.noteGap(read.status === "glitch" ? read.gap : "unattributed-record");
        presence = "missing";
      }
    }

    const prior = this.knownNodes.get(id);
    // Retain last-known identity/source times for a revoked node so history is
    // preserved, but NEVER from an unattributable (mismatched) record.
    const fallback = presence === "missing" ? prior?.last : undefined;
    const identity = record?.identity ?? fallback?.identity ?? {};
    const sourceCreatedAt = record?.createdAt ?? fallback?.sourceCreatedAt;
    const sourceUpdatedAt = record?.updatedAt ?? fallback?.sourceUpdatedAt;
    const sourceIdleAt = record?.idleAt ?? fallback?.sourceIdleAt;

    let activePresence: boolean | undefined;
    if (active !== undefined) {
      if (id !== root && !active.has(id)) {
        // The pinned map only covers process-owned foreground drains. An
        // nonterminal child may still be running as a background session, so do
        // not project `false` (idle) from this unsupported absence. An explicit
        // terminal outcome remains usable on its own. The gap makes unresolved
        // child activity's scope limitation visible to operators.
        if (presence === "observed" && record?.outcome === undefined) {
          this.noteGap("active-map-scope-limited");
        }
      } else {
        activePresence = active.has(id);
      }
    }
    const observation = projectDelegationObservation({
      ...(record === undefined ? { sessionId: id } : { record }),
      ...(activePresence === undefined ? {} : { active: activePresence }),
      lastObservedAt: now,
      now,
      cancellationRequested: this.cancellationRequested,
    });
    const firstObservedAt = prior?.firstObservedAt ?? now;
    const node: DelegationObservedNode = {
      sessionId: id,
      rootSessionId: root,
      ...(discovered.parentSessionId === undefined
        ? {}
        : { parentSessionId: discovered.parentSessionId }),
      depth: discovered.depth,
      role: id === root ? "root" : "child",
      presence,
      state: observation.state,
      contradiction: observation.contradiction,
      ...(observation.outcome === undefined ? {} : { outcome: observation.outcome }),
      ...(presence === "missing" || activePresence === undefined ? {} : { active: activePresence }),
      identity,
      ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt }),
      ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
      ...(sourceIdleAt === undefined ? {} : { sourceIdleAt }),
      firstObservedAt,
      lastObservedAt: now,
      cancellationRequested: this.cancellationRequested,
    };
    this.knownNodes.set(id, {
      ...(discovered.parentSessionId === undefined
        ? {}
        : { parentSessionId: discovered.parentSessionId }),
      depth: discovered.depth,
      role: node.role,
      firstObservedAt,
      lastObservedAt: now,
      last: node,
    });
    return node;
  }

  /* ---------------------------------------------------------------- *
   * Bounded recursive enumeration (task 3.2)
   * ---------------------------------------------------------------- */

  private async walk(
    root: string,
    rootRecord: DelegationSessionRecord,
  ): Promise<{ nodes: Map<string, DiscoveredNode>; truncated: boolean; complete: boolean }> {
    const nodes = new Map<string, DiscoveredNode>();
    nodes.set(root, { id: root, depth: 0, record: rootRecord });
    const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
    let truncated = false;
    let complete = true;

    while (queue.length > 0) {
      if (this.roundStopped()) break;
      const current = queue.shift()!;
      const atDepthLimit = current.depth >= this.depthLimit;
      const listing = await this.listChildren(current.id);
      if (listing.error !== undefined) {
        this.noteGap(listing.error);
        complete = false; // a branch could not be read; absence proves nothing.
        continue;
      }
      if (!listing.complete) complete = false;
      if (listing.truncated) {
        this.noteGap("node-cap");
        truncated = true;
        complete = false;
      }
      if (atDepthLimit) {
        // We may not descend further. A boundary node WITH children means the
        // visible tree is incomplete, which must be disclosed.
        if (listing.children.length > 0) {
          this.noteGap("depth-cap");
          truncated = true;
          complete = false;
        }
        continue;
      }
      for (const child of listing.children) {
        if (nodes.has(child.sessionId)) {
          this.noteGap("cycle");
          complete = false;
          continue;
        }
        if (nodes.size >= this.nodeLimit) {
          this.noteGap("node-cap");
          truncated = true;
          complete = false;
          break;
        }
        const depth = current.depth + 1;
        nodes.set(child.sessionId, {
          id: child.sessionId,
          parentSessionId: current.id,
          depth,
          record: child,
        });
        queue.push({ id: child.sessionId, depth });
      }
      if (truncated) break;
    }
    return { nodes, truncated, complete };
  }

  /**
   * Page through `GET /api/session?parentID=<parent>&directory=<attempt>`,
   * rejecting (with a gap) every record that does not echo the queried parent
   * and live in the exact attempt workspace. Malformed rows are skipped by the
   * dedicated parser and reported as a partial listing. Unlike settlement this
   * NEVER throws: a rejected record reduces coverage instead of inventing
   * ownership, and the accumulated children are capped at the node limit.
   */
  private async listChildren(parentId: string): Promise<ListingResult> {
    const children: DelegationSessionRecord[] = [];
    const usedCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    let complete = true;
    for (;;) {
      if (this.roundStopped()) break;
      pages += 1;
      if (pages > this.pageLimit) {
        return { children, truncated, complete: false, error: "page-cap" };
      }
      let result: ManagedHttpResult;
      try {
        result = await this.bounded(() =>
          this.http.get(
            "/api/session",
            sessionChildListQuery(
              parentId,
              this.workspacePath,
              cursor === undefined ? undefined : { cursor },
            ),
          ),
        );
      } catch (error) {
        return { children, truncated, complete: false, error: this.transportGap(error) };
      }
      if (result.status !== 200) {
        return { children, truncated, complete: false, error: "listing-failed" };
      }
      const page = parseDelegationSessionListing(result.body);
      if (page === undefined) {
        return { children, truncated, complete: false, error: "listing-unusable" };
      }
      if (page.skipped > 0) {
        this.noteGap("listing-partial");
        complete = false;
      }
      for (const item of page.items) {
        if (item.parentIdUnrecognized || item.parentId !== parentId) {
          this.noteGap("unattributed-record");
          complete = false;
          continue;
        }
        if (
          item.directory === undefined ||
          !sameObservedDirectory(item.directory, this.workspacePath)
        ) {
          this.noteGap("unattributed-record");
          complete = false;
          continue;
        }
        if (children.length >= this.nodeLimit) {
          truncated = true;
          complete = false;
          break; // bound what a single listing can accumulate.
        }
        children.push(item);
      }
      if (page.nextCursor === undefined) break;
      if (usedCursors.has(page.nextCursor)) {
        return { children, truncated, complete: false, error: "cycle" };
      }
      usedCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return { children, truncated, complete };
  }

  private isVerifiedRoot(root: string, record: DelegationSessionRecord): boolean {
    return (
      record.sessionId === root &&
      record.parentId === undefined &&
      !record.parentIdUnrecognized &&
      record.directory !== undefined &&
      sameObservedDirectory(record.directory, this.workspacePath)
    );
  }

  private revokeRootVerification(): void {
    this.verifiedRootId = undefined;
  }

  private async readSession(id: string): Promise<SessionRead> {
    let result: ManagedHttpResult;
    try {
      result = await this.bounded(() => this.http.get(sessionRecordPath(id)));
    } catch (error) {
      return { status: "glitch", gap: this.transportGap(error) };
    }
    if (result.status === 404) return { status: "missing" };
    if (result.status !== 200) return { status: "glitch", gap: "transport-error" };
    const record = parseDelegationSessionRecord(result.body);
    // Echo check: a record for a different id (a sibling returned by a
    // misbehaving endpoint) is never trusted as this session's state.
    if (record === undefined || record.sessionId !== id) return { status: "unusable" };
    return { status: "ok", record };
  }

  private async readActive(): Promise<ActiveRead> {
    let result: ManagedHttpResult;
    try {
      result = await this.bounded(() => this.http.get(sessionActivePath()));
    } catch {
      return { status: "unavailable" };
    }
    if (result.status !== 200) return { status: "unavailable" };
    const active = parseDelegationActiveSessions(result.body);
    return active === undefined ? { status: "unavailable" } : { status: "ok", active };
  }

  /* ---------------------------------------------------------------- *
   * Transport bound + concurrency
   * ---------------------------------------------------------------- */

  /**
   * Acquire one global slot (bounded queue wait, cancellable on dispose), run
   * `fn`, and release the slot only when the UNDERLYING call settles — never
   * when the per-call timeout wins the race. Releasing on timeout would let a
   * still-in-flight call coexist with a new one and silently exceed the bound.
   */
  private async bounded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("delegation observation closed");
    const acquired = await this.limiter.acquire({
      timeoutMs: this.perCallTimeoutMs,
      signal: this.closed.signal,
    });
    if (!acquired) {
      throw this.disposed
        ? new Error("delegation observation closed")
        : new Error("delegation observation call timed out");
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.limiter.release();
    };
    let underlying: Promise<T>;
    try {
      underlying = fn();
    } catch (error) {
      release();
      throw error;
    }
    underlying.then(release, release);
    return this.withTimeout(underlying);
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => rejectPromise(new Error("delegation observation call timed out"))),
        Math.max(1, this.perCallTimeoutMs),
      );
      promise.then(
        (value) => finish(() => resolvePromise(value)),
        (error: unknown) => finish(() => rejectPromise(error)),
      );
    });
  }

  private transportGap(error: unknown): DelegationGapReason {
    return error instanceof Error && /timed out/iu.test(error.message)
      ? "call-timeout"
      : "transport-error";
  }

  /** Await `promise` for at most `ms`, swallowing and safely logging failure. */
  private async raceSettle(promise: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, Math.max(1, ms));
    });
    const guarded = promise.then(
      () => undefined,
      () => {
        this.safeWarn("delegation observation promise failed", this.safeFields());
      },
    );
    try {
      await Promise.race([guarded, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------- *
   * Coverage + sink boundary
   * ---------------------------------------------------------------- */

  private noteGap(reason: DelegationGapReason): void {
    this.currentGaps.add(reason);
    this.historicalGaps.add(reason);
  }

  private async publishCoverage(now: number, nodeCount: number): Promise<void> {
    const everObserved = this.knownNodes.size > 0;
    const partial = this.currentGaps.size > 0 || this.truncatedLastRound;
    const status: DelegationCoverageStatus = !everObserved
      ? "unavailable"
      : partial
        ? "partial"
        : "healthy";
    await this.emitSink(() =>
      this.sink.coverage({
        attemptId: this.attemptId,
        ordinal: this.ordinal,
        ...(this.rootSessionId === undefined ? {} : { rootSessionId: this.rootSessionId }),
        observedAt: now,
        status,
        partial,
        gaps: [...this.historicalGaps],
        currentGaps: [...this.currentGaps],
        nodeCount,
        truncated: this.truncatedLastRound,
        transport: "polling",
      }),
    );
  }

  /**
   * Await a sink call for at most one call bound, swallowing and safely logging
   * any failure or hang. Never propagates, so a broken or hung store cannot
   * affect the job or stall finalization.
   */
  private async emitSink(action: () => void | Promise<void>): Promise<void> {
    try {
      await this.raceSettle(Promise.resolve().then(action), this.perCallTimeoutMs);
    } catch {
      this.safeWarn("delegation observation sink failed", this.safeFields());
    }
  }

  /** Invoke the diagnostic seam, swallowing anything it throws. */
  private safeWarn(event: string, fields?: Record<string, unknown>): void {
    try {
      this.warn(event, fields);
    } catch {
      // A diagnostic must never escape.
    }
  }

  /** Non-sensitive diagnostic fields; never an error message payload. */
  private safeFields(): Record<string, unknown> {
    return { attemptId: this.attemptId, ordinal: this.ordinal };
  }
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function clampCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.max(1, Math.floor(value));
}
