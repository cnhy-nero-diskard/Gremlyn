import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isBeneath,
  prepareWorkspace,
  WorkspaceError,
  workspacePathFor,
} from "../src/workspace/worktree.js";
import { currentBranch, headSha } from "../src/workspace/gitops.js";
import { createTempRepo, pushCommit, remoteSha } from "./helpers/gitrepo.js";

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
  assert.equal(
    readFileSync(join(prepared.path, "leftover.txt"), "utf8"),
    "interrupted work\n",
  );
});

test("workspace path derives from root and PR number only", () => {
  assert.equal(workspacePathFor("/root", 42), join("/root", "pr-42"));
  assert.throws(() => workspacePathFor("/root", 0), WorkspaceError);
  assert.throws(() => workspacePathFor("/root", Number("../escape") as number), WorkspaceError);
});

test("isBeneath confines paths to the workspace root", () => {
  assert.equal(isBeneath(join("/root", "pr-1"), "/root"), true);
  assert.equal(isBeneath("/root", "/root"), false);
  assert.equal(isBeneath(join("/root", "..", "elsewhere"), "/root"), false);
});
