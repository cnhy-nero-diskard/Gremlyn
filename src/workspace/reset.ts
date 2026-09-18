import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { OperatorActionStore } from "../store/actions.js";
import { git, workspaceSnapshot, type WorkspaceSnapshot } from "./gitops.js";
import {
  isBeneath,
  prepareWorkspace,
  type PreparedWorkspace,
  WorkspaceError,
  workspacePathFor,
} from "./worktree.js";

/**
 * Explicit workspace reset (design D9, workspace-isolation spec).
 *
 * `git reset --hard` and `git clean -fd` exist ONLY here: discarding working
 * tree contents happens solely through this deliberately requested action,
 * and only after the target path is asserted to lie beneath a configured
 * workspace root. Everything else refuses to touch workspace contents.
 */

export async function resetWorkspace(options: {
  sourcePath: string;
  workspaceRoot: string;
  prNumber: number;
  headBranch: string;
  headSha: string;
  targetPath?: string;
  /** Repository-relative gitignored files copied from the source checkout. */
  seedFiles?: readonly string[];
  actions: Pick<OperatorActionStore, "record">;
}): Promise<PreparedWorkspace> {
  const expectedPath = workspacePathFor(options.workspaceRoot, options.prNumber);
  const targetPath = options.targetPath ?? expectedPath;
  const validTarget =
    isBeneath(targetPath, options.workspaceRoot) && resolve(targetPath) === resolve(expectedPath);

  if (!validTarget) {
    options.actions.record({
      action: "workspace-reset",
      target: targetPath,
      effect: "refused",
      detail: { reason: "workspace-outside-root" },
    });
    throw new WorkspaceError(
      "workspace-outside-root",
      `refusing to reset ${targetPath}: it is not the configured workspace for PR ${options.prNumber}`,
    );
  }

  if (existsSync(targetPath)) {
    try {
      await git(["worktree", "remove", "--force", targetPath], {
        cwd: options.sourcePath,
      });
    } catch {
      await rm(targetPath, { recursive: true, force: true });
      await git(["worktree", "prune"], { cwd: options.sourcePath });
    }
  }

  const prepared = await prepareWorkspace(options);
  options.actions.record({
    action: "workspace-reset",
    target: targetPath,
    effect: "recreated",
    detail: { prNumber: options.prNumber, headSha: prepared.headSha },
  });
  return prepared;
}

/**
 * In-place refresh for the quarantine-before-retry path.
 *
 * Unlike {@link resetWorkspace}, which removes and recreates the checkout
 * (discarding everything, including gitignored dependencies a fresh workspace
 * needs for validation), this resets the existing checkout to the expected
 * head in place: `git reset --hard` restores tracked files and `git clean
 * -fd` removes untracked files that are not ignored. Ignored files such as an
 * installed `node_modules` survive, so a refreshed workspace can still build
 * and test without a reinstall. The stranded work must already be quarantined
 * elsewhere — this discards the working tree by design.
 *
 * The target guards are the same as the explicit reset: only the derived
 * workspace path beneath its workspace root.
 */
export async function refreshWorkspaceTree(options: {
  workspaceRoot: string;
  prNumber: number;
  headSha: string;
  expectedSnapshot?: WorkspaceSnapshot;
  actions?: Pick<OperatorActionStore, "record">;
  auditContext?: {
    jobId: number;
    priorAttemptId: number;
    priorHead: string;
    expectedHead: string;
    priorFailureReason: string | null;
    patchRef: string;
  };
  refreshContext?: {
    workspaceHead: string;
    files: string[];
    stashSha: string | null;
  };
  /** Test seam for forcing a failure at a specific destructive step. */
  runGit?: typeof git;
}): Promise<string> {
  const expectedPath = workspacePathFor(options.workspaceRoot, options.prNumber);
  const runGit = options.runGit ?? git;
  const recordRefresh = (
    effect: "quarantined-and-recreated" | "failed" | "partial",
    stage: "reset" | "clean" | "refresh",
    message?: string,
  ): void => {
    options.actions?.record({
      action: "workspace-quarantine",
      target: expectedPath,
      effect,
      detail: {
        ...(options.auditContext ?? {}),
        ...(options.refreshContext ?? {}),
        reason: options.auditContext?.priorFailureReason ?? null,
        stage,
        ...(message === undefined ? {} : { message }),
      },
    });
  };
  const recordRefusal = (check: string, message?: string): void => {
    options.actions?.record({
      action: "workspace-quarantine",
      target: expectedPath,
      effect: "refused",
      detail: {
        reason: "workspace-dirty",
        check,
        ...(message === undefined ? {} : { message }),
        ...(options.auditContext ?? {}),
      },
    });
  };
  if (!isBeneath(expectedPath, options.workspaceRoot)) {
    options.actions?.record({
      action: "workspace-quarantine",
      target: expectedPath,
      effect: "refused",
      detail: { reason: "workspace-outside-root" },
    });
    throw new WorkspaceError(
      "workspace-outside-root",
      `refusing to refresh ${expectedPath}: it is not beneath the configured workspace root`,
    );
  }
  await runGit(["fetch", "origin", "--prune"], { cwd: expectedPath });
  if (options.expectedSnapshot !== undefined) {
    let actualSnapshot: WorkspaceSnapshot;
    try {
      actualSnapshot = await workspaceSnapshot(expectedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordRefusal("snapshot-unavailable", message);
      throw new WorkspaceError(
        "workspace-dirty",
        `refusing to refresh ${expectedPath}: workspace state could not be re-checked: ${message}`,
      );
    }
    if (
      actualSnapshot.headSha !== options.expectedSnapshot.headSha ||
      actualSnapshot.status !== options.expectedSnapshot.status ||
      actualSnapshot.fingerprint !== options.expectedSnapshot.fingerprint
    ) {
      recordRefusal("snapshot-mismatch");
      throw new WorkspaceError(
        "workspace-dirty",
        `refusing to refresh ${expectedPath}: workspace changed after quarantine validation`,
      );
    }
  }
  try {
    await runGit(["reset", "--hard", options.headSha], { cwd: expectedPath });
  } catch (error) {
    recordRefresh("failed", "reset", error instanceof Error ? error.message : String(error));
    throw error;
  }
  try {
    await runGit(["clean", "-fd"], { cwd: expectedPath });
  } catch (error) {
    recordRefresh("partial", "clean", error instanceof Error ? error.message : String(error));
    throw error;
  }
  recordRefresh("quarantined-and-recreated", "refresh");
  return expectedPath;
}
