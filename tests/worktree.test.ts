import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { createTempRepo, pushCommit, remoteSha } from "./helpers/gitrepo.js";

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
