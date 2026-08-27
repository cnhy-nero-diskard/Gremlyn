import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/workspace/gitops.js";

/**
 * Test helper: a temp bare remote plus a source clone with one commit on
 * `main` and a feature branch, mimicking a registered repository.
 */
export interface TempRepo {
  root: string;
  remotePath: string;
  sourcePath: string;
  workspaceRoot: string;
  headBranch: string;
}

const AUTHOR = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

export async function createTempRepo(): Promise<TempRepo> {
  const root = mkdtempSync(join(tmpdir(), "gremlyn-repo-"));
  const remotePath = join(root, "remote.git");
  const sourcePath = join(root, "source");
  const workspaceRoot = join(root, "workspaces");
  const headBranch = "feature-branch";

  await git(["init", "--bare", remotePath]);
  await git(["clone", remotePath, sourcePath]);
  await git(["checkout", "-b", "main"], { cwd: sourcePath });

  writeFileSync(join(sourcePath, "README.md"), "# temp repo\n", "utf8");
  await git(["add", "-A"], { cwd: sourcePath });
  await git([...AUTHOR, "commit", "-m", "initial"], { cwd: sourcePath });
  await git(["push", "-u", "origin", "main"], { cwd: sourcePath });

  // Feature branch with one extra commit, pushed — a stand-in PR head.
  await git(["checkout", "-b", headBranch], { cwd: sourcePath });
  writeFileSync(join(sourcePath, "feature.txt"), "feature work\n", "utf8");
  await git(["add", "-A"], { cwd: sourcePath });
  await git([...AUTHOR, "commit", "-m", "feature commit"], { cwd: sourcePath });
  await git(["push", "-u", "origin", headBranch], { cwd: sourcePath });
  await git(["checkout", "main"], { cwd: sourcePath });

  return { root, remotePath, sourcePath, workspaceRoot, headBranch };
}

/** Current sha of a branch on the remote. */
export async function remoteSha(remotePath: string, branch: string): Promise<string> {
  const { stdout } = await git(["--git-dir", remotePath, "rev-parse", branch]);
  return stdout.trim();
}

/**
 * Commit a file change on a branch and push it to the remote. Uses a
 * throwaway worktree so it works even when the branch is checked out in
 * another worktree (git forbids a second checkout of the same branch).
 */
export async function pushCommit(
  sourcePath: string,
  branch: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  const scratch = join(mkdtempSync(join(tmpdir(), "gremlyn-scratch-")), "wt");
  // Detached: the branch itself may already be checked out in a worktree.
  await git(["worktree", "add", "--detach", scratch, branch], { cwd: sourcePath });
  try {
    writeFileSync(join(scratch, file), content, "utf8");
    await git(["add", "-A"], { cwd: scratch });
    await git([...AUTHOR, "commit", "-m", message], { cwd: scratch });
    await git(["push", "origin", `HEAD:${branch}`], { cwd: scratch });
    const { stdout } = await git(["rev-parse", "HEAD"], { cwd: scratch });
    return stdout.trim();
  } finally {
    await git(["worktree", "remove", "--force", scratch], { cwd: sourcePath });
  }
}
