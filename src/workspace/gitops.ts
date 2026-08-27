import { execa, ExecaError } from "execa";

/**
 * Git helpers. Every invocation goes through an argv array with no shell
 * (command-authorization spec: GitHub text is untrusted input).
 */
export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | undefined;
  constructor(args: string[], message: string, exitCode?: number) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
  }
}

/** Run a git command, throwing GitError on non-zero exit. */
export async function git(args: string[], options?: { cwd?: string }): Promise<GitResult> {
  try {
    const result = await execa("git", args, {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      shell: false,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (err instanceof ExecaError) {
      throw new GitError(args, String(err.shortMessage ?? err.message), err.exitCode);
    }
    throw err;
  }
}

/** Current HEAD sha of the repository at `cwd`. */
export async function headSha(cwd: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], { cwd })).stdout.trim();
}

/** Abbrev of the checked-out branch, e.g. `main`. */
export async function currentBranch(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
}

/** Porcelain status entries; empty means clean. */
export async function statusEntries(cwd: string): Promise<string[]> {
  const { stdout } = await git(["status", "--porcelain"], { cwd });
  return stdout.split("\n").filter((line) => line.length > 0);
}

/** True when `ancestor` is an ancestor of `descendant` (no history rewrite). */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}
