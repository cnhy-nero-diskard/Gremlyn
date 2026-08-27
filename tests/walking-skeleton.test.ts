import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { FakeExecutor } from "../src/agent/fake.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import {
  runWalkingSkeleton,
  type WalkingSkeletonRepository,
} from "../src/orchestrator/walking-skeleton.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import type { NormalizedEvent } from "../src/types.js";
import { createTempRepo, remoteSha } from "./helpers/gitrepo.js";

test("Layer1 section 39 happy path runs through fake agent, real git, and fixture GitHub", async () => {
  const repo = await createTempRepo();
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
    commentId: 1002,
    authorLogin: "someuser",
    body: "!RESOLVE",
    prNumber: 42,
    observedAt: "2026-01-01T10:10:00Z",
  };
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: 42,
        title: "Resolve review feedback",
        state: "open",
        merged: false,
        headBranch: repo.headBranch,
        headSha: originalHead,
        headRepoOwner: "someuser",
        headRepoName: "repo",
        baseRepoOwner: "someuser",
        baseRepoName: "repo",
        htmlUrl: "https://github.test/someuser/repo/pull/42",
      },
    ],
    comments: [
      {
        id: 1001,
        inReplyToId: null,
        path: "src/subject.ts",
        diffHunk: "@@ -1 +1 @@",
        body: "Please add the missing resolution file.",
        authorLogin: "reviewer",
        createdAt: "2026-01-01T10:00:00Z",
        prNumber: 42,
      },
      {
        id: event.commentId,
        inReplyToId: 1001,
        path: "src/subject.ts",
        diffHunk: "@@ -1 +1 @@",
        body: event.body,
        authorLogin: event.authorLogin,
        createdAt: event.observedAt,
        prNumber: event.prNumber,
      },
    ],
  });
  const executor = new FakeExecutor({
    outcome: "success",
    edits: { "src/resolution.txt": "review feedback resolved\n" },
  });
  const options = {
    event,
    command: "RESOLVE",
    threadId: "1001",
    repository,
    db: store.db,
    github,
    executor,
    dataDir: join(repo.root, "data"),
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
  };

  try {
    const result = await runWalkingSkeleton(options);
    assert.equal(result.kind, "succeeded");
    if (result.kind !== "succeeded") return;

    assert.notEqual(result.commitSha, originalHead);
    assert.equal(await remoteSha(repo.remotePath, repo.headBranch), result.commitSha);
    assert.equal(executor.runs.length, 1);
    assert.equal(executor.runs[0]!.options.cwd, join(repo.workspaceRoot, "pr-42"));
    assert.deepEqual(github.replies, [
      {
        prNumber: 42,
        inReplyTo: event.commentId,
        body: `Resolved in commit ${result.commitSha}. Fake-agent validation passed.`,
      },
    ]);

    const jobs = new JobStore(store.db);
    const job = jobs.getJob(result.jobId);
    const attempt = jobs.getAttempt(result.attemptId);
    assert.equal(job.status, "succeeded");
    assert.ok(job.finished_at);
    assert.equal(job.current_attempt, 1);
    assert.equal(attempt.outcome, "succeeded");
    assert.equal(attempt.workspace_path, join(repo.workspaceRoot, "pr-42"));
    assert.equal(attempt.head_sha_at_prepare, originalHead);
    assert.equal(attempt.agent_exit_code, 0);
    assert.equal(attempt.commit_sha, result.commitSha);
    assert.equal(attempt.pushed, 1);
    assert.equal(attempt.report_status, "posted");

    const replay = await runWalkingSkeleton(options);
    assert.deepEqual(replay, { kind: "duplicate" });
    assert.equal(executor.runs.length, 1, "duplicate command invoked the agent");
    const counts = store.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM jobs) AS jobs,
           (SELECT COUNT(*) FROM attempts) AS attempts,
           (SELECT COUNT(*) FROM processed_commands) AS processed`,
      )
      .get() as { jobs: number; attempts: number; processed: number };
    assert.deepEqual(counts, { jobs: 1, attempts: 1, processed: 1 });
  } finally {
    store.close();
  }
});
