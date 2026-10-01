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
 * Default timeout for one `opencode api` call. The settlement waits are bounded
 * by the remaining attempt timeout, but a hung CLI process would outlive even
 * that unless every individual call is bound too.
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
  const cursor = isRecord(body.cursor) ? asString(body.cursor.next) : undefined;
  return cursor === undefined ? { items } : { items, nextCursor: cursor };
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
  /** Injectable clock and sleeper for deterministic tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DiscoverAttemptChildrenResult {
  readonly parentSessionId: string;
  /** Every child attributed to the parent under the attempt directory. */
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
 * return every record, validating attribution as it goes. The three-variant
 * result distinguishes a transient read failure (`glitch`, retried within the
 * bound) from a readable-but-unusable response (`unusable`, a state that must
 * fail immediately). A record that is readable but cannot be attributed to
 * this attempt throws {@link OpenCodeSessionDiscoveryError} the moment it is
 * seen: an unverifiable set can hide a still-running child and must never be
 * silently filtered.
 *
 * The page chain must terminate: a repeated cursor is a non-terminating chain
 * (the child set can never be trusted complete), and {@link
 * OPENCODE_SESSION_LIST_PAGE_LIMIT} caps how many pages are followed. Both fail
 * closed rather than loop past the attempt budget.
 */
async function listAttemptChildren(
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
      if (item.parentID !== parentSessionId) {
        throw new OpenCodeSessionDiscoveryError(
          `session ${item.id} was returned by the parentID=${parentSessionId} listing but ` +
            `its own record names parent ${item.parentID ?? "(none)"} — the child surface ` +
            "cannot be trusted",
        );
      }
      if (!sameResolvedPath(item.directory, attemptDirectory)) {
        throw new OpenCodeSessionDiscoveryError(
          `session ${item.id} names parent ${parentSessionId} but runs in ${item.directory}, ` +
            `not the attempt workspace ${attemptDirectory} — another run's child must not be settled here`,
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

  let lastGlitch = "the parent session record could not be read";
  for (;;) {
    const parent = await readAttemptParent(
      input.http,
      input.parentSessionId,
      input.attemptDirectory,
    );
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
    const listing = await listAttemptChildren(
      input.http,
      input.parentSessionId,
      input.attemptDirectory,
    );
    if (listing.status === "unusable") {
      throw new OpenCodeSessionDiscoveryError(
        `the parentID=${input.parentSessionId} child listing was returned but could not be ` +
          "parsed into the pinned SessionsResponse shape",
      );
    }
    if (listing.status === "glitch") {
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
    return { parentSessionId: input.parentSessionId, children: listing.children };
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
  parentSessionId: string,
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
    record.parentID !== parentSessionId ||
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
}

export interface ManagedAttemptSettlement {
  readonly parentSessionId: string;
  /** Every child of the attempt, in discovery order, with its final outcome. */
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
 * - Children are enumerated only by the attributed parentID listing (see
 *   {@link discoverAttemptChildSessions}); nothing invents children, and the
 *   active map is never an enumeration source.
 * - A settled child needs a terminal `outcome` AND absence from the active
 *   map. No outcome means unsettled; a missing, unreadable, or contradictory
 *   child is unknown and fails the settlement.
 * - Quiescence is declared only on a round that produced a full, fresh
 *   picture: a successfully read listing (no unseen child could exist) AND a
 *   successfully read active map (every absence is a real absence). A glitched
 *   listing or active map never authorizes a return — a new child may have
 *   spawned, or a session become active, since the last successful read.
 * - An empty tree is NOT trivially quiescent: the parent's own record must
 *   prove it cannot spawn — id == expected, the attempt directory, a terminal
 *   `outcome`, and absence from the active map ({@link settleParentOnlyTree}).
 * - The whole wait is bounded by `timeoutMs` (the remaining attempt budget).
 *   When the budget is exhausted — or the attempt signal is cancelled — every
 *   still-running session is interrupted via
 *   `POST /api/session/{id}/interrupt` and settlement confirms each reaches a
 *   terminal outcome within `interruptGraceMs`, failing closed with the
 *   offending ids preserved if any cannot be confirmed. An unreadable surface
 *   at the bound fails the same way: quiescence cannot be proven.
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
  const sleep = input.sleep ?? ((ms: number) => delay(ms));
  const deadline = now() + Math.max(0, input.timeoutMs);
  const ctx: SettleContext = {
    http: input.http,
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
    now,
    sleep,
  });
  // An empty listing leaves only the parent able to spawn more children: prove
  // it cannot before declaring the tree quiescent.
  if (discovered.children.length === 0) return settleParentOnlyTree(ctx);
  return settleDiscoveredChildren(ctx, discovered.children);
}

/** Shared clock/HTTP/budget state threaded through the settlement loops. */
interface SettleContext {
  readonly http: ManagedSessionHttp;
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
 * Settle a non-empty child tree: observe each attributed child until it is
 * terminal AND absent from the active map, within the shared deadline. A round
 * only ever declares quiescence when its listing AND active map both read
 * successfully AND the parent itself is terminal and absent from that same
 * fresh active map (a still-running parent could spawn a new child after the
 * listing is trusted); see {@link settleAttemptChildren}. Anything else keeps
 * observing, and the bound turns a never-readable surface or never-quiescent
 * parent into a failed attempt rather than trusting a stale or empty picture.
 */
async function settleDiscoveredChildren(
  ctx: SettleContext,
  discoveredChildren: readonly OpenCodeSessionInfo[],
): Promise<ManagedAttemptSettlement> {
  const { http, parentSessionId, attemptDirectory } = ctx;

  // Latest readable record per child, in first-seen order.
  const seen = new Map<string, OpenCodeSessionInfo>();
  const seenOrder: string[] = [];
  for (const child of discoveredChildren) {
    seen.set(child.id, child);
    seenOrder.push(child.id);
  }

  let active = new Set<string>();
  const interrupted = new Set<string>();
  let rounds = 0;
  let phase: "observe" | "interrupt" = "observe";
  let interruptDeadline = ctx.deadline;

  for (;;) {
    rounds += 1;

    const roundRecords = new Map<string, OpenCodeSessionInfo>();
    let listingOk = false;

    // Attributes + per-child records for this round. A readable listing is
    // authoritative; a glitched listing falls back to per-child reads of the
    // pinned `GET /api/session/{id}` route, but such a round can NEVER declare
    // quiescence: the fallback cannot prove no NEW child appeared since the
    // last successful page, so a transient listing failure can never by itself
    // invent quiescence.
    const listing = await listAttemptChildren(http, parentSessionId, attemptDirectory);
    if (listing.status === "unusable") {
      // Readable HTTP with an unusable list is a state, not a race: this round
      // cannot verify any child, so quiescence is unproven.
      throw new OpenCodeSessionSettleError(
        `the parentID=${parentSessionId} child listing was returned but could not be parsed ` +
          "into the pinned SessionsResponse shape",
      );
    }
    if (listing.status === "glitch") {
      for (const id of seenOrder) {
        const read = await readAttemptChildRecord(http, id, parentSessionId, attemptDirectory);
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
        // A glitched read leaves the child without a record this round: it
        // stays unproven, and only a budget/grace expiry turns that into a
        // failure.
      }
    } else {
      listingOk = true;
      const listedIds = new Set<string>();
      for (const child of listing.children) {
        if (!seen.has(child.id)) {
          // A background child spawned late (e.g. right as the parent exited)
          // is still inside the attempt boundary and must be settled too.
          seenOrder.push(child.id);
        }
        seen.set(child.id, child);
        listedIds.add(child.id);
        roundRecords.set(child.id, child);
      }
      for (const id of seenOrder) {
        if (!listedIds.has(id)) {
          throw new OpenCodeSessionSettleError(
            `child session ${id} vanished from the parentID listing mid-settlement; ` +
              "a child that cannot be confirmed stopped must fail the attempt",
            { unknownSessionIds: [id] },
          );
        }
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
    // brand new child the moment the listing we just read omits it. Attribution
    // (id == expected, no parentID, attempt directory) is enforced by
    // readAttemptParent.
    const parentRead = await readAttemptParent(http, parentSessionId, attemptDirectory);
    if (parentRead.status === "unusable") {
      throw new OpenCodeSessionSettleError(
        `the parent session record for ${parentSessionId} was returned but could not be ` +
          "parsed into the pinned Session.Info shape; a parent that cannot be proven unable " +
          "to spawn fails the attempt",
        { unknownSessionIds: [parentSessionId] },
      );
    }
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
    // listing (the child set is complete), a successful active map (every
    // absence is real), every child terminal and inactive, AND the parent
    // itself terminal and inactive (so it cannot spawn more children after the
    // listing we just trusted).
    if (running.length === 0 && unreadable.length === 0 && listingOk && activeOk && parentProven) {
      const children: ChildSettlement[] = [];
      for (const id of seenOrder) {
        const record = roundRecords.get(id);
        if (record === undefined || record.outcome === undefined) {
          // A settled child must carry a terminal outcome; refuse to fabricate
          // one (a stale `seen` record must never be reported as interrupted).
          throw new OpenCodeSessionSettleError(
            `child session ${id} was classified settled without a terminal outcome`,
            { unknownSessionIds: [id] },
          );
        }
        children.push({ id, outcome: record.outcome, interrupted: interrupted.has(id) });
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
      interruptDeadline = ctx.now() + Math.max(0, ctx.interruptGraceMs);
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

    // Fresh enumeration first: the tree must still have no children. When the
    // parent spawned one while we waited, the full child settlement owns it.
    const listing = await listAttemptChildren(http, parentSessionId, attemptDirectory);
    if (listing.status === "unusable") {
      throw new OpenCodeSessionDiscoveryError(
        `the parentID=${parentSessionId} child listing was returned but could not be ` +
          "parsed into the pinned SessionsResponse shape",
      );
    }
    if (listing.status === "ok" && listing.children.length > 0) {
      return settleDiscoveredChildren(ctx, listing.children);
    }

    // The parent record: id == expected and the attempt directory (attribution
    // verified by readAttemptParent), plus a terminal outcome.
    const parent = await readAttemptParent(http, parentSessionId, attemptDirectory);
    if (parent.status === "unusable") {
      throw new OpenCodeSessionSettleError(
        `the parent session record for ${parentSessionId} was returned but could not be ` +
          "parsed into the pinned Session.Info shape; a parent that cannot be proven unable " +
          "to spawn fails the attempt",
        { unknownSessionIds: [parentSessionId] },
      );
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
      interruptDeadline = ctx.now() + Math.max(0, ctx.interruptGraceMs);
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
