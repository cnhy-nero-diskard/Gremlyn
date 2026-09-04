import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { isLockOwnerAlive } from "../orchestrator/instance-lock.js";
import type { OperatorActionStore } from "../store/actions.js";
import {
  currentBranch,
  git,
  headSha,
  isAncestor,
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
  /** Whether the path belongs to an operator checkout adopted for this attempt. */
  adopted: boolean;
  /** Claim held outside the adopted checkout's working tree until the attempt ends. */
  adoptionClaim?: AdoptionClaimHandle;
}

export interface AdoptionClaim {
  attemptId: number;
  pid: number;
  claimedAt: string;
}

export interface AdoptionClaimHandle extends AdoptionClaim {
  path: string;
  release(): void;
}

export class AdoptionClaimError extends Error {
  readonly reason: "adoption-claimed" | "adoption-claim-indeterminate";

  constructor(reason: AdoptionClaimError["reason"], message: string) {
    super(message);
    this.name = "AdoptionClaimError";
    this.reason = reason;
  }
}

const ADOPTION_CLAIM_NAME = "gremlyn-adoption-claim.json";

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
  /** Allow a clean foreign checkout holding the branch to be used for this attempt. */
  adoptExistingCheckout?: boolean;
  /** Required to publish a discoverable claim when adoption is enabled. */
  attemptId?: number;
  /** Audit adoption decisions when the caller has an operator-action store. */
  actions?: Pick<OperatorActionStore, "record">;
}): Promise<PreparedWorkspace> {
  const { sourcePath, workspaceRoot, prNumber, headBranch } = options;
  const expectedSha = options.headSha;
  const path = workspacePathFor(workspaceRoot, prNumber);
  let preparedPath = path;
  // Set when a stray local commit ahead of `expectedSha` was fast-forward
  // pushed to reconcile the workspace (see below) — the final invariant
  // check then compares against that new head instead of the stale one.
  let reconciledSha: string | undefined;
  let adoptionClaim: AdoptionClaimHandle | undefined;

  try {
    await mkdir(workspaceRoot, { recursive: true });
    try {
      await git(["fetch", "origin", "--prune"], { cwd: sourcePath });
    } catch (error) {
      const holder = await worktreeHoldingBranch(sourcePath, headBranch).catch(() => undefined);
      if (
        holder !== undefined &&
        samePath(holder, sourcePath) &&
        !(await hasUsableOrigin(sourcePath))
      ) {
        throw new WorkspaceError(
          "workspace-branch-in-use",
          `branch ${headBranch} is checked out at ${sourcePath}, and the source checkout has no usable origin for an independent workspace`,
        );
      }
      throw error;
    }

    const existed = existsSync(path);
    if (!existed) {
      const checkout = await createWorkspaceCheckout(sourcePath, path, headBranch, {
        ...options,
        expectedSha,
      });
      adoptionClaim = checkout.adoptionClaim;
      preparedPath = checkout.path ?? path;
      // A newly-created checkout may lag the recorded head. Adoption already
      // performs this fast-forward as part of its admission checks.
      if (!checkout.adopted) {
        try {
          await git(["merge", "--ff-only", expectedSha], { cwd: preparedPath });
        } catch {
          throw new WorkspaceError(
            "workspace-diverged",
            `workspace ${preparedPath} cannot fast-forward to ${expectedSha}`,
          );
        }
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
        const localSha = await headSha(path);
        if (localSha !== expectedSha && (await isAncestor(path, expectedSha, localSha))) {
          // The workspace already contains everything at `expectedSha` plus at
          // least one further commit, with an otherwise clean tree — a prior
          // agent run committed its own fix but never published it (the cause
          // behind a `no-changes` publish block that then wedges every retry
          // as `workspace-diverged`). Nothing here is missing or conflicting,
          // so finishing that publish is a plain fast-forward, never a force
          // push, and discarding the commit instead would silently throw away
          // real, already-validated work.
          try {
            await git(["push", "origin", `${localSha}:${headBranch}`], { cwd: path });
          } catch (error) {
            throw new WorkspaceError(
              "workspace-diverged",
              `workspace ${path} at ${localSha} is ahead of expected ${expectedSha} and could not be reconciled: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          reconciledSha = localSha;
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
    }

    const actualSha = await headSha(preparedPath);
    if (actualSha !== (reconciledSha ?? expectedSha)) {
      throw new WorkspaceError(
        "workspace-diverged",
        `workspace ${preparedPath} is at ${actualSha}, expected ${expectedSha}`,
      );
    }
    await seedIgnoredFiles(sourcePath, preparedPath, options.seedFiles ?? []);
    const adopted = adoptionClaim !== undefined;
    return {
      path: preparedPath,
      branch: headBranch,
      headSha: actualSha,
      created: !existed && !adopted,
      adopted,
      ...(adoptionClaim === undefined ? {} : { adoptionClaim }),
    };
  } catch (error) {
    adoptionClaim?.release();
    throw error;
  }
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
  options: {
    expectedSha: string;
    adoptExistingCheckout?: boolean;
    attemptId?: number;
    actions?: Pick<OperatorActionStore, "record">;
  },
): Promise<{ adopted: boolean; path?: string; adoptionClaim?: AdoptionClaimHandle }> {
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
      return { adopted: false };
    }
    if (!options.adoptExistingCheckout) {
      recordAdoptionDecision(options.actions, holder, "refused", "adoption-disabled");
    } else if (options.attemptId === undefined) {
      recordAdoptionDecision(options.actions, holder, "refused", "attempt-id-missing");
    } else {
      const adopted = await tryAdoptCheckout({
        holder,
        branch,
        expectedSha: options.expectedSha,
        attemptId: options.attemptId,
        actions: options.actions,
      });
      if (adopted !== undefined) return { ...adopted, path: holder };
    }
    try {
      await createStandaloneCheckout(sourcePath, path, branch);
      return { adopted: false };
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        "workspace-branch-in-use",
        `branch ${branch} is already checked out at ${holder}; independent clone failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
  return { adopted: false };
}

async function tryAdoptCheckout(options: {
  holder: string;
  branch: string;
  expectedSha: string;
  attemptId: number;
  actions?: Pick<OperatorActionStore, "record"> | undefined;
}): Promise<{ adopted: true; adoptionClaim: AdoptionClaimHandle } | undefined> {
  const refuse = (reason: string): undefined => {
    recordAdoptionDecision(options.actions, options.holder, "refused", reason, options.attemptId);
    return undefined;
  };

  try {
    await assertValidWorktree(options.holder);
  } catch {
    return refuse("not-a-valid-worktree");
  }
  let branch: string;
  try {
    branch = await currentBranch(options.holder);
  } catch {
    return refuse("branch-undeterminable");
  }
  if (branch === "HEAD") return refuse("detached");
  if (branch !== options.branch) return refuse(`branch-mismatch:${branch}`);

  try {
    if ((await unmergedEntries(options.holder)).length > 0) return refuse("unmerged-entries");
    if (await mergeInProgress(options.holder)) return refuse("merge-in-progress");
  } catch {
    return refuse("conflict-state-undeterminable");
  }
  try {
    if ((await statusEntries(options.holder)).length > 0) return refuse("dirty");
  } catch {
    return refuse("cleanliness-undeterminable");
  }

  let currentSha: string;
  try {
    currentSha = await headSha(options.holder);
  } catch {
    return refuse("head-undeterminable");
  }
  if (currentSha !== options.expectedSha) {
    const fastForwardable = await isAncestor(options.holder, currentSha, options.expectedSha);
    if (!fastForwardable) return refuse("not-fast-forwardable");
  }

  let gitDir: string;
  try {
    const reported = (await git(["rev-parse", "--git-dir"], { cwd: options.holder })).stdout.trim();
    if (!reported) return refuse("git-dir-undeterminable");
    gitDir = resolve(options.holder, reported);
  } catch {
    return refuse("git-dir-undeterminable");
  }

  let claim: AdoptionClaimHandle;
  try {
    claim = claimAdoptedCheckout(gitDir, options.attemptId);
  } catch (error) {
    return refuse(error instanceof AdoptionClaimError ? error.reason : "claim-unavailable");
  }

  if (currentSha !== options.expectedSha) {
    try {
      await git(["merge", "--ff-only", options.expectedSha], { cwd: options.holder });
    } catch {
      claim.release();
      return refuse("fast-forward-failed");
    }
  }
  recordAdoptionDecision(
    options.actions,
    options.holder,
    "adopted",
    "preconditions-passed",
    options.attemptId,
  );
  return { adopted: true, adoptionClaim: claim };
}

export function adoptionClaimPath(gitDir: string): string {
  return join(gitDir, ADOPTION_CLAIM_NAME);
}

export function readAdoptionClaim(path: string): AdoptionClaim | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { attemptId?: unknown }).attemptId !== "number" ||
      !Number.isSafeInteger((value as { attemptId: number }).attemptId) ||
      (value as { attemptId: number }).attemptId < 1 ||
      typeof (value as { pid?: unknown }).pid !== "number" ||
      !Number.isSafeInteger((value as { pid: number }).pid) ||
      (value as { pid: number }).pid < 1 ||
      typeof (value as { claimedAt?: unknown }).claimedAt !== "string"
    ) {
      return undefined;
    }
    return {
      attemptId: (value as { attemptId: number }).attemptId,
      pid: (value as { pid: number }).pid,
      claimedAt: (value as { claimedAt: string }).claimedAt,
    };
  } catch {
    return undefined;
  }
}

export function claimAdoptedCheckout(gitDir: string, attemptId: number): AdoptionClaimHandle {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    throw new AdoptionClaimError("adoption-claim-indeterminate", "attempt id is invalid");
  }
  const path = adoptionClaimPath(gitDir);
  const claim: AdoptionClaim = {
    attemptId,
    pid: process.pid,
    claimedAt: new Date().toISOString(),
  };
  for (;;) {
    try {
      writeFileSync(path, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx" });
      let released = false;
      return {
        ...claim,
        path,
        release: (): void => {
          if (released) return;
          released = true;
          const current = readAdoptionClaim(path);
          if (
            current?.attemptId !== claim.attemptId ||
            current?.pid !== claim.pid ||
            current?.claimedAt !== claim.claimedAt
          ) {
            return;
          }
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new AdoptionClaimError(
          "adoption-claim-indeterminate",
          `cannot create adoption claim ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const existing = readAdoptionClaim(path);
      if (existing === undefined) {
        throw new AdoptionClaimError(
          "adoption-claim-indeterminate",
          `adoption claim ${path} is unreadable`,
        );
      }
      if (isLockOwnerAlive(existing.pid)) {
        throw new AdoptionClaimError(
          "adoption-claimed",
          `adoption claim ${path} is held by live process ${existing.pid}`,
        );
      }
      try {
        unlinkSync(path);
      } catch (reclaimError) {
        if ((reclaimError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new AdoptionClaimError(
          "adoption-claim-indeterminate",
          `cannot reclaim adoption claim ${path}: ${
            reclaimError instanceof Error ? reclaimError.message : String(reclaimError)
          }`,
        );
      }
    }
  }
}

function recordAdoptionDecision(
  actions: Pick<OperatorActionStore, "record"> | undefined,
  target: string,
  effect: "adopted" | "refused",
  reason: string,
  attemptId?: number,
): void {
  actions?.record({
    action: "workspace-adoption",
    target,
    effect,
    detail: { reason, ...(attemptId === undefined ? {} : { attemptId }) },
  });
}

async function hasUsableOrigin(sourcePath: string): Promise<boolean> {
  try {
    return (
      (await git(["remote", "get-url", "origin"], { cwd: sourcePath })).stdout.trim().length > 0
    );
  } catch {
    return false;
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
      "workspace-branch-in-use",
      `branch ${branch} is already checked out at ${sourcePath}; the source checkout has no usable origin for an independent workspace`,
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
