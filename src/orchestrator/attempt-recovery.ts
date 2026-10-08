/**
 * Startup recovery for OpenCode attempts (task 3.6, extended by tasks 3.3/4.4/
 * 4.5; design D3/D4; capabilities `opencode-agent-profiles`,
 * `opencode-agent-selection` and `job-orchestration`).
 *
 * The legacy startup sweep (see {@link cleanupStaleAttemptDirs} in
 * `src/index.ts`) treats an attempt whose job the startup sweep marked
 * `interrupted` as disposable and deletes its data dir. That is safe for a
 * Cline attempt, whose agent process cannot outlive its run, but never for any
 * OpenCode attempt:
 *
 * - a native/default attempt journals a generic OWNERSHIP record (see
 *   `src/agent/opencode-ownership.ts`) outside the worktree, and a managed
 *   attempt additionally journals an attempt manifest — the only record of what
 *   the attempt owned and where its generated files live;
 * - a background/nested child of the crashed run may still be alive in the
 *   shared OpenCode service and able to write to the workspace; and
 * - the generated agent files (managed only; carrying the operator's private
 *   instructions, possibly edited by the agent) may still sit in the reuse
 *   worktree where a later attempt could discover or publish them.
 *
 * This module is the OpenCode half of the startup sweep. Every candidate is
 * decided by two independent proofs, and ONLY when both hold is the attempt
 * RECOVERED:
 *
 * 1. the OWNER is known inactive — the attempt row exists and already carries a
 *    terminal outcome; and
 * 2. EVERY invocation tree is provably quiescent through the pinned session API
 *    (`opencode api`, the same surface the runtime settlement uses), so no child
 *    can still modify the workspace. A generic ownership journal may name
 *    several invocations; each must be settled (or trusted from its recorded
 *    settlement), and any pre-launch uncertainty, missing parent, unavailable
 *    API, or mismatched worker context quarantines the whole attempt.
 *
 * Recovery then removes ONLY the manifest-listed generated files (managed
 * attempts; native/default attempts have no manifest, so their workspace is
 * never touched and native project/global configuration is never removed) and
 * retires the data dir.
 *
 * Everything else QUARANTINES the attempt: the journal/manifest, every
 * generated file, and every piece of evidence are left exactly where they are,
 * a durable `recovery.json` record is journaled into the data dir (naming the
 * workspace it owns), and the orchestrator's workspace admission gates refuse
 * to reuse or publish that workspace. An unavailable or unreadable session API
 * NEVER counts as a confirmation of quiescence — it is a fail-closed
 * quarantine, per design D4's "a child that cannot be confirmed stopped leaves
 * a failed, quarantined attempt and diagnostic evidence". A failure to journal
 * that durable record is fatal to startup.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { removeAttemptDataDir } from "../agent/credentials.js";
import type { ProcessRunner } from "../agent/launcher.js";
import {
  ManagedFilesError,
  cleanupManagedOpencodeFiles,
  managedOpencodeManifestPath,
  readManagedOpencodeManifest,
} from "../agent/managed-files.js";
import {
  OPENCODE_SESSION_INTERRUPT_GRACE_MS,
  OpenCodeSessionSettleError,
  createCliManagedSessionHttp,
  settleAttemptChildren,
  type ManagedSessionHttp,
} from "../agent/managed-sessions.js";
import {
  OPENCODE_EXECUTOR_KIND,
  opencodeOwnershipOwnsWorkspace,
  opencodeOwnershipPath,
  opencodeOwnershipWorkspace,
  readOpenCodeOwnership,
  type OpenCodeOwnershipDescriptor,
  type OpenCodeOwnershipInvocation,
  type OpenCodeOwnershipJournal,
} from "../agent/opencode-ownership.js";
import type { Logger } from "../log/logger.js";
import type { OperatorActionStore } from "../store/actions.js";
import type { AttemptRow } from "../store/jobs.js";
import type { ManagedOpencodeManifest } from "../agent/managed-files.js";

/**
 * The durable recovery record name inside an attempt data directory. Its
 * presence is what the orchestrator's retry/reset admission gates consult, so
 * a quarantined workspace can never be silently reused.
 */
export const ATTEMPT_RECOVERY_RECORD_FILE = "recovery.json";

/**
 * Default budget for proving a crashed attempt's child tree quiescent at
 * startup. The runtime settlement is bounded by the remaining configured agent
 * timeout; at startup no agent is running, so recovery uses this fixed bound.
 * A wedged or absent `opencode api` transport cannot stall the queue forever.
 */
export const RECOVERY_SETTLE_TIMEOUT_MS = 10_000;

/** Default interval between observation rounds while proving quiescence. */
export const RECOVERY_SESSION_POLL_INTERVAL_MS = 500;

/**
 * Every reason a managed attempt's data dir was (not) retired at startup.
 * `recovered-*` reasons mean the attempt was cleaned and the dir removed;
 * every other reason is a quarantine that preserves the manifest, files, and
 * evidence and bars the workspace from reuse.
 */
export type AttemptRecoveryReason =
  | "recovered-quiescent"
  | "missing-attempt-record"
  | "owner-not-terminal"
  | "missing-parent-id"
  | "workspace-missing"
  | "worker-unavailable"
  | "child-state-unknown"
  | "manifest-corrupt"
  | "cleanup-failed"
  | "ownership-corrupt"
  | "launched-uncertain"
  | "worker-mismatch"
  | "legacy-ownership-unverifiable";

export type AttemptRecoveryStatus = "recovered" | "quarantined";

/**
 * Raised when startup recovery cannot operate safely and the whole process
 * must refuse to start:
 *
 * - a managed attempt's manifest is unreadable AND its attempt row records no
 *   trustworthy workspace path (the contaminated workspace cannot be
 *   identified or quarantined), or
 * - the durable {@link AttemptRecoveryRecord} that gates the quarantine cannot
 *   be journaled (without it the workspace would be silently reusable).
 *
 * Nothing is deleted or cleaned on this path; startup simply must not continue
 * over an unaccountable managed attempt.
 */
export class AttemptRecoveryFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptRecoveryFatalError";
  }
}

/**
 * True when an attempt data dir belongs to an OpenCode lifecycle that recovery
 * must decide itself — it journals a generic ownership record, an attempt
 * manifest (even an unreadable one), or already carries a durable recovery
 * record. Such a dir must never be deleted by the legacy sweep or trimmed by
 * artifact retention: its ownership/manifest/evidence is the only record of
 * what the attempt owned, and its quarantine gates every workspace admission.
 * A native/default attempt has no managed manifest, so the ownership journal is
 * what keeps it out of the Cline-style sweep.
 */
export function isManagedAttemptDataDir(attemptDataDir: string): boolean {
  return (
    existsSync(managedOpencodeManifestPath(attemptDataDir)) ||
    existsSync(attemptRecoveryRecordPath(attemptDataDir)) ||
    existsSync(opencodeOwnershipPath(attemptDataDir))
  );
}

/**
 * The exact worker context recovery uses to talk to the same OpenCode service a
 * crashed attempt used: cwd + environment plus the optional resolved
 * binary/version/runner for an alias-aware descriptor (design D3, the shared
 * `OpenCodeWorker`). Structurally a superset of `CreateCliManagedSessionHttpInput`
 * and a structural subset of `OpenCodeWorker`, so the parent can pass the one
 * shared descriptor and the pinned session transport never falls back to a
 * hardcoded `opencode`.
 */
export interface RecoveryWorker {
  /** Configured executor alias id, when resolved by the shared descriptor. */
  executorId?: string;
  /** Resolved binary for the configured executor alias, when known. */
  binary?: string;
  /** Pinned version for that binary, when known. */
  version?: string;
  cwd: string;
  env: Record<string, string>;
  /** Injected process runner; defaults to the real launcher. */
  runner?: ProcessRunner;
}

/** Resolve the configured executor's OpenCode kind from its agent alias. */
export type ResolveExecutorKind = (agent: string) => string | undefined;

/** The attempt-row evidence recovery uses to recognize a pre-journal OpenCode run. */
export interface AttemptOwnershipEvidence {
  agent: string;
  workspace_path: string | null;
  agent_session_id: string | null;
}

/** True when an attempt row carries enough evidence of a launched OpenCode run. */
export function hasLegacyOpenCodeEvidence(attempt: AttemptOwnershipEvidence): boolean {
  return attempt.agent_session_id !== null || attempt.workspace_path !== null;
}

/**
 * The classifier the legacy startup sweep (`cleanupStaleAttemptDirs` in
 * `src/index.ts`) must consult before deleting an attempt data dir. Returns
 * true when the dir belongs to the startup recovery module instead: it carries
 * a generic ownership journal, a managed manifest, a recovery record, OR it is
 * a pre-journal OpenCode attempt (identified through the caller's
 * alias->executor-kind resolver) whose service-owned tree must be quarantined
 * rather than swept as a Cline attempt.
 */
export function shouldDeferAttemptToRecovery(input: {
  attemptDataDir: string;
  attempt: AttemptOwnershipEvidence | undefined;
  resolveExecutorKind?: ResolveExecutorKind;
}): boolean {
  if (isManagedAttemptDataDir(input.attemptDataDir)) return true;
  if (input.resolveExecutorKind === undefined || input.attempt === undefined) return false;
  if (input.resolveExecutorKind(input.attempt.agent) !== OPENCODE_EXECUTOR_KIND) return false;
  return hasLegacyOpenCodeEvidence(input.attempt);
}

/**
 * The durable quarantine/recovery record journaled into the attempt data dir.
 * `sessionIds` preserves the parent and every child session observed, so an
 * operator can re-probe the pinned CLI from the diagnostics without the
 * (possibly private) generated file contents.
 */
export interface AttemptRecoveryRecord {
  version: 1;
  attemptId: number;
  status: AttemptRecoveryStatus;
  reason: AttemptRecoveryReason;
  detail: string;
  /** Absolute workspace the attempt materialized into, when known. */
  workspacePath: string | null;
  /** Absolute manifest path, when one was found. */
  manifestPath: string | null;
  /** Parent session id first, then each attributed child session id. */
  sessionIds: readonly string[];
  recordedAt: string;
}

/** One candidate's decision, reported to the caller without secrets. */
export interface AttemptRecoveryOutcome {
  attemptId: number;
  status: AttemptRecoveryStatus;
  reason: AttemptRecoveryReason;
  detail: string;
  workspacePath: string | null;
}

export interface AttemptRecoveryReport {
  /** Managed candidates (attempt data dirs holding a manifest file). */
  candidates: number;
  recovered: AttemptRecoveryOutcome[];
  quarantined: AttemptRecoveryOutcome[];
}

export interface RecoverStaleManagedAttemptsInput {
  dataDir: string;
  db: Database.Database;
  /**
   * Resolve the exact cwd + environment (and, for an alias-aware parent, the
   * binary/version/runner) the crashed attempt's run received so the pinned
   * session API talks to the same OpenCode service. `undefined` means the
   * surface cannot be reached and the attempt is quarantined.
   */
  resolveWorker?: (attempt: AttemptRow, workspacePath: string) => RecoveryWorker | undefined;
  /** Pinned-session HTTP; defaults to the `opencode api` CLI transport. */
  sessionHttp?: (worker: RecoveryWorker) => ManagedSessionHttp;
  /**
   * Resolve an attempt row's configured agent alias to its executor kind.
   * Supplying this lets recovery recognize a LEGACY unmanaged OpenCode attempt
   * (no ownership journal, no manifest) from its recorded agent/workspace
   * evidence and quarantine it instead of leaving it to the Cline-style sweep.
   */
  resolveExecutorKind?: ResolveExecutorKind;
  settleTimeoutMs?: number;
  settlePollIntervalMs?: number;
  settleInterruptGraceMs?: number;
  actions?: Pick<OperatorActionStore, "record">;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  /** Injectable clock and sleeper for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable data-dir retirement operation; production uses recursive removal. */
  removeAttemptDataDir?: (attemptDataDir: string) => void;
}

export function attemptRecoveryRecordPath(attemptDataDir: string): string {
  return join(attemptDataDir, ATTEMPT_RECOVERY_RECORD_FILE);
}

export function attemptDataDirFor(dataDir: string, attemptId: number): string {
  return join(dataDir, "attempts", String(attemptId));
}

/**
 * True when the attempt data dir holds a durable recovery record that bars its
 * workspace from reuse. A record that exists but cannot be parsed is treated as
 * a quarantine (fail closed): an unreadable record must never silently admit
 * the workspace. A deleted dir or one without a record is not quarantined.
 */
export function isAttemptQuarantined(attemptDataDir: string): boolean {
  const path = attemptRecoveryRecordPath(attemptDataDir);
  if (!existsSync(path)) return false;
  return readAttemptRecoveryRecord(attemptDataDir)?.status !== "recovered";
}

/**
 * Every readable quarantine record naming `workspacePath`. Unreadable records
 * are handled by the attempt-specific gate; the workspace-level gate uses only
 * records it can attribute.
 */
export function quarantineRecordsForWorkspace(
  dataDir: string,
  workspacePath: string,
): AttemptRecoveryRecord[] {
  const records: AttemptRecoveryRecord[] = [];
  const attemptsRoot = join(dataDir, "attempts");
  let entries: string[] = [];
  try {
    entries = readdirSync(attemptsRoot);
  } catch {
    return records;
  }
  const target = resolve(workspacePath);
  for (const entry of entries) {
    const attemptId = Number(entry);
    if (!Number.isInteger(attemptId) || attemptId < 1) continue;
    const dir = join(attemptsRoot, entry);
    const record = readAttemptRecoveryRecord(dir);
    if (record === undefined || record.status !== "quarantined") continue;
    if (record.workspacePath === null) continue;
    if (sameResolvedPath(record.workspacePath, target)) records.push(record);
  }
  return records;
}

function sameResolvedPath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * True when `workspacePath` is owned by an attempt whose OpenCode invocation
 * tree has NOT been proven quiescent — even when no durable recovery record has
 * been written yet. Workspace admission (retry/fresh run) and reclamation both
 * consult this so a native/default attempt's unresolved tree keeps ONLY ITS OWN
 * workspace unavailable for reuse, exactly like a managed quarantine; a
 * readable journal in another repository never blocks this workspace. A present
 * but unreadable/unaccountable ownership journal or manifest may conservatively
 * block any workspace until recovery attributes and retires it.
 *
 * This never examines or deletes the workspace itself; it only reads the
 * attempt data directories beneath `dataDir`.
 */
export function workspaceHasUnresolvedAttemptOwnership(
  dataDir: string,
  workspacePath: string,
): boolean {
  const target = resolve(workspacePath);
  const attemptsRoot = join(dataDir, "attempts");
  let entries: string[] = [];
  try {
    entries = readdirSync(attemptsRoot);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const attemptId = Number(entry);
    if (!Number.isInteger(attemptId) || attemptId < 1) continue;
    const dir = join(attemptsRoot, entry);

    const record = readAttemptRecoveryRecord(dir);
    if (existsSync(attemptRecoveryRecordPath(dir)) && record === undefined) {
      // The record's workspace cannot be attributed safely, so do not let a
      // malformed/unreadable quarantine marker admit any workspace.
      return true;
    }
    if (
      record !== undefined &&
      record.status === "quarantined" &&
      record.workspacePath !== null &&
      sameResolvedPath(record.workspacePath, target)
    ) {
      return true;
    }

    const ownershipPath = opencodeOwnershipPath(dir);
    if (existsSync(ownershipPath)) {
      const journal = readOpenCodeOwnership(dir);
      // An unreadable/unaccountable journal may conservatively block any
      // workspace until recovery attributes and retires it. A readable journal
      // blocks ONLY the exact workspace it names — an unresolved attempt in
      // repository A must never freeze an unrelated repository B.
      if (journal === undefined) return true;
      if (opencodeOwnershipOwnsWorkspace(journal, target)) return true;
    }

    const manifestPath = managedOpencodeManifestPath(dir);
    if (existsSync(manifestPath)) {
      const manifest = readManagedOpencodeManifest(manifestPath);
      if (manifest === undefined) {
        // A present-but-unaccountable manifest fails closed; treating it as
        // absent would silently admit a workspace whose ownership is unknown.
        return true;
      }
      if (sameResolvedPath(manifest.workspacePath, target)) return true;
    }
  }
  return false;
}

/**
 * Read and strictly validate a durable recovery record. `undefined` means no
 * usable record (absent or malformed).
 */
export function readAttemptRecoveryRecord(
  attemptDataDir: string,
): AttemptRecoveryRecord | undefined {
  const path = attemptRecoveryRecordPath(attemptDataDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== 1) return undefined;
    if (typeof record.attemptId !== "number" || !Number.isSafeInteger(record.attemptId)) {
      return undefined;
    }
    const status = record.status;
    if (status !== "recovered" && status !== "quarantined") return undefined;
    const reason = record.reason;
    if (typeof reason !== "string" || reason.length === 0) return undefined;
    const detail = record.detail;
    if (typeof detail !== "string") return undefined;
    const workspacePath = record.workspacePath;
    if (workspacePath !== null && typeof workspacePath !== "string") return undefined;
    const manifestPath = record.manifestPath;
    if (manifestPath !== null && typeof manifestPath !== "string") return undefined;
    if (!Array.isArray(record.sessionIds)) return undefined;
    const sessionIds = record.sessionIds.map(String);
    const recordedAt = record.recordedAt;
    if (typeof recordedAt !== "string" || recordedAt.length === 0) return undefined;
    return {
      version: 1,
      attemptId: record.attemptId,
      status,
      reason: reason as AttemptRecoveryReason,
      detail,
      workspacePath,
      manifestPath,
      sessionIds,
      recordedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Journal the recovery record durably and atomically (stage + rename). The
 * record is what gates workspace admission, so a write failure MUST fail
 * startup: without it a contaminated workspace would be silently reusable. An
 * existing identical record is left untouched (a repeated startup need not
 * churn the file); a changed record atomically replaces the old one — rename
 * replaces an existing regular file on every platform. Throws
 * {@link AttemptRecoveryFatalError} on any I/O failure.
 */
function writeAttemptRecoveryRecord(attemptDataDir: string, record: AttemptRecoveryRecord): void {
  const path = attemptRecoveryRecordPath(attemptDataDir);
  const existing = readAttemptRecoveryRecord(attemptDataDir);
  if (existing !== undefined && recoveryRecordEquals(existing, record)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const staged = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`;
    try {
      writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      throw new AttemptRecoveryFatalError(
        `cannot stage the recovery record at ${staged}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      throw new AttemptRecoveryFatalError(
        `cannot install the recovery record at ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } catch (error) {
    if (error instanceof AttemptRecoveryFatalError) throw error;
    throw new AttemptRecoveryFatalError(
      `cannot journal the recovery record at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** True when two records carry identical gating facts (ignoring `recordedAt`). */
function recoveryRecordEquals(a: AttemptRecoveryRecord, b: AttemptRecoveryRecord): boolean {
  return (
    a.status === b.status &&
    a.reason === b.reason &&
    a.detail === b.detail &&
    a.workspacePath === b.workspacePath &&
    a.manifestPath === b.manifestPath &&
    a.sessionIds.length === b.sessionIds.length &&
    a.sessionIds.every((id, index) => id === b.sessionIds[index])
  );
}

interface RecoveryCandidate {
  attemptId: number;
  attemptDataDir: string;
  manifestPath: string;
  manifest: ManagedOpencodeManifest | undefined;
  /** Present when the generic ownership journal file exists (readable or not). */
  hasOwnership: boolean;
  ownership: OpenCodeOwnershipJournal | undefined;
  attempt: AttemptRow | undefined;
  /**
   * A pre-journal OpenCode attempt recognized only from its DB agent/workspace
   * evidence. It has no manifest or ownership file and must be quarantined
   * rather than treated as Cline.
   */
  legacyOpenCode: boolean;
}

function listCandidateDirs(dataDir: string): string[] {
  const attemptsRoot = join(dataDir, "attempts");
  let entries: string[] = [];
  try {
    entries = readdirSync(attemptsRoot);
  } catch {
    return [];
  }
  return entries.filter((entry) => {
    const attemptId = Number(entry);
    return Number.isInteger(attemptId) && attemptId >= 1;
  });
}

function readAttemptRow(db: Database.Database, attemptId: number): AttemptRow | undefined {
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
}

function recordOutcome(input: {
  attemptId: number;
  status: AttemptRecoveryStatus;
  reason: AttemptRecoveryReason;
  detail: string;
  workspacePath: string | null;
  manifestPath: string | null;
  sessionIds: readonly string[];
}): AttemptRecoveryOutcome {
  return {
    attemptId: input.attemptId,
    status: input.status,
    reason: input.reason,
    detail: input.detail,
    workspacePath: input.workspacePath,
  };
}

interface RecoveryRuntime {
  dataDir: string;
  actions?: Pick<OperatorActionStore, "record">;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  resolveWorker?: RecoverStaleManagedAttemptsInput["resolveWorker"];
  resolveExecutorKind?: ResolveExecutorKind;
  sessionHttp: (worker: RecoveryWorker) => ManagedSessionHttp;
  settleTimeoutMs: number;
  settlePollIntervalMs: number;
  settleInterruptGraceMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  removeAttemptDataDir: (attemptDataDir: string) => void;
}

/** True when an attempt row carries enough evidence of a launched OpenCode run. */
function candidateHasLegacyOpenCodeEvidence(attempt: AttemptRow): boolean {
  return attempt.agent_session_id !== null || attempt.workspace_path !== null;
}

/**
 * The startup half of the sweep. Scans `dataDir/attempts` for data dirs that
 * belong to an OpenCode lifecycle — a generic ownership journal (native,
 * default, or managed), a managed manifest, or a pre-journal OpenCode attempt
 * with recorded agent/workspace evidence — and decides each: recover (owner
 * proven inactive AND every invocation tree proven quiescent) or quarantine
 * (everything else). Never deletes such a dir unless ALL proofs hold, and never
 * touches native project/global configuration. Idempotent: a quarantined
 * attempt is re-decided on the next startup (a session that finally proves
 * quiescent is then recovered), and a recovered attempt's dir no longer exists.
 */
export async function recoverStaleManagedAttempts(
  input: RecoverStaleManagedAttemptsInput,
): Promise<AttemptRecoveryReport> {
  const runtime: RecoveryRuntime = {
    dataDir: input.dataDir,
    sessionHttp: input.sessionHttp ?? createCliManagedSessionHttp,
    settleTimeoutMs: input.settleTimeoutMs ?? RECOVERY_SETTLE_TIMEOUT_MS,
    settlePollIntervalMs: input.settlePollIntervalMs ?? RECOVERY_SESSION_POLL_INTERVAL_MS,
    settleInterruptGraceMs: input.settleInterruptGraceMs ?? OPENCODE_SESSION_INTERRUPT_GRACE_MS,
    now: input.now ?? (() => Date.now()),
    sleep: input.sleep ?? ((ms: number) => delay(ms)),
    removeAttemptDataDir: input.removeAttemptDataDir ?? removeAttemptDataDir,
    ...(input.actions === undefined ? {} : { actions: input.actions }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.resolveWorker === undefined ? {} : { resolveWorker: input.resolveWorker }),
    ...(input.resolveExecutorKind === undefined
      ? {}
      : { resolveExecutorKind: input.resolveExecutorKind }),
  };

  const report: AttemptRecoveryReport = { candidates: 0, recovered: [], quarantined: [] };
  for (const entry of listCandidateDirs(input.dataDir)) {
    const attemptId = Number(entry);
    const attemptDataDir = join(input.dataDir, "attempts", entry);
    const manifestPath = managedOpencodeManifestPath(attemptDataDir);
    const ownershipPath = opencodeOwnershipPath(attemptDataDir);
    const hasManifest = existsSync(manifestPath);
    const hasOwnership = existsSync(ownershipPath);
    const attempt = readAttemptRow(input.db, attemptId);
    // A pre-journal OpenCode attempt is recognized only when a resolver maps
    // its agent to OpenCode; it must be quarantined rather than left to the
    // Cline-style sweep, because its service-owned tree cannot be ruled out.
    const legacyOpenCode =
      !hasManifest &&
      !hasOwnership &&
      runtime.resolveExecutorKind !== undefined &&
      attempt !== undefined &&
      runtime.resolveExecutorKind(attempt.agent) === OPENCODE_EXECUTOR_KIND &&
      candidateHasLegacyOpenCodeEvidence(attempt);
    if (!hasManifest && !hasOwnership && !legacyOpenCode) {
      // Everything else (a Cline attempt, an orphan dir) belongs to the legacy
      // sweep (`cleanupStaleAttemptDirs`).
      continue;
    }
    report.candidates += 1;
    const candidate: RecoveryCandidate = {
      attemptId,
      attemptDataDir,
      manifestPath,
      manifest: hasManifest ? readManagedOpencodeManifest(manifestPath) : undefined,
      hasOwnership,
      ownership: hasOwnership ? readOpenCodeOwnership(attemptDataDir) : undefined,
      attempt,
      legacyOpenCode,
    };
    const outcome = await decideAttempt(runtime, candidate);
    if (outcome.status === "recovered") {
      report.recovered.push(outcome);
    } else {
      report.quarantined.push(outcome);
    }
    runtime.actions?.record({
      action: "attempt-recovery",
      target: attemptDataDir,
      effect: outcome.status,
      detail: {
        attemptId: outcome.attemptId,
        reason: outcome.reason,
        ...(outcome.workspacePath === null ? {} : { workspace: outcome.workspacePath }),
      },
    });
    runtime.logger?.info("startup attempt recovery", {
      attemptId: outcome.attemptId,
      status: outcome.status,
      reason: outcome.reason,
    });
  }
  return report;
}

function quarantineAttempt(
  candidate: RecoveryCandidate,
  input: {
    reason: AttemptRecoveryReason;
    detail: string;
    workspacePath: string | null;
    manifestPath: string | null;
    sessionIds?: readonly string[];
  },
): AttemptRecoveryOutcome {
  const sessionIds = [...(input.sessionIds ?? [])];
  // The durable record is the admission gate for every workspace use; a
  // failure to journal it must fail the process rather than leave a
  // contaminated workspace silently reusable (design task 3.6).
  writeAttemptRecoveryRecord(candidate.attemptDataDir, {
    version: 1,
    attemptId: candidate.attemptId,
    status: "quarantined",
    reason: input.reason,
    detail: input.detail,
    workspacePath: input.workspacePath,
    manifestPath: input.manifestPath,
    sessionIds,
    recordedAt: new Date().toISOString(),
  });
  return recordOutcome({
    attemptId: candidate.attemptId,
    status: "quarantined",
    reason: input.reason,
    detail: input.detail,
    workspacePath: input.workspacePath,
    manifestPath: input.manifestPath,
    sessionIds,
  });
}

/**
 * Decide one candidate. A generic ownership journal (native/default/managed)
 * is proven invocation-by-invocation; a manifest-only dir keeps the original
 * managed single-invocation behavior; a pre-journal OpenCode attempt is checked
 * from its recorded evidence and otherwise quarantined rather than swept.
 */
async function decideAttempt(
  runtime: RecoveryRuntime,
  candidate: RecoveryCandidate,
): Promise<AttemptRecoveryOutcome> {
  if (candidate.hasOwnership) return decideGenericOwnershipAttempt(runtime, candidate);
  if (candidate.legacyOpenCode) return decideLegacyOpenCodeAttempt(runtime, candidate);
  return decideManagedManifestAttempt(runtime, candidate);
}

/** Resolve the worker for one invocation, defaulting the alias-aware fields. */
function resolveInvocationWorker(
  runtime: RecoveryRuntime,
  attempt: AttemptRow,
  workspacePath: string,
  invocation: OpenCodeOwnershipInvocation,
): { worker: RecoveryWorker } | { mismatch: string } | Record<string, never> {
  if (runtime.resolveWorker === undefined) {
    return {};
  }
  const base = runtime.resolveWorker(attempt, workspacePath);
  if (base === undefined) return {};
  const mismatch = workerContextMismatch(
    invocation.descriptor,
    base,
    runtime.resolveExecutorKind,
    attempt,
  );
  if (mismatch !== undefined) return { mismatch };
  const worker: RecoveryWorker = {
    ...base,
    // The pinned session transport uses the alias-aware journaled binary/version
    // when the resolver did not already supply them, never a hardcoded default.
    ...(base.binary === undefined ? { binary: invocation.descriptor.binary } : {}),
    ...(base.version === undefined ? { version: invocation.descriptor.version } : {}),
  };
  return { worker };
}

/** True when the resolved worker context disagrees with the journaled descriptor. */
function workerContextMismatch(
  descriptor: OpenCodeOwnershipDescriptor,
  worker: RecoveryWorker,
  resolveExecutorKind: ResolveExecutorKind | undefined,
  attempt: AttemptRow,
): string | undefined {
  if (!sameResolvedPath(worker.cwd, descriptor.workspacePath)) {
    return (
      `worker cwd ${worker.cwd} does not match the journaled workspace ` +
      `${descriptor.workspacePath}; the service may not be the one that ran this attempt`
    );
  }
  if (worker.binary !== undefined && !sameCommand(worker.binary, descriptor.binary)) {
    return (
      `worker binary ${worker.binary} does not match the journaled binary ` +
      `${descriptor.binary}; an alias change must not silently retarget recovery`
    );
  }
  if (worker.version !== undefined && worker.version !== descriptor.version) {
    return (
      `worker version ${worker.version} does not match the journaled version ` +
      `${descriptor.version}; the session API surface may differ`
    );
  }
  if (resolveExecutorKind !== undefined) {
    const kind = resolveExecutorKind(attempt.agent);
    if (kind !== undefined && kind !== descriptor.executor) {
      return (
        `resolved executor kind ${kind} does not match the journaled executor ` +
        `${descriptor.executor}; the worker context cannot be reconciled`
      );
    }
  }
  return undefined;
}

function sameCommand(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Decide an attempt that journals generic OpenCode ownership (native, default,
 * or managed). Every invocation tree must be proven quiescent; a settled
 * invocation is trusted from its recorded proof. Only manifest-owned generated
 * files are ever cleaned — a native/default attempt has no manifest, so its
 * workspace is left exactly as the agent left it (never native configuration).
 */
async function decideGenericOwnershipAttempt(
  runtime: RecoveryRuntime,
  candidate: RecoveryCandidate,
): Promise<AttemptRecoveryOutcome> {
  const { attemptId, attemptDataDir, ownership } = candidate;
  const recordManifestPath = existsSync(candidate.manifestPath) ? candidate.manifestPath : null;
  const journalWorkspace =
    ownership === undefined ? null : (opencodeOwnershipWorkspace(ownership) ?? null);
  const quarantineWorkspace =
    journalWorkspace ??
    candidate.manifest?.workspacePath ??
    candidate.attempt?.workspace_path ??
    null;
  const quarantine = (
    reason: AttemptRecoveryReason,
    detail: string,
    sessionIds: readonly string[] = [],
  ) =>
    quarantineAttempt(candidate, {
      reason,
      detail,
      workspacePath: quarantineWorkspace,
      manifestPath: recordManifestPath,
      sessionIds,
    });

  // 1. The journal must be usable: without it the invocation set (and therefore
  // the session trees that could still write) cannot be known.
  if (ownership === undefined) {
    if (quarantineWorkspace === null) {
      throw new AttemptRecoveryFatalError(
        `attempt data dir ${attemptDataDir} holds an unreadable OpenCode ownership journal and ` +
          "its attempt row records no workspace path; the contaminated workspace cannot be " +
          "identified or quarantined, so this process refuses to start",
      );
    }
    return quarantine(
      "ownership-corrupt",
      `the OpenCode ownership journal at ${opencodeOwnershipPath(attemptDataDir)} exists but ` +
        "could not be read as a version-1 journal; the attempt is preserved and the workspace it " +
        "names is quarantined",
    );
  }
  if (journalWorkspace === null) {
    return quarantine(
      "ownership-corrupt",
      `the OpenCode ownership journal at ${opencodeOwnershipPath(attemptDataDir)} names no workspace; ` +
        "the owned location cannot be accounted for",
    );
  }

  // 2. A corrupt managed manifest alongside a journal cannot be cleaned safely,
  // so fail closed rather than silently skip generated content.
  if (candidate.manifest === undefined && existsSync(candidate.manifestPath)) {
    return quarantine(
      "manifest-corrupt",
      `the attempt manifest at ${candidate.manifestPath} exists but could not be read as a ` +
        "version-1 managed manifest; generated content cannot be accounted for, so the attempt is " +
        "preserved and the workspace is quarantined",
    );
  }

  // 3. The journal's workspace, the manifest's workspace, and the attempt row's
  // workspace must all agree — a mismatch means recovery would talk to the
  // wrong service/context.
  if (
    candidate.manifest !== undefined &&
    !sameResolvedPath(candidate.manifest.workspacePath, journalWorkspace)
  ) {
    return quarantine(
      "worker-mismatch",
      `the ownership journal names ${journalWorkspace} but the managed manifest names ` +
        `${candidate.manifest.workspacePath}; the worker context cannot be reconciled`,
    );
  }
  if (
    candidate.attempt?.workspace_path !== null &&
    candidate.attempt?.workspace_path !== undefined &&
    !sameResolvedPath(candidate.attempt.workspace_path, journalWorkspace)
  ) {
    return quarantine(
      "worker-mismatch",
      `the ownership journal names ${journalWorkspace} but attempt ${attemptId} recorded workspace ` +
        `${candidate.attempt.workspace_path}; the worker context cannot be reconciled`,
    );
  }

  // 4. The owner must be known inactive.
  if (candidate.attempt === undefined) {
    return quarantine(
      "missing-attempt-record",
      `no attempt row ${attemptId} exists in the database, so the owner cannot be proven ` +
        "inactive; the journal and evidence are preserved and the workspace is quarantined",
    );
  }
  if (candidate.attempt.outcome === null) {
    return quarantine(
      "owner-not-terminal",
      `attempt ${attemptId} has no terminal outcome; the owner cannot be proven inactive`,
    );
  }

  // 5. Prove EVERY invocation tree FRESH. A recorded settlement is NOT trusted
  // (a crashed attempt can retain a journal after an earlier settlement) — each
  // launched invocation is re-attributed and re-proven through the pinned
  // session API. A missing parent, a pre-launch uncertainty, an unavailable
  // API/worker, or a mismatched worker context is a quarantine.
  const sessionIds: string[] = [];
  let settledChildren = 0;
  let settledRounds = 0;
  for (const invocation of ownership.invocations) {
    if (invocation.parentSessionId !== null) sessionIds.push(invocation.parentSessionId);
    if (invocation.launchState === "pending") {
      return quarantine(
        "launched-uncertain",
        `invocation ${String(invocation.ordinal)} of attempt ${attemptId} was journaled before ` +
          "launch but never attributed to a parent session; it may have started, so the workspace " +
          "is quarantined rather than assumed idle",
        sessionIds,
      );
    }
    if (invocation.parentSessionId === null) {
      return quarantine(
        "missing-parent-id",
        `invocation ${String(invocation.ordinal)} of attempt ${attemptId} was launched but recorded ` +
          "no parent session id, so its child sessions cannot be enumerated; unknown child state " +
          "preserves the evidence and quarantines the workspace",
        sessionIds,
      );
    }
    const resolved = resolveInvocationWorker(
      runtime,
      candidate.attempt,
      journalWorkspace,
      invocation,
    );
    if ("mismatch" in resolved && resolved.mismatch !== undefined) {
      return quarantine(
        "worker-mismatch",
        `invocation ${String(invocation.ordinal)} of attempt ${attemptId}: ${resolved.mismatch}`,
        sessionIds,
      );
    }
    if (!("worker" in resolved) || resolved.worker === undefined) {
      return quarantine(
        "worker-unavailable",
        `the pinned session API cannot be reached for invocation ${String(invocation.ordinal)} of ` +
          `attempt ${attemptId}: its run cwd/env could not be reconstructed; unavailable evidence is ` +
          "not a confirmation of quiescence",
        sessionIds,
      );
    }
    try {
      const settled = await settleAttemptChildren({
        parentSessionId: invocation.parentSessionId,
        attemptDirectory: resolved.worker.cwd,
        http: runtime.sessionHttp(resolved.worker),
        timeoutMs: runtime.settleTimeoutMs,
        pollIntervalMs: runtime.settlePollIntervalMs,
        interruptGraceMs: runtime.settleInterruptGraceMs,
        now: runtime.now,
        sleep: runtime.sleep,
      });
      settledChildren += settled.children.length;
      settledRounds += settled.rounds;
      for (const child of settled.children) sessionIds.push(child.id);
    } catch (error) {
      let ids = [...sessionIds];
      if (error instanceof OpenCodeSessionSettleError) {
        ids = [...ids, ...error.unsettledSessionIds, ...error.unknownSessionIds];
      }
      const detail = error instanceof Error ? error.message : String(error);
      return quarantine(
        "child-state-unknown",
        `child quiescence for invocation ${String(invocation.ordinal)} of attempt ${attemptId} could ` +
          `not be proven through the pinned session API (${detail}); the journal and evidence are ` +
          "preserved and the workspace is quarantined",
        ids,
      );
    }
  }

  // 6. The owned workspace must still exist: a vanished workspace cannot be
  // cleaned, but the record of what the attempt owned must survive.
  if (!existsSync(journalWorkspace)) {
    return quarantine(
      "workspace-missing",
      `the owned workspace ${journalWorkspace} no longer exists; the attempt data dir is preserved`,
      sessionIds,
    );
  }

  // 7. Quiescence is proven. Clean ONLY manifest-owned generated files — a
  // native/default attempt has no manifest, so no workspace file is touched and
  // native project/global configuration is never removed.
  try {
    let removed = 0;
    if (candidate.manifest !== undefined) {
      const cleanup = await cleanupManagedOpencodeFiles({
        workspacePath: candidate.manifest.workspacePath,
        manifestPath: candidate.manifestPath,
      });
      if (!cleanup.clean) {
        throw new ManagedFilesError([
          {
            reason: "generated-content-remains",
            detail: `startup recovery left generated content in ${candidate.manifest.workspacePath}`,
          },
        ]);
      }
      removed = cleanup.removed.length;
    }
    retireAttemptDataDir(runtime, attemptDataDir);
    return recordOutcome({
      attemptId,
      status: "recovered",
      reason: "recovered-quiescent",
      detail:
        `attempt ${attemptId} was verified inactive and all ${String(ownership.invocations.length)} ` +
        `OpenCode invocation tree(s) provably quiescent (${String(settledChildren)} child session(s) ` +
        `across ${String(settledRounds)} observation round(s)); ${String(removed)} manifest-owned ` +
        "generated file(s) removed and the data dir retired",
      workspacePath: journalWorkspace,
      manifestPath: recordManifestPath,
      sessionIds,
    });
  } catch (error) {
    if (error instanceof AttemptRecoveryFatalError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return quarantine(
      "cleanup-failed",
      `generated files or attempt data dir for attempt ${attemptId} could not be retired (${detail}); the manifest ` +
        "and data dir are preserved so a later pass or the operator can finish",
      sessionIds,
    );
  }
}

/**
 * Decide a pre-journal OpenCode attempt recognized from its DB evidence. With a
 * recorded parent session id the attributed tree is checked through the pinned
 * session API; with no usable evidence (or any unproven/unavailable state) it is
 * quarantined rather than swept as a Cline attempt, because a service-owned
 * tree cannot be ruled out.
 */
async function decideLegacyOpenCodeAttempt(
  runtime: RecoveryRuntime,
  candidate: RecoveryCandidate,
): Promise<AttemptRecoveryOutcome> {
  const { attemptId, attempt } = candidate;
  const workspacePath = attempt?.workspace_path ?? null;
  if (workspacePath === null) {
    throw new AttemptRecoveryFatalError(
      `attempt data dir ${candidate.attemptDataDir} is a legacy unmanaged OpenCode attempt whose ` +
        "attempt row records no workspace path; the contaminated workspace cannot be identified or " +
        "quarantined, so this process refuses to start",
    );
  }
  // Gate the owner's inactivity BEFORE any session read or retirement. A live
  // non-terminal legacy attempt must never be retired, even if the currently
  // observable tree happens to look quiescent.
  if (attempt === undefined) {
    return quarantineAttempt(candidate, {
      reason: "missing-attempt-record",
      detail:
        `no attempt row ${attemptId} exists in the database, so the owner cannot be proven ` +
        "inactive; the legacy OpenCode attempt is preserved and the workspace is quarantined",
      workspacePath,
      manifestPath: null,
    });
  }
  if (attempt.outcome === null) {
    return quarantineAttempt(candidate, {
      reason: "owner-not-terminal",
      detail: `attempt ${attemptId} has no terminal outcome; the owner cannot be proven inactive`,
      workspacePath,
      manifestPath: null,
    });
  }
  const parentSessionId = attempt.agent_session_id;
  if (parentSessionId === null) {
    return quarantineAttempt(candidate, {
      reason: "legacy-ownership-unverifiable",
      detail:
        `attempt ${attemptId} is a pre-journal OpenCode attempt with recorded workspace evidence ` +
        "but no parent session id, so its service-owned tree cannot be enumerated; it is preserved " +
        "and quarantined rather than swept as a Cline attempt",
      workspacePath,
      manifestPath: existsSync(candidate.manifestPath) ? candidate.manifestPath : null,
    });
  }
  const sessionIds: string[] = [parentSessionId];
  const worker =
    runtime.resolveWorker === undefined ? undefined : runtime.resolveWorker(attempt, workspacePath);
  if (worker === undefined) {
    return quarantineAttempt(candidate, {
      reason: "worker-unavailable",
      detail:
        `the pinned session API cannot be reached for legacy OpenCode attempt ${attemptId}: its run ` +
        "cwd/env could not be reconstructed; unavailable evidence is not a confirmation of quiescence",
      workspacePath,
      manifestPath: null,
      sessionIds,
    });
  }
  // The resolved worker must run in the exact owned workspace; a stale or
  // otherwise mismatched cwd would prove a different tree's quiescence.
  if (!sameResolvedPath(worker.cwd, workspacePath)) {
    return quarantineAttempt(candidate, {
      reason: "worker-mismatch",
      detail:
        `the resolved worker cwd ${worker.cwd} is not the workspace ${workspacePath} recorded for ` +
        `legacy OpenCode attempt ${attemptId}; refusing to prove an unrelated session tree`,
      workspacePath,
      manifestPath: null,
      sessionIds,
    });
  }
  let settledChildren = 0;
  let settledRounds = 0;
  try {
    const settled = await settleAttemptChildren({
      parentSessionId,
      attemptDirectory: worker.cwd,
      http: runtime.sessionHttp(worker),
      timeoutMs: runtime.settleTimeoutMs,
      pollIntervalMs: runtime.settlePollIntervalMs,
      interruptGraceMs: runtime.settleInterruptGraceMs,
      now: runtime.now,
      sleep: runtime.sleep,
    });
    settledChildren = settled.children.length;
    settledRounds = settled.rounds;
    for (const child of settled.children) sessionIds.push(child.id);
  } catch (error) {
    let ids = [...sessionIds];
    if (error instanceof OpenCodeSessionSettleError) {
      ids = [...ids, ...error.unsettledSessionIds, ...error.unknownSessionIds];
    }
    const detail = error instanceof Error ? error.message : String(error);
    return quarantineAttempt(candidate, {
      reason: "child-state-unknown",
      detail:
        `child quiescence for legacy OpenCode attempt ${attemptId} could not be proven through the ` +
        `pinned session API (${detail}); the evidence is preserved and the workspace is quarantined`,
      workspacePath,
      manifestPath: null,
      sessionIds: ids,
    });
  }
  // Proven quiescent: there is no manifest, so nothing in the workspace is
  // touched; only the attempt data dir is retired.
  try {
    retireAttemptDataDir(runtime, candidate.attemptDataDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return quarantineAttempt(candidate, {
      reason: "cleanup-failed",
      detail:
        `the data dir for legacy OpenCode attempt ${attemptId} could not be retired (${detail}); ` +
        "its recovery evidence is preserved and the workspace is quarantined",
      workspacePath,
      manifestPath: null,
      sessionIds,
    });
  }
  return recordOutcome({
    attemptId,
    status: "recovered",
    reason: "recovered-quiescent",
    detail:
      `legacy OpenCode attempt ${attemptId} was verified inactive and its ${String(settledChildren)} ` +
      `child session(s) provably quiescent after ${String(settledRounds)} observation round(s); ` +
      "the data dir was retired and no workspace file was touched",
    workspacePath,
    manifestPath: null,
    sessionIds,
  });
}

async function decideManagedManifestAttempt(
  runtime: RecoveryRuntime,
  candidate: RecoveryCandidate,
): Promise<AttemptRecoveryOutcome> {
  const { attemptId, attemptDataDir, manifestPath, manifest } = candidate;
  // The workspace to quarantine: the manifest's own location when the journal
  // is readable (that is where the files were materialized), falling back to
  // the attempt row's recorded workspace for an unreadable journal.
  const quarantineWorkspace =
    manifest !== undefined ? manifest.workspacePath : (candidate.attempt?.workspace_path ?? null);
  const quarantine = (reason: AttemptRecoveryReason, detail: string, sessionIds: string[] = []) =>
    quarantineAttempt(candidate, {
      reason,
      detail,
      workspacePath: quarantineWorkspace,
      manifestPath,
      sessionIds,
    });

  // 1. The manifest must be usable: without it, where the generated files live
  // cannot be proven, so nothing may be touched or deleted.
  if (manifest === undefined) {
    if (quarantineWorkspace === null) {
      // Neither the journal nor the attempt row names a trustworthy location,
      // so the contaminated workspace cannot be identified — let alone
      // quarantined. The only safe action is to refuse to start at all.
      throw new AttemptRecoveryFatalError(
        `attempt data dir ${attemptDataDir} holds an unreadable managed manifest and ` +
          "its attempt row records no workspace path; the contaminated workspace cannot " +
          "be identified or quarantined, so this process refuses to start",
      );
    }
    return quarantine(
      "manifest-corrupt",
      `the attempt manifest at ${manifestPath} exists but could not be read as a ` +
        "version-1 managed manifest; generated content cannot be accounted for, so the " +
        "attempt is preserved and the workspace it names is quarantined",
    );
  }
  const workspacePath = manifest.workspacePath;

  // 2. The owner must be known inactive: a terminal attempt row. A missing row
  // or a still-open outcome means the attempt could be someone else's live run.
  if (candidate.attempt === undefined) {
    return quarantine(
      "missing-attempt-record",
      `no attempt row ${attemptId} exists in the database, so the owner cannot be ` +
        "proven inactive; the manifest and files are preserved and the workspace is quarantined",
    );
  }
  if (candidate.attempt.outcome === null) {
    return quarantine(
      "owner-not-terminal",
      `attempt ${attemptId} has no terminal outcome; the owner cannot be proven inactive`,
    );
  }

  // 2b. The manifest's workspace must agree with the attempt row's recorded
  // workspace when the latter is known; otherwise recovery could prove or clean
  // an unrelated tree.
  if (
    candidate.attempt.workspace_path !== null &&
    !sameResolvedPath(candidate.attempt.workspace_path, workspacePath)
  ) {
    return quarantine(
      "worker-mismatch",
      `the manifest names ${workspacePath} but attempt ${attemptId} recorded workspace ` +
        `${candidate.attempt.workspace_path}; refusing to prove or clean an unrelated tree`,
    );
  }

  // 3. The parent session id must be known: without it the child tree cannot be
  // enumerated, and an unknown tree is exactly the state that must fail closed.
  const parentSessionId = candidate.attempt.agent_session_id;
  if (!parentSessionId) {
    return quarantine(
      "missing-parent-id",
      `attempt ${attemptId} recorded no parent session id, so its child sessions ` +
        "cannot be enumerated; unknown child state preserves the manifest and files and " +
        "quarantines the workspace",
    );
  }
  const sessionIds = [parentSessionId];

  // 4. The workspace the manifest names must still exist: cleaning a vanished
  // workspace is a no-op, but the record of what the attempt owned must survive.
  if (!existsSync(workspacePath)) {
    return quarantine(
      "workspace-missing",
      `the manifest workspace ${workspacePath} no longer exists; the attempt data dir is preserved`,
      sessionIds,
    );
  }

  // 5. Prove the child tree quiescent through the pinned session API. The
  // transport runs under the attempt's exact cwd + environment, so it talks to
  // the same OpenCode service the crashed run used. A missing worker or any
  // discovery/settlement failure is a quarantined outcome — never a deletion.
  const worker =
    runtime.resolveWorker === undefined
      ? undefined
      : runtime.resolveWorker(candidate.attempt, workspacePath);
  if (worker === undefined) {
    return quarantine(
      "worker-unavailable",
      `the pinned session API cannot be reached for attempt ${attemptId}: its run ` +
        "cwd/env could not be reconstructed; unavailable evidence is not a confirmation of quiescence",
      sessionIds,
    );
  }
  // The resolved worker must run in the exact manifest workspace; a stale or
  // otherwise mismatched cwd would prove a different tree's quiescence.
  if (!sameResolvedPath(worker.cwd, workspacePath)) {
    return quarantine(
      "worker-mismatch",
      `the resolved worker cwd ${worker.cwd} is not the manifest workspace ${workspacePath}; ` +
        "refusing to prove an unrelated session tree",
      sessionIds,
    );
  }
  let settledChildrenCount = 0;
  let settledRounds = 0;
  try {
    const settled = await settleAttemptChildren({
      parentSessionId,
      attemptDirectory: worker.cwd,
      http: runtime.sessionHttp(worker),
      timeoutMs: runtime.settleTimeoutMs,
      pollIntervalMs: runtime.settlePollIntervalMs,
      interruptGraceMs: runtime.settleInterruptGraceMs,
      now: runtime.now,
      sleep: runtime.sleep,
    });
    settledChildrenCount = settled.children.length;
    settledRounds = settled.rounds;
    for (const child of settled.children) sessionIds.push(child.id);
  } catch (error) {
    let ids = [...sessionIds];
    if (error instanceof OpenCodeSessionSettleError) {
      ids = [...ids, ...error.unsettledSessionIds, ...error.unknownSessionIds];
    }
    const detail = error instanceof Error ? error.message : String(error);
    return quarantine(
      "child-state-unknown",
      `child quiescence for attempt ${attemptId} could not be proven through the ` +
        `pinned session API (${detail}); the manifest and files are preserved and the workspace is quarantined`,
      ids,
    );
  }

  // 6. Quiescence is proven: remove ONLY the manifest-listed generated files.
  // cleanupManagedOpencodeFiles never overwrites tracked or unowned content,
  // preserves agent-edited bytes in evidence sidecars before unlink, and fails
  // closed on any residual namespace.
  try {
    const cleanup = await cleanupManagedOpencodeFiles({
      workspacePath: manifest.workspacePath,
      manifestPath,
    });
    if (!cleanup.clean) {
      throw new ManagedFilesError([
        {
          reason: "generated-content-remains",
          detail: `startup recovery left generated content in ${manifest.workspacePath}`,
        },
      ]);
    }
    retireAttemptDataDir(runtime, attemptDataDir);
    return recordOutcome({
      attemptId,
      status: "recovered",
      reason: "recovered-quiescent",
      detail:
        `attempt ${attemptId} was verified inactive and its ${String(settledChildrenCount)} ` +
        `child session(s) provably quiescent after ${String(settledRounds)} observation ` +
        `round(s); ${String(cleanup.removed.length)} manifest-owned generated file(s) removed ` +
        "and the data dir retired",
      workspacePath,
      manifestPath,
      sessionIds,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return quarantine(
      "cleanup-failed",
      `generated files or the data dir for attempt ${attemptId} could not all be retired (${detail}); ` +
        "the manifest and data dir are preserved so a later pass or the operator can finish",
      sessionIds,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Do not report recovery unless the directory carrying ownership evidence is gone. */
function retireAttemptDataDir(runtime: RecoveryRuntime, attemptDataDir: string): void {
  runtime.removeAttemptDataDir(attemptDataDir);
  if (existsSync(attemptDataDir)) {
    throw new Error(`attempt data dir ${attemptDataDir} remains after retirement`);
  }
}
