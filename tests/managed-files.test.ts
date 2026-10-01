/**
 * Focused tests for task 3.2: the attempt-owned lifecycle for generated
 * OpenCode V2 agent files (`src/agent/managed-files.ts`). Covers materializing
 * only serialized attempt-owned files inside a prepared disposable worktree,
 * journaling the manifest outside the worktree atomically before any file is
 * written, refusing existing namespaces / symlink chains / path escapes /
 * tracked-file collisions, idempotent cleanup on success and cancellation
 * shapes, detection of agent edits to generated files, cleanup restricted to
 * manifest-listed files, byte-identical untouched tracked OpenCode files, and
 * no generated file entering a publishable diff (verified through git).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeOpenCodeAgents } from "../src/agent/materialize.js";
import {
  cleanupManagedOpencodeFiles,
  ManagedFilesError,
  materializeManagedOpencodeFiles,
  readManagedOpencodeManifest,
} from "../src/agent/managed-files.js";
import { parseOpenCodeAgentProfile } from "../src/config/opencode-profile.js";
import { git } from "../src/workspace/gitops.js";

const AUTHOR = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

interface TempRepo {
  root: string;
  workspace: string;
  manifestDir: string;
}

/** A clean disposable git worktree standing in for a prepared attempt worktree. */
async function makeWorkspace(): Promise<TempRepo> {
  const root = mkdtempSync(join(tmpdir(), "gremlyn-managed-files-"));
  const workspace = join(root, "worktree");
  mkdirSync(workspace, { recursive: true });
  const manifestDir = join(root, "manifests");
  await git(["init"], { cwd: workspace });
  await git([...AUTHOR, "commit", "--allow-empty", "-m", "root"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "# temp repo\n", "utf8");
  await git(["add", "-A"], { cwd: workspace });
  await git([...AUTHOR, "commit", "-m", "base"], { cwd: workspace });
  return { root, workspace, manifestDir };
}

/** Build a validated profile and serialize it into one attempt namespace. */
function serializedFor(namespace: string): ReturnType<typeof serializeOpenCodeAgents> {
  const profile = parseOpenCodeAgentProfile({
    version: 1,
    primary: {
      id: "primary",
      description: "Primary review agent",
      permissions: ["edit", "shell"],
    },
    subagents: [
      { id: "reviewer", description: "Reviews the change", enabled: true, permissions: ["edit"] },
    ],
  });
  return serializeOpenCodeAgents({ profile, namespace });
}

function nativeJoin(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

function cleanupRoot(repo: TempRepo): void {
  rmSync(repo.root, { recursive: true, force: true });
}

test("materialize writes exactly the serialized files and journals the manifest outside the worktree", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-1");
    const manifestPath = join(repo.manifestDir, "att-1.json");
    const result = await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
      profileFingerprint: "rev-7",
    });

    assert.deepEqual(
      [...result.files],
      serialized.files.map((file) => file.path),
    );
    assert.equal(result.manifestPath, resolve(manifestPath));
    for (const file of serialized.files) {
      assert.equal(
        readFileSync(nativeJoin(repo.workspace, file.path), "utf8"),
        file.content,
        `generated file ${file.path} must land byte-for-byte in the worktree`,
      );
    }

    // The journal lives outside the worktree and carries full ownership data.
    const journal = readManagedOpencodeManifest(manifestPath);
    assert.ok(journal, "manifest must exist outside the worktree");
    assert.equal(journal.namespace, "att-1");
    assert.equal(journal.workspacePath, resolve(repo.workspace));
    assert.equal(journal.profileFingerprint, "rev-7");
    assert.deepEqual(
      journal.files.map((file) => file.path),
      serialized.files.map((file) => file.path),
    );

    // Nothing generated is tracked by git.
    const tracked = (await git(["ls-files"], { cwd: repo.workspace })).stdout;
    assert.equal(tracked.includes(".opencode/"), false);
  } finally {
    cleanupRoot(repo);
  }
});

test("the journal is written before generated files, so a mid-write failure leaves evidence", async () => {
  const repo = await makeWorkspace();
  try {
    // `.opencode/agents` is a regular file, so the namespace directory cannot
    // be created. The refusal happens only in the write phase, after the
    // journal already landed.
    mkdirSync(join(repo.workspace, ".opencode"));
    writeFileSync(join(repo.workspace, ".opencode", "agents"), "not a directory\n", "utf8");
    const manifestPath = join(repo.manifestDir, "att-2.json");

    await assert.rejects(
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
        serialized: serializedFor("att-2"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("write-failed"));
        return true;
      },
    );

    // Journal-before-write: even though no generated file exists, the attempt
    // left cleanup evidence outside the worktree.
    const journal = readManagedOpencodeManifest(manifestPath);
    assert.ok(journal, "journal must exist even when the write phase fails");
    assert.equal(journal.namespace, "att-2");
    assert.equal(existsSync(join(repo.workspace, ".opencode", "agents", "att-2")), false);
  } finally {
    cleanupRoot(repo);
  }
});

test("materialize refuses an existing attempt namespace and writes nothing", async () => {
  const repo = await makeWorkspace();
  try {
    const stalePath = join(repo.workspace, ".opencode", "agents", "att-3");
    mkdirSync(stalePath, { recursive: true });
    writeFileSync(join(stalePath, "stale.md"), "stale\n", "utf8");
    const manifestPath = join(repo.manifestDir, "att-3.json");

    await assert.rejects(
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
        serialized: serializedFor("att-3"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("namespace-exists"));
        return true;
      },
    );

    // Nothing was journaled and the pre-existing file is untouched.
    assert.equal(existsSync(manifestPath), false);
    assert.equal(readFileSync(join(stalePath, "stale.md"), "utf8"), "stale\n");
  } finally {
    cleanupRoot(repo);
  }
});

test("materialize refuses a symlink in the generated path chain", async () => {
  const repo = await makeWorkspace();
  try {
    const external = join(repo.root, "external");
    mkdirSync(external, { recursive: true });
    symlinkSync(
      external,
      join(repo.workspace, ".opencode"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifestPath = join(repo.manifestDir, "att-5.json");

    await assert.rejects(
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
        serialized: serializedFor("att-5"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("symlink-component"));
        return true;
      },
    );
    assert.equal(existsSync(manifestPath), false);
  } finally {
    cleanupRoot(repo);
  }
});

test("materialize refuses tracked collisions and a tracked-but-absent namespace", async () => {
  const repo = await makeWorkspace();
  try {
    const trackedDir = join(repo.workspace, ".opencode", "agents", "att-6");
    mkdirSync(trackedDir, { recursive: true });
    const trackedFile = join(trackedDir, "primary.md");
    writeFileSync(trackedFile, "tracked\n", "utf8");
    await git(["add", "-A"], { cwd: repo.workspace });
    await git([...AUTHOR, "commit", "-m", "tracked agent file"], { cwd: repo.workspace });
    const manifestPath = join(repo.manifestDir, "att-6.json");

    const refuse = (): Promise<ManagedFilesError | undefined> =>
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
        serialized: serializedFor("att-6"),
      }).then(
        () => undefined,
        (error: unknown) =>
          error instanceof ManagedFilesError ? error : assert.fail("expected ManagedFilesError"),
      );

    // A tracked file on disk occupies the namespace directory, so the generated
    // namespace refuses to appear over it — and the file stays untouched.
    let error = await refuse();
    assert.ok(error);
    assert.ok(error.reasons.includes("namespace-exists"));
    assert.equal(existsSync(manifestPath), false);
    assert.equal(readFileSync(trackedFile, "utf8"), "tracked\n");

    // Removing the directory from the worktree does not release the collision:
    // the path is still in the index, and writing there would stage a tracked
    // change. This is the pure tracked-collision refusal.
    rmSync(join(repo.workspace, ".opencode"), { recursive: true, force: true });
    error = await refuse();
    assert.ok(error);
    assert.ok(error.reasons.includes("tracked-file-collision"));
    assert.equal(existsSync(manifestPath), false);
    assert.equal(existsSync(join(repo.workspace, ".opencode", "agents", "att-6")), false);
  } finally {
    cleanupRoot(repo);
  }
});

test("materialize refuses an existing journal and a journal inside the worktree", async () => {
  const repo = await makeWorkspace();
  try {
    const manifestPath = join(repo.manifestDir, "att-7.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized: serializedFor("att-7"),
    });

    await assert.rejects(
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
        serialized: serializedFor("att-7"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-exists"));
        return true;
      },
    );

    const inside = join(repo.workspace, "journal.json");
    await assert.rejects(
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath: inside,
        serialized: serializedFor("att-7"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-path-inside-workspace"));
        return true;
      },
    );
    assert.equal(existsSync(inside), false);
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup removes generated files, restores the workspace, and leaves tracked OpenCode bytes identical", async () => {
  const repo = await makeWorkspace();
  try {
    // A tracked OpenCode configuration file that materialization must never touch.
    mkdirSync(join(repo.workspace, ".opencode"));
    const config = join(repo.workspace, ".opencode", "config.json");
    const configBytes = `${JSON.stringify({ model: "opencode/big-pickle" }, null, 2)}\n`;
    writeFileSync(config, configBytes, "utf8");
    await git(["add", "-A"], { cwd: repo.workspace });
    await git([...AUTHOR, "commit", "-m", "tracked opencode config"], { cwd: repo.workspace });

    const serialized = serializedFor("att-8");
    const manifestPath = join(repo.manifestDir, "att-8.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    const report = await cleanupManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
    });
    assert.equal(report.clean, true);
    assert.equal(report.removed.length, serialized.files.length);
    assert.equal(report.missing.length, 0);
    assert.equal(report.edited.length, 0);
    assert.deepEqual(report.trackedChanged, []);

    for (const file of serialized.files) {
      assert.equal(
        existsSync(nativeJoin(repo.workspace, file.path)),
        false,
        `generated file ${file.path} must be gone after cleanup`,
      );
    }
    // Untouched tracked OpenCode file is byte-identical after the round trip.
    assert.equal(readFileSync(config, "utf8"), configBytes);

    // No generated path is visible to git, so none can enter a publishable diff.
    const status = await git(["status", "--porcelain=v1", "-uall"], { cwd: repo.workspace });
    assert.equal(status.stdout.includes(".opencode"), false);
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup detects agent edits to generated files and preserves the evidence outside the worktree before removal", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-9");
    const manifestPath = join(repo.manifestDir, "att-9.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    const primaryRel = serialized.files.find((file) => file.path.endsWith("/primary.md"))!.path;
    const primaryAbs = nativeJoin(repo.workspace, primaryRel);
    writeFileSync(primaryAbs, "---\nvandalized by the agent\n", "utf8");

    const report = await cleanupManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
    });
    assert.equal(report.clean, true);
    assert.deepEqual(
      report.edited.map((entry) => entry.path),
      [primaryRel],
    );
    const edited = report.edited[0]!;
    assert.ok(
      edited.expectedSha !== edited.actualSha,
      "the edited file's actual bytes must differ from the journaled expectation",
    );
    // The edited bytes are preserved in a content-addressed evidence file
    // OUTSIDE the worktree (never inline in the report), so private instruction
    // text never travels through the report and survives the unlink.
    assert.ok(edited.evidencePath.startsWith(manifestPath + ".edited-"));
    assert.ok(edited.evidencePath.endsWith(`${edited.actualSha}.json`));
    assert.equal(
      existsSync(edited.evidencePath),
      true,
      "evidence must be journaled next to the manifest",
    );
    const evidence = JSON.parse(readFileSync(edited.evidencePath, "utf8")) as {
      path: string;
      content: string;
    };
    assert.equal(evidence.path, primaryRel);
    assert.equal(evidence.content, "---\nvandalized by the agent\n");
    // The vandalized generated file was still removed, so it cannot reach a diff.
    assert.equal(existsSync(primaryAbs), false);
    assert.equal(report.removed.length, serialized.files.length - 1);
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup fails closed on a missing journal and stays idempotent on a retained one", async () => {
  const repo = await makeWorkspace();
  try {
    // A missing journal cannot prove generated content is absent: it must not
    // look clean. Callers only clean up attempts whose manifest was journaled.
    await assert.rejects(
      cleanupManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath: join(repo.root, "does-not-exist", "nope.json"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-missing"));
        return true;
      },
    );

    const serialized = serializedFor("att-10");
    const manifestPath = join(repo.manifestDir, "att-10.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    const first = await cleanupManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
    });
    assert.equal(first.clean, true);

    // A repeated cleanup reads the retained manifest, finds everything already
    // gone, and stays clean.
    const second = await cleanupManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
    });
    assert.equal(second.clean, true);
    assert.equal(second.removed.length, 0);
    assert.equal(second.missing.length, serialized.files.length);
    assert.equal(second.edited.length, 0);
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup leaves real agent changes in the diff and no generated files on every outcome shape", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-11");
    const manifestPath = join(repo.manifestDir, "att-11.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    // The agent's actual review fix lands between materialization and cleanup.
    writeFileSync(join(repo.workspace, "README.md"), "# temp repo\n\nfixed per review\n", "utf8");

    // Success, failure, and cancellation all take the same cleanup path; run it
    // three times to prove repeated calls stay clean.
    for (let index = 0; index < 3; index += 1) {
      const report = await cleanupManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
      });
      assert.equal(report.clean, true);
    }

    const status = await git(["status", "--porcelain=v1", "-uall"], { cwd: repo.workspace });
    const lines = status.stdout.split("\n").filter((line) => line.length > 0);
    assert.ok(
      lines.some((line) => line.includes("README.md")),
      "the agent's real fix remains an ordinary workspace change",
    );
    assert.equal(
      lines.some((line) => line.includes(".opencode")),
      false,
      "no generated OpenCode file may enter the publishable diff",
    );
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup preserves unlisted files but refuses publication of an occupied namespace", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-12");
    const manifestPath = join(repo.manifestDir, "att-12.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    const extraPath = join(repo.workspace, ".opencode", "agents", "att-12", "agent-extra.md");
    writeFileSync(extraPath, "the agent wrote this itself\n", "utf8");

    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath }),
      (error: unknown) =>
        error instanceof ManagedFilesError &&
        error.cleanupReport?.residual.includes(".opencode/agents/att-12/agent-extra.md") === true,
    );
    for (const file of serialized.files) {
      assert.equal(existsSync(nativeJoin(repo.workspace, file.path)), false);
    }
    // This file is not manifest-owned. Keep it as evidence, but don't allow it
    // into a publishable diff or a later OpenCode discovery pass.
    assert.equal(readFileSync(extraPath, "utf8"), "the agent wrote this itself\n");

    const status = await git(["status", "--porcelain=v1", "-uall"], { cwd: repo.workspace });
    const lines = status.stdout.split("\n").filter((line) => line.length > 0);
    assert.equal(
      lines.filter((line) => line.includes(".opencode") && !line.includes("agent-extra.md")).length,
      0,
    );
    assert.equal(lines.filter((line) => line.includes("agent-extra.md")).length, 1);
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup removes a symlink at a generated path without traversing to its target", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-sym");
    const manifestPath = join(repo.manifestDir, "att-sym.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    const primaryRel = serialized.files.find((file) => file.path.endsWith("/primary.md"))!.path;
    const primaryAbs = nativeJoin(repo.workspace, primaryRel);
    // The agent replaced its generated file with a link pointing outside the
    // worktree. Cleanup must unlink the link itself and never follow it.
    const outsideDir = join(repo.root, "outside-target");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "keep.txt"), "must survive\n", "utf8");
    unlinkSync(primaryAbs);
    symlinkSync(outsideDir, primaryAbs, process.platform === "win32" ? "junction" : "dir");

    const report = await cleanupManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
    });
    assert.equal(report.clean, true);
    assert.equal(report.suspicious.length, 1);
    assert.equal(report.suspicious[0]!.path, primaryRel);
    assert.equal(report.suspicious[0]!.kind, "symlink");
    assert.ok(
      typeof report.suspicious[0]!.target === "string" && report.suspicious[0]!.target.length > 0,
      "the link target is preserved as evidence",
    );
    // The link itself is gone, but the tree it pointed at is untouched.
    assert.equal(existsSync(primaryAbs), false);
    assert.equal(readFileSync(join(outsideDir, "keep.txt"), "utf8"), "must survive\n");
    // The sibling generated file was still removed normally.
    assert.equal(report.removed.length, serialized.files.length - 1);
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup fails closed when the journal is lost while generated files remain", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-lost");
    const manifestPath = join(repo.manifestDir, "att-lost.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });
    // Simulate a crash that destroyed the attempt data dir but not the worktree.
    rmSync(manifestPath, { force: true });

    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-missing"));
        return true;
      },
    );
    // Nothing was silently "cleaned": the generated files are still present,
    // so a recovery pass can still refuse to trust the workspace.
    for (const file of serialized.files) {
      assert.equal(existsSync(nativeJoin(repo.workspace, file.path)), true);
    }
  } finally {
    cleanupRoot(repo);
  }
});

test("manifest parsing rejects malformed generated paths and out-of-scope tracked keys", async () => {
  const repo = await makeWorkspace();
  try {
    mkdirSync(repo.manifestDir, { recursive: true });
    const manifestPath = join(repo.manifestDir, "parser.json");
    const base = {
      version: 1,
      namespace: "att-p",
      workspacePath: resolve(repo.workspace),
      created: new Date().toISOString(),
      trackedOpencode: {},
    };
    const corruptFiles = async (files: unknown): Promise<void> => {
      writeFileSync(manifestPath, JSON.stringify({ ...base, files }), "utf8");
      await assert.rejects(
        cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath }),
        (error: unknown) => {
          assert.ok(error instanceof ManagedFilesError);
          assert.ok(error.reasons.includes("manifest-corrupt"));
          return true;
        },
      );
    };

    // Duplicate entries, even differing only by case, are rejected.
    await corruptFiles([
      { path: ".opencode/agents/att-p/primary.md", sha256: "a".repeat(64) },
      { path: ".opencode/agents/att-p/PRIMARY.md", sha256: "b".repeat(64) },
    ]);
    // A nested path below the namespace directory is not an immediate agent.
    await corruptFiles([{ path: ".opencode/agents/att-p/sub/primary.md", sha256: "a".repeat(64) }]);
    // A non-.md name is not a V2 agent file.
    await corruptFiles([{ path: ".opencode/agents/att-p/primary", sha256: "a".repeat(64) }]);
    // Any path outside the attempt namespace is refused.
    await corruptFiles([{ path: ".opencode/sneaky.md", sha256: "a".repeat(64) }]);

    // trackedOpencode keys must live under `.opencode/`.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...base,
        files: [{ path: ".opencode/agents/att-p/primary.md", sha256: "a".repeat(64) }],
        trackedOpencode: { "README.md": "a".repeat(64) },
      }),
      "utf8",
    );
    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-corrupt"));
        return true;
      },
    );
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup fails closed when a directory occupies a generated path", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-13");
    const manifestPath = join(repo.manifestDir, "att-13.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    const primaryRel = serialized.files.find((file) => file.path.endsWith("/primary.md"))!.path;
    const reviewerRel = serialized.files.find((file) => file.path.endsWith("/reviewer.md"))!.path;
    const primaryAbs = nativeJoin(repo.workspace, primaryRel);
    unlinkSync(primaryAbs);
    mkdirSync(primaryAbs, { recursive: true });

    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("generated-content-remains"));
        assert.ok(error.cleanupReport, "the thrown error must carry the partial report");
        assert.ok(error.cleanupReport!.unremoved.includes(primaryRel));
        // The sibling generated file was still removed before failing closed.
        assert.ok(error.cleanupReport!.removed.includes(reviewerRel));
        return true;
      },
    );
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup refuses a different workspace and tampered manifests", async () => {
  const repo = await makeWorkspace();
  try {
    const serialized = serializedFor("att-14");
    const manifestPath = join(repo.manifestDir, "att-14.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    await assert.rejects(
      cleanupManagedOpencodeFiles({
        workspacePath: join(repo.root, "unrelated-workspace"),
        manifestPath,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("workspace-mismatch"));
        return true;
      },
    );

    // A tampered manifest with a traversal path is rejected while parsing —
    // fail-closed before it can name a file — rather than acted upon.
    const escapePath = join(repo.manifestDir, "escape.json");
    writeFileSync(
      escapePath,
      JSON.stringify({
        version: 1,
        namespace: "att-14",
        workspacePath: resolve(repo.workspace),
        created: new Date().toISOString(),
        files: [{ path: "../outside.txt", sha256: "ab".repeat(32) }],
        trackedOpencode: {},
      }),
      "utf8",
    );
    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath: escapePath }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-corrupt"));
        return true;
      },
    );

    // A pristine path outside the attempt namespace is refused by cleanup's
    // own containment guard with a distinct reason.
    writeFileSync(
      escapePath,
      JSON.stringify({
        version: 1,
        namespace: "att-14",
        workspacePath: resolve(repo.workspace),
        created: new Date().toISOString(),
        files: [{ path: ".opencode/sneaky.md", sha256: "ab".repeat(32) }],
        trackedOpencode: {},
      }),
      "utf8",
    );
    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath: escapePath }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-corrupt"));
        return true;
      },
    );

    // A path that passes parsing (inside the namespace with a valid shape) is
    // still refused by cleanup's own traversal guard when the workspace gained
    // a symlink component after materialization.
    const symlinkManifest = join(repo.manifestDir, "symlink-chain.json");
    writeFileSync(
      symlinkManifest,
      JSON.stringify({
        version: 1,
        namespace: "att-14",
        workspacePath: resolve(repo.workspace),
        created: new Date().toISOString(),
        files: [{ path: ".opencode/agents/att-14/primary.md", sha256: "ab".repeat(32) }],
        trackedOpencode: {},
      }),
      "utf8",
    );
    const external = join(repo.root, "external");
    mkdirSync(external, { recursive: true });
    // Replace the materialized `.opencode` directory with a link so cleanup's
    // traversal guard sees a symlink component mid-chain.
    rmSync(join(repo.workspace, ".opencode"), { recursive: true, force: true });
    symlinkSync(
      external,
      join(repo.workspace, ".opencode"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath: symlinkManifest }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("path-escape"));
        return true;
      },
    );

    // A corrupt journal fails closed instead of guessing.
    writeFileSync(escapePath, "{ not json", "utf8");
    await assert.rejects(
      cleanupManagedOpencodeFiles({ workspacePath: repo.workspace, manifestPath: escapePath }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("manifest-corrupt"));
        return true;
      },
    );
    assert.equal(existsSync(join(repo.root, "outside.txt")), false);
  } finally {
    cleanupRoot(repo);
  }
});

test("cleanup reports agent edits to tracked OpenCode files and leaves them as ordinary changes", async () => {
  const repo = await makeWorkspace();
  try {
    mkdirSync(join(repo.workspace, ".opencode"));
    const config = join(repo.workspace, ".opencode", "config.json");
    writeFileSync(config, "one\n", "utf8");
    await git(["add", "-A"], { cwd: repo.workspace });
    await git([...AUTHOR, "commit", "-m", "tracked opencode config"], { cwd: repo.workspace });

    const serialized = serializedFor("att-15");
    const manifestPath = join(repo.manifestDir, "att-15.json");
    await materializeManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
      serialized,
    });

    // The agent edits a tracked OpenCode file while working.
    writeFileSync(config, "two\n", "utf8");

    const report = await cleanupManagedOpencodeFiles({
      workspacePath: repo.workspace,
      manifestPath,
    });
    assert.equal(report.clean, true);
    const changed = report.trackedChanged.find((entry) => entry.path === ".opencode/config.json");
    assert.ok(changed, "cleanup must report the changed tracked OpenCode file");
    assert.ok(
      changed.expected !== null && changed.actual !== null && changed.expected !== changed.actual,
    );
    // The edit stays in the workspace, subject to independent validation.
    assert.equal(readFileSync(config, "utf8"), "two\n");
  } finally {
    cleanupRoot(repo);
  }
});

test("materialize refuses unsafe namespaces and non-conforming generated paths", async () => {
  const repo = await makeWorkspace();
  try {
    // The serializer already rejects unsafe namespaces, so the module's own
    // defence is exercised with a hand-built serialization.
    const manifestPath = join(repo.manifestDir, "att-16.json");
    await assert.rejects(
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
        serialized: {
          namespace: "../escape",
          files: [],
          primaryRuntimeId: "../escape/primary",
          children: [],
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("unsafe-namespace"));
        return true;
      },
    );
    assert.equal(existsSync(manifestPath), false);

    // A generated path outside the namespace dir is refused even under an
    // otherwise safe namespace.
    await assert.rejects(
      materializeManagedOpencodeFiles({
        workspacePath: repo.workspace,
        manifestPath,
        serialized: {
          namespace: "att-16",
          files: [{ path: "README.md", content: "evil" }],
          primaryRuntimeId: "att-16/primary",
          children: [],
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedFilesError);
        assert.ok(error.reasons.includes("path-escape"));
        return true;
      },
    );
    assert.equal(existsSync(manifestPath), false);
    assert.equal(readFileSync(join(repo.workspace, "README.md"), "utf8"), "# temp repo\n");
  } finally {
    cleanupRoot(repo);
  }
});

test("readManagedOpencodeManifest is safe for missing and corrupt journals", () => {
  const root = mkdtempSync(join(tmpdir(), "gremlyn-manifest-read-"));
  try {
    assert.equal(readManagedOpencodeManifest(join(root, "missing.json")), undefined);
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "{ definitely not json", "utf8");
    assert.equal(readManagedOpencodeManifest(corrupt), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
