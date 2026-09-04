import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeExecutor } from "../src/agent/fake.js";
import { recordRunningCancellation } from "../src/orchestrator/cancellation.js";
import {
  DataDirectoryLock,
  InstanceLockError,
  parseLockClaim,
} from "../src/orchestrator/instance-lock.js";
import { JobQueue, type QueuedWork } from "../src/orchestrator/queue.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import type { AgentRunOptions } from "../src/types.js";
import { prepareWorkspace } from "../src/workspace/worktree.js";
import { createTempRepo, remoteSha } from "./helpers/gitrepo.js";

test("completed job timeline reconstructs every D7 transition in order", () => {
  const fixture = createJobFixture();
  try {
    const attempt = fixture.jobs.createAttempt(attemptInput(fixture.jobId));
    for (const status of [
      "preparing",
      "running",
      "validating",
      "publishing",
      "reporting",
    ] as const) {
      fixture.jobs.setStatus(fixture.jobId, status, attempt.attemptId);
    }
    fixture.jobs.finishSuccess(fixture.jobId, attempt.attemptId);
    const timeline = fixture.jobs.getTimeline(fixture.jobId);
    assert.deepEqual(
      timeline.map((entry) => entry.status),
      ["queued", "preparing", "running", "validating", "publishing", "reporting", "succeeded"],
    );
    assert.ok(timeline.every((entry) => !Number.isNaN(Date.parse(entry.at))));
    assert.equal(fixture.jobs.getJob(fixture.jobId).status, "succeeded");
  } finally {
    fixture.store.close();
  }
});

test("per-PR locks serialize matching jobs while different PRs use global concurrency", async () => {
  const queue = new JobQueue<number>(2);
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;
  const work = (jobId: number, prNumber: number): QueuedWork<number> => ({
    jobId,
    repoId: 1,
    prNumber,
    verify: () => Promise.resolve({ ok: true }),
    run: async () => {
      started.push(jobId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(jobId, resolve));
      active -= 1;
      return jobId;
    },
  });
  const one = queue.enqueue(work(1, 42));
  const two = queue.enqueue(work(2, 42));
  const three = queue.enqueue(work(3, 43));
  await until(() => started.length === 2);
  assert.deepEqual(started, [1, 3]);
  assert.equal(maxActive, 2);
  releases.get(1)!();
  await until(() => started.includes(2));
  releases.get(2)!();
  releases.get(3)!();
  assert.deepEqual(await Promise.all([one, two, three]), [
    { kind: "completed", value: 1 },
    { kind: "completed", value: 2 },
    { kind: "completed", value: 3 },
  ]);
});

test("per-PR lock releases after success, failure, timeout, and cancellation", async () => {
  for (const outcome of ["success", "failure", "timeout", "cancellation"] as const) {
    const queue = new JobQueue<string>(1);
    let secondStarted = false;
    const first = queue
      .enqueue({
        jobId: 1,
        repoId: 1,
        prNumber: 42,
        verify: () => Promise.resolve({ ok: true }),
        run: async (signal) => {
          if (outcome === "cancellation") {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
            return "cancelled";
          }
          if (outcome === "failure") throw new Error("agent-failure");
          if (outcome === "timeout") throw new Error("agent-timeout");
          return "success";
        },
      })
      .catch((error: unknown) => error);
    const second = queue.enqueue({
      jobId: 2,
      repoId: 1,
      prNumber: 42,
      verify: () => Promise.resolve({ ok: true }),
      run: () => {
        secondStarted = true;
        return Promise.resolve("next");
      },
    });
    if (outcome === "cancellation") {
      await until(() => queue.runningCount === 1);
      assert.equal(queue.cancel(1), true);
    }
    await first;
    assert.deepEqual(await second, { kind: "completed", value: "next" });
    assert.equal(secondStarted, true, outcome);
  }
});

test("dequeue re-verification rejects a closed PR before workspace preparation", async () => {
  const queue = new JobQueue<string>(1);
  const fixture = createJobFixture();
  const attempt = fixture.jobs.createAttempt(attemptInput(fixture.jobId));
  const blocker = deferred<void>();
  const first = queue.enqueue({
    jobId: 999,
    repoId: 1,
    prNumber: 1,
    verify: () => Promise.resolve({ ok: true }),
    run: async () => {
      await blocker.promise;
      return "first";
    },
  });
  let workspaceTouched = false;
  let prOpen = true;
  const second = queue.enqueue({
    jobId: fixture.jobId,
    repoId: 1,
    prNumber: 2,
    verify: () =>
      Promise.resolve(
        prOpen ? { ok: true as const } : { ok: false as const, reason: "pull-request-closed" },
      ),
    run: () => {
      workspaceTouched = true;
      return Promise.resolve("second");
    },
    onRejected: (reason) =>
      fixture.jobs.finishFailure(fixture.jobId, attempt.attemptId, "preparing", reason),
  });
  try {
    prOpen = false;
    blocker.resolve(undefined);
    await first;
    assert.deepEqual(await second, { kind: "rejected", reason: "pull-request-closed" });
    assert.equal(workspaceTouched, false);
    assert.equal(fixture.jobs.getJob(fixture.jobId).status, "failed");
    assert.equal(fixture.jobs.getAttempt(attempt.attemptId).failure_reason, "pull-request-closed");
  } finally {
    fixture.store.close();
  }
});

test("cancelling queued work prevents it from starting and records cancellation", async () => {
  const queue = new JobQueue<string>(1);
  const fixture = createJobFixture();
  const blocker = deferred<void>();
  let started = false;
  const first = queue.enqueue({
    jobId: 999,
    repoId: 1,
    prNumber: 1,
    verify: () => Promise.resolve({ ok: true }),
    run: async () => {
      await blocker.promise;
      return "first";
    },
  });
  const queued = queue.enqueue({
    jobId: fixture.jobId,
    repoId: 1,
    prNumber: 2,
    verify: () => Promise.resolve({ ok: true }),
    run: () => {
      started = true;
      return Promise.resolve("queued");
    },
    onCancelled: () => fixture.jobs.cancelJob(fixture.jobId, null, false),
  });
  try {
    assert.equal(queue.cancel(fixture.jobId), true);
    assert.deepEqual(await queued, { kind: "cancelled", state: "queued" });
    assert.equal(started, false);
    assert.equal(fixture.jobs.getJob(fixture.jobId).status, "cancelled");
  } finally {
    blocker.resolve(undefined);
    await first;
    fixture.store.close();
  }
});

test("cancelling a running agent preserves dirty work and publishes nothing", async () => {
  const repo = await createTempRepo();
  const originalRemote = await remoteSha(repo.remotePath, repo.headBranch);
  const workspace = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 42,
    headBranch: repo.headBranch,
    headSha: originalRemote,
  });
  const fixture = createJobFixture();
  const attempt = fixture.jobs.createAttempt(attemptInput(fixture.jobId));
  fixture.jobs.setStatus(fixture.jobId, "preparing", attempt.attemptId);
  fixture.jobs.recordPreparation(attempt.attemptId, workspace.path, workspace.headSha);
  fixture.jobs.setStatus(fixture.jobId, "running", attempt.attemptId);
  const fake = new FakeExecutor({ outcome: "timeout", delayMs: 60_000 });
  const queue = new JobQueue<void>(1);
  let published = false;
  const agentStarted = deferred<void>();
  try {
    const result = queue.enqueue({
      jobId: fixture.jobId,
      repoId: 1,
      prNumber: 42,
      verify: () => Promise.resolve({ ok: true }),
      run: async (signal) => {
        writeFileSync(join(workspace.path, "agent-leftover.txt"), "partial work\n", "utf8");
        agentStarted.resolve(undefined);
        await fake.run(agentOptions(workspace.path, signal));
        if (!signal.aborted) published = true;
      },
      onCancelled: () =>
        recordRunningCancellation(fixture.jobs, fixture.jobId, attempt.attemptId, workspace.path),
    });
    await agentStarted.promise;
    assert.equal(queue.cancel(fixture.jobId), true);
    assert.deepEqual(await result, { kind: "cancelled", state: "running" });
    assert.equal(fake.runs[0]!.result.timedOut, true);
    assert.equal(published, false);
    assert.equal(await remoteSha(repo.remotePath, repo.headBranch), originalRemote);
    assert.equal(existsSync(join(workspace.path, "agent-leftover.txt")), true);
    assert.equal(fixture.jobs.getAttempt(attempt.attemptId).has_uncommitted_changes, 1);
    assert.equal(fixture.jobs.getJob(fixture.jobId).status, "cancelled");
  } finally {
    fixture.store.close();
  }
});

test("startup sweep interrupts in-flight jobs without losing attempt output", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-restart-"));
  const firstStore = new Store({ dataDir });
  const first = createJobInStore(firstStore);
  const attempt = first.jobs.createAttempt(attemptInput(first.jobId));
  first.jobs.setStatus(first.jobId, "preparing", attempt.attemptId);
  first.jobs.setStatus(first.jobId, "running", attempt.attemptId);
  first.jobs.setAttemptOutputRef(attempt.attemptId, "outputs/attempt-1.log");
  firstStore.close();

  const restarted = new Store({ dataDir });
  const jobs = new JobStore(restarted.db);
  try {
    assert.deepEqual(jobs.interruptIncompleteJobs(), [first.jobId]);
    assert.equal(jobs.getJob(first.jobId).status, "interrupted");
    assert.equal(jobs.getAttempt(attempt.attemptId).output_ref, "outputs/attempt-1.log");
    assert.equal(jobs.getAttempt(attempt.attemptId).outcome, "interrupted");
    assert.deepEqual(jobs.interruptIncompleteJobs(), [], "interrupted job re-executed");
  } finally {
    restarted.close();
  }
});

test("operator retry creates a new attempt and preserves the prior attempt", () => {
  const fixture = createJobFixture();
  try {
    const first = fixture.jobs.createAttempt(attemptInput(fixture.jobId));
    fixture.jobs.setStatus(fixture.jobId, "preparing", first.attemptId);
    fixture.jobs.setStatus(fixture.jobId, "running", first.attemptId);
    fixture.jobs.setAttemptOutputRef(first.attemptId, "outputs/first.log");
    fixture.jobs.finishFailure(fixture.jobId, first.attemptId, "running", "agent-failure");
    const before = fixture.jobs.getAttempt(first.attemptId);
    const second = fixture.jobs.retryJob(attemptInput(fixture.jobId));
    assert.equal(second.attemptNumber, 2);
    assert.deepEqual(fixture.jobs.getAttempt(first.attemptId), before);
    assert.equal(fixture.jobs.listAttempts(fixture.jobId).length, 2);
    assert.equal(fixture.jobs.getJob(fixture.jobId).status, "queued");
  } finally {
    fixture.store.close();
  }
});

test("second instance using the same data directory refuses to start", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-lock-"));
  const first = DataDirectoryLock.acquire(dataDir);
  try {
    assert.throws(() => DataDirectoryLock.acquire(dataDir), InstanceLockError);
  } finally {
    first.release();
  }
  const afterRelease = DataDirectoryLock.acquire(dataDir);
  afterRelease.release();
});

test("lock claims use a parseable owner record and reject legacy or garbage claims", () => {
  assert.deepEqual(parseLockClaim(JSON.stringify({ pid: process.pid })), { pid: process.pid });
  assert.equal(parseLockClaim(`${process.pid}\n`), undefined);
  assert.equal(parseLockClaim("garbage"), undefined);
});

test("dead lock claims are reclaimed while the current process remains protected", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-lock-stale-"));
  const claimPath = join(dataDir, ".gremlyn.lock");
  writeFileSync(claimPath, JSON.stringify({ pid: 999_999_999 }) + "\n", "utf8");
  const reclaimed = DataDirectoryLock.acquire(dataDir);
  try {
    assert.deepEqual(JSON.parse(readFileSync(claimPath, "utf8")), { pid: process.pid });
    assert.throws(
      () => DataDirectoryLock.acquire(dataDir),
      (error: unknown) =>
        error instanceof InstanceLockError && error.message.includes(`pid ${process.pid}`),
    );
  } finally {
    reclaimed.release();
    reclaimed.release();
  }
});

function createJobFixture() {
  return createJobInStore(new Store({ dataDir: ":memory:", file: ":memory:" }));
}

function createJobInStore(store: Store) {
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, effort)
         VALUES ('owner', 'repo', 'source', 'workspaces', 'fake', 'model', 'xhigh')`,
      )
      .run().lastInsertRowid,
  );
  const jobs = new JobStore(store.db);
  const created = jobs.createJob({
    repoId,
    prNumber: 42,
    commentId: 100,
    command: "RESOLVE",
    threadId: "99",
    authorLogin: "owner",
    observedAt: "2026-01-01T00:00:00Z",
  });
  if (created.kind !== "created") throw new Error("job fixture was duplicate");
  return { store, jobs, jobId: created.jobId };
}

function attemptInput(jobId: number) {
  return { jobId, agent: "fake", model: "model", provider: "fixture", effort: "xhigh" as const };
}

function agentOptions(cwd: string, signal: AbortSignal): AgentRunOptions {
  return {
    cwd,
    model: "model",
    provider: "fixture",
    effort: "xhigh",
    prompt: "resolve",
    env: {},
    timeoutSec: 60,
    retries: 0,
    dataDir: join(cwd, ".agent-data"),
    signal,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
