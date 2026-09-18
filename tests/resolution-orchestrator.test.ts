import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeExecutor, type FakeOutcome } from "../src/agent/fake.js";
import { CONTEXT_END, INHERITED_FAILURE_START } from "../src/agent/prompt.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger, type LogFields } from "../src/log/logger.js";
import { FAILURE_REASONS } from "../src/orchestrator/failures.js";
import { ResolutionOrchestrator } from "../src/orchestrator/resolution.js";
import { resolutionCommitMessage } from "../src/publish/policy.js";
import { JobStore } from "../src/store/jobs.js";
import { Store } from "../src/store/db.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { NormalizedEvent } from "../src/types.js";
import { adoptionClaimPath, readAdoptionClaim } from "../src/workspace/worktree.js";
import { currentBranch, git, headSha, statusEntries } from "../src/workspace/gitops.js";
import { createTempRepo, pushCommit, remoteSha } from "./helpers/gitrepo.js";

/**
 * A logger that cancels the running job the instant a named event is logged.
 *
 * Publishing has no external seam between its operations — the commit and the
 * push happen inside one call — so the orchestrator's own progress log is the
 * only place a test can land a cancel at a specific boundary. `commit created`
 * is emitted the moment the commit exists and before any push is attempted;
 * `validation completed` is the last event before the publishing stage begins.
 * Both are logged synchronously, so the abort is observed at the very next
 * checkpoint, exactly as an operator's cancel would be.
 */
class CancellingLogger extends Logger {
  /** Log event at which to cancel; unset means never. */
  cancelAt: string | undefined;
  /** Wired by the test once the job id is known. */
  cancel: ((jobId: number) => void) | undefined;

  override info(event: string, fields: LogFields = {}): void {
    super.info(event, fields);
    if (event === this.cancelAt && typeof fields.jobId === "number") this.cancel?.(fields.jobId);
  }
}

async function setup(
  outcome: FakeOutcome,
  opts: {
    retries?: number;
    honorsRetries?: boolean;
    delayMs?: number;
    adoptWorktree?: boolean;
  } = {},
) {
  const gitRepo = await createTempRepo();
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const foreignPath = opts.adoptWorktree
    ? join(gitRepo.root, "operator-runtime-checkout")
    : undefined;
  if (foreignPath)
    await git(["worktree", "add", foreignPath, gitRepo.headBranch], { cwd: gitRepo.sourcePath });
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
      adoptWorktree: opts.adoptWorktree ?? false,
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
  const operatorActions = new OperatorActionStore(store.db);
  const logger = new CancellingLogger({
    level: "error",
    secrets: ["fixture-secret"],
    db: store.db,
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
    logger,
    secrets: ["fixture-secret"],
    concurrency: 2,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    operatorActions,
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
  return {
    store,
    repository,
    github,
    executor,
    orchestrator,
    logger,
    event,
    gitRepo,
    initialSha,
    foreignPath,
  };
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

async function claimPathFor(worktree: string): Promise<string> {
  const reported = (await git(["rev-parse", "--git-dir"], { cwd: worktree })).stdout.trim();
  return adoptionClaimPath(resolve(worktree, reported));
}

async function waitForClaim(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (readAdoptionClaim(path) !== undefined) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`adoption claim did not appear at ${path}`);
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

test("a successful adopted attempt publishes from the foreign checkout and releases its claim", async () => {
  const data = await setup("files-modified", { adoptWorktree: true });
  assert.ok(data.foreignPath);
  const claimPath = await claimPathFor(data.foreignPath);
  const result = await resolveEvent(data);
  assert.equal(result.kind, "completed");
  const attempt = data.store.db.prepare("SELECT workspace_path, adopted FROM attempts").get() as {
    workspace_path: string;
    adopted: number;
  };
  assert.equal(resolve(attempt.workspace_path), resolve(data.foreignPath));
  assert.equal(attempt.adopted, 1);
  assert.equal(readAdoptionClaim(claimPath), undefined);
  assert.equal(await currentBranch(data.foreignPath), data.gitRepo.headBranch);
  assert.deepEqual(await statusEntries(data.foreignPath), []);
  assert.ok(
    new OperatorActionStore(data.store.db)
      .list()
      .some((row) => row.action === "workspace-adoption" && row.effect === "adopted"),
  );
  data.store.close();
});

test("failed, timed-out, and cancelled adopted attempts release their claims", async () => {
  const failed = await setup("failure", { adoptWorktree: true });
  assert.ok(failed.foreignPath);
  const failedClaim = await claimPathFor(failed.foreignPath);
  await assert.rejects(() => resolveEvent(failed));
  assert.equal(readAdoptionClaim(failedClaim), undefined);
  failed.store.close();

  const timedOut = await setup("timeout", { adoptWorktree: true, delayMs: 1 });
  assert.ok(timedOut.foreignPath);
  const timeoutClaim = await claimPathFor(timedOut.foreignPath);
  await assert.rejects(() => resolveEvent(timedOut));
  assert.equal(readAdoptionClaim(timeoutClaim), undefined);
  timedOut.store.close();

  const cancelled = await setup("timeout", { adoptWorktree: true, delayMs: 60_000 });
  assert.ok(cancelled.foreignPath);
  const cancelClaim = await claimPathFor(cancelled.foreignPath);
  const [queued] = await cancelled.orchestrator.handleEvent(cancelled.repository, cancelled.event);
  assert.ok(queued);
  await waitForClaim(cancelClaim);
  assert.equal(cancelled.orchestrator.cancel(queued.jobId), true);
  assert.equal((await queued.completed).kind, "cancelled");
  assert.equal(readAdoptionClaim(cancelClaim), undefined);
  cancelled.store.close();
});

/**
 * A provider its executor cannot drive is refused before the agent starts.
 * Cline's `opencode` provider executes tools inside a separate long-lived
 * `opencode serve` process whose working directory is fixed when that server
 * starts, so the attempt's workspace argument is ignored and the agent edits
 * an unrelated checkout â a run that reports success while the workspace it
 * was given stays empty. Startup only warns about the pairing, so the refusal
 * has to happen per attempt.
 */
test("a provider the executor cannot drive is refused before the agent runs", async () => {
  const data = await setup("files-modified");
  data.repository.provider = "opencode";
  await assert.rejects(() => resolveEvent(data));
  assert.equal(data.executor.runs.length, 0);
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    failure_stage: string;
    failure_reason: string;
    workspace_path: string | null;
  };
  assert.equal(attempt.failure_stage, "preparing");
  assert.equal(attempt.failure_reason, "provider-executor-mismatch");
  assert.equal(attempt.workspace_path, null);
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  data.store.close();
});

test("an unknown provider id stays usable because the catalog makes no claim about it", async () => {
  const data = await setup("files-modified");
  data.repository.provider = "an-operator-supplied-provider";
  const result = await resolveEvent(data);
  assert.equal(result.kind, "completed");
  assert.equal(data.executor.runs.length, 1);
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

type CancelledAttempt = {
  outcome: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
  has_uncommitted_changes: number;
  commit_sha: string | null;
  pushed: number;
  workspace_path: string | null;
};

/**
 * Job 52 (2026-09-04): the cancel arrived at 18:39 while the attempt sat in
 * publishing and the push went out at 18:42 regardless, because the signal was
 * only ever consulted before validation. The stop now reaches the one stage
 * whose consequences leave the machine.
 */
test("a cancel during publishing stops before the commit and is not a publication failure", async () => {
  const data = await setup("files-modified");
  data.logger.cancelAt = "validation completed";
  data.logger.cancel = (jobId) => {
    data.orchestrator.cancel(jobId);
  };
  const [queued] = await data.orchestrator.handleEvent(data.repository, data.event);
  if (!queued) throw new Error("the event queued no job");
  assert.equal((await queued.completed).kind, "cancelled");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  const job = data.store.db.prepare("SELECT status FROM jobs WHERE id = ?").get(queued.jobId) as {
    status: string;
  };
  assert.equal(job.status, "cancelled");
  const attempt = data.store.db
    .prepare("SELECT * FROM attempts WHERE id = ?")
    .get(queued.attemptId) as CancelledAttempt;
  assert.equal(attempt.outcome, "cancelled");
  assert.equal(attempt.commit_sha, null);
  assert.equal(attempt.pushed, 0);
  // A cancel is not a judgement about the work: no precondition is named and
  // nothing is reported to the pull request.
  assert.equal(attempt.failure_stage, null);
  assert.equal(attempt.failure_reason, null);
  assert.deepEqual(data.github.replies, []);
  // The agent's edits survive uncommitted, as any cancelled attempt's do.
  assert.equal(attempt.has_uncommitted_changes, 1);
  // Taken effect at the boundary, not deferred until publishing finished of
  // its own accord: the timeline stops inside the stage it was cancelled in.
  const timeline = data.store.db
    .prepare("SELECT status FROM status_events WHERE job_id = ? ORDER BY id")
    .all(queued.jobId) as { status: string }[];
  assert.deepEqual(
    timeline.map((row) => row.status),
    ["queued", "preparing", "running", "validating", "publishing", "cancelled"],
  );
  data.store.close();
});

test("a cancel between the commit and the push keeps the commit and never pushes", async () => {
  const data = await setup("files-modified");
  data.logger.cancelAt = "commit created";
  data.logger.cancel = (jobId) => {
    data.orchestrator.cancel(jobId);
  };
  const [queued] = await data.orchestrator.handleEvent(data.repository, data.event);
  if (!queued) throw new Error("the event queued no job");
  assert.equal((await queued.completed).kind, "cancelled");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  const attempt = data.store.db
    .prepare("SELECT * FROM attempts WHERE id = ?")
    .get(queued.attemptId) as CancelledAttempt;
  assert.equal(attempt.outcome, "cancelled");
  assert.equal(attempt.failure_reason, null);
  assert.deepEqual(data.github.replies, []);
  // Committing consumed the modifications, so `commit_sha != null AND
  // pushed = 0` is what says the work is still here and still private.
  assert.ok(attempt.commit_sha);
  assert.equal(attempt.pushed, 0);
  assert.equal(attempt.has_uncommitted_changes, 0);
  assert.ok(attempt.workspace_path);
  assert.equal(await headSha(attempt.workspace_path), attempt.commit_sha);
  data.store.close();
});

/**
 * The retry path has not had to reason about a workspace holding a local
 * commit ahead of origin before, because a cancelled attempt could never
 * produce one. It needs no new branch of its own: preparation already
 * recognises a clean workspace ahead of the recorded head and fast-forward
 * pushes that commit, so the retry finishes the commit that exists instead of
 * creating a second one. The agent then finds nothing left to change, which is
 * the honest outcome — the work was already done and is now published.
 */
test("retrying an attempt cancelled with an unpushed commit reuses that commit", async () => {
  const data = await setup("files-modified");
  data.logger.cancelAt = "commit created";
  data.logger.cancel = (jobId) => {
    data.orchestrator.cancel(jobId);
  };
  const [queued] = await data.orchestrator.handleEvent(data.repository, data.event);
  if (!queued) throw new Error("the event queued no job");
  assert.equal((await queued.completed).kind, "cancelled");
  const cancelled = data.store.db
    .prepare("SELECT commit_sha FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { commit_sha: string | null };
  assert.ok(cancelled.commit_sha);

  data.logger.cancelAt = undefined;
  await assert.rejects(() => completeRetry(data, queued.jobId));
  assert.equal(
    await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
    cancelled.commit_sha,
  );
  const subjects = (
    await git(["--git-dir", data.gitRepo.remotePath, "log", "--pretty=%s", data.gitRepo.headBranch])
  ).stdout;
  assert.deepEqual(
    subjects.split(/\r?\n/u).filter((line) => line.startsWith("Resolve review feedback")),
    [resolutionCommitMessage(501)],
    "the retry created a second resolution commit instead of reusing the first",
  );
  const retryAttempt = data.store.db
    .prepare("SELECT failure_reason, commit_sha FROM attempts WHERE job_id = ? ORDER BY id DESC")
    .get(queued.jobId) as { failure_reason: string | null; commit_sha: string | null };
  assert.equal(retryAttempt.failure_reason, "no-changes");
  assert.equal(retryAttempt.commit_sha, null);
  data.store.close();
});

test("an executor with no CLI retry allowance is bounded by the orchestrator itself", async () => {
  // Cline bounds retries via its own --retries flag; an executor that declares
  // it does not (honorsRetries: false, as OpenCode will) has no such flag, so
  // the orchestrator must re-invoke the whole attempt itself, still bounded.
  const data = await setup("failure", { retries: 3, honorsRetries: false });
  await assert.rejects(() => resolveEvent(data));
  assert.equal(
    data.executor.runs.length,
    3,
    "expected exactly the configured number of invocations",
  );
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
  const row = data.store.db.prepare("SELECT finished_at FROM jobs WHERE id = ?").get(job.jobId) as {
    finished_at: string | null;
  };
  assert.equal(row.finished_at, null, "handleEvent returned only after the job reached a terminus");

  assert.equal(data.orchestrator.cancel(job.jobId), true);
  assert.equal((await job.completed).kind, "cancelled");
  data.store.close();
});

/**
 * Put a completed attempt into the shape a validation failure leaves behind:
 * the agent's edits uncommitted in the workspace, the attempt blocked at
 * `publishing`, and one nonzero validation run recorded with its captured
 * output on disk.
 */
function recordValidationFailure(
  data: Fixture,
  attemptId: number,
  opts: { output?: string; writeArtifact?: boolean } = {},
): string {
  data.store.db
    .prepare(
      `UPDATE attempts
       SET outcome = 'failed', failure_stage = 'publishing', failure_reason = 'validation-failed',
           has_uncommitted_changes = 1
       WHERE id = ?`,
    )
    .run(attemptId);
  const outputRef = join(mkdtempSync(join(tmpdir(), "gremlyn-validation-")), "run.json");
  if (opts.writeArtifact !== false) {
    writeFileSync(
      outputRef,
      JSON.stringify({
        command: ["npm", "test"],
        stdout: opts.output ?? "FAIL tests/widget.test.ts\n1 failing",
        stderr: "",
        exitCode: 1,
        durationMs: 12,
      }),
      "utf8",
    );
  }
  data.store.db
    .prepare(
      `INSERT INTO validation_runs (attempt_id, seq, command, exit_code, duration_ms, output_ref)
       VALUES (?, 1, ?, 1, 12, ?)`,
    )
    .run(attemptId, JSON.stringify(["npm", "test"]), outputRef);
  return outputRef;
}

test("retry resumes edits from an attempt blocked by a failing validation command", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
  };
  const retained = join(attempt.workspace_path, "agent-progress.txt");
  writeFileSync(retained, "retain this\n", "utf8");
  recordValidationFailure(data, attempt.id);

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(data.executor.runs.length, 2, "retry reached the agent instead of failing as dirty");
  assert.equal(readFileSync(retained, "utf8"), "retain this\n");

  // The agent has to know what it inherited and what rejected it.
  const prompt = data.executor.runs[1]?.options.prompt ?? "";
  assert.match(prompt, /already contains uncommitted edits from a previous attempt/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /FAIL tests\/widget\.test\.ts/);
  assert.ok(
    prompt.indexOf(INHERITED_FAILURE_START) > prompt.indexOf(CONTEXT_END),
    "validation output must sit outside the untrusted review context, not inside it",
  );
  data.store.close();
});

test("a fresh attempt is never told it inherited a validation failure", async () => {
  const data = await setup("files-modified");
  assert.equal((await resolveEvent(data)).kind, "completed");
  const prompt = data.executor.runs[0]?.options.prompt ?? "";
  assert.doesNotMatch(prompt, /already contains uncommitted edits/);
  assert.ok(!prompt.includes(INHERITED_FAILURE_START));
  data.store.close();
});

test("a resumed retry survives a validation artifact that has been reclaimed", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
  };
  writeFileSync(join(attempt.workspace_path, "agent-progress.txt"), "retain this\n", "utf8");
  recordValidationFailure(data, attempt.id, { writeArtifact: false });

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(data.executor.runs.length, 2, "a missing artifact must not fail the attempt");
  const prompt = data.executor.runs[1]?.options.prompt ?? "";
  assert.match(prompt, /npm test/, "the failing command is known even when its output is not");
  assert.match(prompt, /output no longer available/);
  data.store.close();
});

test("a publishing failure other than validation does not admit a resume", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
  };
  const manual = join(attempt.workspace_path, "manual-edit.txt");
  writeFileSync(manual, "do not inherit\n", "utf8");
  data.store.db
    .prepare(
      `UPDATE attempts
       SET outcome = 'failed', failure_stage = 'publishing', failure_reason = 'workspace-conflicted',
           has_uncommitted_changes = 1
       WHERE id = ?`,
    )
    .run(attempt.id);

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(data.executor.runs.length, 1, "only a validation failure is admitted");
  assert.equal(
    (
      data.store.db
        .prepare("SELECT failure_reason FROM attempts WHERE attempt_number = 2")
        .get() as { failure_reason: string }
    ).failure_reason,
    "workspace-dirty",
  );
  assert.equal(readFileSync(manual, "utf8"), "do not inherit\n");
  data.store.close();
});

test("a validation failure whose recorded head has moved quarantines and refreshes", async () => {
  const data = await setup("failure");
  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const attempt = data.store.db.prepare("SELECT * FROM attempts").get() as {
    id: number;
    workspace_path: string;
  };
  const stranded = join(attempt.workspace_path, "agent-progress.txt");
  writeFileSync(stranded, "retain this\n", "utf8");
  recordValidationFailure(data, attempt.id);
  // The pull request moves between the attempts: the edits were made against
  // a base it no longer has, so resuming is unsafe — but the retry must not
  // wedge on workspace-dirty either.
  const movedHead = await pushCommit(
    data.gitRepo.sourcePath,
    data.gitRepo.headBranch,
    "next.txt",
    "next\n",
    "advance",
  );
  const pr = await data.github.getPullRequest("acme", "widgets", 27);
  data.github.addPullRequest({ ...pr, headSha: movedHead });

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(data.executor.runs.length, 2, "the retry runs instead of failing as dirty");

  const quarantine = data.store.db
    .prepare("SELECT * FROM operator_actions WHERE action = 'workspace-quarantine'")
    .get() as { effect: string; detail: string } | undefined;
  assert.ok(quarantine, "the quarantine is recorded");
  assert.equal(quarantine.effect, "quarantined-and-recreated");
  const detail = JSON.parse(quarantine.detail) as { reason: string; patchRef: string };
  assert.equal(detail.reason, "validation-failed");
  assert.equal(existsSync(detail.patchRef), true);
  assert.match(readFileSync(detail.patchRef, "utf8"), /agent-progress\.txt/);

  assert.equal(existsSync(stranded), false, "stranded work moves to the patch, not the tree");
  assert.deepEqual(await statusEntries(attempt.workspace_path), []);
  assert.equal(await headSha(attempt.workspace_path), movedHead);
  data.store.close();
});

test("retry after head-changed quarantines stranded work and refreshes to the moved head", async () => {
  const data = await setup("files-modified");
  // Race the first attempt: the agent's edits land, then the pull request head
  // moves both on the git remote and in the GitHub view before publication.
  const originalRun = data.executor.run.bind(data.executor);
  let movedHead = "";
  let moved = false;
  data.executor.run = async (options) => {
    const result = await originalRun(options);
    if (!moved) {
      moved = true;
      movedHead = await pushCommit(
        data.gitRepo.sourcePath,
        data.gitRepo.headBranch,
        "concurrent.txt",
        "remote update\n",
        "concurrent update",
      );
      const pr = await data.github.getPullRequest("acme", "widgets", 27);
      data.github.addPullRequest({ ...pr, headSha: movedHead });
    }
    return result;
  };

  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const first = data.store.db.prepare("SELECT * FROM attempts WHERE attempt_number = 1").get() as {
    id: number;
    failure_stage: string;
    failure_reason: string;
    workspace_path: string;
  };
  assert.equal(first.failure_stage, "publishing");
  assert.equal(first.failure_reason, "head-changed");

  const retried = await completeRetry(data, job.id);
  assert.equal(retried.kind, "completed");
  assert.equal(data.executor.runs.length, 2, "the retry runs on the refreshed workspace");

  const quarantine = data.store.db
    .prepare("SELECT * FROM operator_actions WHERE action = 'workspace-quarantine'")
    .get() as { effect: string; detail: string } | undefined;
  assert.ok(quarantine, "the quarantine is recorded");
  assert.equal(quarantine.effect, "quarantined-and-recreated");
  const patchRef = (JSON.parse(quarantine.detail) as { patchRef: string }).patchRef;
  assert.equal(existsSync(patchRef), true);
  assert.match(readFileSync(patchRef, "utf8"), /resolved\.txt/);

  assert.deepEqual(await statusEntries(first.workspace_path), []);
  assert.equal(
    await headSha(first.workspace_path),
    await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
  );
  data.store.close();
});

test("retry after head-changed refuses to refresh when stranded binary or oversized bytes cannot be captured", async () => {
  const data = await setup("files-modified");
  const originalRun = data.executor.run.bind(data.executor);
  const workspacePath = join(data.gitRepo.workspaceRoot, "pr-27");
  const trackedBinary = Buffer.from([0, 1, 2, 255, 254]);
  const untrackedBinary = Buffer.from([255, 0, 3, 4]);
  const oversized = Buffer.alloc(512 * 1024 + 1, 7);
  let moved = false;
  data.executor.run = async (options) => {
    const result = await originalRun(options);
    if (!moved) {
      moved = true;
      writeFileSync(join(workspacePath, "feature.txt"), trackedBinary);
      writeFileSync(join(workspacePath, "stranded-binary.bin"), untrackedBinary);
      writeFileSync(join(workspacePath, "stranded-oversized.bin"), oversized);
      const movedHead = await pushCommit(
        data.gitRepo.sourcePath,
        data.gitRepo.headBranch,
        "concurrent.txt",
        "remote update\n",
        "concurrent update",
      );
      const pr = await data.github.getPullRequest("acme", "widgets", 27);
      data.github.addPullRequest({ ...pr, headSha: movedHead });
    }
    return result;
  };

  await assert.rejects(() => resolveEvent(data));
  const job = data.store.db.prepare("SELECT id FROM jobs").get() as { id: number };
  const first = data.store.db.prepare("SELECT * FROM attempts WHERE attempt_number = 1").get() as {
    failure_reason: string;
    workspace_path: string;
  };
  assert.equal(first.failure_reason, "head-changed");

  await assert.rejects(() => completeRetry(data, job.id));
  assert.equal(
    (
      data.store.db
        .prepare("SELECT failure_reason FROM attempts WHERE attempt_number = 2")
        .get() as { failure_reason: string }
    ).failure_reason,
    "workspace-dirty",
  );
  assert.equal(data.executor.runs.length, 1, "unsupported stranded bytes block destructive refresh");
  assert.deepEqual(readFileSync(join(workspacePath, "feature.txt")), trackedBinary);
  assert.deepEqual(readFileSync(join(workspacePath, "stranded-binary.bin")), untrackedBinary);
  assert.deepEqual(readFileSync(join(workspacePath, "stranded-oversized.bin")), oversized);
  data.store.close();
});
