import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { OperatorActionStore } from "../store/actions.js";
import { TERMINAL_STATUSES } from "../types.js";
import { git, statusEntries } from "./gitops.js";
import { isBeneath, workspacePathFor } from "./worktree.js";

/** The filesystem and registry facts needed to reclaim one repository's workspaces. */
export interface ReclamationRepository {
  id: number;
  sourcePath: string;
  workspaceRoot: string;
}

export type WorkspaceReclamationOutcome = "reclaimed" | "retained" | "preview";

export interface WorkspaceReclamationDecision {
  repositoryId: number;
  prNumber: number;
  path: string;
  outcome: WorkspaceReclamationOutcome;
  reason: string;
}

export interface WorkspaceReclamationReport {
  candidates: number;
  reclaimed: number;
  retained: number;
  decisions: WorkspaceReclamationDecision[];
}

export interface WorkspaceReclamationOptions {
  db: Database.Database;
  repositories: readonly ReclamationRepository[];
  minimumAgeMs: number;
  actions: Pick<OperatorActionStore, "record">;
  /** Used by tests and preview tooling; defaults to the current wall clock. */
  now?: number | Date;
  /** Report decisions without removing anything. */
  preview?: boolean;
}

/**
 * Enumerate only deterministic workspace paths. Directory names are parsed to
 * find a PR number, then the canonical path is derived again and checked with
 * the same confinement guard used by resetWorkspace. Unknown names, sibling
 * checkouts, and symlinks never become candidates.
 */
export async function listReclamationCandidates(
  repositories: readonly ReclamationRepository[],
): Promise<Array<{ repositoryId: number; prNumber: number; path: string }>> {
  const candidates: Array<{ repositoryId: number; prNumber: number; path: string }> = [];
  const seen = new Set<string>();
  for (const repository of repositories) {
    let entries;
    try {
      entries = await readdir(repository.workspaceRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = /^pr-([1-9]\d*)$/u.exec(entry.name);
      if (!match) continue;
      const prNumber = Number(match[1]);
      if (!Number.isSafeInteger(prNumber)) continue;
      const path = workspacePathFor(repository.workspaceRoot, prNumber);
      if (!isBeneath(path, repository.workspaceRoot)) continue;
      if (resolve(path) !== resolve(join(repository.workspaceRoot, entry.name))) continue;
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ repositoryId: repository.id, prNumber, path });
    }
  }
  return candidates;
}

/** Reclaim eligible workspaces, or return the same decisions in preview mode. */
export async function reclaimWorkspaces(
  options: WorkspaceReclamationOptions,
): Promise<WorkspaceReclamationReport> {
  if (!Number.isFinite(options.minimumAgeMs) || options.minimumAgeMs < 0) {
    throw new Error("workspace reclamation minimum age must be a non-negative finite number");
  }
  const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  if (!Number.isFinite(nowMs)) throw new Error("workspace reclamation clock is invalid");

  const repositories = new Map(options.repositories.map((repository) => [repository.id, repository]));
  const found = await listReclamationCandidates(options.repositories);
  const decisions: WorkspaceReclamationDecision[] = [];
  for (const item of found) {
    const repository = repositories.get(item.repositoryId);
    if (!repository) continue;
    const eligibility = await inspectCandidate(options.db, repository, item.prNumber, item.path, nowMs, options.minimumAgeMs);
    if (!eligibility.ok) {
      const decision: WorkspaceReclamationDecision = {
        repositoryId: repository.id,
        prNumber: item.prNumber,
        path: item.path,
        outcome: "retained",
        reason: eligibility.reason,
      };
      decisions.push(decision);
      recordDecision(options.actions, decision, options.preview === true);
      continue;
    }

    if (options.preview === true) {
      const decision: WorkspaceReclamationDecision = {
        repositoryId: repository.id,
        prNumber: item.prNumber,
        path: item.path,
        outcome: "preview",
        reason: eligibility.reason,
      };
      decisions.push(decision);
      recordDecision(options.actions, decision, true);
      continue;
    }

    try {
      await removeWorkspace(repository, item.path);
      const decision: WorkspaceReclamationDecision = {
        repositoryId: repository.id,
        prNumber: item.prNumber,
        path: item.path,
        outcome: "reclaimed",
        reason: eligibility.reason,
      };
      decisions.push(decision);
      recordDecision(options.actions, decision, false);
    } catch (error) {
      const decision: WorkspaceReclamationDecision = {
        repositoryId: repository.id,
        prNumber: item.prNumber,
        path: item.path,
        outcome: "retained",
        reason: `reclamation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      decisions.push(decision);
      recordDecision(options.actions, decision, false);
    }
  }

  return {
    candidates: found.length,
    reclaimed: decisions.filter((decision) => decision.outcome === "reclaimed").length,
    retained: decisions.filter((decision) => decision.outcome === "retained").length,
    decisions,
  };
}

/** Explicit preview entry point for callers that should never remove files. */
export function previewWorkspaceReclamation(
  options: Omit<WorkspaceReclamationOptions, "preview">,
): Promise<WorkspaceReclamationReport> {
  return reclaimWorkspaces({ ...options, preview: true });
}

async function inspectCandidate(
  db: Database.Database,
  repository: ReclamationRepository,
  prNumber: number,
  path: string,
  nowMs: number,
  minimumAgeMs: number,
): Promise<{ ok: true; reason: string } | { ok: false; reason: string }> {
  try {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    const active = db
      .prepare(
        `SELECT 1 AS present FROM jobs
         WHERE repo_id = ? AND pr_number = ? AND status NOT IN (${placeholders})
         LIMIT 1`,
      )
      .get(repository.id, prNumber, ...TERMINAL_STATUSES) as { present: number } | undefined;
    if (active) return { ok: false, reason: "retained: a non-terminal job is still active" };
  } catch (error) {
    return {
      ok: false,
      reason: `retained: could not determine active jobs (${errorMessage(error)})`,
    };
  }

  let modifiedAt: number;
  try {
    modifiedAt = (await stat(path)).mtimeMs;
  } catch (error) {
    return { ok: false, reason: `retained: could not determine workspace age (${errorMessage(error)})` };
  }
  if (!Number.isFinite(modifiedAt)) {
    return { ok: false, reason: "retained: workspace age is not finite" };
  }
  const ageMs = nowMs - modifiedAt;
  if (ageMs < minimumAgeMs) {
    return { ok: false, reason: `retained: workspace is newer than ${formatAge(minimumAgeMs)}` };
  }

  let status: string[];
  try {
    status = await statusEntries(path);
  } catch (error) {
    return { ok: false, reason: `retained: could not determine workspace cleanliness (${errorMessage(error)})` };
  }
  if (status.length > 0) {
    return { ok: false, reason: "retained: workspace holds uncommitted or untracked work" };
  }
  return { ok: true, reason: `eligible: inactive for ${formatAge(ageMs)} and clean` };
}

async function removeWorkspace(repository: ReclamationRepository, path: string): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", path], { cwd: repository.sourcePath });
  } catch {
    await rm(path, { recursive: true, force: true });
  }
  await git(["worktree", "prune"], { cwd: repository.sourcePath });
  if (existsSync(path)) throw new Error("workspace directory still exists after removal");
}

function recordDecision(
  actions: Pick<OperatorActionStore, "record">,
  decision: WorkspaceReclamationDecision,
  preview: boolean,
): void {
  actions.record({
    action: "workspace-reclamation",
    target: decision.path,
    effect: preview ? "preview" : decision.outcome,
    detail: {
      repositoryId: decision.repositoryId,
      prNumber: decision.prNumber,
      reason: decision.reason,
      preview,
    },
  });
}

function formatAge(milliseconds: number): string {
  const hours = Math.max(0, Math.round(milliseconds / 3_600_000));
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
