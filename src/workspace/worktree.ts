import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  currentBranch,
  git,
  headSha,
  mergeInProgress,
  statusEntries,
  unmergedEntries,
} from "./gitops.js";

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
  | "workspace-detached"
  | "workspace-diverged"
  | "workspace-not-worktree"
  | "workspace-outside-root"
  | "workspace-branch-in-use"
  | "head-changed";

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
    await assertValidWorktree(path);
    if ((await unmergedEntries(path)).length > 0 || (await mergeInProgress(path))) {
      throw new WorkspaceError(
        "workspace-conflicted",
        `workspace ${path} contains unresolved conflicts`,
      );
    }
    const branch = await currentBranch(path);
    if (branch === "HEAD") {
      throw new WorkspaceError("workspace-detached", `workspace ${path} has a detached HEAD`);
    }
    // Refresh: dirty means stop (design D9) — never discard.
    const dirty = (await statusEntries(path)).length > 0;
    if (dirty) {
      throw new WorkspaceError(
        "workspace-dirty",
        `workspace ${path} has uncommitted modifications`,
      );
    }
    if (branch !== headBranch) {
      try {
        await git(["checkout", headBranch], { cwd: path });
      } catch {
        throw new WorkspaceError(
          "workspace-diverged",
          `workspace ${path} cannot switch safely to ${headBranch}`,
        );
      }
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

/** Re-read the remote branch immediately before publication. */
export async function verifyRemoteHead(options: {
  workspacePath: string;
  headBranch: string;
  expectedSha: string;
}): Promise<void> {
  const { stdout } = await git(
    ["ls-remote", "--exit-code", "origin", `refs/heads/${options.headBranch}`],
    { cwd: options.workspacePath },
  );
  const actualSha = stdout.trim().split(/\s+/u)[0];
  if (actualSha !== options.expectedSha) {
    throw new WorkspaceError(
      "head-changed",
      `pull request head changed from ${options.expectedSha} to ${actualSha ?? "unknown"}`,
    );
  }
}

async function assertValidWorktree(path: string): Promise<void> {
  try {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: path });
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: path });
    if (inside.stdout.trim() !== "true" || resolve(top.stdout.trim()) !== resolve(path)) {
      throw new Error("not worktree root");
    }
  } catch {
    throw new WorkspaceError(
      "workspace-not-worktree",
      `workspace ${path} is not a valid git worktree`,
    );
  }
}

/**
 * Find a registered worktree still holding `branch`, if any.
 *
 * `git worktree list --porcelain` emits stanzas of `worktree <path>` /
 * `branch refs/heads/<name>`, so the path is whatever `worktree` line most
 * recently preceded the matching `branch` line.
 */
async function worktreeHoldingBranch(
  sourcePath: string,
  branch: string,
): Promise<string | undefined> {
  const { stdout } = await git(["worktree", "list", "--porcelain"], { cwd: sourcePath });
  let current: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return current;
  }
  return undefined;
}

async function createWorktree(sourcePath: string, path: string, branch: string): Promise<void> {
  // Drop registrations whose directories are gone before asking for a new one.
  // Git treats a stale ("prunable") entry as still holding its branch, so
  // `worktree add` fails with "already used by worktree at <path>" and the job
  // dies at `preparing` — permanently, since nothing else clears it. Deleting a
  // worktree directory by hand is enough to cause this, as is a worktree
  // created under a path this OS can no longer see (a WSL `/mnt/...` path).
  // `fetch --prune` does not help: it prunes remote-tracking refs, not
  // worktrees. Pruning is a no-op when every registration is live.
  await git(["worktree", "prune"], { cwd: sourcePath });

  // A live worktree still holding the branch is a genuine conflict, not
  // something to clean up: some other checkout legitimately owns it, and
  // stealing or force-adding it would corrupt that working copy. Name it
  // precisely instead of surfacing git's raw error as "workspace-corrupted".
  const holder = await worktreeHoldingBranch(sourcePath, branch);
  if (holder !== undefined && resolve(holder) !== resolve(path)) {
    throw new WorkspaceError(
      "workspace-branch-in-use",
      `branch ${branch} is already checked out at ${holder}`,
    );
  }

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
