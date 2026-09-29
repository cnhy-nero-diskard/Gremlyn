/**
 * Startup recovery for managed OpenCode attempts (task 3.6; design D3/D4;
 * capability `opencode-agent-profiles`).
 *
 * The legacy startup sweep (see {@link cleanupStaleAttemptDirs} in
 * `src/index.ts`) treats an attempt whose job the startup sweep marked
 * `interrupted` as disposable and deletes its data dir. That is safe for a
 * Cline attempt, whose agent process cannot outlive its run, but never for a
 * managed OpenCode attempt:
 *
 * - its data dir journals the attempt manifest OUTSIDE the worktree — the only
 *   record of what the attempt owned and where its generated files live;
 * - a background child of the crashed run may still be alive in the shared
 *   OpenCode service and able to write to the workspace; and
 * - the generated agent files (carrying the operator's private instructions,
 *   possibly edited by the agent) may still sit in the reuse worktree where a
 *   later attempt could discover or publish them.
 *
 * This module is the managed half of the startup sweep. Every candidate is
 * decided by two independent proofs, and ONLY when both hold is the attempt
 * RECOVERED:
 *
 * 1. the OWNER is known inactive — the attempt row exists and already carries a
 *    terminal outcome (the startup sweep marks the crashed current attempt
 *    `interrupted`; an attempt preserved for runtime uncertainty already
 *    carries `failed`/`cancelled`); and
 * 2. the CHILD TREE is provably quiescent through the pinned session API
 *    (`opencode api`, the same surface the runtime settlement uses), so no
 *    child can still modify the workspace.
 *
 * Recovery then removes ONLY the manifest-listed generated files from the
 * worktree (via {@link cleanupManagedOpencodeFiles} — nothing unowned or
 * tracked is ever touched, and agent-edited bytes are preserved in
 * content-addressed evidence sidecars before unlink) and retires the data dir.
 *
 * Everything else QUARANTINES the attempt: the manifest, every generated file,
 * and every piece of evidence are left exactly where they are, a durable
 * `recovery.json` record is journaled into the data dir (naming the workspace
 * it owns), and the orchestrator's workspace admission gates refuse to reuse
 * or publish that workspace. An unavailable or unreadable session API NEVER
 * counts as a confirmation of quiescence — it is a fail-closed quarantine, per
 * design D4's "a child that cannot be confirmed stopped leaves a failed,
 * quarantined attempt and diagnostic evidence".
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
  | "cleanup-failed";

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
 * True when an attempt data dir belongs to the managed lifecycle — it journals
 * an attempt manifest (even an unreadable one) or already carries a durable
 * recovery record. Such a dir must never be deleted by the legacy sweep or
 * trimmed by artifact retention: its manifest/evidence is the only record of
 * what the attempt owned, and its quarantine gates every workspace admission.
 */
export function isManagedAttemptDataDir(attemptDataDir: string): boolean {
  return (
    existsSync(managedOpencodeManifestPath(attemptDataDir)) ||
    existsSync(attemptRecoveryRecordPath(attemptDataDir))
  );
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
   * Resolve the exact cwd + environment the crashed attempt's run received so
   * the pinned session API talks to the same OpenCode service. `undefined`
   * means the surface cannot be reached and the attempt is quarantined.
   */
  resolveWorker?: (
    attempt: AttemptRow,
    workspacePath: string,
  ) => { cwd: string; env: Record<string, string> } | undefined;
  /** Pinned-session HTTP; defaults to the `opencode api` CLI transport. */
  sessionHttp?: (worker: { cwd: string; env: Record<string, string> }) => ManagedSessionHttp;
  settleTimeoutMs?: number;
  settlePollIntervalMs?: number;
  settleInterruptGraceMs?: number;
  actions?: Pick<OperatorActionStore, "record">;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  /** Injectable clock and sleeper for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  attempt: AttemptRow | undefined;
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
  sessionHttp: (worker: { cwd: string; env: Record<string, string> }) => ManagedSessionHttp;
  settleTimeoutMs: number;
  settlePollIntervalMs: number;
  settleInterruptGraceMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * The managed half of the startup sweep. Scans `dataDir/attempts` for data
 * dirs holding a managed manifest and decides each: recover (proven inactive +
 * quiescent) or quarantine (everything else). Never deletes a dir holding a
 * manifest unless BOTH proofs hold. Idempotent: a quarantined attempt is
 * re-decided on the next startup (a session that finally proves quiescent is
 * then recovered), and a recovered attempt's dir no longer exists.
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
    ...(input.actions === undefined ? {} : { actions: input.actions }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.resolveWorker === undefined ? {} : { resolveWorker: input.resolveWorker }),
  };

  const report: AttemptRecoveryReport = { candidates: 0, recovered: [], quarantined: [] };
  for (const entry of listCandidateDirs(input.dataDir)) {
    const attemptId = Number(entry);
    const attemptDataDir = join(input.dataDir, "attempts", entry);
    const manifestPath = managedOpencodeManifestPath(attemptDataDir);
    // Only dirs that journaled a manifest are managed-materialized attempts;
    // everything else belongs to the legacy sweep (cleanupStaleAttemptDirs).
    if (!existsSync(manifestPath)) continue;
    report.candidates += 1;
    const candidate: RecoveryCandidate = {
      attemptId,
      attemptDataDir,
      manifestPath,
      manifest: readManagedOpencodeManifest(manifestPath),
      attempt: readAttemptRow(input.db, attemptId),
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

async function decideAttempt(
  runtime: RecoveryRuntime,
  candidate: RecoveryCandidate,
): Promise<AttemptRecoveryOutcome> {
  const { attemptId, attemptDataDir, manifestPath, manifest } = candidate;
  // The workspace to quarantine: the manifest's own location when the journal
  // is readable (that is where the files were materialized), falling back to
  // the attempt row's recorded workspace for an unreadable journal.
  const quarantineWorkspace =
    manifest !== undefined ? manifest.workspacePath : (candidate.attempt?.workspace_path ?? null);
  const quarantine = (reason: AttemptRecoveryReason, detail: string, sessionIds: string[] = []) => {
    // The durable record is the admission gate for every workspace use; a
    // failure to journal it must fail the process rather than leave a
    // contaminated workspace silently reusable (design task 3.6).
    writeAttemptRecoveryRecord(attemptDataDir, {
      version: 1,
      attemptId,
      status: "quarantined",
      reason,
      detail,
      workspacePath: quarantineWorkspace,
      manifestPath,
      sessionIds,
      recordedAt: new Date().toISOString(),
    });
    return recordOutcome({
      attemptId,
      status: "quarantined",
      reason,
      detail,
      workspacePath: quarantineWorkspace,
      manifestPath,
      sessionIds,
    });
  };

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
    removeAttemptDataDir(attemptDataDir);
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
      `generated files for attempt ${attemptId} could not all be removed (${detail}); ` +
        "the manifest and data dir are preserved so a later pass or the operator can finish",
      sessionIds,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
