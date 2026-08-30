import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  currentBranch,
  git,
  headSha,
  mergeInProgress,
  statusEntries,
  unmergedEntries,
} from "./gitops.js";

/**
 * Workspace management (design D9, workspace-isolation spec).
 *
 * Workspaces live at `<workspace_root>/pr-<number>` — derived from registry
 * configuration and an integer PR number, never from GitHub-supplied text.
 * They are normally linked worktrees. If the configured source checkout is
 * itself on the PR branch, Git cannot link that branch a second time, so the
 * workspace is an independent clone with the same branch checked out.
 * Dirty means stop unless the retry was positively identified as resuming a
 * retained workspace from an abruptly ended Gremlyn attempt. Even then the
 * branch and recorded head must match; conflicts and divergence never resume.
 */

export type WorkspaceFailureReason =
  | "workspace-dirty"
  | "workspace-conflicted"
  | "workspace-detached"
  | "workspace-diverged"
  | "workspace-not-worktree"
  | "workspace-outside-root"
  | "workspace-branch-in-use"
  | "workspace-seed-failed"
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
 * fetch current remote state, create or fast-forward the checkout, and
 * verify it ends on the expected branch at the expected commit.
 */
export async function prepareWorkspace(options: {
  sourcePath: string;
  workspaceRoot: string;
  prNumber: number;
  headBranch: string;
  headSha: string;
  /** Repository-relative gitignored files copied from the source checkout. */
  seedFiles?: readonly string[];
  /** Permit edits only for a validated abrupt-run retry. */
  resumeDirtyWorkspace?: boolean;
}): Promise<PreparedWorkspace> {
  const { sourcePath, workspaceRoot, prNumber, headBranch } = options;
  const expectedSha = options.headSha;
  const path = workspacePathFor(workspaceRoot, prNumber);

  await mkdir(workspaceRoot, { recursive: true });
  await git(["fetch", "origin", "--prune"], { cwd: sourcePath });

  const existed = existsSync(path);
  if (!existed) {
    await createWorkspaceCheckout(sourcePath, path, headBranch);
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
    // A standalone fallback clone has its own object database and remote
    // refs; refresh it independently before resolving the recorded head.
    await git(["fetch", "origin", "--prune"], { cwd: path });
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
    if (branch !== headBranch && dirty) {
      throw new WorkspaceError(
        "workspace-dirty",
        `workspace ${path} has uncommitted modifications`,
      );
    }
    if (dirty && !options.resumeDirtyWorkspace) {
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
    if (dirty && options.resumeDirtyWorkspace) {
      const actualSha = await headSha(path);
      if (actualSha !== expectedSha) {
        throw new WorkspaceError(
          "workspace-diverged",
          `workspace ${path} is dirty at ${actualSha}, expected ${expectedSha}`,
        );
      }
    } else {
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
  }

  const actualSha = await headSha(path);
  if (actualSha !== expectedSha) {
    throw new WorkspaceError(
      "workspace-diverged",
      `workspace ${path} is at ${actualSha}, expected ${expectedSha}`,
    );
  }
  await seedIgnoredFiles(sourcePath, path, options.seedFiles ?? []);
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

async function createWorkspaceCheckout(
  sourcePath: string,
  path: string,
  branch: string,
): Promise<void> {
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
  if (holder !== undefined && !samePath(holder, path)) {
    if (samePath(holder, sourcePath)) {
      await createStandaloneCheckout(sourcePath, path, branch);
      return;
    }
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

function samePath(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

/**
 * Create a separate repository when the configured source checkout already
 * holds the requested branch. A normal clone is intentionally used instead
 * of switching or mutating the source checkout: the source may be the
 * developer's primary checkout and may contain unrelated local changes.
 */
async function createStandaloneCheckout(
  sourcePath: string,
  path: string,
  branch: string,
): Promise<void> {
  const remoteUrl = (await git(["remote", "get-url", "origin"], { cwd: sourcePath })).stdout.trim();
  if (remoteUrl.length === 0) {
    throw new WorkspaceError(
      "workspace-diverged",
      `source checkout ${sourcePath} has no usable origin for an independent workspace`,
    );
  }
  await git(["clone", "--no-local", "--branch", branch, remoteUrl, path], {
    cwd: sourcePath,
  });
}

/**
 * Copy repository-relative gitignored files from the source checkout into the
 * workspace.
 *
 * A Git checkout populates tracked content only, so files a build needs but
 * git deliberately does not carry — `local.properties`, `.env` — are absent from
 * every freshly created workspace. The agent and the validation commands then
 * fail on an environment gap that has nothing to do with the review feedback:
 * Gradle reports "SDK location not found" and the job dies at `validating` with
 * `validation-failed`, which reads as the agent's work being wrong. Seeding runs
 * on every preparation, not just creation, so a workspace whose seed file was
 * removed heals on the next job instead of failing identically forever.
 *
 * Each entry must be gitignored in the workspace. That is not a convenience
 * check: publication commits with `git add -A`, so a seeded file git tracks
 * would be committed to the pull request — leaking a machine-local path, or a
 * secret, into someone's branch. A tracked path is a configuration error and
 * fails the job rather than being copied.
 */
async function seedIgnoredFiles(
  sourcePath: string,
  workspacePath: string,
  seedFiles: readonly string[],
): Promise<void> {
  for (const entry of seedFiles) {
    const relative = normalize(entry);
    // Confine to the workspace: an absolute path or a `..` escape would write
    // outside the workspace root, which is the one place writes are allowed.
    if (isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
      throw new WorkspaceError(
        "workspace-seed-failed",
        `seed file ${entry} must be a relative path inside the repository`,
      );
    }
    const from = join(sourcePath, relative);
    const to = join(workspacePath, relative);
    if (!existsSync(from)) {
      throw new WorkspaceError(
        "workspace-seed-failed",
        `seed file ${entry} does not exist in source checkout ${sourcePath}`,
      );
    }
    // `check-ignore` exits 1 when the path is not ignored, which `git` throws on.
    // The index is deliberately consulted: a path git tracks is never reported
    // as ignored, so a file both tracked and named in `.gitignore` is still
    // refused rather than seeded into a commit.
    const ignored = await git(["check-ignore", "--quiet", relative], {
      cwd: workspacePath,
    })
      .then(() => true)
      .catch(() => false);
    if (!ignored) {
      throw new WorkspaceError(
        "workspace-seed-failed",
        `seed file ${entry} is not gitignored in ${workspacePath}; seeding it would commit it`,
      );
    }
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}
