import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { currentBranch, git, headSha, statusEntries } from "./gitops.js";

/**
 * Worktree management (design D9, workspace-isolation spec).
 *
 * Workspaces live at `<workspace_root>/pr-<number>` — derived from registry
 * configuration and an integer PR number, never from GitHub-supplied text.
 * Dirty means stop: an unsafe workspace fails the job, it is never
 * discarded implicitly.
 */

export type WorkspaceFailureReason =
  | "workspace-dirty"
  | "workspace-conflicted"
  | "workspace-diverged"
  | "workspace-not-worktree"
  | "workspace-outside-root";

export class WorkspaceError extends Error {
  readonly reason: WorkspaceFailureReason;
  constructor(reason: WorkspaceFailureReason, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.reason = reason;
  }
}

export interface PreparedWorkspace {
  path: string;
  branch: string;
  headSha: string;
  /** Whether the workspace was created fresh or refreshed. */
  created: boolean;
}

/** Deterministic workspace path: workspace root plus PR number only. */
export function workspacePathFor(workspaceRoot: string, prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new WorkspaceError(
      "workspace-outside-root",
      `invalid PR number for workspace path: ${String(prNumber)}`,
    );
  }
  return join(workspaceRoot, `pr-${prNumber}`);
}

/** True when `candidate` lies strictly beneath `root` (path-traversal safe). */
export function isBeneath(candidate: string, root: string): boolean {
  const rel = resolve(candidate);
  const base = resolve(root);
  return rel.startsWith(base + sep);
}

/**
 * Bring the workspace for a pull request to the expected state:
 * fetch current remote state, create or fast-forward the worktree, and
 * verify it ends on the expected branch at the expected commit.
 */
export async function prepareWorkspace(options: {
  sourcePath: string;
  workspaceRoot: string;
  prNumber: number;
  headBranch: string;
  headSha: string;
}): Promise<PreparedWorkspace> {
  const { sourcePath, workspaceRoot, prNumber, headBranch } = options;
  const expectedSha = options.headSha;
  const path = workspacePathFor(workspaceRoot, prNumber);

  await mkdir(workspaceRoot, { recursive: true });
  await git(["fetch", "origin", "--prune"], { cwd: sourcePath });

  const existed = existsSync(path);
  if (!existed) {
    await createWorktree(sourcePath, path, headBranch);
    // Fast-forward to the recorded head; the local branch may lag the remote.
    try {
      await git(["merge", "--ff-only", expectedSha], { cwd: path });
    } catch {
      throw new WorkspaceError(
        "workspace-diverged",
        `workspace ${path} cannot fast-forward to ${expectedSha}`,
      );
    }
  } else {
    // Refresh: dirty means stop (design D9) — never discard.
    const dirty = (await statusEntries(path)).length > 0;
    if (dirty) {
      throw new WorkspaceError(
        "workspace-dirty",
        `workspace ${path} has uncommitted modifications`,
      );
    }
    const branch = await currentBranch(path).catch(() => {
      throw new WorkspaceError(
        "workspace-not-worktree",
        `workspace ${path} is not a valid git worktree`,
      );
    });
    if (branch !== headBranch) {
      await git(["checkout", headBranch], { cwd: path });
    }
    // Fast-forward only; divergence means stop, not rewrite.
    try {
      await git(["merge", "--ff-only", expectedSha], { cwd: path });
    } catch {
      throw new WorkspaceError(
        "workspace-diverged",
        `workspace ${path} cannot fast-forward to ${expectedSha}`,
      );
    }
  }

  const actualSha = await headSha(path);
  if (actualSha !== expectedSha) {
    throw new WorkspaceError(
      "workspace-diverged",
      `workspace ${path} is at ${actualSha}, expected ${expectedSha}`,
    );
  }
  return { path, branch: headBranch, headSha: actualSha, created: !existed };
}

async function createWorktree(
  sourcePath: string,
  path: string,
  branch: string,
): Promise<void> {
  const localExists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: sourcePath,
  })
    .then(() => true)
    .catch(() => false);
  if (localExists) {
    await git(["worktree", "add", path, branch], { cwd: sourcePath });
  } else {
    await git(["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`], {
      cwd: sourcePath,
    });
  }
}
