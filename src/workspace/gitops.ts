import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
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

/** Exact working-tree state used to guard a destructive refresh. */
export interface WorkspaceSnapshot {
  headSha: string;
  status: string;
  fingerprint: string;
}

/**
 * Capture the exact working-tree state used to guard a destructive refresh.
 *
 * The porcelain status records paths and modes, but not the bytes of files that
 * were already dirty. Include the tracked diff and every untracked file's
 * path, mode, and content so a content-only edit cannot pass the guard.
 */
export async function workspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
  const [head, status] = await Promise.all([
    git(["rev-parse", "HEAD"], { cwd }),
    git(["status", "--porcelain=v1", "-z", "-uall"], { cwd }),
  ]);
  const headSha = head.stdout.trim();
  const fingerprint = createHash("sha256");
  updateFingerprint(fingerprint, "gremlyn-workspace-snapshot-v1");
  updateFingerprint(fingerprint, headSha);
  updateFingerprint(fingerprint, status.stdout);
  updateFingerprint(
    fingerprint,
    (await git(["diff", "--no-ext-diff", "--binary", "--patch", "HEAD"], { cwd })).stdout,
  );

  const untrackedFiles = status.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter((name) => name.length > 0)
    .sort();
  for (const name of untrackedFiles) {
    const absolute = resolve(cwd, name);
    const entry = lstatSync(absolute);
    updateFingerprint(fingerprint, name);
    updateFingerprint(fingerprint, String(entry.mode));
    if (entry.isSymbolicLink()) {
      updateFingerprint(fingerprint, "symlink");
      updateFingerprint(fingerprint, readlinkSync(absolute));
    } else if (entry.isFile()) {
      updateFingerprint(fingerprint, "file");
      updateFingerprint(fingerprint, readFileSync(absolute));
    } else {
      updateFingerprint(fingerprint, "other");
    }
  }

  return { headSha, status: status.stdout, fingerprint: fingerprint.digest("hex") };
}

function updateFingerprint(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(Buffer.from(`${bytes.byteLength}:`, "ascii"));
  hash.update(bytes);
}

const UNMERGED_CODES = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

/** Entries in a conflicted (unmerged) merge state, from porcelain status. */
export async function unmergedEntries(cwd: string): Promise<string[]> {
  const entries = await statusEntries(cwd);
  return entries.filter((entry) => UNMERGED_CODES.has(entry.slice(0, 2)));
}

/** True while a merge is in progress (MERGE_HEAD present). */
export async function mergeInProgress(cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** True when `ancestor` is an ancestor of `descendant` (no history rewrite). */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}
