import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeExecutor, type FakeOutcome } from "../src/agent/fake.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger } from "../src/log/logger.js";
import { FAILURE_REASONS } from "../src/orchestrator/failures.js";
import { ResolutionOrchestrator } from "../src/orchestrator/resolution.js";
import { JobStore } from "../src/store/jobs.js";
import { Store } from "../src/store/db.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { NormalizedEvent } from "../src/types.js";
import { createTempRepo, remoteSha } from "./helpers/gitrepo.js";

async function setup(
  outcome: FakeOutcome,
  opts: { retries?: number; honorsRetries?: boolean; delayMs?: number } = {},
) {
  const gitRepo = await createTempRepo();
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-runtime-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const [repository] = syncRepositories(store.db, [
    {
      owner: "acme",
      name: "widgets",
      sourcePath: gitRepo.sourcePath,
      workspaceRoot: gitRepo.workspaceRoot,
      agent: "fake",
      provider: "fixture",
      model: "fixture/model",
      effort: "xhigh",
      enabled: true,
      validationCommands: [],
      allowedModels: ["fixture/model"],
    },
  ]);
  assert.ok(repository);
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: 27,
        title: "Handle $() safely",
        state: "open",
        merged: false,
        headBranch: gitRepo.headBranch,
        headSha: initialSha,
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRepoOwner: "acme",
        baseRepoName: "widgets",
        htmlUrl: "https://example.test/acme/widgets/pull/27",
      },
    ],
    comments: [
      {
        id: 500,
        inReplyToId: null,
        path: "feature.txt",
        diffHunk: "@@ -1 +1 @@",
        body: "Please address this review.",
        authorLogin: "reviewer",
        createdAt: "2026-08-27T00:00:00.000Z",
        prNumber: 27,
      },
      {
        id: 501,
        inReplyToId: 500,
        path: "feature.txt",
        diffHunk: "@@ -1 +1 @@",
        body: "!RESOLVE\n$(malformed) & echo should-not-run",
        authorLogin: "developer",
        createdAt: "2026-08-27T00:01:00.000Z",
        prNumber: 27,
      },
    ],
  });
  const executor = new FakeExecutor({
    outcome,
    edits: { "resolved.txt": "resolved\n" },
    ...(opts.honorsRetries === undefined ? {} : { honorsRetries: opts.honorsRetries }),
    ...(opts.delayMs === undefined ? {} : { delayMs: opts.delayMs }),
  });
  const orchestrator = new ResolutionOrchestrator({
    db: store.db,
    dataDir,
    allowedAuthors: ["developer"],
    orchestratorLogin: "gremlyn-bot",
    timeoutSec: 30,
    retries: opts.retries ?? 1,
    github,
    registry: createDefaultCommandRegistry(),
    executors: new Map([["fake", executor]]),
    logger: new Logger({ level: "error", secrets: ["fixture-secret"], db: store.db }),
    secrets: ["fixture-secret"],
    concurrency: 2,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
  });
  orchestrator.registerRepository(repository);
  const event: NormalizedEvent = {
    owner: "acme",
    repo: "widgets",
    kind: "review-comment",
    commentId: 501,
    authorLogin: "developer",
    body: "!RESOLVE\n$(malformed) & echo should-not-run",
    prNumber: 27,
    observedAt: "2026-08-27T00:01:00.000Z",
  };
  return { store, repository, github, executor, orchestrator, event, gitRepo, initialSha };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * handleEvent returns as soon as the command is queued, so a test that asserts
 * on the outcome awaits the queued job itself.
 */
async function resolveEvent(data: Fixture) {
  const [queued] = await data.orchestrator.handleEvent(data.repository, data.event);
  if (!queued) throw new Error("the event queued no job");
  return queued.completed;
}

async function completeRetry(data: Fixture, jobId: number) {
  return (await data.orchestrator.retry(jobId)).completed;
}

test("production lifecycle reconstructs context, validates, pushes, replies, and records the timeline", async () => {
  const data = await setup("files-modified");
  const result = await resolveEvent(data);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("job did not complete");
  assert.ok(result.value.commitSha);
  assert.notEqual(
    await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
    data.initialSha,
  );
  assert.equal(data.github.replies.length, 1);
  assert.match(data.github.replies[0]!.body, /Resolved in commit/);
  const job = data.store.db.prepare("SELECT * FROM jobs").get() as {
    id: number;
    status: string;
    review_context: string;
  };
  assert.equal(job.status, "succeeded");
  assert.match(job.review_context, /Please address this review/);
  const timeline = data.store.db
    .prepare("SELECT status FROM status_events WHERE job_id = ? ORDER BY id")
    .all(job.id) as { status: string }[];
  assert.deepEqual(
    timeline.map((row) => row.status),
    ["queued", "preparing", "running", "validating", "publishing", "reporting", "succeeded"],
  );
  assert.equal(data.executor.runs[0]!.options.prompt.includes("$(malformed)"), true);
  assert.equal(data.executor.runs[0]!.options.env.GREMLYN_GITHUB_TOKEN, undefined);
  assert.deepEqual(
    data.github.reactionHistory.map((r) => r.content),
    ["eyes", "rocket", "hooray"],
  );
  assert.equal(data.github.reactions.get(501), "hooray");
  data.store.close();
});

test("failed agent never pushes and records stage, files, commit, and push facts", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    failure_stage: string;
    failure_reason: string;
    has_uncommitted_changes: number;
    commit_sha: string | null;
    pushed: number;
  };
  assert.equal(attempt.failure_stage, "running");
  assert.equal(attempt.failure_reason, "agent-nonzero-exit");
  assert.equal(attempt.has_uncommitted_changes, 0);
  assert.equal(attempt.commit_sha, null);
  assert.equal(attempt.pushed, 0);
  assert.match(data.github.replies[0]!.body, /No changes were pushed/);
  assert.deepEqual(
    data.github.reactionHistory.map((r) => r.content),
    ["eyes", "rocket", "confused"],
  );
  data.store.close();
});

test("an executor with no CLI retry allowance is bounded by the orchestrator itself", async () => {
  // Cline bounds retries via its own --retries flag; an executor that declares
  // it does not (honorsRetries: false, as OpenCode will) has no such flag, so
  // the orchestrator must re-invoke the whole attempt itself, still bounded.
  const data = await setup("failure", { retries: 3, honorsRetries: false });
  await assert.rejects(() => resolveEvent(data));
  assert.equal(data.executor.runs.length, 3, "expected exactly the configured number of invocations");
  data.store.close();
});

test("an executor that honors its own retries is invoked exactly once per attempt", async () => {
  const data = await setup("failure", { retries: 3, honorsRetries: true });
  await assert.rejects(() => resolveEvent(data));
  assert.equal(data.executor.runs.length, 1, "the orchestrator must not add its own retry loop");
  data.store.close();
});

test("retry resumes edits from an abruptly timed-out agent", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
  };
  const { writeFileSync, readFileSync } = await import("node:fs");
  const retained = join(attempt.workspace_path, "agent-progress.txt");
  writeFileSync(retained, "retain this\n", "utf8");
  data.store.db
    .prepare(
      `UPDATE attempts
       SET outcome = 'failed', failure_stage = 'running', failure_reason = 'agent-timeout',
           has_uncommitted_changes = 1
       WHERE id = ?`,
    )
    .run(attempt.id);

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(data.executor.runs.length, 2, "retry reached the agent instead of failing as dirty");
  assert.equal(readFileSync(retained, "utf8"), "retain this\n");
  data.store.close();
});

test("retry resumes edits from an agent that exited nonzero mid-run", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
    failure_reason: string;
  };
  assert.equal(attempt.failure_reason, "agent-nonzero-exit");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const retained = join(attempt.workspace_path, "agent-progress.txt");
  writeFileSync(retained, "retain this\n", "utf8");
  data.store.db
    .prepare("UPDATE attempts SET has_uncommitted_changes = 1 WHERE id = ?")
    .run(attempt.id);

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(data.executor.runs.length, 2, "retry reached the agent instead of failing as dirty");
  assert.equal(readFileSync(retained, "utf8"), "retain this\n");
  data.store.close();
});

test("retry does not inherit a dirty workspace from an agent process crash", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(attempt.workspace_path, "manual-edit.txt"), "do not inherit\n", "utf8");
  data.store.db
    .prepare(
      `UPDATE attempts
       SET failure_reason = 'agent-process-crash', has_uncommitted_changes = 1
       WHERE id = ?`,
    )
    .run(attempt.id);

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(data.executor.runs.length, 1, "process crash must not bypass dirty protection");
  assert.equal(
    (
      data.store.db
        .prepare("SELECT failure_reason FROM attempts WHERE attempt_number = 2")
        .get() as { failure_reason: string }
    ).failure_reason,
    "workspace-dirty",
  );
  data.store.close();
});

test("retry can recover an abrupt workspace after a later preparation-only failure", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const first = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
    head_sha_at_prepare: string;
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(first.workspace_path, "agent-progress.txt"), "retain this\n", "utf8");
  data.store.db
    .prepare(
      `UPDATE attempts
       SET outcome = 'failed', failure_stage = 'running', failure_reason = 'agent-timeout',
           has_uncommitted_changes = 1
       WHERE id = ?`,
    )
    .run(first.id);

  const jobs = new JobStore(data.store.db);
  const second = jobs.retryJob({
    jobId: job.id,
    agent: "fake",
    model: "fixture/model",
    provider: "fixture",
    effort: "xhigh",
  });
  jobs.finishFailure(job.id, second.attemptId, "preparing", "workspace-corrupted");

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(
    data.executor.runs.length,
    2,
    "preparation-only retries do not erase abrupt provenance",
  );
  data.store.close();
});

test("Layer1 failure modes use distinct stable reason codes without a generic fallback", () => {
  const required = [
    "github-unavailable",
    "authentication-expired",
    "target-branch-deleted",
    "pull-request-closed",
    "workspace-corrupted",
    "git-conflict",
    "agent-cli-missing",
    "model-unavailable",
    "agent-process-crash",
    "agent-timeout",
    "validation-failed",
    "push-rejected",
    "comment-post-failed",
    "job-interrupted",
  ];
  for (const reason of required) assert.ok(FAILURE_REASONS.includes(reason as never), reason);
  assert.equal(new Set(FAILURE_REASONS).size, FAILURE_REASONS.length);
  assert.equal(
    FAILURE_REASONS.some((reason) => /unknown|generic/u.test(reason)),
    false,
  );
});

test("ingestion returns as soon as a job is queued, never waiting for the run", async () => {
  // A hung agent stands in for any long job. Awaiting it inside handleEvent
  // parked the single-flight poll loop for the whole run: every repository
  // stopped being ingested, and the second concurrency slot was unreachable
  // because the loop could not get far enough to enqueue anything else.
  const data = await setup("timeout", { delayMs: 500 });
  const queued = await data.orchestrator.handleEvent(data.repository, data.event);
  assert.equal(queued.length, 1);
  const job = queued[0];
  if (!job) throw new Error("the event queued no job");

  assert.equal(data.executor.runs.length, 0, "handleEvent waited for the agent to finish");
  const row = data.store.db
    .prepare("SELECT finished_at FROM jobs WHERE id = ?")
    .get(job.jobId) as { finished_at: string | null };
  assert.equal(row.finished_at, null, "handleEvent returned only after the job reached a terminus");

  assert.equal(data.orchestrator.cancel(job.jobId), true);
  assert.equal((await job.completed).kind, "cancelled");
  data.store.close();
});
