/**
 * Generic OpenCode attempt ownership journal (task 3.3 journal side; design D4;
 * capability `opencode-agent-selection` / `job-orchestration`).
 *
 * The managed-profile manifest (`managed-opencode-files.json`) records what
 * generated files an attempt materialized. That is enough for cleanup, but it
 * is NOT ownership: a native or default OpenCode attempt materializes no
 * generated files at all, yet it still launches a service-owned parent session
 * whose background/nested children can outlive the parent process and keep
 * writing to the workspace. The ownership journal is the attempt-scoped record
 * that exists for EVERY OpenCode launch — managed, native, or default — so
 * startup recovery can prove the whole invocation tree stopped before the
 * workspace is reused or published.
 *
 * ## Where it lives
 *
 * The journal is written to `opencode-ownership.json` inside the attempt's data
 * directory, which is ALWAYS outside the prepared workspace. The module refuses
 * to write a journal whose descriptor workspace contains the journal path, so a
 * workspace reset or publication can never destroy or discover it.
 *
 * ## What it records (and what it must not)
 *
 * Per invocation, a deliberately minimal descriptor:
 *
 * - the resolved executor kind, binary and pinned version (the exact worker
 *   context the launch used, matching design D3's shared descriptor; the
 *   attempt row separately retains the configured alias);
 * - the absolute attempt workspace; and
 * - the captured primary source (`default` / `native` / `managed`) and the
 *   native agent id when applicable.
 *
 * Plus the launch/ownership facts the runtime learns later:
 *
 * - the invocation ordinal (a failed invocation relaunched after quiescence is
 *   a NEW ordinal, so the first invocation's evidence is never overwritten);
 * - the "launched uncertainty" written BEFORE the process is spawned, so a
 *   crash between journaling and spawn still leaves evidence that the launch
 *   may have happened (recovery conservatively treats it as possibly live);
 * - the attributed parent session id and the actual initial primary identity,
 *   captured as early as the run stream exposes them; and
 * - the settled flag once quiescence has been proven for that invocation.
 *
 * The journal NEVER carries prompts, instruction text, credentials, environment
 * values, or any other secret. Its inputs accept none of those, and the strict
 * parser rejects unknown/extra data.
 *
 * ## Durability contract
 *
 * Every write is atomic (unique staged temp file at mode 0600, then rename) and
 * strictly validated before and after. `begin`, `record`, and `settle` return
 * the updated journal as a fresh immutable value; callers that must not launch
 * an unjournaled process treat a write failure as fatal to that launch.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/** Journal file name inside an attempt's data directory. */
export const OPENCODE_OWNERSHIP_RECORD_FILE = "opencode-ownership.json";

/** The journal format version emitted and accepted by this module. */
export const OPENCODE_OWNERSHIP_VERSION = 1;

/** The executor kind that denotes an OpenCode launch. */
export const OPENCODE_EXECUTOR_KIND = "opencode";

/** The captured primary source policy for one invocation (design D1/D2). */
export type OpenCodePrimarySource = "default" | "native" | "managed";

/**
 * A launch that may have occurred but whose process/session attribution is not
 * yet known. `pending` is journaled BEFORE the spawn; any later observation
 * upgrades the same invocation to `launched`.
 */
export type OpenCodeLaunchState = "pending" | "launched" | "not-started";

/**
 * The exact worker context a launch used. This is intentionally tiny and
 * secret-free: identifiers and locations only.
 */
export interface OpenCodeOwnershipDescriptor {
  /** The resolved executor kind (for example, `opencode`) used by recovery. */
  readonly executor: string;
  /** The resolved binary (command or absolute path) used for the launch. */
  readonly binary: string;
  /** The pinned OpenCode version the binary was expected to be. */
  readonly version: string;
  /** The absolute prepared attempt workspace. */
  readonly workspacePath: string;
  /** The captured primary source policy. */
  readonly source: OpenCodePrimarySource;
  /** The native agent id when `source === "native"`; otherwise `null`. */
  readonly nativeId: string | null;
}

/** One parent invocation of an attempt. */
export interface OpenCodeOwnershipInvocation {
  /** 1-based, strictly increasing across the attempt's invocations. */
  readonly ordinal: number;
  /** `pending` is the pre-launch uncertainty; `launched` after the spawn. */
  readonly launchState: OpenCodeLaunchState;
  readonly descriptor: OpenCodeOwnershipDescriptor;
  /** ISO-8601 moment the launch uncertainty was first journaled. */
  readonly startedAt: string;
  /** Attributed parent session id once the run stream exposes it. */
  readonly parentSessionId: string | null;
  /** Actual initial primary identity once observed (never a fabricated value). */
  readonly observedPrimaryId: string | null;
  /** True once this invocation's tree is proven quiescent. */
  readonly settled: boolean;
  /** ISO-8601 settlement moment, or `null` while unsettled. */
  readonly settledAt: string | null;
}

/** The whole durable ownership journal for one attempt. */
export interface OpenCodeOwnershipJournal {
  readonly version: typeof OPENCODE_OWNERSHIP_VERSION;
  readonly attemptId: number;
  readonly invocations: readonly OpenCodeOwnershipInvocation[];
  /** ISO-8601 moment of the most recent write. */
  readonly updatedAt: string;
}

/**
 * Raised when the ownership journal cannot be validated or durably written.
 * A caller about to launch MUST treat this as fatal to the launch: an
 * unjournaled OpenCode invocation has no recoverable ownership evidence.
 */
export class OpenCodeOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeOwnershipError";
  }
}

/* ------------------------------------------------------------------ *
 * Limits and primitive guards
 * ------------------------------------------------------------------ */

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MAX_INVOCATIONS = 64;
const MAX_STRING_LENGTH = 8_192;

/** A control character (including NUL and newlines) is never a valid token. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeToken(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !hasControlCharacters(value)
  );
}

/** A bounded, non-empty string that may contain spaces/newlines (timestamps). */
function isSafeText(value: unknown, maxLength = MAX_STRING_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** A bounded absolute path with no control characters. */
function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    isAbsolute(value) &&
    !hasControlCharacters(value)
  );
}

/**
 * A native agent id: bounded, non-empty, control-free and not argument-like
 * (design D3 rejects a leading `-` so a value can never be read as a flag).
 */
function isSafeNativeId(value: unknown): value is string {
  return isSafeToken(value) && !value.startsWith("-");
}

/** A recorded session/identity id: bounded, control-free, not argument-like. */
function isSafeRecordedId(value: unknown): value is string {
  return isSafeToken(value) && !value.startsWith("-");
}

function sameResolvedPath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `candidate` resolves to `root` or strictly beneath it. */
function isAtOrBeneath(candidate: string, root: string): boolean {
  const target = resolve(candidate);
  const base = resolve(root);
  if (sameResolvedPath(target, base)) return true;
  if (process.platform === "win32") {
    return target.toLowerCase().startsWith(base.toLowerCase() + sep);
  }
  return target.startsWith(base + sep);
}

/* ------------------------------------------------------------------ *
 * Path
 * ------------------------------------------------------------------ */

/** The conventional journal path inside an attempt's data directory. */
export function opencodeOwnershipPath(attemptDataDir: string): string {
  return `${attemptDataDir}${sep}${OPENCODE_OWNERSHIP_RECORD_FILE}`;
}

/* ------------------------------------------------------------------ *
 * Validation — strict, shared by read and write
 * ------------------------------------------------------------------ */

function invalid(detail: string): never {
  throw new OpenCodeOwnershipError(`invalid OpenCode ownership journal: ${detail}`);
}

function validateDescriptor(value: unknown, label: string): OpenCodeOwnershipDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label}.descriptor is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (!isSafeToken(record.executor)) invalid(`${label}.descriptor.executor is invalid`);
  if (!isSafeToken(record.binary, MAX_PATH_LENGTH))
    invalid(`${label}.descriptor.binary is invalid`);
  if (!isSafeToken(record.version)) invalid(`${label}.descriptor.version is invalid`);
  if (!isSafeAbsolutePath(record.workspacePath)) {
    invalid(`${label}.descriptor.workspacePath must be an absolute path`);
  }
  const source = record.source;
  if (source !== "default" && source !== "native" && source !== "managed") {
    invalid(`${label}.descriptor.source is invalid`);
  }
  const nativeId = record.nativeId;
  if (source === "native") {
    if (!isSafeNativeId(nativeId))
      invalid(`${label}.descriptor.nativeId is invalid for native source`);
  } else if (nativeId !== null) {
    invalid(`${label}.descriptor.nativeId must be null for ${source} source`);
  }
  return {
    executor: record.executor,
    binary: record.binary,
    version: record.version,
    workspacePath: record.workspacePath,
    source,
    nativeId: source === "native" ? (nativeId as string) : null,
  };
}

function validateInvocation(value: unknown, label: string): OpenCodeOwnershipInvocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.ordinal) || (record.ordinal as number) < 1) {
    invalid(`${label}.ordinal is invalid`);
  }
  const launchState = record.launchState;
  if (launchState !== "pending" && launchState !== "launched" && launchState !== "not-started") {
    invalid(`${label}.launchState is invalid`);
  }
  const descriptor = validateDescriptor(record.descriptor, label);
  if (!isSafeText(record.startedAt)) invalid(`${label}.startedAt is invalid`);
  const parentSessionId = record.parentSessionId;
  if (parentSessionId !== null && !isSafeRecordedId(parentSessionId)) {
    invalid(`${label}.parentSessionId is invalid`);
  }
  if (launchState === "pending" && parentSessionId !== null) {
    invalid(`${label} is pending but already names a parent session`);
  }
  const observedPrimaryId = record.observedPrimaryId;
  if (observedPrimaryId !== null && !isSafeRecordedId(observedPrimaryId)) {
    invalid(`${label}.observedPrimaryId is invalid`);
  }
  if (typeof record.settled !== "boolean") invalid(`${label}.settled is invalid`);
  const settledAt = record.settledAt;
  if (record.settled) {
    if (!isSafeText(settledAt)) invalid(`${label}.settledAt is required once settled`);
  } else if (settledAt !== null) {
    invalid(`${label}.settledAt must be null while unsettled`);
  }
  if (
    launchState === "not-started" &&
    (!record.settled || parentSessionId !== null || observedPrimaryId !== null)
  ) {
    invalid(`${label} is not-started but has launch evidence or is unsettled`);
  }
  return {
    ordinal: record.ordinal as number,
    launchState,
    descriptor,
    startedAt: record.startedAt as string,
    parentSessionId: parentSessionId as string | null,
    observedPrimaryId: observedPrimaryId as string | null,
    settled: record.settled,
    settledAt: record.settled ? (settledAt as string) : null,
  };
}

/**
 * Strictly validate an unknown value as a journal. Throws
 * {@link OpenCodeOwnershipError} with the first structural fault. Every
 * invocation must name the same workspace, ordinals must be unique and strictly
 * increasing, and no extra fields are trusted.
 */
function validateJournal(value: unknown): OpenCodeOwnershipJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== OPENCODE_OWNERSHIP_VERSION) {
    invalid(`unsupported version ${JSON.stringify(record.version)}`);
  }
  if (!Number.isSafeInteger(record.attemptId) || (record.attemptId as number) < 1) {
    invalid("attemptId is invalid");
  }
  if (!Array.isArray(record.invocations)) invalid("invocations must be a list");
  if (record.invocations.length === 0) invalid("invocations must not be empty");
  if (record.invocations.length > MAX_INVOCATIONS) {
    invalid(`invocations exceeds the ${String(MAX_INVOCATIONS)}-invocation cap`);
  }
  if (!isSafeText(record.updatedAt)) invalid("updatedAt is invalid");

  const invocations = (record.invocations as unknown[]).map((entry, index) =>
    validateInvocation(entry, `invocations[${index}]`),
  );
  let prior = 0;
  let workspace: string | undefined;
  for (const [index, invocation] of invocations.entries()) {
    if (invocation.ordinal <= prior) {
      invalid(`invocations[${index}].ordinal ${String(invocation.ordinal)} is not increasing`);
    }
    prior = invocation.ordinal;
    if (workspace === undefined) {
      workspace = invocation.descriptor.workspacePath;
    } else if (!sameResolvedPath(workspace, invocation.descriptor.workspacePath)) {
      invalid(`invocations[${index}] names a different workspace than the first invocation`);
    }
  }
  return {
    version: OPENCODE_OWNERSHIP_VERSION,
    attemptId: record.attemptId as number,
    invocations,
    updatedAt: record.updatedAt as string,
  };
}

/* ------------------------------------------------------------------ *
 * Read / write
 * ------------------------------------------------------------------ */

/**
 * Read and strictly validate the ownership journal. `undefined` means the file
 * is absent or unusable; a present-but-unreadable journal is a quarantine state
 * for recovery (it is never silently ignored on the write path).
 */
export function readOpenCodeOwnership(
  attemptDataDir: string,
): OpenCodeOwnershipJournal | undefined {
  let raw: string;
  try {
    raw = readFileSync(opencodeOwnershipPath(attemptDataDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    return validateJournal(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Durably and atomically persist a validated journal. The input is fully
 * re-validated; a journal whose (single, consistent) workspace contains the
 * attempt data directory is refused so evidence can never sit inside a
 * workspace that a reset could discard. Returns the same immutable journal.
 * Every I/O failure throws {@link OpenCodeOwnershipError}.
 */
export function writeOpenCodeOwnership(
  attemptDataDir: string,
  journal: OpenCodeOwnershipJournal,
): OpenCodeOwnershipJournal {
  const validated = validateJournal(journal);
  for (const invocation of validated.invocations) {
    if (isAtOrBeneath(attemptDataDir, invocation.descriptor.workspacePath)) {
      throw new OpenCodeOwnershipError(
        `the ownership journal at ${opencodeOwnershipPath(attemptDataDir)} must live outside ` +
          `the workspace ${invocation.descriptor.workspacePath}`,
      );
    }
  }
  const path = opencodeOwnershipPath(attemptDataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const staged = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`;
    try {
      writeFileSync(staged, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      throw new OpenCodeOwnershipError(
        `cannot stage the ownership journal at ${staged}: ${errorMessage(error)}`,
      );
    }
    try {
      renameSync(staged, path);
    } catch (error) {
      try {
        rmSync(staged, { force: true });
      } catch {
        // Best-effort; the staged temp is inert if it survives.
      }
      throw new OpenCodeOwnershipError(
        `cannot install the ownership journal at ${path}: ${errorMessage(error)}`,
      );
    }
  } catch (error) {
    if (error instanceof OpenCodeOwnershipError) throw error;
    throw new OpenCodeOwnershipError(
      `cannot journal OpenCode ownership at ${path}: ${errorMessage(error)}`,
    );
  }
  return validated;
}

/* ------------------------------------------------------------------ *
 * Lifecycle API: begin / record / settle
 * ------------------------------------------------------------------ */

function readForUpdate(
  attemptDataDir: string,
  attemptId: number,
): OpenCodeOwnershipJournal | undefined {
  const path = opencodeOwnershipPath(attemptDataDir);
  if (!existsSync(path)) return undefined;
  const journal = readOpenCodeOwnership(attemptDataDir);
  if (journal === undefined) {
    throw new OpenCodeOwnershipError(
      `the existing ownership journal at ${path} is unreadable; refusing to overwrite it`,
    );
  }
  if (journal.attemptId !== attemptId) {
    throw new OpenCodeOwnershipError(
      `the ownership journal at ${path} belongs to attempt ${String(journal.attemptId)}, ` +
        `not attempt ${String(attemptId)}`,
    );
  }
  return journal;
}

export interface BeginOpenCodeInvocationInput {
  attemptDataDir: string;
  attemptId: number;
  descriptor: OpenCodeOwnershipDescriptor;
  /** Injectable ISO-8601 clock for deterministic tests. */
  now?: string;
}

/**
 * Journal a NEW invocation's launch uncertainty BEFORE the process is spawned.
 * Appends the next strictly-increasing ordinal to the existing journal (or
 * starts a new one) and returns the updated immutable journal. A write failure
 * throws and the caller must not launch.
 */
export function beginOpenCodeInvocation(
  input: BeginOpenCodeInvocationInput,
): OpenCodeOwnershipJournal {
  const existing = readForUpdate(input.attemptDataDir, input.attemptId);
  const ordinal = (existing?.invocations.at(-1)?.ordinal ?? 0) + 1;
  const invocation: OpenCodeOwnershipInvocation = {
    ordinal,
    launchState: "pending",
    descriptor: input.descriptor,
    startedAt: input.now ?? new Date().toISOString(),
    parentSessionId: null,
    observedPrimaryId: null,
    settled: false,
    settledAt: null,
  };
  const journal: OpenCodeOwnershipJournal = {
    version: OPENCODE_OWNERSHIP_VERSION,
    attemptId: input.attemptId,
    invocations: [...(existing?.invocations ?? []), invocation],
    updatedAt: invocation.startedAt,
  };
  return writeOpenCodeOwnership(input.attemptDataDir, journal);
}

export interface RecordOpenCodeInvocationInput {
  attemptDataDir: string;
  attemptId: number;
  ordinal: number;
  /** Attributed parent session id as soon as the run stream exposes it. */
  parentSessionId?: string | null;
  /** Actual initial primary identity, when separately observable. */
  observedPrimaryId?: string | null;
  /** Defaults to `launched`; pass `pending` only to correct a false launch. */
  launchState?: OpenCodeLaunchState;
  now?: string;
}

/**
 * Upgrade one invocation with the early parent/initial identity observed during
 * the stream. Returns the updated immutable journal, preserving the first
 * invocation's evidence and never touching a different ordinal's history.
 */
export function recordOpenCodeInvocation(
  input: RecordOpenCodeInvocationInput,
): OpenCodeOwnershipJournal {
  const existing = requireJournal(input.attemptDataDir, input.attemptId);
  const now = input.now ?? new Date().toISOString();
  const index = existing.invocations.findIndex((entry) => entry.ordinal === input.ordinal);
  if (index < 0) {
    throw new OpenCodeOwnershipError(
      `no invocation ordinal ${String(input.ordinal)} exists in the ownership journal for ` +
        `attempt ${String(input.attemptId)}`,
    );
  }
  const prior = existing.invocations[index]!;
  // Ownership identity is WRITE-ONCE: once a parent session id or observed
  // primary id has been recorded it can never be retargeted or cleared. A later
  // observation must agree exactly; otherwise the stored journal is left
  // untouched. The untrusted input value is never echoed in the error.
  if (
    input.parentSessionId !== undefined &&
    prior.parentSessionId !== null &&
    input.parentSessionId !== prior.parentSessionId
  ) {
    throw new OpenCodeOwnershipError(
      `invocation ${String(input.ordinal)} already has an immutable parent session id; ` +
        "refusing to retarget it",
    );
  }
  if (
    input.observedPrimaryId !== undefined &&
    prior.observedPrimaryId !== null &&
    input.observedPrimaryId !== prior.observedPrimaryId
  ) {
    throw new OpenCodeOwnershipError(
      `invocation ${String(input.ordinal)} already has an immutable observed primary id; ` +
        "refusing to retarget it",
    );
  }
  const launchState = input.launchState ?? "launched";
  const parentSessionId =
    input.parentSessionId === undefined ? prior.parentSessionId : input.parentSessionId;
  if (launchState === "pending" && parentSessionId !== null) {
    throw new OpenCodeOwnershipError(
      `invocation ${String(input.ordinal)} cannot be pending while naming a parent session`,
    );
  }
  const updated: OpenCodeOwnershipInvocation = {
    ...prior,
    launchState,
    parentSessionId,
    observedPrimaryId:
      input.observedPrimaryId === undefined ? prior.observedPrimaryId : input.observedPrimaryId,
  };
  const invocations = [...existing.invocations];
  invocations[index] = updated;
  return writeOpenCodeOwnership(input.attemptDataDir, {
    ...existing,
    invocations,
    updatedAt: now,
  });
}

export interface SettleOpenCodeInvocationInput {
  attemptDataDir: string;
  attemptId: number;
  ordinal: number;
  now?: string;
}

/**
 * Mark one invocation's tree quiescent. Returns the updated immutable journal.
 * Idempotent: settling an already-settled invocation leaves the original
 * settlement moment intact.
 */
export function settleOpenCodeInvocation(
  input: SettleOpenCodeInvocationInput,
): OpenCodeOwnershipJournal {
  const existing = requireJournal(input.attemptDataDir, input.attemptId);
  const now = input.now ?? new Date().toISOString();
  const index = existing.invocations.findIndex((entry) => entry.ordinal === input.ordinal);
  if (index < 0) {
    throw new OpenCodeOwnershipError(
      `no invocation ordinal ${String(input.ordinal)} exists in the ownership journal for ` +
        `attempt ${String(input.attemptId)}`,
    );
  }
  const prior = existing.invocations[index]!;
  if (prior.settled) return existing;
  const updated: OpenCodeOwnershipInvocation = {
    ...prior,
    settled: true,
    settledAt: now,
  };
  const invocations = [...existing.invocations];
  invocations[index] = updated;
  return writeOpenCodeOwnership(input.attemptDataDir, {
    ...existing,
    invocations,
    updatedAt: now,
  });
}

export interface MarkOpenCodeInvocationNotStartedInput {
  attemptDataDir: string;
  attemptId: number;
  ordinal: number;
  now?: string;
}

/**
 * Record a runner-confirmed pre-spawn failure. This is distinct from a pending
 * launch: recovery may safely release the workspace because no CLI process or
 * service-owned session was created.
 */
export function markOpenCodeInvocationNotStarted(
  input: MarkOpenCodeInvocationNotStartedInput,
): OpenCodeOwnershipJournal {
  const existing = requireJournal(input.attemptDataDir, input.attemptId);
  const now = input.now ?? new Date().toISOString();
  const index = existing.invocations.findIndex((entry) => entry.ordinal === input.ordinal);
  if (index < 0) {
    throw new OpenCodeOwnershipError(
      `no invocation ordinal ${String(input.ordinal)} exists in the ownership journal for ` +
        `attempt ${String(input.attemptId)}`,
    );
  }
  const prior = existing.invocations[index]!;
  if (
    prior.launchState !== "pending" ||
    prior.parentSessionId !== null ||
    prior.observedPrimaryId !== null ||
    prior.settled
  ) {
    throw new OpenCodeOwnershipError(
      `invocation ${String(input.ordinal)} has launch evidence and cannot be marked not-started`,
    );
  }
  const invocations = [...existing.invocations];
  invocations[index] = {
    ...prior,
    launchState: "not-started",
    settled: true,
    settledAt: now,
  };
  return writeOpenCodeOwnership(input.attemptDataDir, {
    ...existing,
    invocations,
    updatedAt: now,
  });
}

function requireJournal(attemptDataDir: string, attemptId: number): OpenCodeOwnershipJournal {
  const journal = readForUpdate(attemptDataDir, attemptId);
  if (journal === undefined) {
    throw new OpenCodeOwnershipError(
      `no ownership journal exists at ${opencodeOwnershipPath(attemptDataDir)} for attempt ` +
        `${String(attemptId)}`,
    );
  }
  return journal;
}

/* ------------------------------------------------------------------ *
 * Read helpers for recovery / admission
 * ------------------------------------------------------------------ */

/** The single workspace every invocation names, or `undefined` for an empty journal. */
export function opencodeOwnershipWorkspace(journal: OpenCodeOwnershipJournal): string | undefined {
  return journal.invocations[0]?.descriptor.workspacePath;
}

/** True while any invocation's tree is not proven settled. */
export function opencodeOwnershipIsUnresolved(journal: OpenCodeOwnershipJournal): boolean {
  return journal.invocations.some((invocation) => !invocation.settled);
}

/** True when `workspacePath` is the workspace this journal owns. */
export function opencodeOwnershipOwnsWorkspace(
  journal: OpenCodeOwnershipJournal,
  workspacePath: string,
): boolean {
  const workspace = opencodeOwnershipWorkspace(journal);
  return workspace !== undefined && sameResolvedPath(workspace, workspacePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
