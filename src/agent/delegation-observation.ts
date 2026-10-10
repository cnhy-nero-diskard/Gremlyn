/**
 * Safe delegation-observation parser and projector (tasks 1.1-1.3; design
 * D1/D3/D4; capability `agent-delegation-observability`).
 *
 * This module is the privacy boundary for live parent/child delegation evidence.
 * It turns the pinned OpenCode V2 session surfaces into a deliberately tiny,
 * whitelisted observation snapshot and projects a presentation state from it.
 * It owns no transport, no timers and no storage: the observer (task 2+) drives
 * it, and settlement safety keeps its own independent verdicts.
 *
 * ## Verified against
 *
 * The shapes here were checked read-only against the installed, pinned OpenCode
 * 2.0.16 via the configured CLI (`opencode api`), with the official V2 OpenAPI
 * document as guidance. See `docs/delegation-telemetry-contract.md` for the full
 * coverage matrix and the read-only provenance of each fact. In particular:
 *
 * - `GET /api/session/{id}` -> `{data: Session.Info}`; a live probe observed
 *   keys `agent,cost,id,location,model,projectID,time,title,tokens` and a
 *   `model` of `{id,providerID,variant}`, `time` of `{created,updated}` and
 *   `location` of `{directory}`.
 * - `GET /api/session` -> `{data: Session.Info[], cursor:{previous,next}}`.
 * - `GET /api/session/active` -> `{data: {[ses…]: {type:"running"}}}`.
 * - `GET /api/session/{id}/message` carries the initial identity; the existing
 *   `readOpenCodeInitialIdentity` remains the authority for the *started*
 *   identity. A session record's `agent` is mutable current state.
 *
 * ## What is read and what is never read
 *
 * Only these fields are ever read: `id`, `parentID`, `agent`, `model`
 * (`providerID`/`id`/`variant`), `outcome`, `location.directory` and
 * `time` (`created`/`updated`/`idle`). `title`, `metadata`, `projectID`,
 * `permissions`, `revert`, `tokens`, `cost`, `fork`, `content`, tool state and
 * every unknown field are *never* copied into an observation — so prompts,
 * instructions, tool arguments and credentials cannot ride along. Identity
 * fields must additionally match supported identifier syntax
 * ({@link parseDelegationIdentity}): prose, whitespace, URL/userinfo strings and
 * credential-shaped values are dropped rather than persisted.
 *
 * ## Not a safety verdict
 *
 * {@link projectDelegationObservation} produces a display state. It deliberately
 * does NOT reuse {@link classifyChildSession}: the safety classifier treats any
 * nonterminal session as unsettled, whereas the observation matrix may label a
 * fresh inactive nonterminal child `idle` (explicitly NOT finished) when the
 * caller can support that absence. Nothing in this module may authorize
 * validation, quiescence, workspace reuse or publication, and absence from the
 * active map is never terminal completion.
 *
 * The active map documents process-owned foreground drains
 * ({@link DELEGATION_ACTIVE_MAP_SCOPE}); whether model-backed `background:true`
 * sessions always appear there is UNPROVEN. The live observer therefore does
 * not forward active-map absence for delegated children as `false`; it records
 * limited coverage and leaves their current activity unknown instead.
 */

/** The observation snapshot format version emitted by this module. */
export const DELEGATION_OBSERVATION_VERSION = 1;

/** Bounded identifier cap mirroring the ownership/identity parsers. */
export const DELEGATION_MAX_IDENTIFIER_LENGTH = 256;
/** Bounded directory cap mirroring the ownership parser. */
export const DELEGATION_MAX_DIRECTORY_LENGTH = 4_096;
/** Cap for optional, non-identity description text. */
export const DELEGATION_MAX_DESCRIPTION_LENGTH = 512;
/** Parsing bounds are independent of pagination and ownership/safety limits. */
export const DELEGATION_MAX_PAGE_ITEMS = 256;
export const DELEGATION_MAX_ACTIVE_ITEMS = 4_096;
/**
 * How many missed expected observation intervals make a live projected state
 * stale/unknown (design D4: after two missed intervals).
 */
export const DELEGATION_STALE_MISSED_INTERVALS = 2;
/** Epoch-ms upper bound: 9999-12-31T23:59:59.999Z. */
export const DELEGATION_MAX_EPOCH_MS = 253_402_300_799_999;

/**
 * What the pinned active map actually documents: "foreground Session drains
 * currently owned by this OpenCode process". Absence therefore means inactive
 * for those process-owned drains. Whether every model-backed `background:true`
 * child appears in this map is UNPROVEN (the existing live probe recorded such
 * a child still running after its parent returned); consumers must never treat
 * child absence as idle, a demonstrated stop or any safety proof.
 */
export const DELEGATION_ACTIVE_MAP_SCOPE = "process-owned-foreground-drains" as const;

/** The pinned session `outcome` vocabulary (OpenCode 2.0.16). */
export type DelegationOutcome = "succeeded" | "failed" | "interrupted";

/**
 * Presentation-only observation state. `invoked` means a record was verified
 * but no supported active evidence is available; `idle` is explicitly NOT
 * finished. `unknown` retains last-known evidence without asserting a live
 * state.
 */
export type DelegationObservationState =
  "invoked" | "running" | "idle" | "succeeded" | "failed" | "interrupted" | "unknown";

/** The actual runtime identity a record exposed, or nothing (never invented). */
export interface DelegationActualIdentity {
  /** The record's reported current agent id; not necessarily the started one. */
  readonly agentId?: string;
  /** The record's reported model as `provider/id[#variant]`. */
  readonly model?: string;
}

/**
 * A whitelisted, immutable observation of one session record. Only supported
 * fields are present; every private/unknown field is absent by construction.
 */
export interface DelegationSessionRecord {
  /** The attributed session id (`ses…`). */
  readonly sessionId: string;
  /** The parent session id when the record carries a valid one. */
  readonly parentId?: string;
  /** True when a `parentID` field was present but could not be trusted. */
  readonly parentIdUnrecognized: boolean;
  /** The actual identity exposed by the record (empty when none is usable). */
  readonly identity: DelegationActualIdentity;
  /** The terminal outcome when the record exposed a known one. */
  readonly outcome?: DelegationOutcome;
  /** True when an `outcome` field was present but outside the pinned enum. */
  readonly outcomeUnrecognized: boolean;
  /** The absolute directory the session runs in, when exposed and bounded. */
  readonly directory?: string;
  /** Source `time.created` as validated epoch ms. */
  readonly createdAt?: number;
  /** Source `time.updated` as validated epoch ms. */
  readonly updatedAt?: number;
  /** Source `time.idle` as validated epoch ms when present. */
  readonly idleAt?: number;
}

/** A parsed listing page: safe items plus honest coverage of skipped rows. */
export interface DelegationSessionListing {
  readonly items: readonly DelegationSessionRecord[];
  /** The opaque next-page cursor, absent on the final page. */
  readonly nextCursor?: string;
  /** How many rows were present but could not be safely parsed. */
  readonly skipped: number;
  /** `partial` when any row was skipped; callers must not read it as empty. */
  readonly coverage: "complete" | "partial";
}

/** Freshness of the observation source for one node. */
export interface DelegationFreshness {
  readonly fresh: boolean;
  /** Milliseconds since the last successful observation. */
  readonly ageMs: number;
  /** The age at which the state becomes stale (`interval * missedIntervals`). */
  readonly staleAfterMs: number;
  /** The number of whole expected intervals missed. */
  readonly missedIntervals: number;
}

/** Input to the presentation-state projection. */
export interface ProjectDelegationObservationInput {
  /** The parsed session record, when one was readable. */
  readonly record?: DelegationSessionRecord;
  /** The session id being observed when no record is available. */
  readonly sessionId?: string;
  /**
   * Whether a fresh active map listed the session; `undefined` = not yet read.
   * `false` means absent from the documented {@link DELEGATION_ACTIVE_MAP_SCOPE}
   * map, which the generic projector labels `idle` (nonterminal) — NOT finished
   * and NOT a safety verdict. Callers must not pass unsupported absence for a
   * delegated child: it does NOT prove a model-backed `background:true` child
   * stopped, and must surface as a coverage limitation instead.
   */
  readonly active?: boolean;
  /** Epoch ms of the last successful observation of this node. */
  readonly lastObservedAt: number;
  /** Injectable clock (defaults to `Date.now()`). */
  readonly now?: number;
  /** Expected observation interval; defaults to 1s (design D1). */
  readonly intervalMs?: number;
  /** A cancellation was requested; NEVER converted into an outcome here. */
  readonly cancellationRequested?: boolean;
}

/** The projected, presentation-only observation snapshot. */
export interface DelegationObservation {
  readonly state: DelegationObservationState;
  /** The observed terminal outcome, when one was projected. */
  readonly outcome?: DelegationOutcome;
  /** Whether the source is fresh enough to assert a live state. */
  readonly fresh: boolean;
  readonly ageMs: number;
  readonly staleAfterMs: number;
  /** True when terminal evidence contradicts the active map. */
  readonly contradiction: boolean;
  /** A cancellation request, shown independently of any confirmed outcome. */
  readonly cancellationRequested: boolean;
  /** True only when the runtime itself reported the `interrupted` outcome. */
  readonly interruptionConfirmed: boolean;
  readonly sessionId?: string;
  readonly identity: DelegationActualIdentity;
  /** Machine-readable explanation for an `unknown`/degraded projection. */
  readonly reason?: string;
}

/* ------------------------------------------------------------------ *
 * Primitive guards
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A control character (including NUL and newlines) is never a valid token. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A credential-shaped literal is never an identity or a safe display value. */
const CREDENTIAL_PATTERN =
  /(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[oprs]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|AIza[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9_-]+|Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+|-----BEGIN [A-Z ]+-----)/iu;

function isCredentialLike(value: string): boolean {
  return CREDENTIAL_PATTERN.test(value);
}

/** A bounded, non-empty, control-free path/text value; never credential-shaped. */
function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > maxLength) return undefined;
  if (value.trim().length === 0 || hasControlCharacters(value)) return undefined;
  if (isCredentialLike(value)) return undefined;
  return value;
}

/**
 * A supported runtime identity segment: an alphanumeric start followed by
 * `[A-Za-z0-9._-]`. This deliberately rejects whitespace, prose, quotes,
 * URL/userinfo separators (`:`, `@`), `#` and any other punctuation, so a
 * prompt, instruction text or credential URL can never be persisted as an
 * agent/model identity.
 */
const IDENTITY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** At most this many `/`-separated segments in a runtime agent id. */
const DELEGATION_MAX_IDENTITY_SEGMENTS = 8;

/**
 * A supported runtime agent identity token: `/`-separated identifier segments
 * (for example `build`, `native-reviewer`, `attempt-42/reviewer` or a nested
 * native `dir/name`). Rejects empty/`.`/`..` segments, argument-like leading
 * dashes, over-long values, control/Cf characters, prose and credential-like
 * values. This is identity syntax only; it is NOT directory syntax.
 */
function identityToken(
  value: unknown,
  maxLength = DELEGATION_MAX_IDENTIFIER_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > maxLength) return undefined;
  if (value.startsWith("-") || hasControlCharacters(value)) return undefined;
  const segments = value.split("/");
  if (segments.length > DELEGATION_MAX_IDENTITY_SEGMENTS) return undefined;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !IDENTITY_SEGMENT_PATTERN.test(segment)) {
      return undefined;
    }
  }
  if (isCredentialLike(value)) return undefined;
  return value;
}

/** A bounded session token: exactly the pinned `ses…` id shape. */
function sessionToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > DELEGATION_MAX_IDENTIFIER_LENGTH) {
    return undefined;
  }
  return /^ses[A-Za-z0-9_-]+$/u.test(value) && !isCredentialLike(value) ? value : undefined;
}

/** A finite, non-negative, plausibly-real epoch-ms timestamp, or nothing. */
function parseEpochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > DELEGATION_MAX_EPOCH_MS) return undefined;
  return value;
}

/* ------------------------------------------------------------------ *
 * Parsers — pure, so every whitelist/redaction verdict is unit-testable
 * ------------------------------------------------------------------ */

/** The result of reading a possible outcome field. */
interface OutcomeRead {
  readonly outcome?: DelegationOutcome;
  readonly unrecognized: boolean;
}

function readOutcome(value: unknown): OutcomeRead {
  if (value === undefined) return { unrecognized: false };
  if (value === "succeeded" || value === "failed" || value === "interrupted") {
    return { outcome: value, unrecognized: false };
  }
  return { unrecognized: true };
}

/** Fold a `Model.Ref` into `provider/id[#variant]`, or nothing when malformed. */
function readModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const provider = identityToken(value.providerID);
  const id = identityToken(value.id);
  if (provider === undefined || id === undefined) return undefined;
  // A present-but-unsupported variant makes the whole model untrustworthy
  // rather than persisting a partial/over-long identity.
  const variant = value.variant === undefined ? undefined : identityToken(value.variant);
  if (value.variant !== undefined && variant === undefined) return undefined;
  const combined = variant === undefined ? `${provider}/${id}` : `${provider}/${id}#${variant}`;
  return combined.length <= DELEGATION_MAX_IDENTIFIER_LENGTH ? combined : undefined;
}

/**
 * Read the actual identity a record exposed. `agent` is the session's mutable
 * *current* agent (an operator switch can change it), so callers must not treat
 * it as the started identity; the bounded first-assistant read remains the
 * authority for that. Only supported identifier syntax survives: malformed,
 * prose-like, URL/userinfo and credential-shaped values stay unknown.
 */
export function parseDelegationIdentity(value: unknown): DelegationActualIdentity {
  if (!isRecord(value)) return Object.freeze({});
  const agentId = identityToken(value.agent);
  const model = readModel(value.model);
  const identity: DelegationActualIdentity = {
    ...(agentId === undefined ? {} : { agentId }),
    ...(model === undefined ? {} : { model }),
  };
  return Object.freeze(identity);
}

/**
 * Parse one `Session.Info` from either its `{data: …}` envelope or a bare
 * record into a whitelisted observation. Returns `undefined` only when the
 * record cannot be attributed at all (no trustable session id); every other
 * fault degrades to unknown identity/outcome rather than inventing a value.
 *
 * `title`, `metadata`, `projectID`, `permissions`, tool/prompt content and all
 * unknown fields are never read.
 */
export function parseDelegationSessionRecord(body: unknown): DelegationSessionRecord | undefined {
  if (!isRecord(body)) return undefined;
  const data = isRecord(body.data) ? body.data : body;
  const sessionId = sessionToken(data.id);
  if (sessionId === undefined) return undefined;

  const rawParentId = data.parentID;
  const parentId = sessionToken(rawParentId);
  const parentIdUnrecognized = rawParentId !== undefined && parentId === undefined;

  const outcome = readOutcome(data.outcome);

  const location = isRecord(data.location)
    ? boundedText(data.location.directory, DELEGATION_MAX_DIRECTORY_LENGTH)
    : undefined;

  const time = isRecord(data.time) ? data.time : undefined;
  const createdAt = time === undefined ? undefined : parseEpochMs(time.created);
  const updatedAt = time === undefined ? undefined : parseEpochMs(time.updated);
  const idleAt = time === undefined ? undefined : parseEpochMs(time.idle);

  const record: DelegationSessionRecord = Object.freeze({
    sessionId,
    ...(parentId === undefined ? {} : { parentId }),
    parentIdUnrecognized,
    identity: parseDelegationIdentity(data),
    ...(outcome.outcome === undefined ? {} : { outcome: outcome.outcome }),
    outcomeUnrecognized: outcome.unrecognized,
    ...(location === undefined ? {} : { directory: location }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(idleAt === undefined ? {} : { idleAt }),
  });
  return record;
}

/**
 * Parse one page of `GET /api/session`. A malformed *row* is skipped and
 * counted (`coverage: "partial"`) so a caller can degrade coverage without
 * inventing children; a malformed *page* (no `data` array, unusable cursor) is
 * rejected entirely because the listing then cannot be trusted as a whole.
 *
 * End-of-list is ONLY the explicit `cursor.next === null` the pinned schema
 * defines: a missing/blank `next` is a malformed page, never a silent end.
 */
export function parseDelegationSessionListing(body: unknown): DelegationSessionListing | undefined {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
  const cursor = body.cursor;
  if (!isRecord(cursor) || !("next" in cursor)) return undefined;
  if (
    cursor.next !== null &&
    (typeof cursor.next !== "string" || cursor.next.length === 0 || cursor.next.length > 4_096)
  ) {
    return undefined;
  }
  const items: DelegationSessionRecord[] = [];
  let skipped = Math.max(0, body.data.length - DELEGATION_MAX_PAGE_ITEMS);
  for (let index = 0; index < Math.min(body.data.length, DELEGATION_MAX_PAGE_ITEMS); index += 1) {
    const raw: unknown = body.data[index];
    const item = parseDelegationSessionRecord({ data: raw });
    if (item === undefined) skipped += 1;
    else items.push(item);
  }
  return Object.freeze({
    items: Object.freeze(items),
    ...(cursor.next === null ? {} : { nextCursor: cursor.next as string }),
    skipped,
    coverage: skipped === 0 ? "complete" : "partial",
  });
}

/**
 * Parse `GET /api/session/active` into the set of running session ids. The
 * pinned shape is `{data: {[ses…]: {type:"running"}}}`. Any entry that is not a
 * `running` session id makes the whole map unusable (`undefined`): absence from
 * a partially-trusted map must never be read as "not running".
 */
export function parseDelegationActiveSessions(body: unknown): ReadonlySet<string> | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const active = new Set<string>();
  let count = 0;
  for (const id in body.data) {
    if (!Object.hasOwn(body.data, id)) continue;
    if (++count > DELEGATION_MAX_ACTIVE_ITEMS) return undefined;
    const entry: unknown = body.data[id];
    if (!isRecord(entry) || entry.type !== "running") return undefined;
    if (sessionToken(id) === undefined) return undefined;
    active.add(id);
  }
  return active;
}

/* ------------------------------------------------------------------ *
 * Freshness (independent of any safety verdict)
 * ------------------------------------------------------------------ */

/**
 * Assess how fresh an observation is. After `missedIntervals` (default two)
 * whole expected intervals have elapsed, the source is stale; a stale source
 * makes the projected state `unknown` rather than a stale "running". A
 * non-positive interval is treated as stale, never as fresh.
 */
export function assessDelegationFreshness(input: {
  readonly lastObservedAt: number;
  readonly now?: number;
  readonly intervalMs?: number;
  readonly missedIntervals?: number;
}): DelegationFreshness {
  const now = input.now ?? Date.now();
  const intervalMs = input.intervalMs ?? 1_000;
  const missedIntervals = input.missedIntervals ?? DELEGATION_STALE_MISSED_INTERVALS;
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(missedIntervals) ||
    missedIntervals <= 0
  ) {
    return { fresh: false, ageMs: Number.POSITIVE_INFINITY, staleAfterMs: 0, missedIntervals: 0 };
  }
  const ageMs = Math.max(0, now - input.lastObservedAt);
  const staleAfterMs = intervalMs * missedIntervals;
  const missed = Math.floor(ageMs / intervalMs);
  return { fresh: ageMs < staleAfterMs, ageMs, staleAfterMs, missedIntervals: missed };
}

/* ------------------------------------------------------------------ *
 * Presentation projector — explicitly NOT a safety classifier
 * ------------------------------------------------------------------ */

/**
 * Project a display state from one session snapshot (design D4). This is the
 * "fresh supported evidence" matrix; it must never be used to prove quiescence.
 *
 * | Record                   | Active   | Fresh | State                |
 * | ------------------------ | -------- | ----- | -------------------- |
 * | any                      | any      | no    | unknown (stale)      |
 * | none                     | any      | yes   | unknown (no record)  |
 * | nonterminal              | yes      | yes   | running              |
 * | nonterminal              | no       | yes   | idle (not finished)  |
 * | nonterminal              | unknown  | yes   | invoked              |
 * | terminal                 | no       | yes   | succeeded/failed/…   |
 * | terminal                 | yes      | yes   | unknown (contradict) |
 * | terminal                 | unknown  | yes   | succeeded/failed/…   |
 *
 * A current terminal outcome is explicit source evidence; it remains terminal
 * when active-map evidence is unavailable, unless the map affirmatively
 * contradicts it by listing the session active. A cancellation request is
 * carried independently and is NEVER projected as an outcome; only the
 * runtime's own `interrupted` outcome confirms interruption.
 *
 * The `active = no` row maps to `idle` exactly as design D4 prescribes only when
 * the caller can support that absence. The live observer does not forward
 * absence for delegated children because the map covers only the documented
 * {@link DELEGATION_ACTIVE_MAP_SCOPE}; it leaves their activity unknown and
 * reports limited coverage instead. Active absence is never a safety proof.
 */
export function projectDelegationObservation(
  input: ProjectDelegationObservationInput,
): DelegationObservation {
  const freshness = assessDelegationFreshness({
    lastObservedAt: input.lastObservedAt,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
  });
  const record = input.record;
  const identity = record?.identity ?? Object.freeze({});
  const cancellationRequested = input.cancellationRequested === true;
  const interruptionConfirmed = record?.outcome === "interrupted";
  const base = {
    fresh: freshness.fresh,
    ageMs: freshness.ageMs,
    staleAfterMs: freshness.staleAfterMs,
    cancellationRequested,
    interruptionConfirmed,
    identity,
    ...(record === undefined
      ? input.sessionId === undefined
        ? {}
        : { sessionId: input.sessionId }
      : { sessionId: record.sessionId }),
  };

  if (!freshness.fresh) {
    return Object.freeze({
      ...base,
      state: "unknown",
      contradiction: false,
      reason: "stale-source",
    });
  }
  if (record === undefined) {
    return Object.freeze({
      ...base,
      state: "unknown",
      contradiction: false,
      reason: "missing-record",
    });
  }
  if (record.outcomeUnrecognized) {
    return Object.freeze({
      ...base,
      state: "unknown",
      contradiction: false,
      reason: "unrecognized-outcome",
    });
  }
  if (record.outcome !== undefined) {
    if (input.active === true) {
      return Object.freeze({
        ...base,
        state: "unknown",
        contradiction: true,
        reason: "terminal-while-active",
      });
    }
    return Object.freeze({
      ...base,
      state: record.outcome,
      outcome: record.outcome,
      contradiction: false,
    });
  }
  // Nonterminal record.
  if (input.active === true) {
    return Object.freeze({ ...base, state: "running", contradiction: false });
  }
  if (input.active === false) {
    return Object.freeze({ ...base, state: "idle", contradiction: false });
  }
  return Object.freeze({ ...base, state: "invoked", contradiction: false });
}

/* ------------------------------------------------------------------ *
 * Redaction for optional non-identity text
 * ------------------------------------------------------------------ */

/**
 * Redact a bounded, optional description-like string: control characters are
 * dropped, credential-shaped literals are masked, length is capped. This is for
 * optional scoped-inventory metadata only — it is NEVER identity evidence — and
 * a caller must still keep configured labels separate from observed execution.
 */
export function sanitizeDelegationDescription(
  value: unknown,
  maxLength = DELEGATION_MAX_DESCRIPTION_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControls = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  if (withoutControls.length === 0) return undefined;
  const redacted = withoutControls.replace(
    new RegExp(CREDENTIAL_PATTERN.source, "giu"),
    "[redacted]",
  );
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}
