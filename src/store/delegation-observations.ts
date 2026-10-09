import type Database from "better-sqlite3";

/**
 * Durable, bounded and privacy-safe delegated-execution observation store
 * (design D3/D4; tasks 2.1-2.4; capability `agent-delegation-observability`).
 *
 * This module owns only read/write access to the four observation tables added
 * by migration `0009_delegation_observations` and read-only access to the
 * existing `opencode_invocations` / `managed_child_sessions` rows it seeds
 * legacy evidence from. It NEVER writes attempts, invocations, managed child
 * settlement rows, job status or any other safety verdict: observation is
 * presentation evidence, never an authorization to publish, settle or
 * interrupt. The observer transport/parser may fail; every write here is
 * failure-isolated and returns a discriminated result instead of throwing, so
 * a database fault can never fail an agent job.
 *
 * Nodes are keyed `(attempt, invocation ordinal, session)` so a repeated
 * invocation of one agent is a distinct node and a second root in one attempt
 * never overwrites the first. Only whitelisted scalar facts are accepted
 * (ids, source kind, actual agent/model, source timestamps, observation bounds,
 * last-known state/outcome, cancellation-request metadata); unknown fields and
 * over-long or control-character strings are rejected, so prompts,
 * instructions, tool arguments, config or raw event bodies can never be
 * persisted as delegation evidence.
 */

/* ------------------------------------------------------------------ *
 * Vocabularies and bounds
 * ------------------------------------------------------------------ */

/** Where an observation's evidence came from. */
export const DELEGATION_SOURCE_KINDS = [
  "session-poll",
  "event-stream",
  "legacy-managed",
  "unknown",
] as const;
export type DelegationSourceKind = (typeof DELEGATION_SOURCE_KINDS)[number];

/** The pinned OpenCode terminal outcome vocabulary. */
export const DELEGATION_TERMINAL_OUTCOMES = ["succeeded", "failed", "interrupted"] as const;
export type DelegationTerminalOutcome = (typeof DELEGATION_TERMINAL_OUTCOMES)[number];

/** Whether the source yielded a usable record for the session. */
export const DELEGATION_EVIDENCE_PRESENCES = ["observed", "missing"] as const;
export type DelegationEvidencePresence = (typeof DELEGATION_EVIDENCE_PRESENCES)[number];

/** The transport a reconciliation generation was gathered through. */
export const DELEGATION_TRANSPORTS = [
  "polling",
  "event-stream",
  "legacy-managed",
  "none",
  "unknown",
] as const;
export type DelegationTransport = (typeof DELEGATION_TRANSPORTS)[number];

/** Health of the transport for a coverage record. */
export const DELEGATION_TRANSPORT_STATES = ["ok", "degraded", "unavailable", "unknown"] as const;
export type DelegationTransportState = (typeof DELEGATION_TRANSPORT_STATES)[number];

/**
 * The projected display state.
 *
 * - `invoked` — a record was verified but no active evidence has ever been
 *   observed; the current execution is unknown (design D4 "invoked; current
 *   execution unknown").
 * - `running`/`idle` — fresh nonterminal evidence with the current active map
 *   known present/absent. `idle` explicitly does NOT mean finished.
 * - a terminal outcome — the LATEST evidence reports a terminal outcome AND
 *   fresh evidence proves the session inactive.
 * - `unknown` — missing record, stale source, a lost/unknown current active
 *   map (last-known activity is retained as history, never asserted current),
 *   or a terminal outcome that was retracted or contradicts a still-active
 *   session.
 *
 * Cancellation is tracked separately and never becomes `interrupted`.
 */
export type DelegationProjectedState =
  "invoked" | "running" | "idle" | "succeeded" | "failed" | "interrupted" | "unknown";

/** Caps that keep retained history bounded (design D3). */
export const DELEGATION_NODES_PER_INVOCATION_CAP = 256;
export const DELEGATION_TRANSITIONS_PER_NODE_CAP = 128;
export const DELEGATION_TRANSITIONS_PER_INVOCATION_CAP = 2048;
export const DELEGATION_GAPS_PER_INVOCATION_CAP = 128;

/**
 * Longest whitelisted metadata string (ids, agent/model labels). Anything
 * longer is refused rather than truncated, so a prompt-like payload cannot be
 * silently stored in part.
 */
export const DELEGATION_MAX_METADATA_LENGTH = 256;

/**
 * How long after the last observation a live (nonterminal) state stops being
 * asserted. The observer reconciles once a second during a run, so two missed
 * rounds (design D4) is a deliberately small, honest window; a terminal
 * historic outcome is preserved regardless of age.
 */
export const DELEGATION_STALE_AFTER_MS = 2_000;

/**
 * A supported runtime session token: exactly the pinned `ses…` id shape. Any
 * other string (a prompt, a credential, a free-form id) is refused so a secret
 * cannot be persisted in a session-id column.
 */
const SESSION_TOKEN_PATTERN = /^ses[A-Za-z0-9_-]+$/u;

/**
 * A supported runtime identity segment: an alphanumeric start followed by
 * `[A-Za-z0-9._-]`. Rejects whitespace, prose, quotes, URL/userinfo separators
 * (`:`, `@`), `#` and all other punctuation, so instruction text or a
 * credential URL can never be stored as an agent/model identity. Kept in step
 * with the parser's identity syntax to avoid a store→agent dependency cycle.
 */
const IDENTITY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const IDENTITY_MAX_SEGMENTS = 8;

/**
 * Credential-shaped literals that are never a valid identity, session token,
 * gap code or gap copy. Mirrors the parser's privacy boundary.
 */
const CREDENTIAL_PATTERN =
  /(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[oprs]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|AIza[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9_-]+|Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+|-----BEGIN [A-Z ]+-----)/iu;

/**
 * A gap signature must be a controlled machine code (the observer emits codes
 * like `source-lost`, `node-cap`, `listing-failed`), never free prose.
 */
const GAP_SIGNATURE_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/u;

/** Longest gap copy retained. */
export const DELEGATION_MAX_GAP_DETAIL_LENGTH = 200;
/** Longest gap signature retained. */
export const DELEGATION_MAX_GAP_SIGNATURE_LENGTH = 64;

/**
 * Instruction-shaped prose is refused in a gap copy: the store never echoes a
 * raw transport exception, a stack trace or an injected instruction, only
 * controlled/short operator copy. Kept deliberately narrow and documented.
 */
const GAP_DETAIL_FORBIDDEN = [
  /ignore\s+(all\s+)?(previous|prior|above)/iu,
  /disregard\s+(all\s+)?(previous|prior|above)/iu,
  /system\s+prompt/iu,
  /\byou\s+are\s+(an?|the)\b/iu,
  /(^|\s)(assistant|user|system)\s*:/iu,
  /https?:\/\//iu,
  /file:\/\//iu,
  /\b(?:curl|wget|rm\s+-rf|chmod\s+\+x|sudo)\b/u,
  /\b(?:Error|Exception)\b.*\bat\s+\S+:\d+/u,
  /-----BEGIN/iu,
  /```/u,
];

function isCredentialLike(value: string): boolean {
  return CREDENTIAL_PATTERN.test(value);
}

function hasControlCharactersIn(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * A supported session token, or null. Non-string/empty values return null;
 * unsupported shapes are reported by the caller so nothing is silently
 * normalized.
 */
function sessionToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > DELEGATION_MAX_METADATA_LENGTH) return null;
  if (hasControlCharactersIn(value) || isCredentialLike(value)) return null;
  return SESSION_TOKEN_PATTERN.test(value) ? value : null;
}

/** A supported runtime agent/model identity token, or null. */
function identityToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > DELEGATION_MAX_METADATA_LENGTH) return null;
  if (value.startsWith("-") || hasControlCharactersIn(value) || isCredentialLike(value)) {
    return null;
  }
  const segments = value.split("/");
  if (segments.length > IDENTITY_MAX_SEGMENTS) return null;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !IDENTITY_SEGMENT_PATTERN.test(segment)) return null;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface DelegationObservationIssue {
  path: string;
  message: string;
}

export class DelegationObservationValidationError extends Error {
  readonly issues: readonly DelegationObservationIssue[];
  constructor(issues: readonly DelegationObservationIssue[]) {
    super(
      `Invalid delegation observation input:\n- ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n- ")}`,
    );
    this.name = "DelegationObservationValidationError";
    this.issues = issues;
  }
}

/** One durable observation node as read back. */
export interface DelegationObservationNode {
  id: number;
  attemptId: number;
  invocationOrdinal: number;
  sessionId: string;
  rootSessionId: string | null;
  parentSessionId: string | null;
  depth: number | null;
  sourceKind: DelegationSourceKind;
  presence: DelegationEvidencePresence;
  agent: string | null;
  model: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceIdleAt: string | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  lastState: DelegationProjectedState;
  /** The retained historic terminal outcome (first proven; never cleared). */
  lastOutcome: DelegationTerminalOutcome | null;
  /** The terminal outcome the LATEST observation reported (null if none). */
  currentOutcome: DelegationTerminalOutcome | null;
  /** True when the latest evidence retracted/contradicted `lastOutcome`. */
  outcomeConflict: boolean;
  /** The current observation's active evidence (null when unknown). */
  lastActive: boolean | null;
  /** The most recent NON-NULL active evidence ever seen (history only). */
  lastKnownActive: boolean | null;
  cancellationRequested: boolean;
  cancellationRequestedAt: string | null;
  generation: number;
  historyPartial: boolean;
  limitedUncertainty: boolean;
}

/** One durable coverage record per invocation. */
export interface DelegationInvocationCoverage {
  attemptId: number;
  invocationOrdinal: number;
  generation: number;
  transport: DelegationTransport;
  transportState: DelegationTransportState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  gapCount: number;
  truncated: boolean;
  historyPartial: boolean;
  nodeLimitReached: boolean;
  updatedAt: string;
}

/** One explicit observation gap (open while `closedAt` is null). */
export interface DelegationObservationGap {
  id: number;
  attemptId: number;
  invocationOrdinal: number;
  signature: string;
  detail: string;
  openedAt: string;
  closedAt: string | null;
}

/** Bounded batched read for one attempt. */
export interface DelegationAttemptObservations {
  attemptId: number;
  nodes: DelegationObservationNode[];
  coverage: DelegationInvocationCoverage[];
  gaps: DelegationObservationGap[];
}

/** A write that never throws; a storage failure is reported for the caller. */
export type DelegationWriteResult =
  | { ok: true }
  | {
      ok: false;
      reason: "validation";
      message: string;
      issues: readonly DelegationObservationIssue[];
    }
  | { ok: false; reason: "not-found"; message: string }
  | { ok: false; reason: "storage"; message: string };

export type RecordDelegationObservationResult =
  | {
      ok: true;
      nodeId: number;
      inserted: boolean;
      state: DelegationProjectedState;
      transitioned: boolean;
      generation: number;
    }
  | {
      ok: false;
      reason: "validation";
      message: string;
      issues: readonly DelegationObservationIssue[];
    }
  | { ok: false; reason: "node-limit"; message: string }
  | { ok: false; reason: "storage"; message: string };

export type ImportLegacyResult =
  | {
      ok: true;
      imported: number;
      attemptsConsidered: number;
      skippedAmbiguous: number;
      /** Children skipped for an invalid session ref or unrecognized outcome. */
      skippedInvalid: number;
      /** True when the per-invocation node cap truncated a legacy import. */
      capped: boolean;
    }
  | { ok: false; reason: "storage"; message: string };

/* ------------------------------------------------------------------ *
 * Input validation (whitelist + revalidate)
 * ------------------------------------------------------------------ */

const OBSERVATION_INPUT_FIELDS = new Set([
  "attemptId",
  "invocationOrdinal",
  "sessionId",
  "rootSessionId",
  "parentSessionId",
  "depth",
  "sourceKind",
  "agent",
  "model",
  "sourceCreatedAt",
  "sourceUpdatedAt",
  "sourceIdleAt",
  "observedAt",
  "presence",
  "active",
  "outcome",
  "cancellationRequested",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * A normalized ISO-8601 instant. The FULL string must match (no trailing
 * prose, no partial date), the timezone is required, and the value must parse,
 * so a timestamp field cannot smuggle extra text or be truncated silently.
 */
function isIsoTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return false;
  return Number.isFinite(Date.parse(value));
}

function readPositiveInteger(
  value: unknown,
  path: string,
  issues: DelegationObservationIssue[],
): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    issues.push({ path, message: "must be a positive integer" });
    return null;
  }
  return value;
}

function readOptionalNonNegativeInteger(
  value: unknown,
  path: string,
  issues: DelegationObservationIssue[],
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issues.push({ path, message: "must be a non-negative integer or null" });
    return null;
  }
  return value;
}

/**
 * A supported `ses…` session token, or null. A present-but-unsupported value
 * (a credential, a prompt, a free-form id) is reported as an issue rather than
 * dropped, so a secret cannot quietly enter a session column.
 */
function readSessionToken(
  value: unknown,
  path: string,
  issues: DelegationObservationIssue[],
  options: { required?: boolean } = {},
): string | null {
  if (value === null || value === undefined) {
    if (options.required === true) issues.push({ path, message: "is required" });
    return null;
  }
  const token = sessionToken(value);
  if (token === null) {
    issues.push({
      path,
      message: "must be a supported ses session token (no credential-shaped or free-form values)",
    });
    return null;
  }
  return token;
}

/** A supported agent/model identity token, or null. */
function readIdentityToken(
  value: unknown,
  path: string,
  issues: DelegationObservationIssue[],
): string | null {
  if (value === null || value === undefined) return null;
  const token = identityToken(value);
  if (token === null) {
    issues.push({
      path,
      message: "must be a supported identity token (no prose, credentials or URL punctuation)",
    });
    return null;
  }
  return token;
}

/** Models may include the parser's validated `#variant` suffix; agents may not. */
function readModelToken(value: unknown, issues: DelegationObservationIssue[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.length <= DELEGATION_MAX_METADATA_LENGTH) {
    const parts = value.split("#");
    if (parts.length <= 2 && parts.every((part) => identityToken(part) !== null)) return value;
  }
  issues.push({
    path: "model",
    message: "must be a supported model identity with an optional safe variant",
  });
  return null;
}

/** A controlled gap machine code, or null. */
function readGapSignature(
  value: unknown,
  path: string,
  issues: DelegationObservationIssue[],
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "is required" });
    return null;
  }
  if (value.length > DELEGATION_MAX_GAP_SIGNATURE_LENGTH || !GAP_SIGNATURE_PATTERN.test(value)) {
    issues.push({
      path,
      message: "must be a controlled lowercase machine code (for example source-lost or node-cap)",
    });
    return null;
  }
  return value;
}

/**
 * A bounded, safe gap copy, or null. Credential-shaped values are refused and
 * instruction-shaped prose / raw transport exceptions are refused, so only
 * controlled operator copy enters gap storage.
 */
function readGapDetail(
  value: unknown,
  path: string,
  issues: DelegationObservationIssue[],
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "is required" });
    return null;
  }
  if (value.trim().length === 0 || hasControlCharacters(value)) {
    issues.push({ path, message: "must be non-empty safe text on a single line" });
    return null;
  }
  if (value.length > DELEGATION_MAX_GAP_DETAIL_LENGTH) {
    issues.push({
      path,
      message: `must be at most ${String(DELEGATION_MAX_GAP_DETAIL_LENGTH)} characters`,
    });
    return null;
  }
  if (isCredentialLike(value)) {
    issues.push({ path, message: "must not contain credential-shaped values" });
    return null;
  }
  if (GAP_DETAIL_FORBIDDEN.some((pattern) => pattern.test(value))) {
    issues.push({
      path,
      message: "must be controlled copy, not instruction-shaped prose or a raw error payload",
    });
    return null;
  }
  return value;
}

function readOptionalTimestamp(
  value: unknown,
  path: string,
  issues: DelegationObservationIssue[],
  options: { required?: boolean } = {},
): string | null {
  if (value === null || value === undefined) {
    if (options.required === true) issues.push({ path, message: "is required" });
    return null;
  }
  if (typeof value !== "string" || !isIsoTimestamp(value)) {
    issues.push({ path, message: "must be an ISO-8601 timestamp string" });
    return null;
  }
  return value;
}

interface NormalizedObservation {
  attemptId: number;
  invocationOrdinal: number;
  sessionId: string;
  rootSessionId: string | null;
  parentSessionId: string | null;
  depth: number | null;
  sourceKind: DelegationSourceKind;
  agent: string | null;
  model: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceIdleAt: string | null;
  observedAt: string;
  presence: DelegationEvidencePresence;
  active: boolean | null;
  outcome: DelegationTerminalOutcome | null;
  cancellationRequested: boolean;
}

/**
 * Validate and normalize one observation candidate. Atomic: either the whole
 * candidate becomes a normalized observation or every issue is thrown at once.
 * Unknown fields are rejected, not dropped, so an accidental prompt/config/
 * event payload cannot ride along inside a whitelisted object.
 */
export function parseDelegationObservationInput(input: unknown): NormalizedObservation {
  if (!isRecord(input)) {
    throw new DelegationObservationValidationError([
      { path: "observation", message: "must be an object" },
    ]);
  }
  const issues: DelegationObservationIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!OBSERVATION_INPUT_FIELDS.has(key)) {
      issues.push({ path: key, message: `unknown field "${key}"` });
    }
  }

  const attemptId = readPositiveInteger(input.attemptId, "attemptId", issues);
  const invocationOrdinal = readPositiveInteger(
    input.invocationOrdinal,
    "invocationOrdinal",
    issues,
  );
  const sessionId = readSessionToken(input.sessionId, "sessionId", issues, { required: true });
  const rootSessionId = readSessionToken(input.rootSessionId, "rootSessionId", issues);
  const parentSessionId = readSessionToken(input.parentSessionId, "parentSessionId", issues);
  const depth = readOptionalNonNegativeInteger(input.depth, "depth", issues);
  const agent = readIdentityToken(input.agent, "agent", issues);
  const model = readModelToken(input.model, issues);
  const sourceCreatedAt = readOptionalTimestamp(input.sourceCreatedAt, "sourceCreatedAt", issues);
  const sourceUpdatedAt = readOptionalTimestamp(input.sourceUpdatedAt, "sourceUpdatedAt", issues);
  const sourceIdleAt = readOptionalTimestamp(input.sourceIdleAt, "sourceIdleAt", issues);
  const observedAt = readOptionalTimestamp(input.observedAt, "observedAt", issues, {
    required: true,
  });

  let sourceKind: DelegationSourceKind = "unknown";
  if (input.sourceKind !== undefined) {
    if (
      typeof input.sourceKind === "string" &&
      (DELEGATION_SOURCE_KINDS as readonly string[]).includes(input.sourceKind)
    ) {
      sourceKind = input.sourceKind as DelegationSourceKind;
    } else {
      issues.push({
        path: "sourceKind",
        message: `must be one of ${DELEGATION_SOURCE_KINDS.join(", ")}`,
      });
    }
  }

  let presence: DelegationEvidencePresence = "observed";
  if (input.presence !== undefined) {
    if (
      typeof input.presence === "string" &&
      (DELEGATION_EVIDENCE_PRESENCES as readonly string[]).includes(input.presence)
    ) {
      presence = input.presence as DelegationEvidencePresence;
    } else {
      issues.push({
        path: "presence",
        message: `must be one of ${DELEGATION_EVIDENCE_PRESENCES.join(", ")}`,
      });
    }
  }

  let active: boolean | null = null;
  if (input.active !== undefined) {
    if (typeof input.active === "boolean") active = input.active;
    else if (input.active !== null) {
      issues.push({ path: "active", message: "must be a boolean or null" });
    }
  }

  let outcome: DelegationTerminalOutcome | null = null;
  if (input.outcome !== undefined) {
    if (
      typeof input.outcome === "string" &&
      (DELEGATION_TERMINAL_OUTCOMES as readonly string[]).includes(input.outcome)
    ) {
      outcome = input.outcome as DelegationTerminalOutcome;
    } else if (input.outcome !== null) {
      issues.push({
        path: "outcome",
        message: `must be null or one of ${DELEGATION_TERMINAL_OUTCOMES.join(", ")}`,
      });
    }
  }

  let cancellationRequested = false;
  if (input.cancellationRequested !== undefined) {
    if (typeof input.cancellationRequested === "boolean") {
      cancellationRequested = input.cancellationRequested;
    } else {
      issues.push({ path: "cancellationRequested", message: "must be a boolean" });
    }
  }

  if (issues.length > 0) throw new DelegationObservationValidationError(issues);

  return {
    attemptId: attemptId as number,
    invocationOrdinal: invocationOrdinal as number,
    sessionId: sessionId as string,
    rootSessionId,
    parentSessionId,
    depth,
    sourceKind,
    agent,
    model,
    sourceCreatedAt,
    sourceUpdatedAt,
    sourceIdleAt,
    observedAt: observedAt as string,
    presence,
    active,
    outcome,
    cancellationRequested,
  };
}

function toEpoch(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * Independent state projection
 * ------------------------------------------------------------------ */

export interface DelegationEvidence {
  presence: DelegationEvidencePresence;
  /** Current observation's active evidence (null when unknown). */
  active: boolean | null;
  /** The terminal outcome the LATEST observation reported (null if none). */
  currentOutcome: DelegationTerminalOutcome | null;
  /** True when the retained historic outcome was retracted/contradicted. */
  outcomeConflict: boolean;
  /** Most recent non-null active evidence ever observed (history only). */
  lastKnownActive: boolean | null;
}

/**
 * Classify raw evidence.
 *
 * - `missing` presence, a stale source, or a retracted/contradicted outcome is
 *   `unknown` (last-known evidence is retained on the node, not asserted
 *   current).
 * - A terminal outcome is shown only when the LATEST observation reported it,
 *   it is consistent with retained evidence, and fresh evidence proves the
 *   session inactive. A terminal outcome still listed active is a contradiction
 *   and becomes `unknown`.
 * - Fresh nonterminal evidence with current active presence/absence is
 *   `running`/`idle`. A fresh record whose active evidence has never been seen
 *   is `invoked` (verified record, current execution unknown); if activity was
 *   once known and is now unknown, it is `unknown` rather than a resurrected
 *   live state.
 */
export function classifyDelegationState(
  evidence: DelegationEvidence,
  options: { fresh: boolean },
): DelegationProjectedState {
  if (evidence.presence === "missing") return "unknown";
  if (evidence.outcomeConflict) return "unknown";
  if (evidence.currentOutcome !== null) {
    return evidence.active === false ? evidence.currentOutcome : "unknown";
  }
  if (!options.fresh) return "unknown";
  if (evidence.active === true) return "running";
  if (evidence.active === false) return "idle";
  return evidence.lastKnownActive === null ? "invoked" : "unknown";
}

/** True when a node's last observation is absent or older than the window. */
export function isDelegationNodeStale(
  node: Pick<DelegationObservationNode, "lastObservedAt">,
  options: { now: Date | number | string; staleAfterMs?: number },
): boolean {
  if (node.lastObservedAt === null) return true;
  const observed = Date.parse(node.lastObservedAt);
  const now = toEpoch(options.now);
  if (!Number.isFinite(observed) || !Number.isFinite(now)) return true;
  return now - observed > (options.staleAfterMs ?? DELEGATION_STALE_AFTER_MS);
}

/**
 * Project a node's display state from its retained evidence and freshness.
 * Independent of `classifyChildSession`: idle never means completed, and a
 * cancellation request never fabricates an interrupted outcome (it is exposed
 * separately on the node).
 */
export function projectDelegationState(
  node: DelegationObservationNode,
  options: { now: Date | number | string; staleAfterMs?: number },
): DelegationProjectedState {
  const fresh = !isDelegationNodeStale(node, options);
  return classifyDelegationState(
    {
      presence: node.presence,
      active: node.lastActive,
      currentOutcome: node.currentOutcome,
      outcomeConflict: node.outcomeConflict,
      lastKnownActive: node.lastKnownActive,
    },
    { fresh },
  );
}

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

interface NodeRow {
  id: number;
  attempt_id: number;
  invocation_ordinal: number;
  session_id: string;
  root_session_id: string | null;
  parent_session_id: string | null;
  depth: number | null;
  source_kind: string;
  evidence_presence: string;
  actual_agent: string | null;
  actual_model: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  source_idle_at: string | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  last_state: string;
  last_outcome: string | null;
  last_active: number | null;
  last_known_active: number | null;
  current_outcome: string | null;
  outcome_conflict: number;
  cancellation_requested: number;
  cancellation_requested_at: string | null;
  observation_generation: number;
  history_partial: number;
  limited_uncertainty: number;
  created_at: string;
  updated_at: string;
}

interface CoverageRow {
  attempt_id: number;
  invocation_ordinal: number;
  generation: number;
  transport: string;
  transport_state: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  gap_count: number;
  truncated: number;
  history_partial: number;
  node_limit_reached: number;
  updated_at: string;
}

interface GapRow {
  id: number;
  attempt_id: number;
  invocation_ordinal: number;
  signature: string;
  detail: string;
  opened_at: string;
  closed_at: string | null;
}

function mapNodeRow(row: NodeRow): DelegationObservationNode {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    invocationOrdinal: row.invocation_ordinal,
    sessionId: row.session_id,
    rootSessionId: row.root_session_id,
    parentSessionId: row.parent_session_id,
    depth: row.depth,
    sourceKind: row.source_kind as DelegationSourceKind,
    presence: row.evidence_presence as DelegationEvidencePresence,
    agent: row.actual_agent,
    model: row.actual_model,
    sourceCreatedAt: row.source_created_at,
    sourceUpdatedAt: row.source_updated_at,
    sourceIdleAt: row.source_idle_at,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    lastState: row.last_state as DelegationProjectedState,
    lastOutcome: row.last_outcome as DelegationTerminalOutcome | null,
    currentOutcome: row.current_outcome as DelegationTerminalOutcome | null,
    outcomeConflict: row.outcome_conflict === 1,
    lastActive: row.last_active === null ? null : row.last_active === 1,
    lastKnownActive: row.last_known_active === null ? null : row.last_known_active === 1,
    cancellationRequested: row.cancellation_requested === 1,
    cancellationRequestedAt: row.cancellation_requested_at,
    generation: row.observation_generation,
    historyPartial: row.history_partial === 1,
    limitedUncertainty: row.limited_uncertainty === 1,
  };
}

function mapCoverageRow(row: CoverageRow): DelegationInvocationCoverage {
  return {
    attemptId: row.attempt_id,
    invocationOrdinal: row.invocation_ordinal,
    generation: row.generation,
    transport: row.transport as DelegationTransport,
    transportState: row.transport_state as DelegationTransportState,
    lastSuccessAt: row.last_success_at,
    lastAttemptAt: row.last_attempt_at,
    gapCount: row.gap_count,
    truncated: row.truncated === 1,
    historyPartial: row.history_partial === 1,
    nodeLimitReached: row.node_limit_reached === 1,
    updatedAt: row.updated_at,
  };
}

function mapGapRow(row: GapRow): DelegationObservationGap {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    invocationOrdinal: row.invocation_ordinal,
    signature: row.signature,
    detail: row.detail,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

const NODE_COLUMNS = `id, attempt_id, invocation_ordinal, session_id, root_session_id,
  parent_session_id, depth, source_kind, evidence_presence, actual_agent, actual_model,
  source_created_at, source_updated_at, source_idle_at, first_observed_at, last_observed_at,
  last_state, last_outcome, last_active, last_known_active, current_outcome, outcome_conflict,
  cancellation_requested, cancellation_requested_at, observation_generation, history_partial,
  limited_uncertainty, created_at, updated_at`;

function readNodeRow(
  db: Database.Database,
  attemptId: number,
  invocationOrdinal: number,
  sessionId: string,
): NodeRow | undefined {
  return db
    .prepare(
      `SELECT ${NODE_COLUMNS} FROM delegation_observation_nodes
       WHERE attempt_id = ? AND invocation_ordinal = ? AND session_id = ?`,
    )
    .get(attemptId, invocationOrdinal, sessionId) as NodeRow | undefined;
}

function readCoverageRow(
  db: Database.Database,
  attemptId: number,
  invocationOrdinal: number,
): CoverageRow | undefined {
  return db
    .prepare(
      `SELECT attempt_id, invocation_ordinal, generation, transport, transport_state,
              last_success_at, last_attempt_at, gap_count, truncated, history_partial,
              node_limit_reached, updated_at
       FROM delegation_invocation_coverage
       WHERE attempt_id = ? AND invocation_ordinal = ?`,
    )
    .get(attemptId, invocationOrdinal) as CoverageRow | undefined;
}

function transportForSource(sourceKind: DelegationSourceKind): DelegationTransport {
  switch (sourceKind) {
    case "session-poll":
      return "polling";
    case "event-stream":
      return "event-stream";
    case "legacy-managed":
      return "legacy-managed";
    default:
      return "unknown";
  }
}

/* ------------------------------------------------------------------ *
 * Node + coverage upsert (idempotent, evidence preserving)
 * ------------------------------------------------------------------ */

interface MergedNode {
  attemptId: number;
  invocationOrdinal: number;
  sessionId: string;
  rootSessionId: string | null;
  parentSessionId: string | null;
  depth: number | null;
  sourceKind: DelegationSourceKind;
  presence: DelegationEvidencePresence;
  agent: string | null;
  model: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceIdleAt: string | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  lastState: DelegationProjectedState;
  lastOutcome: DelegationTerminalOutcome | null;
  currentOutcome: DelegationTerminalOutcome | null;
  outcomeConflict: boolean;
  lastActive: boolean | null;
  lastKnownActive: boolean | null;
  cancellationRequested: boolean;
  cancellationRequestedAt: string | null;
  generation: number;
  historyPartial: boolean;
  limitedUncertainty: boolean;
  createdAt: string;
  updatedAt: string;
}

function chooseSourceKind(
  existing: DelegationSourceKind,
  incoming: DelegationSourceKind,
): DelegationSourceKind {
  const existingIsWeak = existing === "legacy-managed" || existing === "unknown";
  const incomingIsStrong = incoming !== "legacy-managed" && incoming !== "unknown";
  if (existingIsWeak && incomingIsStrong) return incoming;
  return existing;
}

/** The later of two ISO instants; an out-of-order older read never regresses it. */
function latestTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

function mergeNode(
  existing: NodeRow | undefined,
  input: NormalizedObservation,
  generation: number,
): MergedNode {
  let limitedUncertainty = existing?.limited_uncertainty === 1;
  const agent = existing?.actual_agent ?? input.agent;
  const model = existing?.actual_model ?? input.model;
  // `last_outcome` is retained historic terminal evidence (first proven, never
  // cleared); `currentOutcome` is what the LATEST observation reported and is
  // what the projection actually reads. `outcomeConflict` marks a retraction or
  // a differing terminal outcome so the projection stays unknown until a fresh
  // record is consistent again.
  const retainedOutcome = (existing?.last_outcome as DelegationTerminalOutcome | null) ?? null;
  const incomingOutcome = input.outcome;
  if (
    existing?.actual_agent != null &&
    input.agent != null &&
    existing.actual_agent !== input.agent
  ) {
    limitedUncertainty = true;
  }
  if (
    existing?.actual_model != null &&
    input.model != null &&
    existing.actual_model !== input.model
  ) {
    limitedUncertainty = true;
  }

  let lastOutcome = retainedOutcome;
  let currentOutcome: DelegationTerminalOutcome | null;
  let outcomeConflict = retainedOutcome !== null && existing?.outcome_conflict === 1;
  if (incomingOutcome === null) {
    currentOutcome = null;
    // A terminal outcome that the latest record no longer reports has been
    // retracted: keep the historic value but do not display it.
    if (retainedOutcome !== null) outcomeConflict = true;
  } else {
    currentOutcome = incomingOutcome;
    if (retainedOutcome === null) {
      lastOutcome = incomingOutcome; // first proven terminal outcome
      outcomeConflict = false;
    } else if (retainedOutcome === incomingOutcome) {
      outcomeConflict = false; // consistent fresh supported evidence
    } else {
      outcomeConflict = true; // conflicting terminal outcome
    }
  }
  if (outcomeConflict) limitedUncertainty = true;

  const presence = input.presence;
  const previousKnownActive =
    existing?.last_known_active === null || existing?.last_known_active === undefined
      ? null
      : existing.last_known_active === 1;
  // Current active evidence is exactly what this observation reported. A lost
  // active map (null) must NOT resurrect a previous value as current; the most
  // recent non-null value is retained separately as history for display only.
  const lastActive = presence === "missing" ? null : input.active;
  const lastKnownActive =
    presence === "missing" ? previousKnownActive : (input.active ?? previousKnownActive);
  const lastState = classifyDelegationState(
    { presence, active: lastActive, currentOutcome, outcomeConflict, lastKnownActive },
    { fresh: true },
  );
  const cancellationRequested =
    existing?.cancellation_requested === 1 || input.cancellationRequested;
  return {
    attemptId: input.attemptId,
    invocationOrdinal: input.invocationOrdinal,
    sessionId: input.sessionId,
    rootSessionId: existing?.root_session_id ?? input.rootSessionId,
    parentSessionId: existing?.parent_session_id ?? input.parentSessionId,
    depth: existing?.depth ?? input.depth,
    sourceKind: existing
      ? chooseSourceKind(existing.source_kind as DelegationSourceKind, input.sourceKind)
      : input.sourceKind,
    presence,
    agent,
    model,
    sourceCreatedAt: existing?.source_created_at ?? input.sourceCreatedAt,
    sourceUpdatedAt: latestTimestamp(existing?.source_updated_at ?? null, input.sourceUpdatedAt),
    sourceIdleAt: latestTimestamp(existing?.source_idle_at ?? null, input.sourceIdleAt),
    firstObservedAt: existing?.first_observed_at ?? input.observedAt,
    lastObservedAt: input.observedAt,
    lastState,
    lastOutcome,
    currentOutcome,
    outcomeConflict,
    lastActive,
    lastKnownActive,
    cancellationRequested,
    cancellationRequestedAt:
      existing?.cancellation_requested_at ??
      (input.cancellationRequested ? input.observedAt : null),
    generation,
    historyPartial: existing?.history_partial === 1,
    limitedUncertainty,
    createdAt: existing?.created_at ?? input.observedAt,
    updatedAt: input.observedAt,
  };
}

const UPSERT_NODE_SQL = `
INSERT INTO delegation_observation_nodes (
  attempt_id, invocation_ordinal, session_id, root_session_id, parent_session_id, depth,
  source_kind, evidence_presence, actual_agent, actual_model, source_created_at,
  source_updated_at, source_idle_at, first_observed_at, last_observed_at, last_state,
  last_outcome, last_active, last_known_active, current_outcome, outcome_conflict,
  cancellation_requested, cancellation_requested_at,
  observation_generation, history_partial, limited_uncertainty, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(attempt_id, invocation_ordinal, session_id) DO UPDATE SET
  root_session_id = excluded.root_session_id,
  parent_session_id = excluded.parent_session_id,
  depth = excluded.depth,
  source_kind = excluded.source_kind,
  evidence_presence = excluded.evidence_presence,
  actual_agent = excluded.actual_agent,
  actual_model = excluded.actual_model,
  source_created_at = excluded.source_created_at,
  source_updated_at = excluded.source_updated_at,
  source_idle_at = excluded.source_idle_at,
  first_observed_at = excluded.first_observed_at,
  last_observed_at = excluded.last_observed_at,
  last_state = excluded.last_state,
  last_outcome = excluded.last_outcome,
  last_active = excluded.last_active,
  last_known_active = excluded.last_known_active,
  current_outcome = excluded.current_outcome,
  outcome_conflict = excluded.outcome_conflict,
  cancellation_requested = excluded.cancellation_requested,
  cancellation_requested_at = excluded.cancellation_requested_at,
  observation_generation = excluded.observation_generation,
  history_partial = excluded.history_partial,
  limited_uncertainty = excluded.limited_uncertainty,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at`;

function upsertNode(db: Database.Database, node: MergedNode): void {
  db.prepare(UPSERT_NODE_SQL).run(
    node.attemptId,
    node.invocationOrdinal,
    node.sessionId,
    node.rootSessionId,
    node.parentSessionId,
    node.depth,
    node.sourceKind,
    node.presence,
    node.agent,
    node.model,
    node.sourceCreatedAt,
    node.sourceUpdatedAt,
    node.sourceIdleAt,
    node.firstObservedAt,
    node.lastObservedAt,
    node.lastState,
    node.lastOutcome,
    node.lastActive === null ? null : node.lastActive ? 1 : 0,
    node.lastKnownActive === null ? null : node.lastKnownActive ? 1 : 0,
    node.currentOutcome,
    node.outcomeConflict ? 1 : 0,
    node.cancellationRequested ? 1 : 0,
    node.cancellationRequestedAt,
    node.generation,
    node.historyPartial ? 1 : 0,
    node.limitedUncertainty ? 1 : 0,
    node.createdAt,
    node.updatedAt,
  );
}

function bumpCoverage(db: Database.Database, input: NormalizedObservation): { generation: number } {
  const existing = readCoverageRow(db, input.attemptId, input.invocationOrdinal);
  const incomingTransport = transportForSource(input.sourceKind);
  let transport: DelegationTransport;
  if (existing === undefined) {
    transport = incomingTransport;
  } else {
    const current = existing.transport as DelegationTransport;
    transport =
      (current === "unknown" || current === "none") && incomingTransport !== "unknown"
        ? incomingTransport
        : current === "legacy-managed" &&
            incomingTransport !== "legacy-managed" &&
            incomingTransport !== "unknown"
          ? incomingTransport
          : current;
  }
  const generation = (existing?.generation ?? 0) + 1;
  const lastSuccessAt =
    input.presence === "observed" ? input.observedAt : (existing?.last_success_at ?? null);
  db.prepare(
    `INSERT INTO delegation_invocation_coverage (
       attempt_id, invocation_ordinal, generation, transport, transport_state,
       last_success_at, last_attempt_at, gap_count, truncated, history_partial,
       node_limit_reached, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id, invocation_ordinal) DO UPDATE SET
       generation = excluded.generation,
       transport = excluded.transport,
       transport_state = excluded.transport_state,
       last_success_at = excluded.last_success_at,
       last_attempt_at = excluded.last_attempt_at,
       gap_count = excluded.gap_count,
       truncated = excluded.truncated,
       history_partial = excluded.history_partial,
       node_limit_reached = excluded.node_limit_reached,
       updated_at = excluded.updated_at`,
  ).run(
    input.attemptId,
    input.invocationOrdinal,
    generation,
    transport,
    "ok",
    lastSuccessAt,
    input.observedAt,
    existing?.gap_count ?? 0,
    existing?.truncated ?? 0,
    existing?.history_partial ?? 0,
    existing?.node_limit_reached ?? 0,
    input.observedAt,
  );
  return { generation };
}

/* ------------------------------------------------------------------ *
 * Transitions (bounded, change-only)
 * ------------------------------------------------------------------ */

function nodeChanged(existing: NodeRow | undefined, merged: MergedNode): boolean {
  if (existing === undefined) return true;
  return (
    existing.last_state !== merged.lastState ||
    existing.last_outcome !== merged.lastOutcome ||
    existing.last_active !== (merged.lastActive === null ? null : merged.lastActive ? 1 : 0) ||
    existing.last_known_active !==
      (merged.lastKnownActive === null ? null : merged.lastKnownActive ? 1 : 0) ||
    existing.current_outcome !== merged.currentOutcome ||
    existing.outcome_conflict !== (merged.outcomeConflict ? 1 : 0) ||
    existing.cancellation_requested !== (merged.cancellationRequested ? 1 : 0)
  );
}

function insertTransition(db: Database.Database, merged: MergedNode, at: string): void {
  db.prepare(
    `INSERT INTO delegation_observation_transitions
       (attempt_id, invocation_ordinal, session_id, at, state, outcome, active, cancellation_requested)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    merged.attemptId,
    merged.invocationOrdinal,
    merged.sessionId,
    at,
    merged.lastState,
    merged.lastOutcome,
    merged.lastActive === null ? null : merged.lastActive ? 1 : 0,
    merged.cancellationRequested ? 1 : 0,
  );
}

/**
 * Trim the oldest transitions past the per-node cap. Returns true when rows
 * were removed so the caller can mark the node's retained history partial.
 */
function trimNodeTransitions(
  db: Database.Database,
  attemptId: number,
  invocationOrdinal: number,
  sessionId: string,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM delegation_observation_transitions
       WHERE attempt_id = ? AND invocation_ordinal = ? AND session_id = ?
         AND id NOT IN (
           SELECT id FROM delegation_observation_transitions
           WHERE attempt_id = ? AND invocation_ordinal = ? AND session_id = ?
           ORDER BY id DESC LIMIT ?
         )`,
    )
    .run(
      attemptId,
      invocationOrdinal,
      sessionId,
      attemptId,
      invocationOrdinal,
      sessionId,
      DELEGATION_TRANSITIONS_PER_NODE_CAP,
    );
  return result.changes > 0;
}

/** Trim the oldest transitions past the per-invocation cap across all nodes. */
function trimInvocationTransitions(
  db: Database.Database,
  attemptId: number,
  invocationOrdinal: number,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM delegation_observation_transitions
       WHERE attempt_id = ? AND invocation_ordinal = ?
         AND id NOT IN (
           SELECT id FROM delegation_observation_transitions
           WHERE attempt_id = ? AND invocation_ordinal = ?
           ORDER BY id DESC LIMIT ?
         )`,
    )
    .run(
      attemptId,
      invocationOrdinal,
      attemptId,
      invocationOrdinal,
      DELEGATION_TRANSITIONS_PER_INVOCATION_CAP,
    );
  return result.changes > 0;
}

function countNodesForInvocation(
  db: Database.Database,
  attemptId: number,
  invocationOrdinal: number,
): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM delegation_observation_nodes
         WHERE attempt_id = ? AND invocation_ordinal = ?`,
      )
      .get(attemptId, invocationOrdinal) as { n: number }
  ).n;
}

/* ------------------------------------------------------------------ *
 * Public writes
 * ------------------------------------------------------------------ */

/**
 * Idempotently record one observation. `first_observed_at`, first-known
 * identity and the first terminal outcome are preserved; a later round only
 * advances `last_*`. On a genuine state change a bounded transition is
 * appended. A database failure or validation error is returned, never thrown.
 * Exceeding the per-invocation node cap records partial coverage and refuses
 * the extra node without inventing a tree.
 */
export function recordDelegationObservation(
  db: Database.Database,
  input: unknown,
): RecordDelegationObservationResult {
  let normalized: NormalizedObservation;
  try {
    normalized = parseDelegationObservationInput(input);
  } catch (error) {
    if (error instanceof DelegationObservationValidationError) {
      return { ok: false, reason: "validation", message: error.message, issues: error.issues };
    }
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
  try {
    return db.transaction((): RecordDelegationObservationResult => {
      const existing = readNodeRow(
        db,
        normalized.attemptId,
        normalized.invocationOrdinal,
        normalized.sessionId,
      );
      if (
        existing === undefined &&
        countNodesForInvocation(db, normalized.attemptId, normalized.invocationOrdinal) >=
          DELEGATION_NODES_PER_INVOCATION_CAP
      ) {
        db.prepare(
          `UPDATE delegation_invocation_coverage
           SET node_limit_reached = 1, truncated = 1, updated_at = ?
           WHERE attempt_id = ? AND invocation_ordinal = ?`,
        ).run(normalized.observedAt, normalized.attemptId, normalized.invocationOrdinal);
        return {
          ok: false,
          reason: "node-limit",
          message:
            `invocation ${String(normalized.attemptId)}/${String(normalized.invocationOrdinal)} ` +
            `already holds ${String(DELEGATION_NODES_PER_INVOCATION_CAP)} observation nodes`,
        };
      }

      const { generation } = bumpCoverage(db, normalized);
      const merged = mergeNode(existing, normalized, generation);
      upsertNode(db, merged);

      let transitioned = false;
      if (nodeChanged(existing, merged)) {
        insertTransition(db, merged, normalized.observedAt);
        transitioned = true;
        if (trimNodeTransitions(db, merged.attemptId, merged.invocationOrdinal, merged.sessionId)) {
          db.prepare(
            `UPDATE delegation_observation_nodes SET history_partial = 1
             WHERE attempt_id = ? AND invocation_ordinal = ? AND session_id = ?`,
          ).run(merged.attemptId, merged.invocationOrdinal, merged.sessionId);
        }
        if (trimInvocationTransitions(db, merged.attemptId, merged.invocationOrdinal)) {
          db.prepare(
            `UPDATE delegation_invocation_coverage SET history_partial = 1, updated_at = ?
             WHERE attempt_id = ? AND invocation_ordinal = ?`,
          ).run(normalized.observedAt, merged.attemptId, merged.invocationOrdinal);
        }
      }

      const row = readNodeRow(
        db,
        merged.attemptId,
        merged.invocationOrdinal,
        merged.sessionId,
      ) as NodeRow;
      return {
        ok: true,
        nodeId: row.id,
        inserted: existing === undefined,
        state: merged.lastState,
        transitioned,
        generation,
      };
    })();
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

/**
 * Record a cancellation request separately from any terminal outcome. It only
 * flags a known node and never writes a terminal `interrupted` result; the
 * runtime must still confirm interruption through a later observation.
 */
export function recordDelegationCancellationRequest(
  db: Database.Database,
  input: unknown,
): DelegationWriteResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      reason: "validation",
      message: "cancellation request must be an object",
      issues: [{ path: "cancellation", message: "must be an object" }],
    };
  }
  const issues: DelegationObservationIssue[] = [];
  const attemptId = readPositiveInteger(input.attemptId, "attemptId", issues);
  const invocationOrdinal = readPositiveInteger(
    input.invocationOrdinal,
    "invocationOrdinal",
    issues,
  );
  const sessionId = readSessionToken(input.sessionId, "sessionId", issues, { required: true });
  const at = readOptionalTimestamp(input.at, "at", issues, { required: true });
  if (issues.length > 0) {
    return {
      ok: false,
      reason: "validation",
      message: "invalid cancellation request",
      issues,
    };
  }
  try {
    return db.transaction((): DelegationWriteResult => {
      const existing = readNodeRow(
        db,
        attemptId as number,
        invocationOrdinal as number,
        sessionId as string,
      );
      if (existing === undefined) {
        return {
          ok: false,
          reason: "not-found",
          message: `no observation node for ${String(attemptId)}/${String(invocationOrdinal)}/${String(sessionId)}`,
        };
      }
      if (existing.cancellation_requested === 0) {
        db.prepare(
          `UPDATE delegation_observation_nodes
           SET cancellation_requested = 1, cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
               updated_at = ?
           WHERE id = ?`,
        ).run(at, at, existing.id);
        // A cancellation request is a transition of its own; it does not
        // change the projected state and never writes a terminal outcome.
        db.prepare(
          `INSERT INTO delegation_observation_transitions
             (attempt_id, invocation_ordinal, session_id, at, state, outcome, active, cancellation_requested)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(
          existing.attempt_id,
          existing.invocation_ordinal,
          existing.session_id,
          at,
          existing.last_state,
          existing.last_outcome,
          existing.last_active,
        );
        if (
          trimNodeTransitions(
            db,
            existing.attempt_id,
            existing.invocation_ordinal,
            existing.session_id,
          )
        ) {
          db.prepare(
            "UPDATE delegation_observation_nodes SET history_partial = 1 WHERE id = ?",
          ).run(existing.id);
        }
        if (trimInvocationTransitions(db, existing.attempt_id, existing.invocation_ordinal)) {
          db.prepare(
            `UPDATE delegation_invocation_coverage SET history_partial = 1, updated_at = ?
             WHERE attempt_id = ? AND invocation_ordinal = ?`,
          ).run(at, existing.attempt_id, existing.invocation_ordinal);
        }
      }
      return { ok: true };
    })();
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

/**
 * Upsert one invocation's coverage/transport/freshness record. Used when the
 * observer has a coverage fact (source lost, event disconnect, partial round)
 * that is not tied to a single node. Omitted fields keep their stored value.
 */
export function recordDelegationCoverage(
  db: Database.Database,
  input: unknown,
): DelegationWriteResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      reason: "validation",
      message: "coverage must be an object",
      issues: [{ path: "coverage", message: "must be an object" }],
    };
  }
  const issues: DelegationObservationIssue[] = [];
  const attemptId = readPositiveInteger(input.attemptId, "attemptId", issues);
  const invocationOrdinal = readPositiveInteger(
    input.invocationOrdinal,
    "invocationOrdinal",
    issues,
  );
  const at = readOptionalTimestamp(input.at, "at", issues, { required: true });
  let transport: DelegationTransport | undefined;
  if (input.transport !== undefined) {
    if (
      typeof input.transport === "string" &&
      (DELEGATION_TRANSPORTS as readonly string[]).includes(input.transport)
    ) {
      transport = input.transport as DelegationTransport;
    } else {
      issues.push({
        path: "transport",
        message: `must be one of ${DELEGATION_TRANSPORTS.join(", ")}`,
      });
    }
  }
  let transportState: DelegationTransportState | undefined;
  if (input.transportState !== undefined) {
    if (
      typeof input.transportState === "string" &&
      (DELEGATION_TRANSPORT_STATES as readonly string[]).includes(input.transportState)
    ) {
      transportState = input.transportState as DelegationTransportState;
    } else {
      issues.push({
        path: "transportState",
        message: `must be one of ${DELEGATION_TRANSPORT_STATES.join(", ")}`,
      });
    }
  }
  const lastSuccessAt = readOptionalTimestamp(input.lastSuccessAt, "lastSuccessAt", issues);
  const lastAttemptAt = readOptionalTimestamp(input.lastAttemptAt, "lastAttemptAt", issues);
  let truncated: boolean | undefined;
  if (input.truncated !== undefined) {
    if (typeof input.truncated === "boolean") truncated = input.truncated;
    else issues.push({ path: "truncated", message: "must be a boolean" });
  }
  let nodeLimitReached: boolean | undefined;
  if (input.nodeLimitReached !== undefined) {
    if (typeof input.nodeLimitReached === "boolean") nodeLimitReached = input.nodeLimitReached;
    else issues.push({ path: "nodeLimitReached", message: "must be a boolean" });
  }
  if (issues.length > 0) {
    return { ok: false, reason: "validation", message: "invalid coverage input", issues };
  }
  try {
    return db.transaction((): DelegationWriteResult => {
      const existing = readCoverageRow(db, attemptId as number, invocationOrdinal as number);
      const generation = (existing?.generation ?? 0) + 1;
      db.prepare(
        `INSERT INTO delegation_invocation_coverage (
           attempt_id, invocation_ordinal, generation, transport, transport_state,
           last_success_at, last_attempt_at, gap_count, truncated, history_partial,
           node_limit_reached, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id, invocation_ordinal) DO UPDATE SET
           generation = excluded.generation,
           transport = excluded.transport,
           transport_state = excluded.transport_state,
           last_success_at = excluded.last_success_at,
           last_attempt_at = excluded.last_attempt_at,
           gap_count = excluded.gap_count,
           truncated = excluded.truncated,
           history_partial = excluded.history_partial,
           node_limit_reached = excluded.node_limit_reached,
           updated_at = excluded.updated_at`,
      ).run(
        attemptId as number,
        invocationOrdinal as number,
        generation,
        transport ?? existing?.transport ?? "unknown",
        transportState ?? existing?.transport_state ?? "unknown",
        lastSuccessAt ?? existing?.last_success_at ?? null,
        lastAttemptAt ?? at ?? existing?.last_attempt_at ?? null,
        existing?.gap_count ?? 0,
        truncated === true ? 1 : truncated === false ? 0 : (existing?.truncated ?? 0),
        existing?.history_partial ?? 0,
        nodeLimitReached === true
          ? 1
          : nodeLimitReached === false
            ? 0
            : (existing?.node_limit_reached ?? 0),
        (at as string) ?? existing?.updated_at ?? new Date().toISOString(),
      );
      return { ok: true };
    })();
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

/* ------------------------------------------------------------------ *
 * Explicit gaps
 * ------------------------------------------------------------------ */

const GAP_INPUT_FIELDS = new Set(["attemptId", "invocationOrdinal", "signature", "detail", "at"]);

/**
 * Open (or refresh) one explicit observation gap. A gap already open with the
 * same signature is refreshed in place; a closed one is left as history and a
 * new row opens. Gaps are bounded per invocation, trimming the oldest closed
 * rows first so the note survives while memory stays bounded.
 */
export function reportDelegationGap(db: Database.Database, input: unknown): DelegationWriteResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      reason: "validation",
      message: "gap must be an object",
      issues: [{ path: "gap", message: "must be an object" }],
    };
  }
  const issues: DelegationObservationIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!GAP_INPUT_FIELDS.has(key)) issues.push({ path: key, message: `unknown field "${key}"` });
  }
  const attemptId = readPositiveInteger(input.attemptId, "attemptId", issues);
  const invocationOrdinal = readPositiveInteger(
    input.invocationOrdinal,
    "invocationOrdinal",
    issues,
  );
  const signature = readGapSignature(input.signature, "signature", issues);
  const detail = readGapDetail(input.detail, "detail", issues);
  const at = readOptionalTimestamp(input.at, "at", issues, { required: true });
  if (issues.length > 0) {
    return { ok: false, reason: "validation", message: "invalid gap input", issues };
  }
  try {
    return db.transaction((): DelegationWriteResult => {
      const open = db
        .prepare(
          `SELECT id FROM delegation_observation_gaps
           WHERE attempt_id = ? AND invocation_ordinal = ? AND signature = ? AND closed_at IS NULL`,
        )
        .get(attemptId as number, invocationOrdinal as number, signature as string) as
        { id: number } | undefined;
      if (open !== undefined) {
        db.prepare("UPDATE delegation_observation_gaps SET detail = ? WHERE id = ?").run(
          detail as string,
          open.id,
        );
      } else {
        db.prepare(
          `INSERT INTO delegation_observation_gaps
             (attempt_id, invocation_ordinal, signature, detail, opened_at, closed_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        ).run(
          attemptId as number,
          invocationOrdinal as number,
          signature as string,
          detail as string,
          at as string,
        );
      }
      db.prepare(
        `DELETE FROM delegation_observation_gaps
         WHERE attempt_id = ? AND invocation_ordinal = ?
           AND id NOT IN (
             SELECT id FROM delegation_observation_gaps
             WHERE attempt_id = ? AND invocation_ordinal = ?
             ORDER BY (closed_at IS NULL) DESC, id DESC LIMIT ?
           )`,
      ).run(
        attemptId as number,
        invocationOrdinal as number,
        attemptId as number,
        invocationOrdinal as number,
        DELEGATION_GAPS_PER_INVOCATION_CAP,
      );
      refreshGapCount(db, attemptId as number, invocationOrdinal as number, at as string);
      return { ok: true };
    })();
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

/** Close every open gap for one invocation after a successful reconciliation. */
export function reconcileDelegationGaps(
  db: Database.Database,
  input: unknown,
): DelegationWriteResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      reason: "validation",
      message: "reconciliation must be an object",
      issues: [{ path: "reconciliation", message: "must be an object" }],
    };
  }
  const issues: DelegationObservationIssue[] = [];
  const attemptId = readPositiveInteger(input.attemptId, "attemptId", issues);
  const invocationOrdinal = readPositiveInteger(
    input.invocationOrdinal,
    "invocationOrdinal",
    issues,
  );
  const at = readOptionalTimestamp(input.at, "at", issues, { required: true });
  if (issues.length > 0) {
    return { ok: false, reason: "validation", message: "invalid reconciliation input", issues };
  }
  try {
    return db.transaction((): DelegationWriteResult => {
      db.prepare(
        `UPDATE delegation_observation_gaps SET closed_at = ?
         WHERE attempt_id = ? AND invocation_ordinal = ? AND closed_at IS NULL`,
      ).run(at as string, attemptId as number, invocationOrdinal as number);
      refreshGapCount(db, attemptId as number, invocationOrdinal as number, at as string);
      return { ok: true };
    })();
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

function refreshGapCount(
  db: Database.Database,
  attemptId: number,
  invocationOrdinal: number,
  at: string,
): void {
  const open = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM delegation_observation_gaps
         WHERE attempt_id = ? AND invocation_ordinal = ? AND closed_at IS NULL`,
      )
      .get(attemptId, invocationOrdinal) as { n: number }
  ).n;
  db.prepare(
    `UPDATE delegation_invocation_coverage
     SET gap_count = ?, updated_at = ?
     WHERE attempt_id = ? AND invocation_ordinal = ?`,
  ).run(open, at, attemptId, invocationOrdinal);
}

/* ------------------------------------------------------------------ *
 * Legacy import
 * ------------------------------------------------------------------ */

interface LegacyChildRow {
  session_id: string;
  outcome: string | null;
  state: string;
  interrupted: number;
}

/**
 * Import attributable legacy managed child records as explicitly limited
 * evidence (task 2.2). A legacy child has no invocation ordinal, root edge,
 * timestamp or identity, so it is only imported when the attempt's root
 * attribution is unambiguous: exactly one journaled invocation and that
 * invocation carries a captured parent session. Otherwise the attempt is
 * skipped rather than attaching a fabricated root. Imported nodes keep NULL
 * first/last observation, NULL immediate parent edge and `limited_uncertainty`
 * so nothing is shown as live; a settled terminal outcome is preserved.
 * Idempotent: an existing richer node is never overwritten.
 */
export function importLegacyManagedChildObservations(
  db: Database.Database,
  options: { attemptId?: number; at?: string } = {},
): ImportLegacyResult {
  const at = options.at ?? new Date().toISOString();
  try {
    return db.transaction((): ImportLegacyResult => {
      const attempts =
        options.attemptId === undefined
          ? (db
              .prepare(
                `SELECT DISTINCT attempt_id AS id FROM managed_child_sessions ORDER BY attempt_id`,
              )
              .all() as { id: number }[])
          : [{ id: options.attemptId }];
      let imported = 0;
      let skippedAmbiguous = 0;
      let skippedInvalid = 0;
      let capped = false;
      const insertNode = db.prepare(
        `INSERT OR IGNORE INTO delegation_observation_nodes (
           attempt_id, invocation_ordinal, session_id, root_session_id, parent_session_id,
           depth, source_kind, evidence_presence, actual_agent, actual_model,
           source_created_at, source_updated_at, source_idle_at, first_observed_at,
           last_observed_at, last_state, last_outcome, last_active, last_known_active,
           current_outcome, outcome_conflict, cancellation_requested, cancellation_requested_at,
           observation_generation, history_partial, limited_uncertainty, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, NULL, 'legacy-managed', 'observed', NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, NULL, 0, 0, 1, ?, ?)`,
      );
      const insertCoverage = db.prepare(
        `INSERT OR IGNORE INTO delegation_invocation_coverage (
           attempt_id, invocation_ordinal, generation, transport, transport_state,
           last_success_at, last_attempt_at, gap_count, truncated, history_partial,
           node_limit_reached, updated_at
         ) VALUES (?, ?, 0, 'legacy-managed', 'unknown', NULL, NULL, 0, 0, 0, 0, ?)`,
      );
      const markCoveragePartial = db.prepare(
        `UPDATE delegation_invocation_coverage
         SET truncated = 1, node_limit_reached = ?, updated_at = ?
         WHERE attempt_id = ? AND invocation_ordinal = ?`,
      );
      for (const attempt of attempts) {
        const invocations = db
          .prepare(
            `SELECT invocation_ordinal, parent_session_id FROM opencode_invocations
             WHERE attempt_id = ? ORDER BY invocation_ordinal`,
          )
          .all(attempt.id) as { invocation_ordinal: number; parent_session_id: string | null }[];
        const onlyInvocation = invocations.length === 1 ? invocations[0] : undefined;
        if (onlyInvocation === undefined || onlyInvocation.parent_session_id === null) {
          skippedAmbiguous += 1;
          continue;
        }
        const root = sessionToken(onlyInvocation.parent_session_id);
        if (root === null) {
          // An unusable root ref stays missing rather than being invented.
          skippedInvalid += 1;
          continue;
        }
        const ordinal = onlyInvocation.invocation_ordinal;
        const children = db
          .prepare(
            `SELECT session_id, outcome, state, interrupted FROM managed_child_sessions
             WHERE attempt_id = ? ORDER BY id`,
          )
          .all(attempt.id) as LegacyChildRow[];
        let partial = false;
        let considered = countNodesForInvocation(db, attempt.id, ordinal);
        let invocationCapped = false;
        for (const child of children) {
          const childToken = sessionToken(child.session_id);
          const stateOk =
            child.state === "settled" || child.state === "unsettled" || child.state === "unknown";
          const outcomeRecognized =
            child.outcome === null ||
            (DELEGATION_TERMINAL_OUTCOMES as readonly string[]).includes(child.outcome);
          if (childToken === null || !stateOk || !outcomeRecognized) {
            // A malformed legacy ref, state or outcome stays unavailable: it is
            // skipped and the coverage is marked partial rather than leaking or
            // failing the whole import.
            skippedInvalid += 1;
            partial = true;
            continue;
          }
          if (readNodeRow(db, attempt.id, ordinal, childToken) !== undefined) continue;
          if (considered >= DELEGATION_NODES_PER_INVOCATION_CAP) {
            // Nodes past the per-invocation cap are validated but not stored;
            // the coverage is marked partial instead of presenting a truncated
            // tree as complete. Invalid refs are still counted and skipped.
            capped = true;
            invocationCapped = true;
            partial = true;
            continue;
          }
          considered += 1;
          const outcomeValid =
            child.outcome !== null &&
            (DELEGATION_TERMINAL_OUTCOMES as readonly string[]).includes(child.outcome);
          const terminal = child.state === "settled" && outcomeValid;
          const validOutcome = terminal ? (child.outcome as DelegationTerminalOutcome) : null;
          const result = insertNode.run(
            attempt.id,
            ordinal,
            childToken,
            root,
            terminal ? validOutcome : "unknown",
            validOutcome,
            terminal ? 0 : null,
            terminal ? 0 : null,
            validOutcome,
            0,
            at,
            at,
          );
          if (result.changes > 0) imported += 1;
        }
        insertCoverage.run(attempt.id, ordinal, at);
        if (partial) markCoveragePartial.run(invocationCapped ? 1 : 0, at, attempt.id, ordinal);
      }
      return {
        ok: true,
        imported,
        attemptsConsidered: attempts.length,
        skippedAmbiguous,
        skippedInvalid,
        capped,
      };
    })();
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

/* ------------------------------------------------------------------ *
 * Restart handling
 * ------------------------------------------------------------------ */

/**
 * Mark unresolved live observations unknown on daemon restart (task 2.4). Any
 * observed node with no terminal outcome loses its active assertion and reads
 * `unknown` until a fresh reconciliation confirms it, so an interrupted daemon
 * never leaves a stale node labeled running. Terminal historic evidence is
 * preserved, and the coverage generation is bumped so the console refreshes.
 */
export function markDelegationObservationsUnknownOnRestart(
  db: Database.Database,
  options: { at?: string } = {},
): { ok: true; marked: number } | { ok: false; reason: "storage"; message: string } {
  const at = options.at ?? new Date().toISOString();
  try {
    return db.transaction(
      (): { ok: true; marked: number } | { ok: false; reason: "storage"; message: string } => {
        const unresolved = db
          .prepare(
            `SELECT DISTINCT attempt_id, invocation_ordinal FROM delegation_observation_nodes
           WHERE last_outcome IS NULL AND evidence_presence = 'observed'`,
          )
          .all() as Array<{ attempt_id: number; invocation_ordinal: number }>;
        const marked = db
          .prepare(
            `UPDATE delegation_observation_nodes
            SET last_state = 'unknown', last_active = NULL, evidence_presence = 'missing', updated_at = ?
           WHERE last_outcome IS NULL
             AND evidence_presence = 'observed'
             AND (last_active IS NOT NULL OR last_state != 'unknown')`,
          )
          .run(at).changes;
        db.prepare(
          `UPDATE delegation_invocation_coverage
         SET generation = generation + 1, updated_at = ?`,
        ).run(at);
        for (const row of unresolved) {
          recordDelegationCoverage(db, {
            attemptId: row.attempt_id,
            invocationOrdinal: row.invocation_ordinal,
            at,
            transportState: "degraded",
          });
          reportDelegationGap(db, {
            attemptId: row.attempt_id,
            invocationOrdinal: row.invocation_ordinal,
            signature: "daemon-restart",
            detail: "Observation paused across daemon restart.",
            at,
          });
        }
        return { ok: true, marked };
      },
    )();
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

/* ------------------------------------------------------------------ *
 * Batched reads
 * ------------------------------------------------------------------ */

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Batched read of nodes, coverage and gaps for one set of attempts, so the
 * console never issues a per-row session query. Pure string data; no raw
 * runtime payload is stored to return.
 */
export function readDelegationObservations(
  db: Database.Database,
  attemptIds: readonly number[],
): Map<number, DelegationAttemptObservations> {
  const result = new Map<number, DelegationAttemptObservations>();
  for (const attemptId of attemptIds) {
    result.set(attemptId, { attemptId, nodes: [], coverage: [], gaps: [] });
  }
  if (attemptIds.length === 0) return result;
  const list = placeholders(attemptIds.length);

  const nodeRows = db
    .prepare(
      `SELECT ${NODE_COLUMNS} FROM delegation_observation_nodes
       WHERE attempt_id IN (${list})
       ORDER BY attempt_id, invocation_ordinal, id`,
    )
    .all(...attemptIds) as NodeRow[];
  for (const row of nodeRows) {
    const bucket = result.get(row.attempt_id);
    if (bucket !== undefined) bucket.nodes.push(mapNodeRow(row));
  }

  const coverageRows = db
    .prepare(
      `SELECT attempt_id, invocation_ordinal, generation, transport, transport_state,
              last_success_at, last_attempt_at, gap_count, truncated, history_partial,
              node_limit_reached, updated_at
       FROM delegation_invocation_coverage
       WHERE attempt_id IN (${list})
       ORDER BY attempt_id, invocation_ordinal`,
    )
    .all(...attemptIds) as CoverageRow[];
  for (const row of coverageRows) {
    const bucket = result.get(row.attempt_id);
    if (bucket !== undefined) bucket.coverage.push(mapCoverageRow(row));
  }

  const gapRows = db
    .prepare(
      `SELECT id, attempt_id, invocation_ordinal, signature, detail, opened_at, closed_at
       FROM delegation_observation_gaps
       WHERE attempt_id IN (${list})
       ORDER BY attempt_id, invocation_ordinal, id`,
    )
    .all(...attemptIds) as GapRow[];
  for (const row of gapRows) {
    const bucket = result.get(row.attempt_id);
    if (bucket !== undefined) bucket.gaps.push(mapGapRow(row));
  }

  return result;
}

/** Failure-isolated batched read for callers that must continue on error. */
export function safeReadDelegationObservations(
  db: Database.Database,
  attemptIds: readonly number[],
):
  | { ok: true; value: Map<number, DelegationAttemptObservations> }
  | { ok: false; reason: "storage"; message: string } {
  try {
    return { ok: true, value: readDelegationObservations(db, attemptIds) };
  } catch (error) {
    return { ok: false, reason: "storage", message: messageOf(error) };
  }
}

/** Read a node's bounded transition history in chronological order. */
export function readDelegationTransitions(
  db: Database.Database,
  input: { attemptId: number; invocationOrdinal: number; sessionId?: string; limit?: number },
): Array<{
  id: number;
  attemptId: number;
  invocationOrdinal: number;
  sessionId: string;
  at: string;
  state: DelegationProjectedState;
  outcome: DelegationTerminalOutcome | null;
  active: boolean | null;
  cancellationRequested: boolean;
}> {
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? DELEGATION_TRANSITIONS_PER_NODE_CAP)),
    DELEGATION_TRANSITIONS_PER_NODE_CAP,
  );
  const filter = input.sessionId === undefined ? "" : " AND session_id = ?";
  const params: Array<number | string> = [input.attemptId, input.invocationOrdinal];
  if (input.sessionId !== undefined) params.push(input.sessionId);
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT id, attempt_id, invocation_ordinal, session_id, at, state, outcome, active,
                cancellation_requested
         FROM delegation_observation_transitions
         WHERE attempt_id = ? AND invocation_ordinal = ?${filter}
         ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(...params) as Array<{
    id: number;
    attempt_id: number;
    invocation_ordinal: number;
    session_id: string;
    at: string;
    state: string;
    outcome: string | null;
    active: number | null;
    cancellation_requested: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    attemptId: row.attempt_id,
    invocationOrdinal: row.invocation_ordinal,
    sessionId: row.session_id,
    at: row.at,
    state: row.state as DelegationProjectedState,
    outcome: row.outcome as DelegationTerminalOutcome | null,
    active: row.active === null ? null : row.active === 1,
    cancellationRequested: row.cancellation_requested === 1,
  }));
}

/* ------------------------------------------------------------------ *
 * Console signature + report
 * ------------------------------------------------------------------ */

/**
 * Compact change signature over the observation tables for a set of attempts,
 * suitable for extending the shared console ticker without rescanning whole
 * histories. No attempt filter returns a global signature.
 */
export function delegationObservationSignature(
  db: Database.Database,
  attemptIds: readonly number[],
): string {
  try {
    if (attemptIds.length === 0) return "no-attempts";
    const list = placeholders(attemptIds.length);
    const row = db
      .prepare(
        `SELECT
           (SELECT COALESCE(MAX(id), 0) FROM delegation_observation_nodes
              WHERE attempt_id IN (${list})) AS node_max_id,
           (SELECT COALESCE(MAX(id), 0) FROM delegation_observation_transitions
              WHERE attempt_id IN (${list})) AS transition_max_id,
           (SELECT COALESCE(SUM(generation), 0) FROM delegation_invocation_coverage
              WHERE attempt_id IN (${list})) AS generation_sum,
           (SELECT COALESCE(MAX(updated_at), '') FROM delegation_observation_nodes
              WHERE attempt_id IN (${list})) AS node_updated_at,
           (SELECT COALESCE(COUNT(*), 0) FROM delegation_observation_gaps
              WHERE attempt_id IN (${list}) AND closed_at IS NULL) AS open_gaps`,
      )
      .get(...attemptIds, ...attemptIds, ...attemptIds, ...attemptIds, ...attemptIds) as Record<
      string,
      unknown
    >;
    return JSON.stringify(row);
  } catch {
    return "closed";
  }
}

export interface DelegationObservationReport {
  attemptId: number;
  total: number;
  invoked: number;
  running: number;
  idle: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  unknown: number;
  cancellationRequested: number;
  /** `none` until a coverage record exists; never means "no delegations". */
  coverage: "known" | "partial" | "unavailable" | "none";
  transport: DelegationTransport | null;
  truncated: boolean;
  historyPartial: boolean;
}

/**
 * Project one attempt's batched observations into a truthful summary. Counts
 * are labeled observed by the caller when coverage is partial; `unknown` is
 * never folded into completed, and a cancellation request is never a terminal
 * outcome.
 */
export function reportDelegationObservations(
  observations: DelegationAttemptObservations,
  options: { now: Date | number | string; staleAfterMs?: number },
): DelegationObservationReport {
  const report: DelegationObservationReport = {
    attemptId: observations.attemptId,
    total: observations.nodes.length,
    invoked: 0,
    running: 0,
    idle: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    unknown: 0,
    cancellationRequested: 0,
    coverage: observations.coverage.length === 0 ? "none" : "known",
    transport: observations.coverage[0]?.transport ?? null,
    truncated: observations.coverage.some((row) => row.truncated || row.nodeLimitReached),
    historyPartial: observations.coverage.some((row) => row.historyPartial),
  };
  for (const node of observations.nodes) {
    if (node.cancellationRequested) report.cancellationRequested += 1;
    const state = projectDelegationState(node, options);
    report[state] += 1;
  }
  const degraded = observations.coverage.some(
    (row) =>
      row.transportState === "unavailable" ||
      row.transportState === "degraded" ||
      row.historyPartial,
  );
  const openGaps = observations.gaps.some((gap) => gap.closedAt === null);
  if (observations.coverage.length === 0) report.coverage = "none";
  else if (observations.coverage.some((row) => row.transportState === "unavailable")) {
    report.coverage = "unavailable";
  } else if (report.truncated || degraded || openGaps) report.coverage = "partial";
  else report.coverage = "known";
  return report;
}
