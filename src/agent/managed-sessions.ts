/**
 * Track and settle an OpenCode attempt's child sessions before validation and
 * publication (task 3.5; design D4; capability `opencode-agent-profiles`).
 *
 * OpenCode 2's subagent tool can run children in the *background*, and the
 * parent CLI exiting does not prove that background work has stopped: the
 * task-1.2 pinned probe observed a 2.0.16 `run` parent return successfully
 * while a `background: true` child was still running, and that child wrote to
 * the workspace after the parent became idle. Validation, commit, push, and
 * success reporting must therefore wait until every child of the attempt's
 * parent session is provably quiescent.
 *
 * Pinned session surface (verified against the official OpenCode 2.0.16
 * OpenAPI specification, matching the task-1.2 design probe):
 *
 * - `GET /api/session/{sessionID}` -> `{data: Session.Info}`; 404 ->
 *   `SessionNotFoundError`. `Session.Info.id` is `ses…`;
 *   `Session.Info.outcome` is `succeeded`, `failed`, or `interrupted` and is
 *   ABSENT while execution remains unsettled; `Session.Info.location.directory`
 *   is the absolute directory the session runs in.
 * - `GET /api/session` -> `{data: Session.Info[], cursor:{previous,next}}`.
 *   It takes a `parentID` filter ("filter by parent session") and a
 *   `directory` filter, and pages through `cursor.next`.
 * - `GET /api/session/active` -> `{data: {[ses…]: {type:"running"}}}`;
 *   "sessions absent from the result are inactive".
 * - `POST /api/session/{sessionID}/interrupt` -> `{interrupted: boolean}`;
 *   404 when the session does not exist.
 *
 * Child discovery is NOT assumed: it is verified from the same two documented
 * first-class facts. A session record carries its own `parentID`, and the
 * listing endpoint filters by `parentID`. This module therefore only ever
 * treats a session as an attempt child when ALL of the following hold for it:
 *
 * 1. It was returned by a `parentID=<parent>` filtered listing, and
 * 2. Its own record echoes `parentID === <parent>` (so we are not trusting a
 *    filter the server might ignore), and
 * 3. Its `location.directory` resolves to the attempt directory (so it belongs
 *    to this attempt's workspace, not some other run in the same data store).
 *
 * Anything else — a parent record that cannot be read, a listing whose records
 * do not attribute to the parent, a wrong location, a session that vanishes
 * mid-settlement, an outcome value the pinned schema does not define, or a
 * settlement that cannot complete within the remaining attempt timeout —
 * fails closed via {@link OpenCodeSessionDiscoveryError} or
 * {@link OpenCodeSessionSettleError}. In particular the ACTIVE map alone never
 * enumerates children: `GET /api/session/active` carries no parentage, so it
 * is used only to cross-check session ids that discovery already attributed;
 * a running session seen there that we cannot attribute never becomes "our"
 * child.
 *
 * Child discovery recurses. The same parentID-filtered listing, whose records
 * echo their parent, is applied at every level so the attempt's *complete*
 * descendant tree is enumerated, not just the direct children: a background
 * child can itself run a background child, and a still-running ancestor could
 * spawn a new descendant after a leaf check. Every edge requires an echoed
 * parent id and the exact resolved workspace; the walk is bounded by the page
 * cap per listing ({@link OPENCODE_SESSION_LIST_PAGE_LIMIT}), a depth cap
 * ({@link OPENCODE_SESSION_TREE_DEPTH_LIMIT}) and a node cap
 * ({@link OPENCODE_SESSION_TREE_NODE_LIMIT}). A repeated id (a cycle/duplicate)
 * and any record that does not echo the queried parent — even one already
 * attributed by an earlier round — are hard discovery failures. Tolerating a
 * misattributed record would let a service that ignores the parentID filter
 * hide a still-running native descendant and authorize unsafe publication, so
 * the edge proof is never narrowed.
 *
 * Settlement contract (design D4 and the `agent-execution` delta):
 *
 * - The wait for quiescence is bounded by the caller's `timeoutMs`, which is
 *   the portion of the configured agent timeout remaining after the parent
 *   process returned. Discovery may take time too (the parent session row can
 *   still be settling into the store right after the process exits), so
 *   discovery and the quiescence wait share the same budget.
 * - A child is settled only when its record carries a terminal `outcome` AND
 *   it is absent from the active map, mirroring the probe where interrupt made
 *   the outcome `interrupted` and removed it from the map. A child whose
 *   outcome is present yet still appears active is treated as unknown (the two
 *   surfaces contradict each other) and fails closed.
 * - A child with no `outcome` is unsettled: wait for it within the budget, and
 *   interrupt it once the budget is exhausted or the attempt is cancelled.
 *   After interrupting, settlement confirms every interrupted child reaches a
 *   terminal outcome within a short `interruptGraceMs`; an unconfirmed child
 *   fails the attempt, preserving its id in the error for diagnostics.
 * - A missing or unreadable child (404, transport error, unparsable record) is
 *   NEVER treated as settled, because absence is not proof of quiescence.
 * - Quiescence is declared only on a round whose listing AND active map both
 *   read successfully AND whose parent is itself proven quiescent (id ==
 *   expected, no `parentID`, the attempt directory, a terminal `outcome`,
 *   absent from the fresh active map). A glitched listing cannot prove no new
 *   child appeared, a glitched active map cannot prove a session is absent, and
 *   a still-running parent could spawn a new child the moment the listing is
 *   trusted — none may authorize a clean return, and anything that keeps
 *   failing to the bound fails the attempt.
 *
 * The HTTP client is injected so tests can script the pinned surfaces exactly;
 * {@link createCliManagedSessionHttp} is the production transport, speaking the
 * same routes to a live OpenCode service through the installed pinned CLI
 * (`opencode api`). The orchestrator's direction (task 3.5 integration) only
 * constructs it with the attempt's binary, cwd, env, and runner.
 *
 * Transport facts pinned against the installed 2.0.16 CLI (`opencode api`): a
 * successful call prints the raw JSON body on stdout and exits 0; a failed call
 * exits non-zero and prints its HTTP verdict on stderr as `HTTP <status>
 * <reason>` (e.g. `HTTP 404 Not Found`), with no such line on a pure transport
 * failure. A 404 therefore stays distinguishable from a transient fault. The
 * CLI's `--param key=value` flag silently drops query parameters on the session
 * listing and returns unrelated rows, while the same filters embedded in the
 * request path (`/api/session?parentID=...&directory=<encoded>&order=asc`)
 * return exactly the matching children — so the adapter encodes queries into
 * the path and never uses `--param`.
 */

import { defaultRunner, type ProcessRunner } from "./launcher.js";

/** Default wait between observation rounds while a child is still unsettled. */
export const OPENCODE_SESSION_POLL_INTERVAL_MS = 250;

/**
 * How long after interrupting active children the settlement keeps confirming
 * their terminal state before failing closed. The probe saw an interrupted
 * child settle quickly; 5s is a generous bound on the confirmation, not the
 * quiescence wait, which is the caller's `timeoutMs`.
 */
export const OPENCODE_SESSION_INTERRUPT_GRACE_MS = 5_000;

/**
 * Hard cap on the number of `GET /api/session` pages a single child listing
 * follows before failing closed. An attempt's child set is small (a managed
 * profile allows at most a handful of children), so 50 pages is far beyond any
 * real tree and only a pathological store would page further; looping forever
 * on a non-terminating cursor chain would otherwise outlive the attempt budget.
 */
export const OPENCODE_SESSION_LIST_PAGE_LIMIT = 50;

/**
 * Hard cap on how deep the recursive descendant walk descends from the attempt
 * root before failing closed. The root is level 0, its direct children level 1;
 * a session at level 16 may still be enumerated, but a child at level 17 fails
 * the attempt. Nested delegation is real (a background child can spawn its own
 * background child), so the walk must recurse — but an implausibly deep store
 * is a proof failure, never a reason to truncate the tree.
 */
export const OPENCODE_SESSION_TREE_DEPTH_LIMIT = 16;

/**
 * Hard cap on how many descendants the recursive walk may accumulate before
 * failing closed. Exceeding it means the tree cannot be enumerated completely,
 * which is exactly the state that must never authorize validation or
 * publication; truncating instead would let an unseen running descendant pass.
 */
export const OPENCODE_SESSION_TREE_NODE_LIMIT = 1024;

/**
 * Default timeout for one `opencode api` call. The settlement waits are bounded
 * by the remaining attempt timeout, but a hung CLI process — or a hung injected
 * transport — would outlive even that unless every individual call is bound
 * too. The same bound is applied to an injected {@link ManagedSessionHttp} so
 * tests (and future non-CLI transports) cannot stall the settlement past its
 * deadline.
 */
export const OPENCODE_SESSION_CLI_TIMEOUT_MS = 5_000;

/** The pinned session `outcome` vocabulary (OpenCode 2.0.16). */
export type OpenCodeSessionOutcome = "succeeded" | "failed" | "interrupted";

/**
 * One parsed session record (`Session.Info`) from the pinned API. Only the
 * fields settlement relies on are surfaced; extra fields are ignored.
 */
export interface OpenCodeSessionInfo {
  /** The session id (`ses…`). */
  readonly id: string;
  /** The parent session id. Absent on root sessions. */
  readonly parentID?: string;
  /**
   * The terminal outcome. Absent while execution remains unsettled — absence
   * of this field is the API's "still executing" signal (task-1.2 probe).
   */
  readonly outcome?: OpenCodeSessionOutcome;
  /** The absolute directory the session runs in (`location.directory`). */
  readonly directory: string;
}

/**
 * The injectable HTTP transport for the pinned session surface. Tests script
 * `{status, body}` responses directly; {@link createCliManagedSessionHttp} is
 * the production implementation, running `opencode api` for every call.
 */
export interface ManagedSessionHttp {
  /**
   * Send `GET` to a server path (no base URL). `query` becomes the query
   * string; the same endpoint can be called with different filters.
   */
  get(path: string, query?: Readonly<Record<string, string>>): Promise<ManagedHttpResult>;
  /** Send `POST` to a server path (no body; the pinned endpoints take none). */
  post(path: string): Promise<ManagedHttpResult>;
}

/** A raw HTTP response: status plus a parsed (JSON) body when any was sent. */
export interface ManagedHttpResult {
  readonly status: number;
  readonly body: unknown;
}

/* ------------------------------------------------------------------ *
 * Paths — the exact pinned routes, built from a session id
 * ------------------------------------------------------------------ */

/** `GET /api/session/{sessionID}` — one session record. */
export function sessionRecordPath(sessionId: string): string {
  return `/api/session/${encodeURIComponent(sessionId)}`;
}

/** `GET /api/session` — the filtered, paged listing endpoint. */
export function sessionListPath(): string {
  return "/api/session";
}

/** The `parentID`, `directory`, and ordering filter for a child listing. */
export function sessionChildListQuery(
  parentSessionId: string,
  attemptDirectory: string,
  options?: { readonly cursor?: string },
): Record<string, string> {
  const query: Record<string, string> = {
    parentID: parentSessionId,
    directory: attemptDirectory,
    order: "asc",
  };
  if (options?.cursor !== undefined) query.cursor = options.cursor;
  return query;
}

/** `GET /api/session/active` — the running sessions map, keyed by session id. */
export function sessionActivePath(): string {
  return "/api/session/active";
}

/** `POST /api/session/{sessionID}/interrupt` — interrupt one session. */
export function sessionInterruptPath(sessionId: string): string {
  return `/api/session/${encodeURIComponent(sessionId)}/interrupt`;
}

/* ------------------------------------------------------------------ *
 * Parsers — pure, so the verdicts can be unit-tested directly
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse one `Session.Info` from the API's `{data: Session.Info}` envelope.
 * Returns `undefined` for anything that cannot be trusted: no id, no
 * directory, or an `outcome` outside the pinned enum (an outcome we cannot
 * classify is a state we must fail on, never guess at).
 */
export function parseSessionRecord(body: unknown): OpenCodeSessionInfo | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  if (!isRecord(data)) return undefined;
  const id = asString(data.id);
  if (id === undefined) return undefined;
  const directory = isRecord(data.location) ? asString(data.location.directory) : undefined;
  if (directory === undefined) return undefined;
  const parentID = asString(data.parentID);
  let outcome: OpenCodeSessionOutcome | undefined;
  if (data.outcome !== undefined) {
    const value = data.outcome;
    if (value !== "succeeded" && value !== "failed" && value !== "interrupted") return undefined;
    outcome = value;
  }
  const info: OpenCodeSessionInfo = {
    id,
    directory,
    ...(parentID === undefined ? {} : { parentID }),
    ...(outcome === undefined ? {} : { outcome }),
  };
  return info;
}

/** One page of the child listing: parsed records plus the next cursor. */
export interface OpenCodeSessionListingPage {
  readonly items: readonly OpenCodeSessionInfo[];
  readonly nextCursor?: string;
}

/**
 * Parse one page of `GET /api/session` (`{data: Session.Info[], cursor}`).
 * Any item that is not a usable record makes the whole page unusable: a
 * session we cannot read could be a child we must refuse to skip.
 *
 * The cursor is just as load-bearing as the items: absence of a next page is
 * ONLY the explicit `cursor.next === null` the pinned schema defines. A missing
 * `cursor`, a missing `next`, or a `next` that is not a non-empty string is a
 * malformed end-of-list shape, not proof that the page chain ended — treating
 * it as final would silently truncate the child set and could hide a running
 * descendant. Such shapes reject the page instead.
 */
export function parseSessionListing(body: unknown): OpenCodeSessionListingPage | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  if (!Array.isArray(data)) return undefined;
  const items: OpenCodeSessionInfo[] = [];
  for (const raw of data) {
    const item = parseSessionRecord({ data: raw });
    if (item === undefined) return undefined;
    items.push(item);
  }
  const cursor = body.cursor;
  if (!isRecord(cursor) || !("next" in cursor)) return undefined;
  if (cursor.next === null) return { items };
  if (typeof cursor.next !== "string" || cursor.next.length === 0) return undefined;
  return { items, nextCursor: cursor.next };
}

/**
 * Parse `GET /api/session/active` into the set of running session ids. The
 * pinned shape is `{data: {[ses…]: {type:"running"}}}`; each entry's `type`
 * must be `running` or the map is unusable.
 */
export function parseActiveSessions(body: unknown): ReadonlySet<string> | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  if (!isRecord(data)) return undefined;
  const active = new Set<string>();
  for (const [id, entry] of Object.entries(data)) {
    if (!isRecord(entry) || entry.type !== "running") return undefined;
    if (!/^ses/u.test(id)) return undefined;
    active.add(id);
  }
  return active;
}

/** Parse `POST /api/session/{sessionID}/interrupt` (`{interrupted: boolean}`). */
export function parseInterruptResponse(body: unknown): { interrupted: boolean } | undefined {
  if (!isRecord(body)) return undefined;
  return typeof body.interrupted === "boolean" ? { interrupted: body.interrupted } : undefined;
}

/* ------------------------------------------------------------------ *
 * Fail-closed errors
 * ------------------------------------------------------------------ */

/**
 * Raised when the attempt's child sessions cannot be enumerated and attributed
 * reliably from the session API. This is the "report issue and stop" path: the
 * module never invents children, and a parentage it cannot prove is a
 * discovery limitation, reported distinctly from a settlement failure so the
 * operator can re-probe the pinned CLI rather than read it as the agent's work
 * failing.
 */
export class OpenCodeSessionDiscoveryError extends Error {
  /** The specific unverified fact that forced the stop. */
  readonly reason: string;

  constructor(reason: string) {
    super(`Cannot enumerate OpenCode child sessions for the attempt:\n- ${reason}`);
    this.name = "OpenCodeSessionDiscoveryError";
    this.reason = reason;
  }
}

/**
 * Raised when quiescence cannot be PROVEN. A child with unknown state (missing
 * record, unparsable record, contradictory surfaces) or one that is still
 * running after the attempt boundary is a failed, quarantined attempt that
 * must not validate, commit, push, or report success. The ids are preserved so
 * the attempt records diagnostic evidence (design D4).
 */
export class OpenCodeSessionSettleError extends Error {
  /** Children that are still provably unsettled at the failure. */
  readonly unsettledSessionIds: readonly string[];
  /** Children whose state could not be read or was contradictory. */
  readonly unknownSessionIds: readonly string[];

  constructor(
    reason: string,
    details: {
      readonly unsettledSessionIds?: readonly string[];
      readonly unknownSessionIds?: readonly string[];
    } = {},
  ) {
    super(`OpenCode child sessions are not provably quiescent:\n- ${reason}`);
    this.name = "OpenCodeSessionSettleError";
    this.unsettledSessionIds = details.unsettledSessionIds ?? [];
    this.unknownSessionIds = details.unknownSessionIds ?? [];
  }
}

/* ------------------------------------------------------------------ *
 * Child state classification
 * ------------------------------------------------------------------ */

/**
 * The settlement verdict for one session in one observation round.
 *
 * - `settled` — a terminal `outcome` AND absent from the active map. Both
 *   surfaces agree the session can no longer modify the workspace.
 * - `running` — unsettled: no terminal `outcome` (the API keeps it absent
 *   while execution remains ongoing) and/or still present in the active map.
 *   A session can be absent from the map yet still lack an outcome; that is
 *   still `running` — not provably stopped, so it must wait or be interrupted.
 * - `unknown` — cannot be classified: a `record` that is not a usable session
 *   record, an outcome the pinned schema does not define, or an outcome that
 *   contradicts the active map (present yet still active). Every unknown child
 *   fails the settlement.
 */
export type ChildSessionState =
  | { readonly state: "settled"; readonly outcome: OpenCodeSessionOutcome }
  | { readonly state: "running" }
  | { readonly state: "unknown"; readonly reason: string };

/** Classify one session from its parsed record (if readable) and the active map. */
export function classifyChildSession(
  record: OpenCodeSessionInfo | undefined,
  active: ReadonlySet<string>,
): ChildSessionState {
  const sessionId = record?.id ?? "";
  if (record === undefined) {
    return {
      state: "unknown",
      reason: `${sessionId}: no readable session record (missing or unusable)`,
    };
  }
  const isActive = active.has(record.id);
  const outcome = record.outcome;
  if (outcome === undefined) {
    // No terminal outcome: the API itself reports execution as unsettled.
    return { state: "running" };
  }
  if (isActive) {
    return {
      state: "unknown",
      reason:
        `${record.id}: outcome "${outcome}" while still listed in the active map; ` +
        "the two surfaces contradict each other",
    };
  }
  return { state: "settled", outcome };
}

/* ------------------------------------------------------------------ *
 * Runtime helpers
 * ------------------------------------------------------------------ */

function sameResolvedPath(left: string, right: string): boolean {
  // The listing may come from the same host, but normalize before comparing so
  // a trailing separator or a sibling-typed path cannot slip past.
  let a = left.replace(/[\\/]+$/u, "");
  let b = right.replace(/[\\/]+$/u, "");
  if (a.length === 0 || b.length === 0) return false;
  if (process.platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b;
}

/** A delay that resolves immediately on abort instead of rejecting. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise();
      return;
    }
    const settle = (): void => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(settle, ms);
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Reject `promise` when it does not settle within `timeoutMs`, or as soon as
 * `signal` aborts. The CLI transport already bounds each process, but an
 * injected transport (or a future non-CLI one) could hang forever; the
 * settlement's own deadline is a fake-clock value and cannot interrupt a pending
 * promise, so every call is put in a real race here. A timeout surfaces as a
 * transport error, which the loops map to a bounded `glitch` — never to
 * quiescence. The signal is passed only for observation reads (so a cancelled
 * attempt stops reading promptly); interrupt POSTs are deliberately never
 * aborted, because they must still reach the service, bounded by the remaining
 * grace.
 */
function withCallTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => rejectPromise(new Error("session API call aborted")));
    const timer = setTimeout(
      () => finish(() => rejectPromise(new Error("session API call timed out"))),
      Math.max(1, timeoutMs),
    );
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (value) => finish(() => resolvePromise(value)),
      (error: unknown) => finish(() => rejectPromise(error)),
    );
  });
}

/**
 * Wrap a session transport so every call is bounded by the SMALLER of the
 * per-call cap and whatever budget remains of the active deadline (the attempt
 * budget while observing, the interrupt grace while interrupting). Recomputing
 * the bound per call from the live clock means a walk of 16/1024 nodes cannot
 * spend the full per-call timeout on each one: once the budget is spent every
 * remaining call fails fast as a transport glitch, which can never authorize
 * quiescence.
 *
 * `getSignal` returns the abort signal to apply to GET (observation) calls; it
 * is `undefined` once interrupting so the attributed interrupt POSTs and the
 * confirming reads can still complete. POST calls are never aborted.
 */
function boundSessionHttp(
  http: ManagedSessionHttp,
  perCallTimeoutMs: number,
  remaining: () => number,
  getSignal: () => AbortSignal | undefined,
): ManagedSessionHttp {
  const callTimeout = (): number => {
    const left = remaining();
    if (left <= 0) return 1;
    return Math.max(1, Math.min(perCallTimeoutMs, left));
  };
  return {
    get: (path, query) => withCallTimeout(http.get(path, query), callTimeout(), getSignal()),
    post: (path) => withCallTimeout(http.post(path), callTimeout()),
  };
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

export interface DiscoverAttemptChildrenInput {
  /** The parent session id captured from the attempt's `run` output. */
  readonly parentSessionId: string;
  /**
   * The absolute attempt workspace — the same location the parent session ran
   * in. Discovery scopes the listing to it and refuses children elsewhere.
   */
  readonly attemptDirectory: string;
  /** The injectable pinned-session HTTP client. */
  readonly http: ManagedSessionHttp;
  /**
   * The remaining attempt timeout in ms: the parent already consumed part of
   * the configured agent timeout, and discovery + the quiescence wait share
   * what is left.
   */
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  /**
   * Per-call bound for the transport in ms. Defaults to
   * {@link OPENCODE_SESSION_CLI_TIMEOUT_MS}; a hung injected call is failed as
   * a transport glitch rather than left to stall the settlement. Discovery is
   * deliberately NOT abort-bound: cancellation must still enumerate the known
   * children so the settlement can interrupt them, and the per-call bound
   * already keeps a hung discovery call finite.
   */
  readonly perCallTimeoutMs?: number;
  /** Injectable clock and sleeper for deterministic tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DiscoverAttemptChildrenResult {
  readonly parentSessionId: string;
  /**
   * Every descendant attributed to the parent under the attempt directory, in
   * breadth-first discovery order (direct children first, then nested ones).
   */
  readonly children: readonly OpenCodeSessionInfo[];
}

/** The result of reading the attempt's own parent session record. */
type AttemptParentRead =
  | { readonly status: "ok"; readonly record: OpenCodeSessionInfo }
  | { readonly status: "glitch" }
  | { readonly status: "unusable" };

/**
 * Read the parent record through the pinned `GET /api/session/{id}` route and
 * verify it IS this attempt's parent: the record must come back with the
 * expected id, WITHOUT a `parentID` (a root attempt's own session can never be
 * a child), and in the attempt directory. Any deviation is a deterministic
 * fault, not a race, and the attempt must stop rather than attribute or settle
 * another run's sessions. Unreadable/non-200 responses stay `glitch` for the
 * bounded cold-read retry (design D4: the row can still be settling into the
 * store right after the process exits); a readable HTTP response that is not a
 * usable session record is `unusable`, a state.
 */
async function readAttemptParent(
  http: ManagedSessionHttp,
  parentSessionId: string,
  attemptDirectory: string,
): Promise<AttemptParentRead> {
  let result: ManagedHttpResult;
  try {
    result = await http.get(sessionRecordPath(parentSessionId));
  } catch {
    return { status: "glitch" }; // transient transport error: bounded retry, then fail
  }
  if (result.status === 404 || result.status !== 200) {
    return { status: "glitch" }; // row still settling into the store
  }
  const parsed = parseSessionRecord(result.body);
  if (parsed === undefined) return { status: "unusable" }; // readable HTTP, unreadable session
  if (parsed.id !== parentSessionId) {
    throw new OpenCodeSessionDiscoveryError(
      `the session record read for parent ${parentSessionId} came back with id ${parsed.id}; ` +
        "the parent surface cannot be trusted",
    );
  }
  if (parsed.parentID !== undefined) {
    throw new OpenCodeSessionDiscoveryError(
      `parent session ${parentSessionId} carries parentID ${parsed.parentID}; ` +
        "a root attempt's own session cannot itself be a child — the wrong session was returned",
    );
  }
  if (!sameResolvedPath(parsed.directory, attemptDirectory)) {
    throw new OpenCodeSessionDiscoveryError(
      `parent session ${parentSessionId} runs in ${parsed.directory}, ` +
        `not the attempt workspace ${attemptDirectory} — it is not this attempt's session`,
    );
  }
  return { status: "ok", record: parsed };
}

/**
 * Page through `GET /api/session?parentID=<parent>&directory=<attempt>` and
 * return the direct records that echo the parent, validating attribution as it
 * goes. The three-variant result distinguishes a transient read failure
 * (`glitch`, retried within the bound) from a readable-but-unusable response
 * (`unusable`, a state that must fail immediately).
 *
 * EVERY returned record must echo the queried parent AND live in the attempt
 * workspace. A record that names any other parent — even one we have already
 * attributed with an unchanged recorded parent — throws
 * {@link OpenCodeSessionDiscoveryError} the moment it is seen. Tolerating such
 * a record would let a service that ignores the `parentID` filter (returning
 * root siblings, or an already-seen child, for a nested query) hide a
 * still-running native descendant and authorize publication; the edge proof is
 * never narrowed for the sake of a lenient fake.
 *
 * The page chain must terminate: a repeated cursor is a non-terminating chain
 * (the child set can never be trusted complete), and {@link
 * OPENCODE_SESSION_LIST_PAGE_LIMIT} caps how many pages are followed. Both fail
 * closed rather than loop past the attempt budget.
 */
async function listChildrenForNode(
  http: ManagedSessionHttp,
  parentSessionId: string,
  attemptDirectory: string,
): Promise<
  | { readonly status: "ok"; readonly children: readonly OpenCodeSessionInfo[] }
  | { readonly status: "glitch" }
  | { readonly status: "unusable" }
> {
  const children: OpenCodeSessionInfo[] = [];
  let cursor: string | undefined;
  const usedCursors = new Set<string>();
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > OPENCODE_SESSION_LIST_PAGE_LIMIT) {
      throw new OpenCodeSessionDiscoveryError(
        `the parentID=${parentSessionId} child listing exceeded ` +
          `${String(OPENCODE_SESSION_LIST_PAGE_LIMIT)} pages; the child set is implausibly ` +
          "large and cannot be trusted",
      );
    }
    let result: ManagedHttpResult;
    try {
      result = await http.get(
        sessionListPath(),
        sessionChildListQuery(parentSessionId, attemptDirectory, {
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
    } catch {
      return { status: "glitch" };
    }
    if (result.status !== 200) return { status: "glitch" };
    const page = parseSessionListing(result.body);
    if (page === undefined) return { status: "unusable" };
    for (const item of page.items) {
      if (!sameResolvedPath(item.directory, attemptDirectory)) {
        throw new OpenCodeSessionDiscoveryError(
          `session ${item.id} names parent ${parentSessionId} but runs in ${item.directory}, ` +
            `not the attempt workspace ${attemptDirectory} — another run's child must not be settled here`,
        );
      }
      if (item.parentID !== parentSessionId) {
        throw new OpenCodeSessionDiscoveryError(
          `session ${item.id} was returned by the parentID=${parentSessionId} listing but ` +
            `its own record names parent ${item.parentID ?? "(none)"} — the child surface ` +
            "cannot be trusted",
        );
      }
      children.push(item);
    }
    if (page.nextCursor === undefined) break;
    const next = page.nextCursor;
    if (usedCursors.has(next)) {
      throw new OpenCodeSessionDiscoveryError(
        `the parentID=${parentSessionId} child listing repeated cursor ${JSON.stringify(next)}; ` +
          "the page chain cannot terminate, so the child set cannot be trusted",
      );
    }
    usedCursors.add(next);
    cursor = next;
  }
  return { status: "ok", children };
}

/** The full descendant picture produced by one complete recursive walk. */
interface DescendantTree {
  /** Every descendant, keyed by id (the attempt root is NOT included). */
  readonly records: ReadonlyMap<string, OpenCodeSessionInfo>;
  /** Descendant ids in breadth-first discovery order. */
  readonly order: readonly string[];
  /** Descendant id -> depth; direct children are depth 1. */
  readonly depths: ReadonlyMap<string, number>;
  /** Descendant id -> the session id it was listed under. */
  readonly parents: ReadonlyMap<string, string | undefined>;
  /**
   * Settlement-only proof that each node was terminal before its own child
   * listing. Undefined for discovery walks, which only enumerate descendants.
   */
  readonly terminalAncestorsBeforeListing?: boolean;
}

interface DescendantTreeReadOptions {
  /** Require each possible spawner to be terminal before listing its children. */
  readonly requireTerminalAncestorsBeforeListing?: boolean;
  /** The root record already read immediately before starting this walk. */
  readonly rootRecord?: OpenCodeSessionInfo;
}

type DescendantTreeResult =
  | { readonly status: "ok"; readonly tree: DescendantTree }
  | { readonly status: "glitch" }
  | { readonly status: "unusable" };

/**
 * Walk the attempt's complete descendant tree with the filtered parentID
 * listing, one level at a time. The root is level 0; every record returned for
 * `parentID=<node>` must echo that node and live in the attempt workspace (see
 * {@link listChildrenForNode}) or the walk fails closed. A repeated id (a
 * cycle or an id returned under two parents), an over-deep chain and an
 * over-large tree all fail closed rather than truncate the proof. Returns
 * `glitch`/`unusable` unchanged so the caller can retry or fail exactly as for
 * a single listing.
 */
async function readDescendantTree(
  http: ManagedSessionHttp,
  rootSessionId: string,
  attemptDirectory: string,
  options?: DescendantTreeReadOptions,
): Promise<DescendantTreeResult> {
  const records = new Map<string, OpenCodeSessionInfo>();
  const depths = new Map<string, number>();
  const order: string[] = [];
  const parents = new Map<string, string | undefined>();
  let terminalAncestorsBeforeListing =
    options?.requireTerminalAncestorsBeforeListing === true &&
    options.rootRecord?.outcome !== undefined;
  // The root is seeded so a child listing that tries to return the root itself
  // is caught as a cycle rather than silently attributed.
  parents.set(rootSessionId, undefined);

  const queue: Array<{ readonly id: string; readonly depth: number }> = [
    { id: rootSessionId, depth: 0 },
  ];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (options?.requireTerminalAncestorsBeforeListing === true) {
      if (node.depth === 0) {
        // The caller read the root before entering this walk. A missing or
        // non-terminal root record cannot prove this listing excludes future
        // children.
        if (options.rootRecord?.outcome === undefined) {
          terminalAncestorsBeforeListing = false;
        }
      } else {
        // A descendant can spawn its own children, so its own record must be
        // read BEFORE its child listing. A listing at a higher level may carry
        // an older snapshot and cannot prove this node was already terminal.
        const parentId = parents.get(node.id);
        const read = await readAttemptChildRecord(
          http,
          node.id,
          parentId ?? rootSessionId,
          attemptDirectory,
        );
        if (read.status === "missing") {
          throw new OpenCodeSessionSettleError(
            `child session ${node.id} returned 404 before its descendants could be enumerated; ` +
              "a child that cannot be confirmed stopped must fail the attempt",
            { unknownSessionIds: [node.id] },
          );
        }
        if (read.status === "unusable") {
          throw new OpenCodeSessionSettleError(
            `child session ${node.id} returned a session record that cannot be attributed to this attempt; ` +
              "unknown child state fails the attempt",
            { unknownSessionIds: [node.id] },
          );
        }
        if (read.status === "glitch") {
          // We can still enumerate known nodes, but this round cannot prove
          // that this ancestor was unable to spawn during its listing.
          terminalAncestorsBeforeListing = false;
        } else {
          // Prefer the direct, pre-listing record for this node's settlement
          // state as well: the parent listing can carry an older snapshot.
          records.set(node.id, read.record);
          if (read.record.outcome === undefined) {
            terminalAncestorsBeforeListing = false;
          }
        }
      }
    }
    const listing = await listChildrenForNode(http, node.id, attemptDirectory);
    if (listing.status === "glitch") return { status: "glitch" };
    if (listing.status === "unusable") return { status: "unusable" };
    for (const child of listing.children) {
      if (parents.has(child.id)) {
        throw new OpenCodeSessionDiscoveryError(
          `session ${child.id} appeared more than once while walking the ` +
            `parentID=${rootSessionId} descendant tree (listed under ${node.id}); a repeated ` +
            "id is a cycle or duplicate and the descendant tree cannot be trusted",
        );
      }
      const depth = node.depth + 1;
      if (depth > OPENCODE_SESSION_TREE_DEPTH_LIMIT) {
        throw new OpenCodeSessionDiscoveryError(
          `the parentID=${rootSessionId} descendant tree exceeded ` +
            `${String(OPENCODE_SESSION_TREE_DEPTH_LIMIT)} levels; the child set is implausibly ` +
            "deep and cannot be trusted",
        );
      }
      if (records.size >= OPENCODE_SESSION_TREE_NODE_LIMIT) {
        throw new OpenCodeSessionDiscoveryError(
          `the parentID=${rootSessionId} descendant tree exceeded ` +
            `${String(OPENCODE_SESSION_TREE_NODE_LIMIT)} nodes; the child set is implausibly ` +
            "large and cannot be trusted",
        );
      }
      records.set(child.id, child);
      depths.set(child.id, depth);
      order.push(child.id);
      parents.set(child.id, node.id);
      queue.push({ id: child.id, depth });
    }
  }
  return {
    status: "ok",
    tree: {
      records,
      order,
      depths,
      parents,
      ...(options?.requireTerminalAncestorsBeforeListing === true
        ? { terminalAncestorsBeforeListing }
        : {}),
    },
  };
}

/**
 * Enumerate and attribute the attempt's child sessions under one attempt
 * location. Bounded by `timeoutMs`: the parent session row and its children
 * can still be settling into the store right after the parent process exits,
 * so an unreadable response is polled until it resolves or the budget dies.
 * An empty list means no children were attributed — quiescence is then the
 * settlement's job to prove from the parent's own record (see
 * {@link settleAttemptChildren}), not something this enumeration decides.
 * Nothing here ever falls back to the active map for enumeration.
 */
export async function discoverAttemptChildSessions(
  input: DiscoverAttemptChildrenInput,
): Promise<DiscoverAttemptChildrenResult> {
  const pollIntervalMs = input.pollIntervalMs ?? OPENCODE_SESSION_POLL_INTERVAL_MS;
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => delay(ms));
  const deadline = now() + Math.max(0, input.timeoutMs);
  // Discovery never aborts its reads: cancellation must still enumerate the
  // known children so the settlement can interrupt them. Each call is instead
  // capped by the remaining discovery budget so a hung transport cannot outlive
  // it; unknown state after the budget still fails closed.
  const http = boundSessionHttp(
    input.http,
    input.perCallTimeoutMs ?? OPENCODE_SESSION_CLI_TIMEOUT_MS,
    () => deadline - now(),
    () => undefined,
  );

  let lastGlitch = "the parent session record could not be read";
  for (;;) {
    const parent = await readAttemptParent(http, input.parentSessionId, input.attemptDirectory);
    if (parent.status === "unusable") {
      throw new OpenCodeSessionDiscoveryError(
        `the parent session record for ${input.parentSessionId} was returned but could not be ` +
          "parsed into the pinned Session.Info shape",
      );
    }
    if (parent.status === "glitch") {
      if (now() >= deadline) {
        throw new OpenCodeSessionDiscoveryError(
          `${lastGlitch} within the remaining attempt timeout ` +
            `(${String(Math.max(0, input.timeoutMs))}ms after the parent returned)`,
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }
    const tree = await readDescendantTree(http, input.parentSessionId, input.attemptDirectory);
    if (tree.status === "unusable") {
      throw new OpenCodeSessionDiscoveryError(
        `the parentID=${input.parentSessionId} child listing was returned but could not be ` +
          "parsed into the pinned SessionsResponse shape",
      );
    }
    if (tree.status === "glitch") {
      lastGlitch = "the parentID-filtered child listing could not be read";
      if (now() >= deadline) {
        throw new OpenCodeSessionDiscoveryError(
          `${lastGlitch} within the remaining attempt timeout ` +
            `(${String(Math.max(0, input.timeoutMs))}ms after the parent returned)`,
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }
    return {
      parentSessionId: input.parentSessionId,
      children: tree.tree.order.map((id) => tree.tree.records.get(id)!),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Per-child and per-surface reads (the pinned routes)
 * ------------------------------------------------------------------ */

type SessionRecordRead =
  | { readonly status: "ok"; readonly record: OpenCodeSessionInfo }
  | { readonly status: "missing" }
  | { readonly status: "unusable" }
  | { readonly status: "glitch" };

/**
 * Read one child's session record through the pinned `GET /api/session/{id}`
 * route and re-verify its attribution. `missing` is definitive (a 404 says the
 * session no longer exists — the "missing child state" that must fail closed);
 * `unusable` is a readable response that no longer classifies as this attempt's
 * child (both must fail immediately); transport/non-404 errors are `glitch`,
 * which the settle loop retries within the bound. A readable record that no
 * longer attributes to this attempt is an unknown state, because we must never
 * settle a session that stopped being our child partway through.
 */
async function readAttemptChildRecord(
  http: ManagedSessionHttp,
  childSessionId: string,
  expectedParentSessionId: string,
  attemptDirectory: string,
): Promise<SessionRecordRead> {
  let result: ManagedHttpResult;
  try {
    result = await http.get(sessionRecordPath(childSessionId));
  } catch {
    return { status: "glitch" };
  }
  if (result.status === 404) return { status: "missing" };
  if (result.status !== 200) return { status: "glitch" };
  const record = parseSessionRecord(result.body);
  if (record === undefined) return { status: "unusable" };
  if (
    record.parentID !== expectedParentSessionId ||
    !sameResolvedPath(record.directory, attemptDirectory)
  ) {
    return { status: "unusable" };
  }
  return { status: "ok", record };
}

/**
 * Read the active sessions map. A readable-but-unusable response is a hard
 * failure (`unusable`), because quiescence cannot be cross-checked against it;
 * transport/non-200 failures are a `glitch` and keep the previous map.
 */
async function readActiveSessions(
  http: ManagedSessionHttp,
): Promise<
  | { readonly status: "ok"; readonly active: ReadonlySet<string> }
  | { readonly status: "unusable" }
  | { readonly status: "glitch" }
> {
  let result: ManagedHttpResult;
  try {
    result = await http.get(sessionActivePath());
  } catch {
    return { status: "glitch" };
  }
  if (result.status !== 200) return { status: "glitch" };
  const active = parseActiveSessions(result.body);
  return active === undefined ? { status: "unusable" } : { status: "ok", active };
}

/**
 * Interrupt one child through the pinned `POST /api/session/{id}/interrupt`
 * route. `interrupted: false` is not a failure — it simply means no execution
 * owned by this process was draining, and the next observation round decides —
 * but an unreadable response or a vanished session is a state we cannot trust.
 */
async function interruptAttemptChild(
  http: ManagedSessionHttp,
  childSessionId: string,
): Promise<
  | { readonly status: "ok" }
  | { readonly status: "missing" }
  | { readonly status: "unusable" }
  | { readonly status: "glitch" }
> {
  let result: ManagedHttpResult;
  try {
    result = await http.post(sessionInterruptPath(childSessionId));
  } catch {
    return { status: "glitch" };
  }
  if (result.status === 404) return { status: "missing" };
  if (result.status !== 200) return { status: "glitch" };
  return parseInterruptResponse(result.body) === undefined
    ? { status: "unusable" }
    : { status: "ok" };
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

export interface ChildSettlement {
  /** The child session id. */
  readonly id: string;
  /** The terminal outcome the child reached (`succeeded`/`failed`/`interrupted`). */
  readonly outcome: OpenCodeSessionOutcome;
  /** True when this child had to be interrupted to reach quiescence. */
  readonly interrupted: boolean;
  /**
   * The parent session this descendant was listed under. Present only for
   * nested descendants (depth > 1); direct children keep the original shape.
   */
  readonly parentID?: string;
  /**
   * The descendant's depth (direct children are 1). Present only for nested
   * descendants so the flat result still conveys the tree shape.
   */
  readonly depth?: number;
}

export interface ManagedAttemptSettlement {
  readonly parentSessionId: string;
  /**
   * Every descendant of the attempt, direct children and nested background
   * children alike, in breadth-first discovery order, with its final outcome.
   */
  readonly children: readonly ChildSettlement[];
  /** The ids Gremlyn interrupted to reach quiescence (empty when none were needed). */
  readonly interruptedSessionIds: readonly string[];
  /** How many observation rounds settlement ran. */
  readonly rounds: number;
}

export interface SettleAttemptChildrenInput {
  /** The parent session id captured from the attempt's `run` output. */
  readonly parentSessionId: string;
  /** The absolute attempt workspace, scoping discovery and children. */
  readonly attemptDirectory: string;
  /** The injectable pinned-session HTTP client. */
  readonly http: ManagedSessionHttp;
  /**
   * The remaining portion of the configured agent timeout in ms. Discovery and
   * the quiescence wait share this budget; on expiry, remaining children are
   * interrupted and confirmed within `interruptGraceMs`.
   */
  readonly timeoutMs: number;
  readonly interruptGraceMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * Per-call bound for the transport in ms. Defaults to
   * {@link OPENCODE_SESSION_CLI_TIMEOUT_MS}; a hung injected transport is
   * failed as a transport glitch rather than left to stall the settlement.
   */
  readonly perCallTimeoutMs?: number;
  /** Abort the attempt: immediately switches to interrupting remaining children. */
  readonly signal?: AbortSignal;
  /** Injectable clock and sleeper for deterministic tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait until the attempt's child sessions are provably quiescent (design D4,
 * `agent-execution` delta: no validation, commit, push, or success report
 * before a child can no longer modify the workspace), then — for an EMPTY tree
 * — the same for the parent itself.
 *
 * Bounded and fail-closed:
 *
 * - Children are enumerated only by the attributed recursive parentID listing
 *   (see {@link discoverAttemptChildSessions}); nothing invents children, and
 *   the active map is never an enumeration source.
 * - A settled child needs a terminal `outcome` AND absence from the active map.
 *   No outcome means unsettled; a missing, unreadable, or contradictory child
 *   is unknown and fails the settlement.
 * - Quiescence is declared only on a round that produced a full, fresh picture:
 *   successfully read listings for the WHOLE descendant tree (no unseen child
 *   could exist at any level) AND a successfully read active map (every absence
 *   is a real absence). A glitched listing or active map never authorizes a
 *   return — a new child may have spawned, or a session become active, since the
 *   last successful read, and a still-running ancestor could spawn after a leaf
 *   check.
 * - An empty tree is NOT trivially quiescent: the parent's own record must
 *   prove it cannot spawn — id == expected, the attempt directory, a terminal
 *   `outcome`, and absence from the active map ({@link settleParentOnlyTree}).
 * - Every individual transport call is bounded by the SMALLER of
 *   `perCallTimeoutMs` and the budget remaining on the active deadline (the
 *   attempt budget while observing, the interrupt grace while interrupting), so
 *   a walk over many nodes cannot spend the full per-call timeout on each one.
 *   A cancel that arrives mid-observation aborts the in-flight observation
 *   reads so the switch is prompt, and the default observe-phase poll wait also
 *   returns on abort; once the interrupt phase begins the default wait is
 *   always the full bounded interval (even with the signal aborted) so the
 *   confirmation rounds poll rather than spin. A signal already aborted before
 *   settlement still gets one observation pass so the tree can be attributed,
 *   and attributed interrupt POSTs always proceed within the bounded grace.
 * - The whole wait is bounded by `timeoutMs` (the remaining attempt budget).
 *   When the budget is exhausted — or the attempt signal is cancelled — every
 *   still-running session is interrupted via
 *   `POST /api/session/{id}/interrupt` and settlement confirms each reaches a
 *   terminal outcome within `interruptGraceMs`, failing closed with the
 *   offending ids preserved if any cannot be confirmed. An unreadable surface
 *   at the bound fails the same way: quiescence cannot be proven. Only sessions
 *   this attempt attributed are ever interrupted.
 *
 * Returns once quiescence is proven; throws {@link OpenCodeSessionDiscoveryError}
 * when the child surface cannot be enumerated reliably, and
 * {@link OpenCodeSessionSettleError} when quiescence cannot be proven.
 */
export async function settleAttemptChildren(
  input: SettleAttemptChildrenInput,
): Promise<ManagedAttemptSettlement> {
  const pollIntervalMs = input.pollIntervalMs ?? OPENCODE_SESSION_POLL_INTERVAL_MS;
  const interruptGraceMs = input.interruptGraceMs ?? OPENCODE_SESSION_INTERRUPT_GRACE_MS;
  const now = input.now ?? (() => Date.now());
  const perCallTimeoutMs = input.perCallTimeoutMs ?? OPENCODE_SESSION_CLI_TIMEOUT_MS;
  const deadline = now() + Math.max(0, input.timeoutMs);
  const callState: SettleCallState = { phase: "observe", deadline };
  // The DEFAULT poll wait returns promptly on cancellation only while
  // observing. Once interrupting it must always wait the bounded interval even
  // when the original signal is already aborted: an abort-aware wait would
  // resolve instantly on every interrupt/confirmation round, spinning the loop
  // while the service is being asked to drain. Only the observation reads and
  // the observe-phase wait race the signal; the interrupt POSTs are never
  // aborted (boundSessionHttp drops the signal once interrupting).
  const sleep =
    input.sleep ??
    ((ms: number) => (callState.phase === "observe" ? delay(ms, input.signal) : delay(ms)));
  // A signal already aborted before settlement began does not abort the first
  // observation pass: the attempt still needs a read to attribute its tree so
  // the interrupt phase can target the right sessions (the loop flips to
  // interrupt after that pass). A signal that aborts mid-observation aborts the
  // in-flight reads so the switch is prompt.
  const startedWithAbort = input.signal?.aborted ?? false;
  const ctx: SettleContext = {
    http: boundSessionHttp(
      input.http,
      perCallTimeoutMs,
      () => callState.deadline - now(),
      // Observation reads abort on a mid-flight cancel; once interrupting,
      // reads/POSTs must still be able to prove/confirm quiescence.
      () => (callState.phase === "observe" && !startedWithAbort ? input.signal : undefined),
    ),
    callState,
    parentSessionId: input.parentSessionId,
    attemptDirectory: input.attemptDirectory,
    pollIntervalMs,
    interruptGraceMs,
    now,
    sleep,
    deadline,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };

  const discovered = await discoverAttemptChildSessions({
    parentSessionId: input.parentSessionId,
    attemptDirectory: input.attemptDirectory,
    http: input.http,
    timeoutMs: input.timeoutMs,
    pollIntervalMs,
    perCallTimeoutMs,
    now,
    sleep,
  });
  // An empty listing leaves only the parent able to spawn more children: prove
  // it cannot before declaring the tree quiescent.
  if (discovered.children.length === 0) return settleParentOnlyTree(ctx);
  return settleTree(ctx, discovered.children);
}

/** Mutable phase/budget driving the per-call transport bound. */
interface SettleCallState {
  phase: "observe" | "interrupt";
  /** The deadline currently in force: the attempt budget, or the interrupt grace. */
  deadline: number;
}

/** Shared clock/HTTP/budget state threaded through the settlement loops. */
interface SettleContext {
  readonly http: ManagedSessionHttp;
  readonly callState: SettleCallState;
  readonly parentSessionId: string;
  readonly attemptDirectory: string;
  readonly pollIntervalMs: number;
  readonly interruptGraceMs: number;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly deadline: number;
}

/**
 * Switch the settlement into its interrupt phase: observation reads stop being
 * aborted, and every subsequent transport call is capped by the interrupt grace
 * (not the expired attempt budget). Returns the grace deadline.
 */
function enterInterrupt(ctx: SettleContext): number {
  const interruptDeadline = ctx.now() + Math.max(0, ctx.interruptGraceMs);
  ctx.callState.phase = "interrupt";
  ctx.callState.deadline = interruptDeadline;
  return interruptDeadline;
}

/**
 * Settle a non-empty descendant tree: observe EVERY attributed descendant,
 * direct or nested, until it is terminal AND absent from the active map within
 * the shared deadline. Each round re-reads the whole tree: a complete fresh
 * listing for every node (no unseen descendant can exist at any level) plus a
 * fresh active map, then proves every known descendant AND the root terminal
 * and inactive. A still-running ancestor is never trusted — quiescence requires
 * all of them terminal and inactive; see {@link settleAttemptChildren}. A
 * glitched listing falls back to per-node reads of the already-known
 * descendants but can never declare quiescence.
 */
async function settleTree(
  ctx: SettleContext,
  discoveredChildren: readonly OpenCodeSessionInfo[],
): Promise<ManagedAttemptSettlement> {
  const { http, parentSessionId, attemptDirectory } = ctx;

  // Every descendant ever attributed in this settlement, in first-seen order,
  // with the session it was listed under. Records are retained across rounds so
  // a transient listing glitch never loses a known descendant.
  const seen = new Map<string, OpenCodeSessionInfo>();
  const seenOrder: string[] = [];
  const knownParents = new Map<string, string | undefined>();
  for (const child of discoveredChildren) {
    if (seen.has(child.id)) continue;
    seen.set(child.id, child);
    seenOrder.push(child.id);
    knownParents.set(child.id, child.parentID ?? parentSessionId);
  }

  let active = new Set<string>();
  const interrupted = new Set<string>();
  let rounds = 0;
  let phase: "observe" | "interrupt" = "observe";
  let interruptDeadline = ctx.deadline;

  for (;;) {
    rounds += 1;

    // Parent proof FIRST — before the authoritative listing. A parent that
    // already carries a terminal outcome cannot spawn a new child, so the
    // listing below is complete with respect to the parent's own spawns.
    // Reading the parent only AFTER the listing (as an earlier revision did)
    // lets the parent spawn between the two, then turn terminal before the
    // parent read, and falsely prove a stale/empty tree quiescent. Attribution
    // (id == expected, no parentID, attempt directory) is enforced by
    // readAttemptParent. The parent's inactivity is still cross-checked against
    // the active map, read later in the round.
    const parentRead = await readAttemptParent(http, parentSessionId, attemptDirectory);
    if (parentRead.status === "unusable") {
      throw new OpenCodeSessionSettleError(
        `the parent session record for ${parentSessionId} was returned but could not be ` +
          "parsed into the pinned Session.Info shape; a parent that cannot be proven unable " +
          "to spawn fails the attempt",
        { unknownSessionIds: [parentSessionId] },
      );
    }

    const roundRecords = new Map<string, OpenCodeSessionInfo>();
    const roundDepths = new Map<string, number>();
    let listingOk = false;
    let terminalAncestorsBeforeListing = false;

    // A complete fresh walk of the WHOLE descendant tree is authoritative. A
    // glitched listing falls back to per-node reads of the pinned
    // `GET /api/session/{id}` route, but such a round can NEVER declare
    // quiescence: the fallback cannot prove no NEW child appeared at any level
    // since the last complete walk, so a transient listing failure can never by
    // itself invent quiescence.
    const treeRead = await readDescendantTree(http, parentSessionId, attemptDirectory, {
      requireTerminalAncestorsBeforeListing: true,
      ...(parentRead.status === "ok" ? { rootRecord: parentRead.record } : {}),
    });
    if (treeRead.status === "unusable") {
      // Readable HTTP with an unusable list is a state, not a race: this round
      // cannot verify any descendant, so quiescence is unproven.
      throw new OpenCodeSessionSettleError(
        `the parentID=${parentSessionId} child listing was returned but could not be parsed ` +
          "into the pinned SessionsResponse shape",
      );
    }
    if (treeRead.status === "glitch") {
      for (const id of seenOrder) {
        const read = await readAttemptChildRecord(
          http,
          id,
          knownParents.get(id) ?? parentSessionId,
          attemptDirectory,
        );
        if (read.status === "ok") {
          roundRecords.set(id, read.record);
          // Keep the latest readable record fresh so no later use of `seen`
          // reports a stale outcome.
          seen.set(id, read.record);
        } else if (read.status === "missing") {
          // A 404 is definitive: the child no longer exists at all, which is
          // exactly the "missing child state" that must fail closed.
          throw new OpenCodeSessionSettleError(
            `child session ${id} returned 404 (missing) mid-settlement; ` +
              "a child that cannot be confirmed stopped must fail the attempt",
            { unknownSessionIds: [id] },
          );
        } else if (read.status === "unusable") {
          // Readable HTTP but not classifiable as this attempt's child: an
          // unknown child state, not a transient read failure.
          throw new OpenCodeSessionSettleError(
            `child session ${id} returned a session record that cannot be attributed to this attempt; ` +
              "unknown child state fails the attempt",
            { unknownSessionIds: [id] },
          );
        }
        // A glitched read leaves the descendant without a record this round: it
        // stays unproven, and only a budget/grace expiry turns that into a
        // failure.
      }
    } else {
      listingOk = true;
      const tree = treeRead.tree;
      terminalAncestorsBeforeListing = tree.terminalAncestorsBeforeListing === true;
      // Disappearance and parent stability: a known descendant must still be
      // present under the SAME parent; a vanished or moved session cannot be
      // confirmed stopped and fails the attempt.
      for (const id of seenOrder) {
        const record = tree.records.get(id);
        if (record === undefined) {
          throw new OpenCodeSessionSettleError(
            `child session ${id} vanished from the parentID listing mid-settlement; ` +
              "a child that cannot be confirmed stopped must fail the attempt",
            { unknownSessionIds: [id] },
          );
        }
        const expectedParent = knownParents.get(id);
        if (expectedParent !== undefined && tree.parents.get(id) !== expectedParent) {
          throw new OpenCodeSessionSettleError(
            `child session ${id} changed parent from ${expectedParent} to ` +
              `${tree.parents.get(id) ?? "(none)"} mid-settlement; the descendant tree cannot be trusted`,
            { unknownSessionIds: [id] },
          );
        }
      }
      // Adopt newly appeared descendants (a background child, or a nested child
      // of a still-running ancestor, spawned since the last complete walk); they
      // are inside the attempt boundary and must be settled too.
      for (const id of tree.order) {
        const record = tree.records.get(id)!;
        if (!seen.has(id)) {
          seenOrder.push(id);
          knownParents.set(id, tree.parents.get(id) ?? parentSessionId);
        }
        seen.set(id, record);
        roundRecords.set(id, record);
        roundDepths.set(id, tree.depths.get(id) ?? 1);
      }
    }

    // Active map: the cross-check surface. A glitch keeps the previous trusted
    // map for classification but marks this round as unable to prove absence;
    // the return gate below refuses a round whose active map was not read.
    let activeOk = false;
    const activeRead = await readActiveSessions(http);
    if (activeRead.status === "unusable") {
      throw new OpenCodeSessionSettleError(
        "the active sessions map was returned but could not be parsed into the pinned shape; " +
          "quiescence cannot be cross-checked",
      );
    }
    if (activeRead.status === "ok") {
      activeOk = true;
      active = new Set(activeRead.active);
    }

    // Classify every child against the round's records and the active map.
    const running: string[] = [];
    const unreadable: string[] = [];
    for (const id of seenOrder) {
      const record = roundRecords.get(id);
      if (record === undefined) {
        unreadable.push(id);
        continue;
      }
      const verdict = classifyChildSession(record, active);
      if (verdict.state === "unknown") {
        throw new OpenCodeSessionSettleError(verdict.reason, { unknownSessionIds: [id] });
      }
      if (verdict.state === "running") running.push(id);
    }

    // Parent proof for THIS round: the attempt's own session must be terminal
    // AND absent from the freshly read active map, or it could still spawn a
    // brand new child the moment the listing we just read omits it. The record
    // was read at the top of the round — BEFORE the authoritative listing — so
    // a terminal parent cannot have spawned into the listing we just trusted;
    // the active map was read AFTER the listing so a child that finished during
    // the round is not misread as "terminal while still active". Attribution
    // (id == expected, no parentID, attempt directory) is enforced by
    // readAttemptParent.
    let parentProven = false;
    if (parentRead.status === "ok" && activeOk) {
      const parentOutcome = parentRead.record.outcome;
      if (parentOutcome !== undefined && active.has(parentSessionId)) {
        throw new OpenCodeSessionSettleError(
          `parent session ${parentSessionId} has outcome "${parentOutcome}" while still listed ` +
            "in the active map; the two surfaces contradict each other",
          { unknownSessionIds: [parentSessionId] },
        );
      }
      parentProven = parentOutcome !== undefined;
    }

    // Quiescent only with the full, fresh picture of THIS round: a successful
    // listing (the child set is complete), every possible spawner terminal
    // BEFORE its own child listing, a successful active map (every absence is
    // real), every child terminal and inactive, AND the parent itself terminal
    // and inactive. The per-ancestor proof closes the nested spawn/list race:
    // an ancestor that was still running during its listing must be observed
    // again on a later round, when any child it created will be included.
    if (
      running.length === 0 &&
      unreadable.length === 0 &&
      listingOk &&
      terminalAncestorsBeforeListing &&
      activeOk &&
      parentProven
    ) {
      const children: ChildSettlement[] = [];
      for (const id of seenOrder) {
        const record = roundRecords.get(id);
        if (record === undefined || record.outcome === undefined) {
          // A settled descendant must carry a terminal outcome; refuse to
          // fabricate one (a stale `seen` record must never be reported as
          // interrupted).
          throw new OpenCodeSessionSettleError(
            `child session ${id} was classified settled without a terminal outcome`,
            { unknownSessionIds: [id] },
          );
        }
        const depth = roundDepths.get(id) ?? 1;
        children.push(
          depth > 1
            ? {
                id,
                outcome: record.outcome,
                interrupted: interrupted.has(id),
                ...(record.parentID === undefined ? {} : { parentID: record.parentID }),
                depth,
              }
            : { id, outcome: record.outcome, interrupted: interrupted.has(id) },
        );
      }
      return {
        parentSessionId,
        children,
        interruptedSessionIds: [...interrupted],
        rounds,
      };
    }

    // Enter the interrupt phase when the remaining attempt budget is spent or
    // the attempt is cancelled; after it, settlement must confirm every child
    // — and, when needed, the parent — reaches a terminal outcome within the
    // interrupt grace.
    const cancelled = ctx.signal?.aborted ?? false;
    if (phase === "observe" && (cancelled || ctx.now() >= ctx.deadline)) {
      phase = "interrupt";
      interruptDeadline = enterInterrupt(ctx);
    }
    if (phase === "interrupt") {
      for (const id of [...running, ...unreadable]) {
        const result = await interruptAttemptChild(http, id);
        if (result.status === "missing") {
          throw new OpenCodeSessionSettleError(
            `child session ${id} returned 404 while being interrupted; ` +
              "its terminal state cannot be confirmed",
            { unknownSessionIds: [id] },
          );
        }
        if (result.status === "unusable") {
          throw new OpenCodeSessionSettleError(
            `child session ${id} returned an interrupt response that cannot be parsed; ` +
              "its terminal state cannot be confirmed",
            { unknownSessionIds: [id] },
          );
        }
        if (result.status === "ok") interrupted.add(id);
        // A glitch is retried on a later interrupt round while the grace holds.
      }
      // A parent that was not proven terminal and inactive this round can still
      // spawn; interrupt it with the same bounded confirmation as a child.
      if (!parentProven) {
        const result = await interruptAttemptChild(http, parentSessionId);
        if (result.status === "missing") {
          throw new OpenCodeSessionSettleError(
            `parent session ${parentSessionId} returned 404 while being interrupted; ` +
              "its terminal state cannot be confirmed",
            { unknownSessionIds: [parentSessionId] },
          );
        }
        if (result.status === "unusable") {
          throw new OpenCodeSessionSettleError(
            `parent session ${parentSessionId} returned an interrupt response that cannot be parsed; ` +
              "its terminal state cannot be confirmed",
            { unknownSessionIds: [parentSessionId] },
          );
        }
        if (result.status === "ok") interrupted.add(parentSessionId);
        // A glitch is retried on a later interrupt round while the grace holds.
      }
      if (ctx.now() >= interruptDeadline) {
        // An interrupt can only settle sessions; surfaces that kept glitching
        // need a different verdict, so name them explicitly at the bound.
        const reasons: string[] = [];
        if (running.length + unreadable.length > 0) {
          reasons.push(
            `${[...running, ...unreadable].join(", ")} still running after interrupt within ` +
              `${String(Math.max(0, ctx.interruptGraceMs))}ms grace`,
          );
        }
        if (!parentProven) {
          reasons.push(`parent session ${parentSessionId} still not terminal and inactive`);
        }
        if (!terminalAncestorsBeforeListing) {
          reasons.push("not every potential spawner was proven terminal before its child listing");
        }
        if (!listingOk) reasons.push("the child listing could not be successfully read");
        if (!activeOk) reasons.push("the active sessions map could not be successfully read");
        if (reasons.length === 0) reasons.push("quiescence could not be proven");
        throw new OpenCodeSessionSettleError(
          `${reasons.join("; ")} — validation and publication must not begin`,
          {
            unsettledSessionIds: [...running, ...(parentProven ? [] : [parentSessionId])],
            unknownSessionIds: unreadable,
          },
        );
      }
      await ctx.sleep(ctx.pollIntervalMs);
      continue;
    }

    if (ctx.now() >= ctx.deadline) {
      // The observe loop has exhausted its budget without flipping phase; this
      // guard exists so the bound is never exceeded no matter how the pieces
      // interleave.
      phase = "interrupt";
      interruptDeadline = enterInterrupt(ctx);
      continue;
    }
    await ctx.sleep(ctx.pollIntervalMs);
  }
}

/**
 * Settle an EMPTY tree: the parent is the only session left that could spawn a
 * child, so quiescence requires its own record to prove it cannot — id ==
 * expected, the attempt directory, a terminal `outcome`, absence from the
 * active map, all on a round that ALSO read the listing successfully and found
 * it still empty. Bounded by the shared deadline; on expiry or cancellation
 * the parent is interrupted and must reach a terminal outcome within
 * `interruptGraceMs`, else the attempt fails. If a child appears mid-wait, the
 * full child settlement owns it under the same shared deadline.
 */
async function settleParentOnlyTree(ctx: SettleContext): Promise<ManagedAttemptSettlement> {
  const { http, parentSessionId, attemptDirectory } = ctx;
  let phase: "observe" | "interrupt" = "observe";
  let interruptDeadline = ctx.deadline;
  let rounds = 0;
  const interrupted = new Set<string>();

  for (;;) {
    rounds += 1;

    // Parent terminal proof FIRST — before the authoritative listing. A parent
    // that already carries a terminal outcome cannot spawn a new child, so the
    // listing below is complete with respect to the parent's own spawns.
    // Listing first and reading the parent only afterwards (as an earlier
    // revision did) lets the parent spawn between the two, then turn terminal
    // before the parent read, and falsely prove an empty/quiescent tree.
    // Attribution (id == expected, no parentID, attempt directory) is enforced
    // by readAttemptParent; the parent's inactivity is cross-checked against
    // the active map, read later in the round.
    const parent = await readAttemptParent(http, parentSessionId, attemptDirectory);
    if (parent.status === "unusable") {
      throw new OpenCodeSessionSettleError(
        `the parent session record for ${parentSessionId} was returned but could not be ` +
          "parsed into the pinned Session.Info shape; a parent that cannot be proven unable " +
          "to spawn fails the attempt",
        { unknownSessionIds: [parentSessionId] },
      );
    }

    // Fresh enumeration: the tree must still have no children. The parent
    // record above was read first, so a listed child cannot have been spawned
    // after a proven-terminal parent; when the parent spawned one while we
    // waited, the full descendant settlement owns it (and any nested children
    // it brings).
    const listing = await listChildrenForNode(http, parentSessionId, attemptDirectory);
    if (listing.status === "unusable") {
      throw new OpenCodeSessionDiscoveryError(
        `the parentID=${parentSessionId} child listing was returned but could not be ` +
          "parsed into the pinned SessionsResponse shape",
      );
    }
    if (listing.status === "ok" && listing.children.length > 0) {
      return settleTree(ctx, listing.children);
    }

    // The active map proves the parent is not still draining (and could spawn).
    let activeOk = false;
    let active = new Set<string>();
    const activeRead = await readActiveSessions(http);
    if (activeRead.status === "unusable") {
      throw new OpenCodeSessionSettleError(
        "the active sessions map was returned but could not be parsed into the pinned shape; " +
          "the parent's inactivity cannot be cross-checked",
      );
    }
    if (activeRead.status === "ok") {
      activeOk = true;
      active = new Set(activeRead.active);
    }

    // All four facts must hold on THIS round: parent readable with a terminal
    // outcome, absent from a freshly read active map, and a still-empty list.
    const parentQuiescent =
      parent.status === "ok" &&
      parent.record.outcome !== undefined &&
      listing.status === "ok" &&
      activeOk &&
      !active.has(parentSessionId);
    if (parentQuiescent) {
      return {
        parentSessionId,
        children: [],
        interruptedSessionIds: [...interrupted],
        rounds,
      };
    }

    // A terminal outcome while still active contradicts the cross-check surface.
    if (
      parent.status === "ok" &&
      parent.record.outcome !== undefined &&
      activeOk &&
      active.has(parentSessionId)
    ) {
      throw new OpenCodeSessionSettleError(
        `parent session ${parentSessionId} has outcome "${parent.record.outcome}" while still ` +
          "listed in the active map; the two surfaces contradict each other",
        { unknownSessionIds: [parentSessionId] },
      );
    }

    // Bounded wait; on expiry or cancellation interrupt the parent (the only
    // session left that could spawn), mirroring child settlement.
    const cancelled = ctx.signal?.aborted ?? false;
    if (phase === "observe" && (cancelled || ctx.now() >= ctx.deadline)) {
      phase = "interrupt";
      interruptDeadline = enterInterrupt(ctx);
    }
    if (phase === "interrupt") {
      const result = await interruptAttemptChild(http, parentSessionId);
      if (result.status === "missing") {
        throw new OpenCodeSessionSettleError(
          `parent session ${parentSessionId} returned 404 while being interrupted; ` +
            "its terminal state cannot be confirmed",
          { unknownSessionIds: [parentSessionId] },
        );
      }
      if (result.status === "unusable") {
        throw new OpenCodeSessionSettleError(
          `parent session ${parentSessionId} returned an interrupt response that cannot be parsed; ` +
            "its terminal state cannot be confirmed",
          { unknownSessionIds: [parentSessionId] },
        );
      }
      if (result.status === "ok") interrupted.add(parentSessionId);
      // A glitch is retried on a later interrupt round while the grace holds.
      if (ctx.now() >= interruptDeadline) {
        throw new OpenCodeSessionSettleError(
          `parent session ${parentSessionId} did not reach a terminal outcome within ` +
            `${String(Math.max(0, ctx.interruptGraceMs))}ms of interrupt; a parent that can ` +
            "still spawn children fails the attempt",
          { unsettledSessionIds: [parentSessionId] },
        );
      }
      await ctx.sleep(ctx.pollIntervalMs);
      continue;
    }

    if (ctx.now() >= ctx.deadline) {
      phase = "interrupt";
      interruptDeadline = enterInterrupt(ctx);
      continue;
    }
    await ctx.sleep(ctx.pollIntervalMs);
  }
}

/* ------------------------------------------------------------------ *
 * Production CLI adapter — the pinned `opencode api` transport
 * ------------------------------------------------------------------ */

export interface CreateCliManagedSessionHttpInput {
  /**
   * The pinned CLI binary. Defaults to `opencode`, matching the executor's
   * default.
   */
  readonly binary?: string;
  /**
   * The absolute attempt workspace — exactly the cwd the attempt's parent `run`
   * used. The CLI resolves the same project session store only when it runs
   * from the same location and environment.
   */
  readonly cwd: string;
  /** The exact environment the attempt's `run` received. */
  readonly env: Record<string, string>;
  /** Injected process launcher (tests); defaults to the real runner. */
  readonly runner?: ProcessRunner;
  /**
   * Per-call process timeout in ms. Defaults to
   * {@link OPENCODE_SESSION_CLI_TIMEOUT_MS} so a hung `opencode api` cannot
   * outlive the settlement's own bounded wait.
   */
  readonly timeoutMs?: number;
}

/**
 * Raised when the pinned `opencode api` CLI cannot produce a usable session
 * response: the process failed without reporting an HTTP status on stderr (the
 * background service was unreachable, the CLI itself errored), or a successful
 * exit printed output that cannot be trusted. The settlement loop already maps
 * any thrown transport error to a bounded `glitch`, so these never invent
 * quiescence; they just fail the current observation.
 */
export class OpenCodeSessionCliError extends Error {
  /** The failed argv: `[binary, "api", method, path]`. */
  readonly argv: readonly string[];

  constructor(argv: readonly string[], reason: string, stderr: string) {
    const detail = stderr.trim() === "" ? "" : `; stderr: ${stderr.trim()}`;
    super(`The OpenCode session API call \`${argv.join(" ")}\` failed: ${reason}${detail}`);
    this.name = "OpenCodeSessionCliError";
    this.argv = [...argv];
  }
}

/**
 * Extract the HTTP status the pinned CLI reports on stderr for a failed call
 * (`HTTP 404 Not Found`). `undefined` means the failure carried no HTTP status
 * — a transport/CLI error, not a server verdict.
 */
export function parseCliHttpStatus(stderr: string): number | undefined {
  const match = /(?:^|\r?\n)\s*HTTP\s+(\d{3})\b/iu.exec(stderr);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Fold a query into a request path as `path?k=v&k2=v2`, percent-encoding keys
 * and values with `encodeURIComponent`. The pinned CLI probe showed that
 * `opencode api … --param key=value` silently drops the parameters and returns
 * unrelated rows, while an explicit query embedded in the path is honored
 * exactly — so this is the only form the adapter sends.
 */
export function cliSessionRequestPath(
  path: string,
  query?: Readonly<Record<string, string>>,
): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (pairs.length === 0) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${pairs.join("&")}`;
}

/** Parse the CLI's stdout as one JSON body; empty stdout has no body. */
function parseCliBody(stdout: string): unknown {
  const trimmed = stdout.trim();
  return trimmed === "" ? undefined : JSON.parse(trimmed);
}

/**
 * Run one `opencode api <method> <path>` call under the attempt's exact cwd and
 * environment (no shell — the launcher spawns the binary directly) and
 * translate the process result into a {@link ManagedHttpResult}:
 *
 * - exit 0 → `{status: 200, body}`; empty or unparsable stdout is rejected
 *   (a successful call must print the JSON body).
 * - non-zero exit whose stderr names an HTTP status → `{status, body}` with
 *   that status, so a 404 stays distinguishable as "missing" instead of being
 *   flattened into a transport error.
 * - non-zero exit with no HTTP status on stderr → throws
 *   {@link OpenCodeSessionCliError}, the transport/CLI case.
 *
 * Every call is bounded by `timeoutMs` so a hung `opencode api` process cannot
 * outlive the settlement's own bounded wait.
 */
async function readCliApiResult(
  runner: ProcessRunner,
  binary: string,
  method: "GET" | "POST",
  path: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ManagedHttpResult> {
  const argv: readonly string[] = [binary, "api", method, path];
  const args: readonly string[] = ["api", method, path];
  const result = await runner(binary, args, { cwd, env, timeoutMs });
  if (result.exitCode === 0) {
    let body: unknown;
    try {
      body = parseCliBody(result.stdout);
    } catch {
      throw new OpenCodeSessionCliError(
        argv,
        "printed output that is not valid JSON",
        result.stderr,
      );
    }
    if (body === undefined) {
      throw new OpenCodeSessionCliError(argv, "printed no response body", result.stderr);
    }
    return { status: 200, body };
  }
  const status = parseCliHttpStatus(result.stderr);
  if (status === undefined) {
    throw new OpenCodeSessionCliError(
      argv,
      `exited ${String(result.exitCode)} without an HTTP status on stderr`,
      result.stderr,
    );
  }
  let body: unknown;
  try {
    body = parseCliBody(result.stdout);
  } catch {
    // A failed call's diagnostic body is not trusted; the status decides.
    body = undefined;
  }
  return { status, body };
}

/**
 * The production {@link ManagedSessionHttp}: the pinned session surface over a
 * live OpenCode service through the installed CLI, with no shell and under the
 * attempt's exact cwd and environment.
 *
 * Queries are encoded INTO the request path — the CLI's `--param` flag is
 * unreliable on 2.0.16 (see the probe note on {@link cliSessionRequestPath}) —
 * and an HTTP 404 reported on stderr is preserved verbatim so the settlement
 * distinguishes a missing session from a transient fault.
 */
export function createCliManagedSessionHttp(
  input: CreateCliManagedSessionHttpInput,
): ManagedSessionHttp {
  const binary = input.binary ?? "opencode";
  const runner = input.runner ?? defaultRunner;
  const timeoutMs = input.timeoutMs ?? OPENCODE_SESSION_CLI_TIMEOUT_MS;
  const request = (method: "GET" | "POST", path: string): Promise<ManagedHttpResult> =>
    readCliApiResult(runner, binary, method, path, input.cwd, input.env, timeoutMs);
  return {
    get: (path, query) => request("GET", cliSessionRequestPath(path, query)),
    post: (path) => request("POST", path),
  };
}
