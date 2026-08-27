import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitAll, pushHead } from "../src/publish/gitops.js";
import { prepareWorkspace } from "../src/workspace/worktree.js";
import { git, headSha, isAncestor } from "../src/workspace/gitops.js";
import { createTempRepo, pushCommit, remoteSha } from "./helpers/gitrepo.js";

const AUTHOR = { name: "Human Developer", email: "developer@example.com" };

test("commit and non-force push land on the PR head branch without rewriting history", async () => {
  const repo = await createTempRepo();
  const baseSha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 42,
    headBranch: repo.headBranch,
    headSha: baseSha,
  });

  writeFileSync(join(prepared.path, "resolution.txt"), "agent fix\n", "utf8");
  const commitSha = await commitAll(
    prepared.path,
    "Resolve review feedback (comment 1001)",
    AUTHOR,
  );
  assert.ok(commitSha, "expected a commit");

  await pushHead(prepared.path, repo.headBranch);

  // The commit landed on the remote branch...
  const remoteAfter = await remoteSha(repo.remotePath, repo.headBranch);
  assert.equal(remoteAfter, commitSha);
  const attribution = await git(["show", "-s", "--format=%an <%ae>", remoteAfter], {
    cwd: prepared.path,
  });
  assert.equal(attribution.stdout, `${AUTHOR.name} <${AUTHOR.email}>`);
  // ...and history was extended, not rewritten: the old head is an ancestor.
  assert.equal(await isAncestor(repo.sourcePath, baseSha, remoteAfter), true);
});

test("commitAll returns null when the workspace has no modifications", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 43,
    headBranch: repo.headBranch,
    headSha: sha,
  });
  const commitSha = await commitAll(prepared.path, "nothing to do", AUTHOR);
  assert.equal(commitSha, null);
});

test("a rejected push surfaces as an error and no force-push is attempted", async () => {
  const repo = await createTempRepo();
  const baseSha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 44,
    headBranch: repo.headBranch,
    headSha: baseSha,
  });
  writeFileSync(join(prepared.path, "resolution.txt"), "agent fix\n", "utf8");
  await commitAll(prepared.path, "agent work", AUTHOR);

  // Move the remote head forward so the push is rejected as non-fast-forward.
  const newerSha = await pushCommit(
    repo.sourcePath,
    repo.headBranch,
    "racing.txt",
    "racing commit\n",
    "racing commit",
  );

  await assert.rejects(pushHead(prepared.path, repo.headBranch));

  // The remote head is the racing commit, unchanged — no rewrite happened.
  assert.equal(await remoteSha(repo.remotePath, repo.headBranch), newerSha);
  assert.equal((await headSha(prepared.path)) !== newerSha, true);
});
