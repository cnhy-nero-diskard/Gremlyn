import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import {
  isBeneath,
  prepareWorkspace,
  WorkspaceError,
  workspacePathFor,
} from "../src/workspace/worktree.js";
import { currentBranch, git, headSha, statusEntries } from "../src/workspace/gitops.js";
import { resetWorkspace } from "../src/workspace/reset.js";
import { createTempRepo, pushCommit, remoteSha, type TempRepo } from "./helpers/gitrepo.js";

const AUTHOR = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

test("worktree create ends on the expected branch at the expected commit", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 42,
    headBranch: repo.headBranch,
    headSha: expectedSha,
  });
  assert.equal(prepared.created, true);
  assert.equal(prepared.path, workspacePathFor(repo.workspaceRoot, 42));
  assert.equal(await currentBranch(prepared.path), repo.headBranch);
  assert.equal(await headSha(prepared.path), expectedSha);
});

test("source checkout already on the PR branch uses an independent clone", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  await git(["checkout", repo.headBranch], { cwd: repo.sourcePath });
  writeFileSync(join(repo.sourcePath, "developer-notes.txt"), "keep in source\n", "utf8");
  const sourceStatus = await statusEntries(repo.sourcePath);

  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 93,
    headBranch: repo.headBranch,
    headSha: expectedSha,
  });

  assert.equal(prepared.created, true);
  assert.equal(await currentBranch(prepared.path), repo.headBranch);
  assert.equal(await headSha(prepared.path), expectedSha);
  assert.deepEqual(await statusEntries(repo.sourcePath), sourceStatus);
  assert.equal(await currentBranch(repo.sourcePath), repo.headBranch);
  const registered = await git(["worktree", "list", "--porcelain"], { cwd: repo.sourcePath });
  assert.equal(registered.stdout.includes(prepared.path), false);

  const nextSha = await pushCommit(
    repo.sourcePath,
    repo.headBranch,
    "follow-up.txt",
    "follow-up\n",
    "follow-up feature work",
  );
  const refreshed = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 93,
    headBranch: repo.headBranch,
    headSha: nextSha,
  });
  assert.equal(refreshed.created, false);
  assert.equal(await headSha(refreshed.path), nextSha);
  assert.deepEqual(await statusEntries(repo.sourcePath), sourceStatus);
});

test("existing clean workspace is refreshed to the current head", async () => {
  const repo = await createTempRepo();
  const firstSha = await remoteSha(repo.remotePath, repo.headBranch);
  await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 7,
    headBranch: repo.headBranch,
    headSha: firstSha,
  });
  // Move the remote head forward, then prepare again.
  const secondSha = await pushCommit(
    repo.sourcePath,
    repo.headBranch,
    "more.txt",
    "more\n",
    "more work",
  );
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 7,
    headBranch: repo.headBranch,
    headSha: secondSha,
  });
  assert.equal(prepared.created, false);
  assert.equal(await headSha(prepared.path), secondSha);
});

test("dirty workspace fails with workspace-dirty and contents are preserved", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 9,
    headBranch: repo.headBranch,
    headSha: sha,
  });
  writeFileSync(join(prepared.path, "leftover.txt"), "interrupted work\n", "utf8");
  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 9,
      headBranch: repo.headBranch,
      headSha: sha,
    }),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceError);
      assert.equal(err.reason, "workspace-dirty");
      return true;
    },
  );
  // Leftover content is intact.
  assert.equal(readFileSync(join(prepared.path, "leftover.txt"), "utf8"), "interrupted work\n");
});

test("validated abrupt-run retry resumes a dirty workspace at the same head", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 10,
    headBranch: repo.headBranch,
    headSha: sha,
  });
  writeFileSync(join(prepared.path, "retained.txt"), "keep me\n", "utf8");

  const resumed = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 10,
    headBranch: repo.headBranch,
    headSha: sha,
    resumeDirtyWorkspace: true,
  });
  assert.equal(resumed.created, false);
  assert.equal(readFileSync(join(resumed.path, "retained.txt"), "utf8"), "keep me\n");
});

test("dirty resume still refuses a workspace whose base head diverged", async () => {
  const repo = await createTempRepo();
  const firstSha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 12,
    headBranch: repo.headBranch,
    headSha: firstSha,
  });
  writeFileSync(join(prepared.path, "retained.txt"), "keep me\n", "utf8");
  const secondSha = await pushCommit(
    repo.sourcePath,
    repo.headBranch,
    "next.txt",
    "next\n",
    "advance",
  );

  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 12,
      headBranch: repo.headBranch,
      headSha: secondSha,
      resumeDirtyWorkspace: true,
    }),
    (err: unknown) => err instanceof WorkspaceError && err.reason === "workspace-diverged",
  );
});

test("workspace path derives from root and PR number only", () => {
  const attackerBranch = "../../outside";
  assert.equal(workspacePathFor("/root", 42), join("/root", "pr-42"));
  assert.equal(workspacePathFor("/root", 42).includes(attackerBranch), false);
  assert.throws(() => workspacePathFor("/root", 0), WorkspaceError);
  assert.throws(() => workspacePathFor("/root", Number("../escape") as number), WorkspaceError);
});

test("isBeneath confines paths to the workspace root", () => {
  assert.equal(isBeneath(join("/root", "pr-1"), "/root"), true);
  assert.equal(isBeneath("/root", "/root"), false);
  assert.equal(isBeneath(join("/root", "..", "elsewhere"), "/root"), false);
});

test("conflicted workspace fails specifically and preserves conflict state", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 11,
    headBranch: repo.headBranch,
    headSha: sha,
  });

  await git(["checkout", "-b", "conflict-side"], { cwd: prepared.path });
  writeFileSync(join(prepared.path, "feature.txt"), "side\n", "utf8");
  await git(["add", "feature.txt"], { cwd: prepared.path });
  await git([...AUTHOR, "commit", "-m", "side"], { cwd: prepared.path });
  await git(["checkout", repo.headBranch], { cwd: prepared.path });
  writeFileSync(join(prepared.path, "feature.txt"), "local\n", "utf8");
  await git(["add", "feature.txt"], { cwd: prepared.path });
  await git([...AUTHOR, "commit", "-m", "local"], { cwd: prepared.path });
  await git(["merge", "conflict-side"], { cwd: prepared.path }).catch(() => undefined);
  const conflictContents = readFileSync(join(prepared.path, "feature.txt"), "utf8");

  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 11,
      headBranch: repo.headBranch,
      headSha: sha,
    }),
    (err: unknown) => err instanceof WorkspaceError && err.reason === "workspace-conflicted",
  );
  assert.equal(readFileSync(join(prepared.path, "feature.txt"), "utf8"), conflictContents);
  assert.ok((await git(["diff", "--name-only", "--diff-filter=U"], { cwd: prepared.path })).stdout);
});

test("diverged workspace fails specifically and preserves local commits", async () => {
  const repo = await createTempRepo();
  const originalSha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 12,
    headBranch: repo.headBranch,
    headSha: originalSha,
  });
  const remoteHead = await pushCommit(
    repo.sourcePath,
    repo.headBranch,
    "remote.txt",
    "remote\n",
    "remote advance",
  );
  writeFileSync(join(prepared.path, "local.txt"), "local\n", "utf8");
  await git(["add", "local.txt"], { cwd: prepared.path });
  await git([...AUTHOR, "commit", "-m", "local advance"], { cwd: prepared.path });
  const localHead = await headSha(prepared.path);

  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 12,
      headBranch: repo.headBranch,
      headSha: remoteHead,
    }),
    (err: unknown) => err instanceof WorkspaceError && err.reason === "workspace-diverged",
  );
  assert.equal(await headSha(prepared.path), localHead);
  assert.equal(readFileSync(join(prepared.path, "local.txt"), "utf8"), "local\n");
});

test("a clean workspace ahead of the expected head is reconciled by pushing forward", async () => {
  const repo = await createTempRepo();
  const originalSha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 15,
    headBranch: repo.headBranch,
    headSha: originalSha,
  });
  // A prior agent run committed its own fix but never pushed it — the
  // workspace is clean, just ahead of what the remote (and this attempt's
  // recorded expectation) still shows.
  writeFileSync(join(prepared.path, "self-committed.txt"), "agent fix\n", "utf8");
  await git(["add", "self-committed.txt"], { cwd: prepared.path });
  await git([...AUTHOR, "commit", "-m", "Resolve review feedback (comment 1)"], {
    cwd: prepared.path,
  });
  const aheadSha = await headSha(prepared.path);

  const reconciled = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 15,
    headBranch: repo.headBranch,
    headSha: originalSha,
  });

  assert.equal(reconciled.created, false);
  assert.equal(reconciled.headSha, aheadSha);
  assert.equal(await headSha(reconciled.path), aheadSha);
  assert.equal(await remoteSha(repo.remotePath, repo.headBranch), aheadSha);
});

test("non-worktree workspace fails specifically and preserves contents", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const target = workspacePathFor(repo.workspaceRoot, 13);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "marker.txt"), "keep\n", "utf8");

  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 13,
      headBranch: repo.headBranch,
      headSha: sha,
    }),
    (err: unknown) => err instanceof WorkspaceError && err.reason === "workspace-not-worktree",
  );
  assert.equal(readFileSync(join(target, "marker.txt"), "utf8"), "keep\n");
});

test("explicit reset recreates only the deterministic workspace and records actions", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 14,
    headBranch: repo.headBranch,
    headSha: sha,
  });
  writeFileSync(join(prepared.path, "discard.txt"), "discard\n", "utf8");
  const outside = join(repo.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "marker.txt"), "keep\n", "utf8");
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const actions = new OperatorActionStore(store.db);

  try {
    await assert.rejects(
      resetWorkspace({
        sourcePath: repo.sourcePath,
        workspaceRoot: repo.workspaceRoot,
        prNumber: 14,
        headBranch: repo.headBranch,
        headSha: sha,
        targetPath: outside,
        actions,
      }),
      (err: unknown) => err instanceof WorkspaceError && err.reason === "workspace-outside-root",
    );
    assert.equal(readFileSync(join(outside, "marker.txt"), "utf8"), "keep\n");

    const reset = await resetWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 14,
      headBranch: repo.headBranch,
      headSha: sha,
      actions,
    });
    assert.equal(reset.path, prepared.path);
    assert.equal(existsSync(join(reset.path, "discard.txt")), false);
    assert.deepEqual(await statusEntries(reset.path), []);
    const recorded = actions.list().reverse();
    assert.deepEqual(
      recorded.map(({ action, target, effect }) => ({ action, target, effect })),
      [
        { action: "workspace-reset", target: outside, effect: "refused" },
        { action: "workspace-reset", target: prepared.path, effect: "recreated" },
      ],
    );
  } finally {
    store.close();
  }
});

/**
 * A worktree registration whose directory is gone still counts, to git, as
 * holding its branch — so `worktree add` fails with "already used by worktree
 * at <path>" and the job dies at `preparing` with no way to retry out of it.
 * Deleting a worktree by hand does this, as does one created under a path this
 * OS can no longer resolve (a WSL `/mnt/...` path). `fetch --prune` does not
 * clear it; only `git worktree prune` does.
 */
test("a stale worktree registration holding the branch is pruned, not fatal", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);

  // Register a worktree on the head branch, then delete its directory so the
  // registration survives as "prunable" — exactly the observed state.
  const stale = join(repo.workspaceRoot, "stale-holder");
  await git(["worktree", "add", stale, repo.headBranch], { cwd: repo.sourcePath });
  rmSync(stale, { recursive: true, force: true });
  const listed = await git(["worktree", "list"], { cwd: repo.sourcePath });
  assert.match(listed.stdout, /prunable/u);

  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 12,
    headBranch: repo.headBranch,
    headSha: expectedSha,
  });

  assert.equal(prepared.created, true);
  assert.equal(prepared.headSha, expectedSha);
  assert.equal(await currentBranch(prepared.path), repo.headBranch);
});

test("a live worktree holding the branch fails as branch-in-use, not corruption", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);

  // Still on disk: another checkout legitimately owns the branch. Pruning must
  // not touch it, and force-adding would corrupt that working copy.
  const live = join(repo.workspaceRoot, "live-holder");
  await git(["worktree", "add", live, repo.headBranch], { cwd: repo.sourcePath });

  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 13,
      headBranch: repo.headBranch,
      headSha: expectedSha,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceError);
      assert.equal(error.reason, "workspace-branch-in-use");
      // The operator has to release a specific directory; name it.
      assert.match(error.message, /live-holder/u);
      return true;
    },
  );
  assert.equal(existsSync(live), true, "the live worktree must survive");
});

/** A feature-branch commit that ignores `local.properties`, plus the file itself. */
async function repoWithIgnoredSeed(): Promise<{ repo: TempRepo; headSha: string }> {
  const repo = await createTempRepo();
  const headSha = await pushCommit(
    repo.sourcePath,
    repo.headBranch,
    ".gitignore",
    "local.properties\n",
    "ignore local.properties",
  );
  return { repo, headSha };
}

test("gitignored seed files are copied into a freshly created workspace", async () => {
  const { repo, headSha: expectedSha } = await repoWithIgnoredSeed();
  writeFileSync(join(repo.sourcePath, "local.properties"), "sdk.dir=/opt/sdk\n", "utf8");

  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 51,
    headBranch: repo.headBranch,
    headSha: expectedSha,
    seedFiles: ["local.properties"],
  });

  assert.equal(readFileSync(join(prepared.path, "local.properties"), "utf8"), "sdk.dir=/opt/sdk\n");
  // Ignored, so it never makes the workspace dirty and is never committed.
  assert.deepEqual(await statusEntries(prepared.path), []);
});

test("a seed file deleted from an existing workspace is restored on the next preparation", async () => {
  const { repo, headSha: expectedSha } = await repoWithIgnoredSeed();
  writeFileSync(join(repo.sourcePath, "local.properties"), "sdk.dir=/opt/sdk\n", "utf8");
  const options = {
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 52,
    headBranch: repo.headBranch,
    headSha: expectedSha,
    seedFiles: ["local.properties"],
  };
  const first = await prepareWorkspace(options);
  rmSync(join(first.path, "local.properties"));

  const second = await prepareWorkspace(options);

  assert.equal(second.created, false);
  assert.equal(existsSync(join(second.path, "local.properties")), true);
});

test("a seed file git tracks is refused rather than copied", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  // `feature.txt` is committed, so seeding it would be picked up by `git add -A`.
  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 53,
      headBranch: repo.headBranch,
      headSha: expectedSha,
      seedFiles: ["feature.txt"],
    }),
    (error: unknown) => error instanceof WorkspaceError && error.reason === "workspace-seed-failed",
  );
});

test("a seed file missing from the source checkout fails with a seed reason", async () => {
  const { repo, headSha: expectedSha } = await repoWithIgnoredSeed();

  await assert.rejects(
    prepareWorkspace({
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber: 54,
      headBranch: repo.headBranch,
      headSha: expectedSha,
      seedFiles: ["local.properties"],
    }),
    (error: unknown) => error instanceof WorkspaceError && error.reason === "workspace-seed-failed",
  );
});

test("a seed path escaping the workspace is refused", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  for (const escape of ["../outside.txt", "/etc/passwd"]) {
    await assert.rejects(
      prepareWorkspace({
        sourcePath: repo.sourcePath,
        workspaceRoot: repo.workspaceRoot,
        prNumber: 55,
        headBranch: repo.headBranch,
        headSha: expectedSha,
        seedFiles: [escape],
      }),
      (error: unknown) =>
        error instanceof WorkspaceError && error.reason === "workspace-seed-failed",
    );
  }
});
