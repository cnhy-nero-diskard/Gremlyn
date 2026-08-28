import { existsSync, realpathSync } from "node:fs";
import { normalize, resolve, win32 } from "node:path";
import type { AgentDefinition, RepoConfig } from "../config/loader.js";
import { git } from "../workspace/gitops.js";
import { parseOriginUrl } from "./infer.js";

export interface VerificationEnvironment {
  pathExists(path: string): boolean;
  isGitWorkTree(path: string): Promise<boolean>;
  originUrl(path: string): Promise<string | undefined>;
}

export interface CheckResult {
  id: string;
  passed: boolean;
  /** Alias useful to renderers that use pass/fail terminology. */
  pass: boolean;
  observed: unknown;
  remedy: string;
  message: string;
}

export interface CheckEntryOptions {
  /** Index of the entry being verified; it must not conflict with itself. */
  entryIndex?: number;
}

export const realVerificationEnvironment: VerificationEnvironment = {
  pathExists: (path) => existsSync(path),
  isGitWorkTree: async (path) => {
    try {
      return (
        (await git(["rev-parse", "--is-inside-work-tree"], { cwd: path })).stdout.trim() === "true"
      );
    } catch {
      return false;
    }
  },
  originUrl: async (path) => {
    try {
      return (await git(["remote", "get-url", "origin"], { cwd: path })).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Resolve a path for containment comparisons. Existing paths are realpathed so
 * a symlinked checkout cannot evade the source/workspace boundary.
 */
export function resolveComparablePath(path: string): string {
  const windowsStyle = isWindowsStyle(path);
  const absolute = windowsStyle ? win32.resolve(path) : resolve(path);
  let resolved = absolute;
  try {
    resolved = realpathSync(path);
  } catch {
    // A workspace root may not exist yet; its lexical absolute path is enough.
  }
  return normalizePathForComparison(resolved, windowsStyle);
}

/** Return true when child is the same path as, or below, parent. */
export function isPathInside(child: string, parent: string): boolean {
  const childPath = resolveComparablePath(child);
  const parentPath = resolveComparablePath(parent);
  if (childPath === parentPath) return true;
  const separator = isWindowsStyle(parentPath) ? "\\" : "/";
  const boundary = parentPath.endsWith(separator) ? parentPath : `${parentPath}${separator}`;
  return childPath.startsWith(boundary);
}

/** Resolve and compare two paths for equality, including Windows case folding. */
export function sameResolvedPath(left: string, right: string): boolean {
  return resolveComparablePath(left) === resolveComparablePath(right);
}

/** Run every registration check, even after failures, so the remedy list is complete. */
export async function checkEntry(
  entry: RepoConfig,
  existingEntries: readonly RepoConfig[],
  agents: Record<string, AgentDefinition>,
  environment: VerificationEnvironment = realVerificationEnvironment,
  options: CheckEntryOptions = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const sourceExists = environment.pathExists(entry.sourcePath);
  results.push(
    check(
      "source-path-exists",
      sourceExists,
      entry.sourcePath,
      sourceExists
        ? `source path ${entry.sourcePath} exists`
        : `source path ${entry.sourcePath} does not exist; create it or supply an existing checkout`,
      "Create or select an existing local checkout for source_path.",
    ),
  );

  const gitWorkTree = sourceExists && (await environment.isGitWorkTree(entry.sourcePath));
  results.push(
    check(
      "source-is-git-work-tree",
      gitWorkTree,
      gitWorkTree ? entry.sourcePath : sourceExists ? "not a git work tree" : "path missing",
      gitWorkTree
        ? `${entry.sourcePath} is a git work tree`
        : `${entry.sourcePath} is not a git work tree; use a checkout rather than a plain directory`,
      "Initialize or clone a Git repository at source_path, then register that path.",
    ),
  );

  const remote =
    sourceExists && gitWorkTree ? await environment.originUrl(entry.sourcePath) : undefined;
  const remoteIdentity = remote ? parseOriginUrl(remote) : undefined;
  const originMatches =
    remoteIdentity !== undefined &&
    remoteIdentity.owner.toLowerCase() === entry.owner.toLowerCase() &&
    remoteIdentity.name.toLowerCase() === entry.name.toLowerCase();
  results.push(
    check(
      "origin-matches-owner-name",
      originMatches,
      remoteIdentity
        ? `${remoteIdentity.owner}/${remoteIdentity.name}`
        : (remote ?? "origin unavailable"),
      originMatches
        ? `origin addresses ${entry.owner}/${entry.name}`
        : remoteIdentity
          ? `origin addresses ${remoteIdentity.owner}/${remoteIdentity.name}, not ${entry.owner}/${entry.name}`
          : "origin is missing or does not address a GitHub repository",
      `Set origin to the GitHub repository ${entry.owner}/${entry.name}, or supply matching owner and name.`,
    ),
  );

  const sourceBoundaryOk = !isPathInside(entry.workspaceRoot, entry.sourcePath);
  results.push(
    check(
      "workspace-outside-source",
      sourceBoundaryOk,
      { workspaceRoot: entry.workspaceRoot, sourcePath: entry.sourcePath },
      sourceBoundaryOk
        ? "workspace root is outside the source repository"
        : "workspace root is the source path or lies inside the source repository",
      "Set workspace_root to a directory outside source_path.",
    ),
  );

  const conflictingSource = existingEntries.find((other, index) => {
    if (index === options.entryIndex) return false;
    return isPathInside(entry.workspaceRoot, other.sourcePath);
  });
  results.push(
    check(
      "workspace-outside-other-sources",
      conflictingSource === undefined,
      conflictingSource?.sourcePath ?? "no configured source contains workspace root",
      conflictingSource
        ? `workspace root lies inside ${conflictingSource.owner}/${conflictingSource.name} source path ${conflictingSource.sourcePath}`
        : "workspace root is outside every other configured source path",
      conflictingSource
        ? `Choose a workspace_root outside ${conflictingSource.owner}/${conflictingSource.name} at ${conflictingSource.sourcePath}.`
        : "Keep workspace_root outside every configured source_path.",
    ),
  );

  const workspaceConflict = existingEntries.find((other, index) => {
    if (index === options.entryIndex) return false;
    return sameResolvedPath(entry.workspaceRoot, other.workspaceRoot);
  });
  results.push(
    check(
      "workspace-root-available",
      workspaceConflict === undefined,
      workspaceConflict
        ? `${workspaceConflict.owner}/${workspaceConflict.name} uses ${workspaceConflict.workspaceRoot}`
        : entry.workspaceRoot,
      workspaceConflict
        ? `workspace root collides with ${workspaceConflict.owner}/${workspaceConflict.name}`
        : "workspace root does not collide with another entry",
      workspaceConflict
        ? `Choose a different workspace_root from ${workspaceConflict.workspaceRoot}.`
        : "Use a workspace_root not already assigned to another repository.",
    ),
  );

  const duplicate = existingEntries.find((other, index) => {
    if (index === options.entryIndex) return false;
    return (
      other.owner.toLowerCase() === entry.owner.toLowerCase() &&
      other.name.toLowerCase() === entry.name.toLowerCase()
    );
  });
  results.push(
    check(
      "repository-not-duplicate",
      duplicate === undefined,
      duplicate ? `${duplicate.owner}/${duplicate.name}` : `${entry.owner}/${entry.name}`,
      duplicate
        ? `repository ${entry.owner}/${entry.name} is already registered`
        : `no existing entry registers ${entry.owner}/${entry.name}`,
      duplicate
        ? `Use the existing ${duplicate.owner}/${duplicate.name} entry or choose another repository.`
        : "Register each GitHub owner/name pair only once.",
    ),
  );

  const agent = agents[entry.agent];
  results.push(
    check(
      "agent-known",
      agent !== undefined,
      entry.agent,
      agent ? `agent ${entry.agent} is configured` : `agent ${entry.agent} is not configured`,
      agent
        ? "Keep the configured agent entry available."
        : `Add ${entry.agent} under agents or choose one of: ${Object.keys(agents).join(", ") || "(none)"}.`,
    ),
  );

  const modelAllowed =
    entry.allowedModels.length === 0 || entry.allowedModels.includes(entry.model);
  results.push(
    check(
      "model-allowed",
      modelAllowed,
      { model: entry.model, allowedModels: entry.allowedModels },
      modelAllowed
        ? entry.allowedModels.length === 0
          ? `model ${entry.model} is permitted because allowed_models is empty`
          : `model ${entry.model} is in allowed_models`
        : `model ${entry.model} is outside allowed_models (${entry.allowedModels.join(", ")})`,
      modelAllowed
        ? "Keep allowed_models empty deliberately or retain the model in its non-empty list."
        : `Choose one of the permitted models: ${entry.allowedModels.join(", ")}.`,
    ),
  );

  return results;
}

export function allChecksPassed(results: readonly CheckResult[]): boolean {
  return results.every((result) => result.passed);
}

export function failedChecks(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((result) => !result.passed);
}

function check(
  id: string,
  passed: boolean,
  observed: unknown,
  message: string,
  remedy: string,
): CheckResult {
  return { id, passed, pass: passed, observed, message, remedy };
}

function normalizePathForComparison(path: string, windowsStyle = isWindowsStyle(path)): string {
  if (!windowsStyle) return normalize(path).replace(/[\\/]$/u, "") || "/";
  const normalized = win32.normalize(path).replace(/[\\/]$/u, "");
  return normalized.toLowerCase() || win32.parse(normalized).root.toLowerCase();
}

function isWindowsStyle(path: string): boolean {
  return /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\") || path.includes("\\");
}
