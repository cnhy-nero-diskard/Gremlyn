import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeExecutor } from "../src/agent/fake.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import {
  runWalkingSkeleton,
  type WalkingSkeletonRepository,
} from "../src/orchestrator/walking-skeleton.js";
import { Store } from "../src/store/db.js";
import type { AgentExecutor, NormalizedEvent } from "../src/types.js";
import { currentBranch, git, statusEntries } from "../src/workspace/gitops.js";
import { WorkspaceError, workspacePathFor } from "../src/workspace/worktree.js";
import { createTempRepo, pushCommit, remoteSha, type TempRepo } from "./helpers/gitrepo.js";

test("a full job leaves the dirty source checkout tree, index, and branch unchanged", async () => {
  const repo = await createTempRepo();
  writeFileSync(join(repo.sourcePath, "staged.txt"), "staged\n", "utf8");
  await git(["add", "staged.txt"], { cwd: repo.sourcePath });
  writeFileSync(join(repo.sourcePath, "README.md"), "dirty source\n", "utf8");
  const before = await sourceState(repo.sourcePath);
  const fixture = await makeFixture(repo, 21, 2100);

  try {
    const result = await runWalkingSkeleton({
      ...fixture.options,
      executor: new FakeExecutor({
        outcome: "success",
        edits: { "resolution.txt": "resolved\n" },
      }),
    });
    assert.equal(result.kind, "succeeded");
    assert.deepEqual(await sourceState(repo.sourcePath), before);
  } finally {
    fixture.store.close();
  }
});

test("a full job adapts when the source checkout already holds the PR branch", async () => {
  const repo = await createTempRepo();
  await git(["checkout", repo.headBranch], { cwd: repo.sourcePath });
  writeFileSync(join(repo.sourcePath, "developer-notes.txt"), "keep in source\n", "utf8");
  const before = {
    branch: await currentBranch(repo.sourcePath),
    status: await statusEntries(repo.sourcePath),
  };
  const fixture = await makeFixture(repo, 93, 9300);

  try {
    const result = await runWalkingSkeleton({
      ...fixture.options,
      executor: new FakeExecutor({
        outcome: "success",
        edits: { "resolution.txt": "resolved from source checkout\n" },
      }),
    });
    assert.equal(result.kind, "succeeded");
    assert.deepEqual(
      {
        branch: await currentBranch(repo.sourcePath),
        status: await statusEntries(repo.sourcePath),
      },
      before,
    );
    assert.equal(
      readFileSync(join(workspacePathFor(repo.workspaceRoot, 93), "resolution.txt"), "utf8"),
      "resolved from source checkout\n",
    );
  } finally {
    fixture.store.close();
  }
});

test("a head move during execution blocks publication and retains agent work", async () => {
  const repo = await createTempRepo();
  const fixture = await makeFixture(repo, 22, 2200);
  const fake = new FakeExecutor({
    outcome: "success",
    edits: { "resolution.txt": "retain this work\n" },
  });
  let movedHead = "";
  const racingExecutor: AgentExecutor = {
    id: "racing-fake",
    async run(options) {
      const result = await fake.run(options);
      movedHead = await pushCommit(
        repo.sourcePath,
        repo.headBranch,
        "concurrent.txt",
        "remote update\n",
        "concurrent update",
      );
      return result;
    },
  };

  try {
    await assert.rejects(
      runWalkingSkeleton({ ...fixture.options, executor: racingExecutor }),
      (err: unknown) => err instanceof WorkspaceError && err.reason === "head-changed",
    );
    assert.equal(await remoteSha(repo.remotePath, repo.headBranch), movedHead);
    const workspace = workspacePathFor(repo.workspaceRoot, 22);
    assert.equal(readFileSync(join(workspace, "resolution.txt"), "utf8"), "retain this work\n");
    assert.ok((await statusEntries(workspace)).some((entry) => entry.includes("resolution.txt")));
    assert.deepEqual(fixture.github.replies, []);

    const attempt = fixture.store.db
      .prepare(
        `SELECT head_sha_at_prepare, failure_stage, failure_reason, commit_sha, pushed
         FROM attempts`,
      )
      .get() as {
      head_sha_at_prepare: string;
      failure_stage: string;
      failure_reason: string;
      commit_sha: string | null;
      pushed: number;
    };
    assert.equal(attempt.head_sha_at_prepare, fixture.originalHead);
    assert.equal(attempt.failure_stage, "publishing");
    assert.equal(attempt.failure_reason, "head-changed");
    assert.equal(attempt.commit_sha, null);
    assert.equal(attempt.pushed, 0);
  } finally {
    fixture.store.close();
  }
});

async function makeFixture(repo: TempRepo, prNumber: number, commentId: number) {
  const originalHead = await remoteSha(repo.remotePath, repo.headBranch);
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const repositoryId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider,
            effort, validation_commands, allowed_models)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "someuser",
        "repo",
        repo.sourcePath,
        repo.workspaceRoot,
        "fake",
        "fixture-model",
        "fixture-provider",
        "xhigh",
        "[]",
        '["fixture-model"]',
      ).lastInsertRowid,
  );
  const repository: WalkingSkeletonRepository = {
    id: repositoryId,
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    agent: "fake",
    model: "fixture-model",
    provider: "fixture-provider",
    effort: "xhigh",
  };
  const event: NormalizedEvent = {
    owner: "someuser",
    repo: "repo",
    kind: "review-comment",
    commentId,
    authorLogin: "someuser",
    body: "!RESOLVE",
    prNumber,
    observedAt: "2026-01-01T10:10:00Z",
  };
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: prNumber,
        title: "Resolve review feedback",
        state: "open",
        merged: false,
        headBranch: repo.headBranch,
        headSha: originalHead,
        headRepoOwner: "someuser",
        headRepoName: "repo",
        baseRepoOwner: "someuser",
        baseRepoName: "repo",
        htmlUrl: `https://github.test/someuser/repo/pull/${prNumber}`,
      },
    ],
  });
  return {
    store,
    github,
    originalHead,
    options: {
      event,
      command: "RESOLVE",
      threadId: String(commentId),
      repository,
      db: store.db,
      github,
      dataDir: join(repo.root, "data"),
      commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    },
  };
}

async function sourceState(sourcePath: string) {
  return {
    branch: await currentBranch(sourcePath),
    status: (await git(["status", "--porcelain=v1"], { cwd: sourcePath })).stdout,
    index: (await git(["diff", "--cached"], { cwd: sourcePath })).stdout,
    readme: readFileSync(join(sourcePath, "README.md"), "utf8"),
    staged: readFileSync(join(sourcePath, "staged.txt"), "utf8"),
  };
}
