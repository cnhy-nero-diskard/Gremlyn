import { git, headSha, statusEntries } from "../workspace/gitops.js";

/**
 * Commit and push policy (resolution-publication spec): a deterministic,
 * attributable commit pushed to the existing PR head branch. Never force,
 * never rewrite history, never create or delete branches, never merge.
 */

export interface CommitAuthor {
  name: string;
  email: string;
}

/**
 * Commit every modification in the workspace with the given message.
 * Returns the new commit sha, or null when the workspace is clean
 * (agent exited successfully having changed nothing).
 */
export async function commitAll(
  workspacePath: string,
  message: string,
  author: CommitAuthor,
): Promise<string | null> {
  if ((await statusEntries(workspacePath)).length === 0) return null;
  await git(["add", "-A"], { cwd: workspacePath });
  await git(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-m",
      message,
    ],
    { cwd: workspacePath },
  );
  return headSha(workspacePath);
}

/**
 * Push HEAD to the existing PR head branch. Non-force by construction: no
 * `--force` flag exists in this invocation, so a rejected push surfaces as a
 * GitError and no history is rewritten.
 */
export async function pushHead(workspacePath: string, branch: string): Promise<void> {
  await git(["push", "origin", `HEAD:${branch}`], { cwd: workspacePath });
}
