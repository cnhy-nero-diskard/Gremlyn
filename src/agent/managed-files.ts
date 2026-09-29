/**
 * Attempt-owned lifecycle for generated OpenCode V2 agent files (task 3.2;
 * design D3; capability `opencode-agent-profiles`).
 *
 * {@link serializeOpenCodeAgents} turns a validated profile into
 * repository-relative paths and deterministic byte content, all scoped to one
 * attempt namespace (`.opencode/agents/<namespace>/…`). This module owns the
 * three filesystem concerns around those paths:
 *
 * **Materialize** writes exactly the serialized files into the prepared,
 * disposable attempt worktree — the only place generated configuration for a
 * run is ever allowed to exist. Before a single byte lands inside the worktree
 * it journals the attempt manifest *outside* the worktree with one atomic
 * temp-and-rename write, so a crash between journaling and writing still
 * leaves cleanup evidence. Materialization refuses an unsafe or already-used
 * namespace, any symlink in a generated path's parent chain, any path that
 * escapes the worktree, and any target path git already tracks, and it never
 * overwrites an existing file.
 *
 * **Cleanup** consumes only the manifest, removes only manifest-listed files
 * (idempotently — a repeated call on a retained manifest is clean), detects
 * agent edits to generated files, preserves their edited bytes *outside the
 * worktree* in a content-addressed evidence sidecar before removing them, and
 * verifies that tracked OpenCode files still carry the bytes materialization
 * snapshotted. It also re-checks git's view of the worktree so no generated
 * path survives into a publishable diff.
 *
 * Cleanup fails closed when it cannot prove the workspace matches its
 * pre-generation state: a missing manifest throws `manifest-missing` (the
 * caller must only call cleanup for an attempt whose manifest was journaled —
 * {@link readManagedOpencodeManifest} is the existence probe), and a path that
 * cannot be removed leaves the attempt failed with `generated-content-remains`
 * while the manifest is retained so a later pass can retry the removal. Agent
 * edits to generated files (which can carry private instructions) are never
 * returned inline: they are written to a mode-0600 evidence file next to the
 * manifest before the generated file is unlinked, and the report references
 * that file by path and hashes.
 *
 * **Recovery** reads are exposed through {@link readManagedOpencodeManifest} so
 * startup recovery (task 3.6) can discover what an inactive attempt owned
 * without touching the worktree.
 *
 * The module deliberately knows nothing about launching OpenCode or settling
 * child sessions: the caller (tasks 3.3-3.5) gates child sessions first, then
 * cleans up before validation and publication on success, failure, and
 * cancellation alike. Nothing here stages, commits, or pushes.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { git } from "../workspace/gitops.js";
import {
  OPENCODE_AGENT_DIR,
  isSafeAttemptNamespace,
  type SerializedOpenCodeAgents,
} from "./materialize.js";

/** Conventional manifest file name inside an attempt's data directory. */
export const MANAGED_OPENCODE_MANIFEST_FILE = "managed-opencode-files.json";

/** Conventional path for an attempt's manifest, inside its attempt data dir. */
export function managedOpencodeManifestPath(attemptDataDir: string): string {
  return join(attemptDataDir, MANAGED_OPENCODE_MANIFEST_FILE);
}

/**
 * Every distinct way managed-file lifecycle can fail. Each reason is
 * deliberate and fail-closed: nothing here silently drops generated content,
 * overwrites an existing file, follows a symlink out of the worktree, or
 * reports success while a generated path could still enter a diff.
 */
export type ManagedFilesFailureReason =
  | "invalid-workspace"
  | "unsafe-namespace"
  | "manifest-exists"
  | "manifest-path-inside-workspace"
  | "manifest-missing"
  | "manifest-write-failed"
  | "namespace-exists"
  | "generated-file-exists"
  | "symlink-component"
  | "path-escape"
  | "tracked-file-collision"
  | "tracked-state-unavailable"
  | "write-failed"
  | "verify-failed"
  | "unlink-failed"
  | "manifest-corrupt"
  | "workspace-mismatch"
  | "generated-content-remains"
  | "git-unavailable";

/** One refusal or failure with a human-readable detail line. */
export interface ManagedFilesIssue {
  readonly reason: ManagedFilesFailureReason;
  readonly detail: string;
}

/**
 * Raised by every lifecycle operation. Materialization collects every refusal
 * it finds in one pass (like the serializer does) so the caller sees the whole
 * problem; cleanup throws when it cannot guarantee the workspace matches its
 * pre-generation state. {@link reasons} carries each distinct reason in order.
 */
export class ManagedFilesError extends Error {
  readonly issues: readonly ManagedFilesIssue[];
  readonly reasons: readonly ManagedFilesFailureReason[];
  /** Partial cleanup accounting, present when cleanup had to stop. */
  readonly cleanupReport?: ManagedOpencodeCleanupReport;

  constructor(issues: readonly ManagedFilesIssue[], cleanupReport?: ManagedOpencodeCleanupReport) {
    super(
      `Managed OpenCode agent files error:\n- ${issues
        .map((issue) => `${issue.reason}: ${issue.detail}`)
        .join("\n- ")}`,
    );
    this.name = "ManagedFilesError";
    this.issues = issues;
    this.reasons = issues.map((issue) => issue.reason);
    if (cleanupReport !== undefined) this.cleanupReport = cleanupReport;
  }
}

export interface ManagedOpencodeFilesInput {
  /** The prepared, disposable attempt worktree (git checkout) root. */
  workspacePath: string;
  /**
   * Journal path for the attempt manifest. This module refuses any value
   * inside the worktree; recovery (task 3.6) reads the same file.
   */
  manifestPath: string;
  /** The serialization to materialize (see {@link serializeOpenCodeAgents}). */
  serialized: SerializedOpenCodeAgents;
  /** A short identity of the source profile (e.g. its revision) for diagnostics. */
  profileFingerprint?: string;
}

export interface ManagedOpencodeFilesMaterialized {
  /** The validated attempt namespace every generated id shares. */
  namespace: string;
  /** Repository-relative generated paths, in serialization order. */
  files: readonly string[];
  /** Absolute path of the journal written outside the worktree. */
  manifestPath: string;
}

/** The journaled attempt manifest, version 1. */
export interface ManagedOpencodeManifest {
  version: 1;
  namespace: string;
  /** Absolute worktree path the files were written into (see workspace-mismatch). */
  workspacePath: string;
  /** ISO-8601 moment the attempt materialized its files. */
  created: string;
  profileFingerprint?: string;
  /** Every generated file: repository-relative path and expected sha256. */
  files: ReadonlyArray<{ path: string; sha256: string }>;
  /**
   * Tracked files under `.opencode/` with their working-tree sha256 at
   * materialization time (`null` when tracked but absent from the worktree).
   * Cleanup compares against this to prove untouched tracked OpenCode files
   * are byte-identical.
   */
  trackedOpencode: Readonly<Record<string, string | null>>;
}

/** The full audit of one cleanup pass. */
export interface ManagedOpencodeCleanupReport {
  /** Generated files removed whose bytes still matched the manifest. */
  removed: string[];
  /**
   * Generated files the agent (or anything) modified and that were removed.
   * The edited bytes are preserved in a content-addressed evidence file
   * OUTSIDE the worktree (written before the generated file is unlinked, so a
   * crash cannot destroy the record) and referenced here by path — the report
   * itself never carries the possibly-private instruction text inline.
   */
  edited: Array<{ path: string; expectedSha: string; actualSha: string; evidencePath: string }>;
  /** Manifest-listed files already absent before this call ran. */
  missing: string[];
  /** Unusual entries at generated paths that were removed. */
  suspicious: Array<{ path: string; kind: "symlink"; target: string }>;
  /**
   * Manifest-listed paths that could NOT be removed this pass (fail-closed).
   * The manifest is retained so a later cleanup pass can retry the removal.
   */
  unremoved: string[];
  /** Manifest-listed paths still visible to git after removal (fail-closed). */
  residual: string[];
  /**
   * Tracked OpenCode files whose bytes differ from materialization time. These
   * are the agent's ordinary workspace changes — reported, left in place, and
   * subject to independent validation — and do not by themselves fail cleanup.
   */
  trackedChanged: Array<{ path: string; expected: string | null; actual: string | null }>;
  /** True when no generated content remains anywhere in git's or the fs's view. */
  clean: boolean;
}

/**
 * The only manifest file shape: a safe `<id>.md` placed DIRECTLY inside the
 * attempt namespace directory. Anything else — nested paths, non-`.md` names,
 * unsupported id characters, reserved names — is malformed and rejected.
 */
function isImmediateNamespaceAgentRel(rel: string, namespace: string): boolean {
  if (!isPristineRelPath(rel)) return false;
  const prefix = `${OPENCODE_AGENT_DIR}/${namespace}/`;
  if (!rel.startsWith(prefix)) return false;
  const rest = rel.slice(prefix.length);
  if (!rest.endsWith(".md")) return false;
  const id = rest.slice(0, -".md".length);
  return id.length > 0 && isSafeAttemptNamespace(id);
}

/**
 * The content-addressed evidence path for an agent-edited generated file: a
 * sibling of the manifest (outside the worktree) whose name embeds the id and
 * the full sha256 of the edited bytes, so the same edit always resolves to the
 * same path and a different edit can never be confused with a prior record.
 */
function editedEvidencePath(manifestPath: string, rel: string, actualSha: string): string {
  const basename = rel.slice(rel.lastIndexOf("/") + 1, -".md".length);
  return `${manifestPath}.edited-${basename}-${actualSha}.json`;
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameResolvedPath(left: string, right: string): boolean {
  const l = resolve(left);
  const r = resolve(right);
  return process.platform === "win32" ? l.toLowerCase() === r.toLowerCase() : l === r;
}

/** True when `candidate` resolves strictly beneath `root`, never equal to it. */
function isStrictlyBeneath(candidate: string, root: string): boolean {
  const relative = resolve(candidate);
  const base = resolve(root);
  if (sameResolvedPath(relative, base)) return false;
  if (process.platform === "win32") {
    return relative.toLowerCase().startsWith(base.toLowerCase() + sep);
  }
  return relative.startsWith(base + sep);
}

/**
 * True when `rel` is a clean repository-relative path: forward slashes only,
 * no leading separator, no `.`/`..` segment, no empty segment. Git reports
 * repository-relative paths this way on every platform, and the serializer
 * builds generated paths this way.
 */
function isPristineRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0 || isAbsolute(rel) || rel.includes("\\")) {
    return false;
  }
  return rel
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Join a repository-relative (slash-separated) path onto an absolute root. */
function nativeJoin(root: string, ...relSegments: readonly string[]): string {
  return join(root, ...relSegments.flatMap((segment) => segment.split("/")));
}

/**
 * The first parent component of `relative` that is a symbolic link, if any.
 * All component checks use `lstat`, so a link anywhere in the chain — including
 * a junction on Windows — is found without following it.
 */
function firstSymlinkComponent(worktree: string, relative: string): string | undefined {
  const segments = relative.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  let current = worktree;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) break;
    current = join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (entry.isSymbolicLink()) return current;
  }
  return undefined;
}

/**
 * Install the fully-written staged file at `destination` WITHOUT ever
 * overwriting an existing entry. A hard-link install is attempted first
 * (atomic, fails with `EEXIST` when the destination appears concurrently on
 * POSIX and NTFS); filesystems without hard-link support fall back to an
 * exclusive copy (`COPYFILE_EXCL`), which is the no-replace guarantee
 * everywhere. The staged temp file is always removed.
 */
function installNoReplace(options: {
  staged: string;
  destination: string;
  label: string;
  onExistingReason: ManagedFilesFailureReason;
}): void {
  const { staged, destination, label, onExistingReason } = options;
  const alreadyExists = (): ManagedFilesError =>
    new ManagedFilesError([
      {
        reason: onExistingReason,
        detail: `${label} already exists at ${destination}`,
      },
    ]);
  try {
    try {
      linkSync(staged, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw alreadyExists();
      try {
        copyFileSync(staged, destination, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") throw alreadyExists();
        throw new ManagedFilesError([
          {
            reason: "write-failed",
            detail: `cannot install ${label} at ${destination}: ${errorMessage(copyError)}`,
          },
        ]);
      }
    }
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      // Best-effort; the staged file has a unique name and is inert if it stays.
    }
  }
}

/**
 * Write one file through a staged temp file and an unconditional no-replace
 * install, so a journal or generated file is never silently overwritten, even
 * when a destination appears in the window between an existence check and the
 * install. On rare filesystems where hard links are unsupported the exclusive
 * copy still refuses an existing destination.
 */
function writeFileAtomically(options: {
  destination: string;
  content: string;
  label: string;
  onExistingReason: ManagedFilesFailureReason;
}): void {
  const { destination, content, label, onExistingReason } = options;
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const staged = join(
    parent,
    `.${basename(destination)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    writeFileSync(staged, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  } catch (error) {
    throw new ManagedFilesError([
      {
        reason: "write-failed",
        detail: `cannot stage ${label} at ${staged}: ${errorMessage(error)}`,
      },
    ]);
  }
  installNoReplace({ staged, destination, label, onExistingReason });
}

/**
 * Create a private evidence sidecar without replacing an existing file. The
 * path embeds the edited content hash, but metadata (including the timestamp)
 * can differ between attempts; an existing sidecar is not ours to overwrite.
 */
function writePrivateEvidence(destination: string, content: string, mode: number): void {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const staged = join(
    parent,
    `.${basename(destination)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    writeFileSync(staged, content, { encoding: "utf8", mode, flag: "wx" });
    installNoReplace({
      staged,
      destination,
      label: "edited agent evidence",
      onExistingReason: "manifest-exists",
    });
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // Best-effort cleanup of the staged file; the throw below is the signal.
    }
    throw new ManagedFilesError([
      {
        reason: "write-failed",
        detail: `cannot write evidence file ${destination}: ${errorMessage(error)}`,
      },
    ]);
  }
}

/**
 * The namespace directory must be creatable beneath `.opencode/`. A regular
 * file occupying a parent slot would otherwise surface as an opaque
 * platform-specific fs error mid-write; name it as a managed failure instead.
 */
function assertDirectoryChainCreatable(namespaceDirectory: string): void {
  let probe = namespaceDirectory;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe || parent.length === 0) break;
    probe = parent;
  }
  if (existsSync(probe) && !statSync(probe).isDirectory()) {
    throw new ManagedFilesError([
      {
        reason: "write-failed",
        detail: `cannot create the attempt namespace directory ${namespaceDirectory}: existing entry ${probe} is not a directory`,
      },
    ]);
  }
}

/**
 * Snapshot the tracked files under `.opencode/` in the worktree: path -> sha256
 * of the working-tree bytes, or `null` when the index still lists the file but
 * the worktree no longer has it. Cleanup compares against this snapshot.
 */
async function snapshotTrackedOpencode(
  worktree: string,
): Promise<Readonly<Record<string, string | null>>> {
  const snapshot: Record<string, string | null> = {};
  const listed = await git(["ls-files", "-z", "--", ".opencode"], { cwd: worktree });
  for (const rel of listed.stdout.split("\0").filter((entry) => entry.length > 0)) {
    // Only real files beneath `.opencode/` belong in the snapshot (a tracked
    // entry named exactly `.opencode` is not a path cleanup every verifies).
    if (!isPristineRelPath(rel) || !rel.startsWith(".opencode/")) continue;
    let value: string | null = null;
    try {
      value = sha256Hex(readFileSync(nativeJoin(worktree, rel)));
    } catch {
      value = null;
    }
    snapshot[rel] = value;
  }
  return snapshot;
}

/**
 * Materialize the serialized attempt into the prepared worktree. The journals
 * outside the worktree is written first (atomically); only then are the
 * generated files placed beneath `.opencode/agents/<namespace>/`. Every
 * pre-flight refusal — unsafe namespace, existing namespace or file, symlink
 * chain, path escape, tracked collision — is collected in one pass and throws
 * before anything is written.
 */
export async function materializeManagedOpencodeFiles(
  input: ManagedOpencodeFilesInput,
): Promise<ManagedOpencodeFilesMaterialized> {
  const { workspacePath, manifestPath, serialized, profileFingerprint } = input;
  const issues: ManagedFilesIssue[] = [];
  const workspace = resolve(workspacePath);
  const manifest = resolve(manifestPath);

  let workspaceIsDirectory = false;
  try {
    workspaceIsDirectory = statSync(workspace).isDirectory();
  } catch {
    workspaceIsDirectory = false;
  }
  if (!workspaceIsDirectory) {
    issues.push({
      reason: "invalid-workspace",
      detail: `workspace ${workspace} does not exist or is not a directory`,
    });
  }

  if (!isSafeAttemptNamespace(serialized.namespace)) {
    issues.push({
      reason: "unsafe-namespace",
      detail: `namespace ${JSON.stringify(serialized.namespace)} is not a safe single path segment`,
    });
  }
  if (existsSync(manifest)) {
    issues.push({
      reason: "manifest-exists",
      detail: `attempt manifest ${manifest} already exists`,
    });
  }
  if (sameResolvedPath(manifest, workspace) || isStrictlyBeneath(manifest, workspace)) {
    issues.push({
      reason: "manifest-path-inside-workspace",
      detail: `attempt manifest ${manifest} must be journaled outside the worktree ${workspace}`,
    });
  }

  const namespacePrefix = `${OPENCODE_AGENT_DIR}/${serialized.namespace}/`;
  const targets: Array<{ rel: string; abs: string; sha256: string; content: string }> = [];
  for (const file of serialized.files) {
    if (!isImmediateNamespaceAgentRel(file.path, serialized.namespace)) {
      issues.push({
        reason: "path-escape",
        detail: `generated path ${JSON.stringify(file.path)} must be a safe <id>.md directly inside ${namespacePrefix}`,
      });
      continue;
    }
    const absolute = nativeJoin(workspace, file.path);
    if (!isStrictlyBeneath(absolute, workspace)) {
      issues.push({
        reason: "path-escape",
        detail: `generated path ${file.path} resolves outside the worktree ${workspace}`,
      });
      continue;
    }
    targets.push({
      rel: file.path,
      abs: absolute,
      sha256: sha256Hex(file.content),
      content: file.content,
    });
  }

  if (workspaceIsDirectory && issues.length === 0) {
    const namespaceDirectory = nativeJoin(workspace, namespacePrefix.replace(/\/$/u, ""));
    if (existsSync(namespaceDirectory)) {
      issues.push({
        reason: "namespace-exists",
        detail: `attempt namespace directory ${namespaceDirectory} already exists`,
      });
    }
    for (const target of targets) {
      if (existsSync(target.abs)) {
        issues.push({
          reason: "generated-file-exists",
          detail: `generated file already exists at ${target.abs}`,
        });
      }
    }
    for (const rel of [namespacePrefix.replace(/\/$/u, ""), ...targets.map((t) => t.rel)]) {
      const offender = firstSymlinkComponent(workspace, rel);
      if (offender !== undefined) {
        issues.push({
          reason: "symlink-component",
          detail: `a path component of ${rel} is a symbolic link: ${offender}`,
        });
      }
    }
    if (issues.length === 0) {
      try {
        const listed = await git(["ls-files", "-z", "--", ...targets.map((target) => target.rel)], {
          cwd: workspace,
        });
        for (const rel of listed.stdout.split("\0").filter((entry) => entry.length > 0)) {
          issues.push({
            reason: "tracked-file-collision",
            detail: `generated path ${rel} is tracked by git in ${workspace}; materialization never overwrites tracked files`,
          });
        }
      } catch (error) {
        issues.push({
          reason: "tracked-state-unavailable",
          detail: `cannot determine tracked files in ${workspace}: ${errorMessage(error)}`,
        });
      }
    }
  }

  if (issues.length > 0) throw new ManagedFilesError(issues);

  const trackedOpencode = await snapshotTrackedOpencode(workspace);
  const journal: ManagedOpencodeManifest = {
    version: 1,
    namespace: serialized.namespace,
    workspacePath: workspace,
    created: new Date().toISOString(),
    files: targets.map((target) => ({ path: target.rel, sha256: target.sha256 })),
    trackedOpencode,
    ...(typeof profileFingerprint === "string" && profileFingerprint.length > 0
      ? { profileFingerprint }
      : {}),
  };
  try {
    writeFileAtomically({
      destination: manifest,
      content: `${JSON.stringify(journal, null, 2)}\n`,
      label: "attempt manifest",
      onExistingReason: "manifest-exists",
    });
  } catch (error) {
    if (error instanceof ManagedFilesError) throw error;
    throw new ManagedFilesError([
      {
        reason: "manifest-write-failed",
        detail: `cannot journal attempt manifest at ${manifest}: ${errorMessage(error)}`,
      },
    ]);
  }

  try {
    const namespaceDirectory = nativeJoin(workspace, namespacePrefix.replace(/\/$/u, ""));
    assertDirectoryChainCreatable(namespaceDirectory);
    mkdirSync(namespaceDirectory, { recursive: true });
    for (const target of targets) {
      writeFileAtomically({
        destination: target.abs,
        content: target.content,
        label: `generated file ${target.rel}`,
        onExistingReason: "generated-file-exists",
      });
    }
  } catch (error) {
    if (error instanceof ManagedFilesError) throw error;
    throw new ManagedFilesError([
      {
        reason: "write-failed",
        detail: `cannot write generated OpenCode agent files into ${workspace}: ${errorMessage(error)}`,
      },
    ]);
  }

  // Read back what landed in the worktree before returning, so a partial or
  // mangled write is reported instead of being silently accepted.
  const verifyIssues: ManagedFilesIssue[] = [];
  for (const target of targets) {
    try {
      if (sha256Hex(readFileSync(target.abs)) !== target.sha256) {
        verifyIssues.push({
          reason: "verify-failed",
          detail: `generated file ${target.rel} does not match the journaled bytes`,
        });
      }
    } catch (error) {
      verifyIssues.push({
        reason: "verify-failed",
        detail: `cannot read back generated file ${target.rel}: ${errorMessage(error)}`,
      });
    }
  }
  if (verifyIssues.length > 0) throw new ManagedFilesError(verifyIssues);

  return {
    namespace: serialized.namespace,
    files: targets.map((t) => t.rel),
    manifestPath: manifest,
  };
}

/**
 * Strictly validate a journaled manifest. Any shape deviation is a
 * {@link ManagedFilesError} with reason `manifest-corrupt`, so cleanup and
 * recovery never trust a partial or hand-tampered journal.
 */
function parseManagedOpencodeManifest(raw: string, path: string): ManagedOpencodeManifest {
  const corrupt = (detail: string): never => {
    throw new ManagedFilesError([
      {
        reason: "manifest-corrupt",
        detail: `attempt manifest ${path} is unusable: ${detail}`,
      },
    ]);
  };
  const requireString = (value: unknown, detail: string): string => {
    if (typeof value !== "string" || value.length === 0) corrupt(detail);
    // The guard above guarantees the runtime type; the cast keeps the parser's
    // narrowing independent of whether a never-returning call narrows.
    return value as string;
  };
  const requireSha256 = (value: unknown, detail: string): string => {
    const text = requireString(value, detail);
    if (!/^[0-9a-f]{64}$/u.test(text)) corrupt(detail);
    return text;
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    corrupt("not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) corrupt("not an object");
  const record = value as Record<string, unknown>;

  if (record.version !== 1) corrupt(`unsupported version ${JSON.stringify(record.version)}`);
  const namespace = requireString(record.namespace, "invalid namespace");
  if (!isSafeAttemptNamespace(namespace)) corrupt("invalid namespace");
  const workspacePath = requireString(record.workspacePath, "invalid workspacePath");
  const created = requireString(record.created, "invalid created");
  let fingerprint: string | undefined;
  const fingerprintValue = record.profileFingerprint;
  if (fingerprintValue !== undefined) {
    fingerprint = requireString(fingerprintValue, "profileFingerprint must be a string");
  }

  if (!Array.isArray(record.files)) corrupt("files must be a list");
  const files = (record.files as unknown[]).map(
    (rawFile, index): { path: string; sha256: string } => {
      if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
        corrupt(`files[${index}] is not an object`);
      }
      const file = rawFile as Record<string, unknown>;
      const rel = requireString(file.path, `files[${index}].path is unsafe`);
      if (!isImmediateNamespaceAgentRel(rel, namespace)) {
        corrupt(
          `files[${index}].path ${JSON.stringify(rel)} must be a safe <id>.md directly inside ${namespace}`,
        );
      }
      const sha256 = requireSha256(file.sha256, `files[${index}].sha256 is invalid`);
      return { path: rel, sha256 };
    },
  );
  // A manifest may name a generated path at most once, even case-insensitively
  // (Windows filesystems are case-insensitive, so two entries differing only
  // by case would designate the same file).
  const seenFiles = new Map<string, number>();
  files.forEach((entry, index) => {
    const key = entry.path.toLowerCase();
    const prior = seenFiles.get(key);
    if (prior !== undefined) corrupt(`files[${index}] duplicates files[${prior}]`);
    seenFiles.set(key, index);
  });

  const trackedRaw = record.trackedOpencode;
  if (
    trackedRaw !== undefined &&
    (typeof trackedRaw !== "object" || trackedRaw === null || Array.isArray(trackedRaw))
  ) {
    corrupt("trackedOpencode must be an object");
  }
  const trackedOpencode: Record<string, string | null> = {};
  for (const [rel, sha] of Object.entries((trackedRaw ?? {}) as Record<string, unknown>)) {
    if (!isPristineRelPath(rel) || !rel.startsWith(".opencode/")) {
      corrupt(`trackedOpencode key ${JSON.stringify(rel)} is not a file under .opencode/`);
    }
    const hash =
      sha === null ? null : requireSha256(sha, `trackedOpencode entry ${rel} has an invalid hash`);
    trackedOpencode[rel] = hash;
  }

  return {
    version: 1,
    namespace,
    workspacePath,
    created,
    files,
    trackedOpencode,
    ...(fingerprint === undefined ? {} : { profileFingerprint: fingerprint }),
  };
}

/**
 * Read and validate an attempt manifest for recovery (task 3.6). Returns
 * `undefined` when the file is absent or unusable, so startup recovery can
 * discover attempt ownership without throwing over ordinary states.
 */
export function readManagedOpencodeManifest(path: string): ManagedOpencodeManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseManagedOpencodeManifest(raw, path);
  } catch {
    return undefined;
  }
}

/**
 * Remove everything an attempt materialized, then verify the worktree matches
 * its pre-generation state for those paths. Runs after the caller has settled
 * child sessions and before validation and publication, on every outcome.
 *
 * Contract:
 * - Only manifest-listed files are touched; anything else the agent wrote
 *   (including edits to tracked OpenCode files) stays as an ordinary workspace
 *   change subject to independent validation and is reported, not reverted.
 * - A missing manifest throws `manifest-missing` and does NOT look clean: a
 *   lost journal cannot prove generated content is absent. Call cleanup only
 *   for an attempt whose manifest was journaled (probe with
 *   {@link readManagedOpencodeManifest}); recovery (task 3.6) must treat a
 *   retained worktree without a manifest as uncertain.
 * - An agent edit to a generated file destroys its only remaining record when
 *   the file is removed, so the edited bytes are written to a content-addressed
 *   mode-0600 evidence file OUTSIDE the worktree BEFORE the unlink. The report
 *   references that file and never carries the (possibly private) text inline.
 *   If the evidence cannot be written the file is left in place and counted in
 *   {@link ManagedOpencodeCleanupReport.unremoved}, failing closed so the
 *   content is not destroyed unrecorded.
 * - A path that cannot be removed this pass is collected as `unremoved`; the
 *   manifest is retained so a later pass can retry, and cleanup then throws
 *   `generated-content-remains` (also thrown when a generated path stays
 *   visible to git). Idempotent by construction: a repeated call on a retained
 *   manifest is clean once the first pass finished.
 */
export async function cleanupManagedOpencodeFiles(input: {
  workspacePath: string;
  manifestPath: string;
}): Promise<ManagedOpencodeCleanupReport> {
  const { workspacePath, manifestPath } = input;
  const workspace = resolve(workspacePath);
  const manifest = resolve(manifestPath);

  let manifestBody: string;
  try {
    manifestBody = readFileSync(manifest, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ManagedFilesError([
        {
          reason: "manifest-missing",
          detail: `no attempt manifest exists at ${manifest}; generated files cannot be proven absent, so cleanup fails closed`,
        },
      ]);
    }
    throw new ManagedFilesError([
      {
        reason: "manifest-corrupt",
        detail: `cannot read attempt manifest ${manifest}: ${errorMessage(error)}`,
      },
    ]);
  }
  const journal = parseManagedOpencodeManifest(manifestBody, manifest);
  if (!sameResolvedPath(journal.workspacePath, workspace)) {
    throw new ManagedFilesError([
      {
        reason: "workspace-mismatch",
        detail: `manifest ${manifest} was journaled for ${journal.workspacePath}, not ${workspace}`,
      },
    ]);
  }

  const report: ManagedOpencodeCleanupReport = {
    removed: [],
    edited: [],
    missing: [],
    suspicious: [],
    unremoved: [],
    residual: [],
    trackedChanged: [],
    clean: false,
  };

  const namespacePrefix = `${OPENCODE_AGENT_DIR}/${journal.namespace}/`;
  const entries: Array<{ path: string; sha256: string; abs: string }> = [];
  for (const file of journal.files) {
    if (
      !isPristineRelPath(file.path) ||
      !file.path.startsWith(namespacePrefix) ||
      !isStrictlyBeneath(nativeJoin(workspace, file.path), workspace)
    ) {
      throw new ManagedFilesError([
        {
          reason: "path-escape",
          detail: `manifest path ${JSON.stringify(file.path)} escapes the attempt namespace or worktree ${workspace}`,
        },
      ]);
    }
    const offender = firstSymlinkComponent(workspace, file.path);
    if (offender !== undefined) {
      throw new ManagedFilesError([
        {
          reason: "path-escape",
          detail: `manifest path ${file.path} crosses symbolic link ${offender}; refusing to remove through it`,
        },
      ]);
    }
    entries.push({ path: file.path, sha256: file.sha256, abs: nativeJoin(workspace, file.path) });
  }

  for (const entry of entries) {
    let info;
    try {
      info = lstatSync(entry.abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        report.missing.push(entry.path);
        continue;
      }
      throw new ManagedFilesError([
        {
          reason: "manifest-corrupt",
          detail: `cannot inspect generated path ${entry.path}: ${errorMessage(error)}`,
        },
      ]);
    }
    // A symlink at a generated path is tampering evidence. The leaf is handled
    // FIRST (before isFile): lstat reports a link as not-a-file, and only unlink
    // is safe here because it removes the link itself while never following or
    // traversing it. The link target is captured as evidence before removal.
    if (info.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(entry.abs);
      } catch {
        target = "?";
      }
      try {
        unlinkSync(entry.abs);
      } catch (error) {
        throw new ManagedFilesError(
          [
            {
              reason: "unlink-failed",
              detail: `cannot remove symbolic link at ${entry.path}: ${errorMessage(error)}`,
            },
          ],
          report,
        );
      }
      report.suspicious.push({ path: entry.path, kind: "symlink", target });
      continue;
    }
    if (!info.isFile()) {
      // A directory (or special file) where a generated file belongs cannot be
      // removed safely by unlink; the workspace no longer matches its
      // pre-generation state, so the caller must not proceed.
      report.unremoved.push(entry.path);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(entry.abs);
    } catch {
      report.unremoved.push(entry.path);
      continue;
    }
    const actualSha = sha256Hex(bytes);
    let evidencePath: string | undefined;
    if (actualSha !== entry.sha256) {
      // The agent edited its own generated file. The journal only holds the
      // expected sha, so the edited bytes WOULD be unrecoverable after an
      // unlink — write them to a content-addressed evidence file outside the
      // worktree first, then remove the generated file so it cannot reach a
      // diff. If the evidence cannot be preserved the file is left in place
      // (unremoved) rather than destroyed unrecorded.
      const candidateEvidence = editedEvidencePath(manifest, entry.path, actualSha);
      try {
        writePrivateEvidence(
          candidateEvidence,
          `${JSON.stringify(
            {
              path: entry.path,
              expectedSha: entry.sha256,
              actualSha,
              content: bytes.toString("utf8"),
              recordedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          0o600,
        );
        evidencePath = candidateEvidence;
      } catch {
        // A prior cleanup may have written the evidence before crashing. Reuse
        // it only when the existing sidecar proves the same edited bytes; never
        // replace a different record at this path.
        try {
          const prior = JSON.parse(readFileSync(candidateEvidence, "utf8")) as Record<
            string,
            unknown
          >;
          if (
            prior.path === entry.path &&
            prior.expectedSha === entry.sha256 &&
            prior.actualSha === actualSha &&
            prior.content === bytes.toString("utf8")
          ) {
            evidencePath = candidateEvidence;
          }
        } catch {
          // The existing evidence is not usable; keep the generated file.
        }
        if (evidencePath === undefined) {
          report.unremoved.push(entry.path);
          continue;
        }
      }
    }
    try {
      unlinkSync(entry.abs);
    } catch {
      report.unremoved.push(entry.path);
      continue;
    }
    if (actualSha === entry.sha256) {
      report.removed.push(entry.path);
    } else {
      report.edited.push({
        path: entry.path,
        expectedSha: entry.sha256,
        actualSha,
        evidencePath: evidencePath!,
      });
    }
  }

  // Best-effort removal of directories this attempt created, up to `.opencode`.
  // Never removes a non-empty directory and never touches pre-existing files.
  for (const directory of [
    nativeJoin(workspace, OPENCODE_AGENT_DIR, journal.namespace),
    nativeJoin(workspace, OPENCODE_AGENT_DIR),
    nativeJoin(workspace, ".opencode"),
  ]) {
    try {
      if (lstatSync(directory).isDirectory() && readdirSync(directory).length === 0) {
        rmdirSync(directory);
      }
    } catch {
      // Absent, non-empty, or unexpectedly protected — leave in place.
    }
  }

  // Confirm the generated paths are invisible to git: anything still listed
  // would enter a publication diff.
  let statuses: string[] = [];
  try {
    const status = await git(["status", "--porcelain=v1", "-z", "-uall"], { cwd: workspace });
    statuses = status.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(3));
  } catch (error) {
    throw new ManagedFilesError([
      {
        reason: "git-unavailable",
        detail: `cannot verify the worktree after cleanup in ${workspace}: ${errorMessage(error)}`,
      },
    ]);
  }
  // An agent may create a *new* file under its generated namespace. It is not
  // manifest-owned, so never remove it automatically; nevertheless it cannot
  // be allowed into a published diff or a later OpenCode discovery pass.
  for (const path of statuses) {
    if (path === namespacePrefix.slice(0, -1) || path.startsWith(namespacePrefix)) {
      report.residual.push(path);
    }
  }
  const namespaceDirectory = nativeJoin(workspace, OPENCODE_AGENT_DIR, journal.namespace);
  try {
    for (const name of readdirSync(namespaceDirectory)) {
      const path = `${namespacePrefix}${name}`;
      if (!report.residual.includes(path)) report.residual.push(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      report.residual.push(namespacePrefix.slice(0, -1));
    }
  }

  for (const [rel, expected] of Object.entries(journal.trackedOpencode)) {
    if (!isPristineRelPath(rel) || !isStrictlyBeneath(nativeJoin(workspace, rel), workspace)) {
      throw new ManagedFilesError([
        {
          reason: "path-escape",
          detail: `manifest tracked path ${JSON.stringify(rel)} escapes the worktree ${workspace}`,
        },
      ]);
    }
    let actual: string | null;
    try {
      actual = sha256Hex(readFileSync(nativeJoin(workspace, rel)));
    } catch {
      actual = null;
    }
    if (actual !== expected) {
      report.trackedChanged.push({ path: rel, expected, actual });
    }
  }

  report.clean = report.unremoved.length === 0 && report.residual.length === 0;
  if (!report.clean) {
    const blocked = [...report.unremoved, ...report.residual];
    throw new ManagedFilesError(
      blocked.map((path) => ({
        reason: "generated-content-remains" as const,
        detail: `generated OpenCode agent content remains at ${path}; the workspace does not match its pre-generation state`,
      })),
      report,
    );
  }
  return report;
}
