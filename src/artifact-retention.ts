import type Database from "better-sqlite3";
import { lstat, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OperatorActionStore } from "./store/actions.js";
import { TERMINAL_STATUSES } from "./types.js";

/** The disk-backed artifacts Gremlyn is allowed to trim. */
export type ArtifactKind = "agent-output" | "validation-output" | "attempt-state";

interface AttemptOwner {
  attemptId: number;
  jobId: number;
  status: string;
  outputRef: string | null;
}

interface ArtifactHint {
  path: string;
  attemptId: number;
  kind: ArtifactKind;
}

export interface ArtifactRecord {
  path: string;
  kind: ArtifactKind;
  attemptId: number;
  jobId: number;
  status: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface ArtifactRetentionDecision extends ArtifactRecord {
  outcome: "removed" | "retained";
  reason: string;
}

export interface ArtifactRetentionReport {
  candidates: number;
  totalBytes: number;
  remainingBytes: number;
  protectedBytes: number;
  removedBytes: number;
  removed: number;
  retained: number;
  decisions: ArtifactRetentionDecision[];
}

export interface ArtifactRetentionOptions {
  dataDir: string;
  db: Database.Database;
  /** Terminal artifacts older than this are removed regardless of the ceiling. */
  maximumAgeMs: number;
  /** The combined size of managed artifacts, including protected live artifacts. */
  maximumTotalBytes: number;
  actions?: Pick<OperatorActionStore, "record">;
  now?: Date | number;
}

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/**
 * Apply the terminal-artifact retention policy.
 *
 * Only paths Gremlyn derives from its own data layout, or paths already
 * recorded beneath that data directory, are considered. A live job protects
 * every artifact belonging to it; terminal artifacts are selected oldest-first
 * when the total ceiling still needs trimming after age-based removal.
 */
export async function retainArtifacts(
  options: ArtifactRetentionOptions,
): Promise<ArtifactRetentionReport> {
  validateOptions(options);
  const owners = loadAttemptOwners(options.db);
  const candidates = await collectArtifacts(options.dataDir, options.db, owners);
  const totalBytes = candidates.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const protectedBytes = candidates
    .filter((artifact) => !TERMINAL.has(artifact.status))
    .reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const plans = new Map<string, string>();
  const cutoff = toMillis(options.now) - options.maximumAgeMs;

  for (const artifact of candidates) {
    if (!TERMINAL.has(artifact.status)) continue;
    if (artifact.modifiedAtMs <= cutoff) {
      plans.set(
        pathKey(artifact.path),
        `older than maximum age (${formatAge(options.maximumAgeMs)})`,
      );
    }
  }

  let projectedBytes = totalBytes;
  for (const artifact of candidates
    .filter((candidate) => TERMINAL.has(candidate.status))
    .filter((candidate) => !plans.has(pathKey(candidate.path)))
    .sort(compareOldest)) {
    if (projectedBytes <= options.maximumTotalBytes) break;
    plans.set(
      pathKey(artifact.path),
      `total size exceeds ${formatBytes(options.maximumTotalBytes)}; trimmed oldest-first`,
    );
    projectedBytes -= artifact.sizeBytes;
  }

  const decisions: ArtifactRetentionDecision[] = [];
  let removedBytes = 0;
  for (const artifact of candidates) {
    const reason = plans.get(pathKey(artifact.path));
    if (reason === undefined) {
      decisions.push({ ...artifact, outcome: "retained", reason: retainedReason(artifact) });
      continue;
    }
    try {
      await rm(artifact.path, { recursive: true, force: true });
      const stillPresent = await pathExists(artifact.path);
      if (stillPresent) throw new Error("path remains after removal");
      removedBytes += artifact.sizeBytes;
      const decision = { ...artifact, outcome: "removed" as const, reason };
      decisions.push(decision);
      options.actions?.record({
        action: "artifact-retention",
        target: artifact.path,
        effect: "removed",
        detail: {
          attemptId: artifact.attemptId,
          jobId: artifact.jobId,
          kind: artifact.kind,
          bytes: artifact.sizeBytes,
          reason,
        },
      });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const decision = {
        ...artifact,
        outcome: "retained" as const,
        reason: `retained: removal failed (${failure})`,
      };
      decisions.push(decision);
      options.actions?.record({
        action: "artifact-retention",
        target: artifact.path,
        effect: "retained",
        detail: {
          attemptId: artifact.attemptId,
          jobId: artifact.jobId,
          kind: artifact.kind,
          bytes: artifact.sizeBytes,
          reason: decision.reason,
        },
      });
    }
  }

  const removed = decisions.filter((decision) => decision.outcome === "removed");
  return {
    candidates: candidates.length,
    totalBytes,
    remainingBytes: totalBytes - removedBytes,
    protectedBytes,
    removedBytes,
    removed: removed.length,
    retained: decisions.length - removed.length,
    decisions,
  };
}

function validateOptions(options: ArtifactRetentionOptions): void {
  if (!Number.isFinite(options.maximumAgeMs) || options.maximumAgeMs < 0) {
    throw new Error("maximumAgeMs must be a non-negative finite number");
  }
  if (
    !Number.isSafeInteger(options.maximumTotalBytes) ||
    options.maximumTotalBytes < 0
  ) {
    throw new Error("maximumTotalBytes must be a non-negative safe integer");
  }
}

function loadAttemptOwners(db: Database.Database): Map<number, AttemptOwner> {
  const rows = db
    .prepare(
      `SELECT attempts.id AS attempt_id, attempts.job_id, attempts.output_ref,
              jobs.status
       FROM attempts JOIN jobs ON jobs.id = attempts.job_id`,
    )
    .all() as {
    attempt_id: number;
    job_id: number;
    output_ref: string | null;
    status: string;
  }[];
  return new Map(
    rows.map((row) => [
      row.attempt_id,
      {
        attemptId: row.attempt_id,
        jobId: row.job_id,
        status: row.status,
        outputRef: row.output_ref,
      },
    ]),
  );
}

async function collectArtifacts(
  dataDir: string,
  db: Database.Database,
  owners: Map<number, AttemptOwner>,
): Promise<ArtifactRecord[]> {
  const hints = new Map<string, ArtifactHint>();
  const add = (path: string, attemptId: number, kind: ArtifactKind): void => {
    const safe = pathInsideDataDir(path, dataDir);
    if (safe === undefined || !owners.has(attemptId)) return;
    const key = pathKey(safe);
    if (!hints.has(key)) hints.set(key, { path: safe, attemptId, kind });
  };

  for (const owner of owners.values()) {
    add(join(dataDir, "output", `attempt-${owner.attemptId}.json`), owner.attemptId, "agent-output");
    add(
      join(dataDir, "output", `attempt-${owner.attemptId}.activity.json`),
      owner.attemptId,
      "agent-output",
    );
    add(join(dataDir, "attempts", String(owner.attemptId)), owner.attemptId, "attempt-state");
    if (owner.outputRef !== null) add(owner.outputRef, owner.attemptId, "agent-output");
  }

  const validationRows = db
    .prepare("SELECT attempt_id, seq, output_ref FROM validation_runs")
    .all() as { attempt_id: number; seq: number; output_ref: string | null }[];
  for (const row of validationRows) {
    add(
      join(dataDir, "validation", `attempt-${row.attempt_id}-${row.seq}.json`),
      row.attempt_id,
      "validation-output",
    );
    if (row.output_ref !== null) add(row.output_ref, row.attempt_id, "validation-output");
  }

  for (const entry of await directoryEntries(join(dataDir, "output"))) {
    if (!entry.isFile()) continue;
    const match = /^attempt-(\d+)(?:\.activity)?\.json$/u.exec(entry.name);
    if (!match) continue;
    const attemptId = Number(match[1]);
    if (Number.isSafeInteger(attemptId) && attemptId > 0) {
      add(join(dataDir, "output", entry.name), attemptId, "agent-output");
    }
  }
  for (const entry of await directoryEntries(join(dataDir, "validation"))) {
    if (!entry.isFile()) continue;
    const match = /^attempt-(\d+)-\d+\.json$/u.exec(entry.name);
    if (!match) continue;
    const attemptId = Number(match[1]);
    if (Number.isSafeInteger(attemptId) && attemptId > 0) {
      add(join(dataDir, "validation", entry.name), attemptId, "validation-output");
    }
  }
  for (const entry of await directoryEntries(join(dataDir, "attempts"))) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const attemptId = Number(entry.name);
    if (Number.isSafeInteger(attemptId) && attemptId > 0) {
      add(join(dataDir, "attempts", entry.name), attemptId, "attempt-state");
    }
  }

  const records: ArtifactRecord[] = [];
  for (const hint of hints.values()) {
    const measured = await measure(hint.path, hint.kind);
    const owner = owners.get(hint.attemptId);
    if (measured === undefined || owner === undefined) continue;
    records.push({
      path: hint.path,
      kind: hint.kind,
      attemptId: owner.attemptId,
      jobId: owner.jobId,
      status: owner.status,
      ...measured,
    });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function directoryEntries(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function measure(
  path: string,
  kind: ArtifactKind,
): Promise<{ sizeBytes: number; modifiedAtMs: number } | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return undefined;
    if (kind !== "attempt-state") {
      return info.isFile() && Number.isFinite(info.mtimeMs)
        ? { sizeBytes: info.size, modifiedAtMs: info.mtimeMs }
        : undefined;
    }
    if (!info.isDirectory() || !Number.isFinite(info.mtimeMs)) return undefined;
    let sizeBytes = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) continue;
      if (childInfo.isFile()) {
        sizeBytes += childInfo.size;
      } else if (childInfo.isDirectory()) {
        const nested = await measureDirectory(child);
        if (nested === undefined) return undefined;
        sizeBytes += nested.sizeBytes;
      }
    }
    return { sizeBytes, modifiedAtMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

async function measureDirectory(
  path: string,
): Promise<{ sizeBytes: number } | undefined> {
  try {
    let sizeBytes = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) continue;
      if (childInfo.isFile()) {
        sizeBytes += childInfo.size;
      } else if (childInfo.isDirectory()) {
        const nested = await measureDirectory(child);
        if (nested === undefined) return undefined;
        sizeBytes += nested.sizeBytes;
      }
    }
    return { sizeBytes };
  } catch {
    return undefined;
  }
}

function pathInsideDataDir(path: string, dataDir: string): string | undefined {
  const candidate = resolve(isAbsolute(path) ? path : join(dataDir, path));
  const base = resolve(dataDir);
  const rel = relative(base, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return candidate;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compareOldest(a: ArtifactRecord, b: ArtifactRecord): number {
  return a.modifiedAtMs - b.modifiedAtMs || a.path.localeCompare(b.path);
}

function retainedReason(artifact: ArtifactRecord): string {
  return TERMINAL.has(artifact.status)
    ? "retained: within maximum age and total-size limits"
    : `retained: job is ${artifact.status}, not terminal`;
}

function toMillis(value: Date | number | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.now();
}

function formatAge(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds % 86_400 === 0) return `${String(seconds / 86_400)}d`;
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)}h`;
  return `${String(seconds)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${String(bytes)} bytes`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
