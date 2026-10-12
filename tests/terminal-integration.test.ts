/* eslint-disable no-control-regex -- Tests explicitly assert terminal-control containment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { FakeOutcome } from "../src/agent/fake.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createShutdownHandler } from "../src/index.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger, type LogFields } from "../src/log/logger.js";
import { ResolutionOrchestrator, type RuntimeRepository } from "../src/orchestrator/resolution.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import {
  AudioQueue,
  OutcomeObserver,
  resolveTerminalAssetsDir,
  soundHelperArgs,
  type Cue,
  type PlaybackChild,
  type ProcessLauncher,
} from "../src/terminal/audio.js";
import { snapshotLines, TerminalPresentation } from "../src/terminal/controller.js";
import { resolveTerminalOptions } from "../src/terminal/options.js";
import { readTerminalSnapshot, type TerminalSnapshot } from "../src/terminal/projection.js";
import type { AgentExecutor, AgentResult, AgentRunOptions, NormalizedEvent } from "../src/types.js";
import { createTempRepo, remoteSha, type TempRepo } from "./helpers/gitrepo.js";

/**
 * Task 5.2: fixture daemon integration for the terminal operator experience.
 *
 * These tests run a real `ResolutionOrchestrator` against fixture GitHub, a
 * controlled fake agent and a real temp git repository — no browser, no
 * network, no external agent API. They span queued, running, validating,
 * succeeded, failed, explicitly retried and interrupted work, and verify that
 * the terminal surface is observational end to end:
 *
 * - `TerminalPresentation` owns the Logger sink while the Logger still persists
 *   redacted detail records to `log_entries` (the data `npm run logs` tails).
 * - `OutcomeObserver` receives its cues from real committed orchestrator
 *   events (never from agent exits or log lines), through an injected
 *   dispatch/lane so no real PowerShell SoundPlayer helper ever spawns.
 * - Terminal snapshots and counts reflect the durable job/repository state
 *   without mutating it, and validation/publication semantics are unchanged.
 *
 * Real audio never plays: the process launcher is always injected, and the
 * interruption baseline is modeled with the production restart sweep
 * (`JobStore.interruptIncompleteJobs`, src/index.ts) before an observer is
 * created.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A capture stream standing in for stderr; EventEmitter for resize/error. */
class FakeStream extends EventEmitter {
  isTTY = false;
  columns = 120;
  rows = 30;
  readonly output: string[] = [];
  write(text: string): boolean {
    this.output.push(text);
    return true;
  }
}

/** An executor whose outcome and launch gate are controllable per test. */
class ControlledExecutor implements AgentExecutor {
  readonly id = "fake";
  readonly honorsRetries = true;
  readonly runs: AgentRunOptions[] = [];
  outcome: FakeOutcome = "files-modified";
  /** When set, `run` does not return until the gate resolves (holds `running`). */
  gate: Promise<void> | undefined;
  readonly edits: Record<string, string> = { "resolved.txt": "resolved\n" };

  async checkVersion(_env: Record<string, string>): Promise<void> {
    // A fake CLI is always the expected version.
  }

  additionalEnvironment(): Record<string, string> {
    return {};
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    this.runs.push(opts);
    if (this.gate !== undefined) await this.gate;
    const startedAt = new Date().toISOString();
    const exitCode = this.outcome === "failure" ? 1 : 0;
    if (this.outcome === "success" || this.outcome === "files-modified") {
      for (const [relative, content] of Object.entries(this.edits)) {
        const absolute = join(opts.cwd, relative);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content, "utf8");
      }
    }
    return { stdout: "", stderr: "", exitCode, startedAt, endedAt: startedAt, timedOut: false };
  }
}

/** Logger seam: hook information records for deterministic stage snapshots. */
class HookLogger extends Logger {
  onInfo: ((event: string, fields: LogFields) => void) | undefined;

  override info(event: string, fields: LogFields = {}): void {
    super.info(event, fields);
    this.onInfo?.(event, fields);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake child for the injected audio lane; never a real PowerShell process. */
class FakeChild implements PlaybackChild {
  killed = false;
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly closeListeners: ((code: number | null) => void)[] = [];

  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  once(
    event: "error" | "close",
    listener: ((error: Error) => void) | ((code: number | null) => void),
  ): this {
    if (event === "error") {
      this.errorListeners.push(listener as (error: Error) => void);
    } else {
      this.closeListeners.push(listener as (code: number | null) => void);
    }
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitClose(code: number | null): void {
    for (const listener of this.closeListeners.splice(0)) listener(code);
  }
}

/** Records every requested playback and exposes the last child for assertion. */
class RecordingLauncher {
  readonly calls: { file: string; args: readonly string[] }[] = [];
  readonly children: FakeChild[] = [];

  readonly launch: ProcessLauncher = (file, args) => {
    this.calls.push({ file, args });
    const child = new FakeChild();
    this.children.push(child);
    return child;
  };

  get lastChild(): FakeChild | undefined {
    return this.children[this.children.length - 1];
  }
}

const ASSETS_DIR = resolveTerminalAssetsDir();
const SECRETS = ["fixture-secret"];

interface DaemonFixture {
  store: Store;
  gitRepo: TempRepo;
  repository: RuntimeRepository;
  github: FixtureGitHubClient;
  executor: ControlledExecutor;
  logger: HookLogger;
  presentation: TerminalPresentation;
  stream: FakeStream;
  outcomes: OutcomeObserver;
  cues: Cue[];
  orchestrator: ResolutionOrchestrator;
  event: NormalizedEvent;
  initialSha: string;
  cleanup(): void;
}

async function createDaemon(
  options: {
    outcome?: FakeOutcome;
    concurrency?: number;
    sound?: boolean;
    validationCommands?: string[][];
    dispatch?: (cue: Cue) => void;
    presentation?: "terminal" | "plain";
  } = {},
): Promise<DaemonFixture> {
  const gitRepo = await createTempRepo();
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-terminal-daemon-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const repositories = syncRepositories(store.db, [
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
      adoptWorktree: false,
      validationCommands: options.validationCommands ?? [],
      workspaceSeedFiles: [],
      allowedModels: ["fixture/model"],
    },
  ]);
  const repository = repositories[0];
  if (!repository) throw new Error("no repository was synced");
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
        body: "!RESOLVE",
        authorLogin: "developer",
        createdAt: "2026-08-27T00:01:00.000Z",
        prNumber: 27,
      },
    ],
  });
  const executor = new ControlledExecutor();
  executor.outcome = options.outcome ?? "files-modified";
  const stream = new FakeStream();
  stream.isTTY = options.presentation === "terminal";
  const presentation = new TerminalPresentation(
    resolveTerminalOptions(undefined, {
      presentation: options.presentation ?? "plain",
      noColor: true,
      ...(options.sound === undefined ? {} : { sound: options.sound }),
    }),
    stream,
    { TERM: "xterm" },
    SECRETS,
  );
  const logger = new HookLogger({
    level: "info",
    secrets: SECRETS,
    db: store.db,
    sink: presentation.sink,
  });
  const orchestrator = new ResolutionOrchestrator({
    db: store.db,
    dataDir,
    allowedAuthors: ["developer"],
    orchestratorLogin: "gremlyn-bot",
    timeoutSec: 30,
    retries: 1,
    github,
    registry: createDefaultCommandRegistry(),
    executors: new Map([["fake", executor]]),
    logger,
    secrets: SECRETS,
    concurrency: options.concurrency ?? 1,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    operatorActions: new OperatorActionStore(store.db),
  });
  orchestrator.registerRepository(repository);
  const event: NormalizedEvent = {
    owner: "acme",
    repo: "widgets",
    kind: "review-comment",
    commentId: 501,
    authorLogin: "developer",
    body: "!RESOLVE",
    prNumber: 27,
    observedAt: "2026-08-27T00:01:00.000Z",
  };
  const cues: Cue[] = [];
  const outcomes = new OutcomeObserver(
    store.db,
    options.dispatch ??
      ((cue: Cue): void => {
        cues.push(cue);
      }),
  );
  presentation.setReadiness("ready");
  presentation.attach(store.db, 60, () => outcomes.scan(options.sound ?? false, false));
  let closed = false;
  return {
    store,
    gitRepo,
    repository,
    github,
    executor,
    logger,
    presentation,
    stream,
    outcomes,
    cues,
    orchestrator,
    event,
    initialSha,
    cleanup: () => {
      if (closed) return;
      closed = true;
      presentation.dispose();
      try {
        store.close();
      } catch {
        // A test may close the store first (shutdown coverage); idempotent teardown.
      }
    },
  };
}

function jobStatus(db: Database.Database, jobId: number): string {
  const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as
    { status: string } | undefined;
  if (!row) throw new Error(`job ${jobId} not found`);
  return row.status;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function terminalSnapshot(fixture: DaemonFixture): TerminalSnapshot {
  return readTerminalSnapshot(fixture.store.db, {
    now: Date.now(),
    pollIntervalSec: 60,
    readiness: "ready",
    pollObservation: { lastSuccessAt: Date.now(), failed: false },
    secrets: SECRETS,
    rowLimit: 16,
  });
}

/* ------------------------------------------------------------------ *
 * Lifecycle span: queued / running / validating / succeeded
 * ------------------------------------------------------------------ */

test("daemon fixture spans queued, running, validating and succeeded with accurate terminal snapshots, detail logs and one success cue", async () => {
  const fixture = await createDaemon({
    sound: true,
    presentation: "terminal",
    concurrency: 1,
    validationCommands: [["node", "-e", "process.exit(0)"]],
  });
  try {
    // Gate the first job inside `running` so a second same-PR comment queues
    // instead of starting (per-PR serialization uses the queue's own lock).
    const gate = deferred<void>();
    fixture.executor.gate = gate.promise;
    const [queuedA] = await fixture.orchestrator.handleEvent(fixture.repository, fixture.event);
    if (!queuedA) throw new Error("the event queued no job");
    await waitFor(() => jobStatus(fixture.store.db, queuedA.jobId) === "running", "job A running");

    const runningSnapshot = terminalSnapshot(fixture);
    assert.equal(runningSnapshot.activeCount, 1);
    assert.equal(runningSnapshot.queuedCount, 0);
    assert.equal(runningSnapshot.rows[0]?.stage, "running");
    assert.match(snapshotLines(runningSnapshot, "enabled [m: mute]", 10)[1]!, /Active: 1/);

    const eventB: NormalizedEvent = {
      ...fixture.event,
      commentId: 502,
      observedAt: "2026-08-27T00:02:00.000Z",
    };
    const [queuedB] = await fixture.orchestrator.handleEvent(fixture.repository, eventB);
    if (!queuedB) throw new Error("the second event queued no job");
    const queuedSnapshot = terminalSnapshot(fixture);
    assert.equal(queuedSnapshot.activeCount, 1);
    assert.equal(queuedSnapshot.queuedCount, 1);
    assert.deepEqual(
      [queuedSnapshot.rows[0]?.stage, queuedSnapshot.rows[1]?.stage],
      ["running", "queued"],
    );
    assert.match(
      snapshotLines(queuedSnapshot, "enabled [m: mute]", 10)[1]!,
      /Active: 1 \| Queued: 1/,
    );

    // The queued lane is genuinely committed work: cancel it exactly like an
    // operator would, then finish it so no background lane is left waiting.
    assert.equal(fixture.orchestrator.cancel(queuedB.jobId), true);
    assert.equal((await queuedB.completed).kind, "cancelled");

    // Capture the validating stage at the "validation started" boundary: the
    // DB status is committed before that record is emitted, so this is the
    // exact durable state the dashboard reads at that moment.
    const validatingSnapshots: TerminalSnapshot[] = [];
    fixture.logger.onInfo = (eventName) => {
      if (eventName === "validation started") validatingSnapshots.push(terminalSnapshot(fixture));
    };
    gate.resolve(undefined);
    assert.equal((await queuedA.completed).kind, "completed");

    assert.equal(validatingSnapshots.length, 1);
    assert.equal(validatingSnapshots[0]!.activeCount, 1);
    assert.equal(validatingSnapshots[0]!.rows[0]?.stage, "validating");

    // The real validation command ran and its durable result is unchanged.
    const validationRun = fixture.store.db
      .prepare("SELECT exit_code FROM validation_runs ORDER BY id DESC LIMIT 1")
      .get() as { exit_code: number } | undefined;
    assert.ok(validationRun, "the validation run was persisted");
    assert.equal(validationRun.exit_code, 0);

    // Terminal successor counts include the cancelled lane from the fixture and
    // the succeeded job, exactly as stored. The compact surface lists no history
    // rows; it surfaces only the single most recent completion.
    const finalSnapshot = terminalSnapshot(fixture);
    assert.equal(finalSnapshot.activeCount, 0);
    assert.equal(finalSnapshot.queuedCount, 0);
    assert.equal(finalSnapshot.recentCount, 2);
    assert.equal(finalSnapshot.rows.length, 0);
    assert.equal(finalSnapshot.latestCompletion?.stage, "succeeded");

    // Publication semantics are unchanged: one pushed commit and one reply.
    assert.notEqual(
      await remoteSha(fixture.gitRepo.remotePath, fixture.gitRepo.headBranch),
      fixture.initialSha,
    );
    assert.equal(fixture.github.replies.length, 1);
    assert.match(fixture.github.replies[0]!.body, /Resolved in commit/);
    const attempt = fixture.store.db
      .prepare("SELECT pushed, commit_sha FROM attempts WHERE job_id = ? AND attempt_number = 1")
      .get(queuedA.jobId) as { pushed: number; commit_sha: string | null };
    assert.equal(attempt.pushed, 1);
    assert.ok(attempt.commit_sha);

    // At most one cue per committed terminal transition; duplicate scans are
    // idempotent.
    fixture.outcomes.scan(true, false);
    fixture.outcomes.scan(true, false);
    assert.deepEqual(fixture.cues, ["success"]);

    // Detail logs persisted alongside the dashboard sink, tail-able via `npm
    // run logs`, and never carry a configured secret.
    const logRows = fixture.store.db
      .prepare("SELECT event, job_id FROM log_entries ORDER BY id")
      .all() as { event: string; job_id: number | null }[];
    assert.ok(
      logRows.some((row) => row.event === "validation started" && row.job_id === queuedA.jobId),
    );
    assert.ok(logRows.some((row) => row.event === "job completed" && row.job_id === queuedA.jobId));
    fixture.logger.warn("fixture secret check", { token: "fixture-secret" });
    const redacted = fixture.store.db
      .prepare("SELECT fields FROM log_entries ORDER BY id DESC LIMIT 1")
      .get() as { fields: string };
    assert.equal((JSON.parse(redacted.fields) as { token: string }).token, "[redacted]");
    assert.doesNotMatch(redacted.fields, /fixture-secret/);

    // The actual timer-driven terminal surface reflects the committed result,
    // while durable details never interleave routine JSON with its anchor.
    await waitFor(
      () => fixture.stream.output.join("").includes("| succeeded |"),
      "terminal success refresh",
    );
    const terminal = fixture.stream.output.join("");
    assert.match(terminal, /Gremlyn/);
    assert.match(terminal, /Active: 0 \| Queued: 0/);
    assert.doesNotMatch(terminal, /"level"|"event"/);
    assert.doesNotMatch(terminal, /\x1b\[2J|\x1b\[\?1049|\u0007/);
  } finally {
    fixture.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Failure + explicit retry: exact cues through the injected audio lane
 * ------------------------------------------------------------------ */

test("a failed job then an explicit retry requests exactly failure and success cues through the injected audio lane and never replays", async () => {
  const cues: Cue[] = [];
  const launcher = new RecordingLauncher();
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    assetsDir: ASSETS_DIR,
    warn: () => undefined,
  });
  const fixture = await createDaemon({
    outcome: "failure",
    sound: true,
    dispatch: (cue) => {
      cues.push(cue);
      queue.request(cue);
    },
  });
  try {
    const [queued] = await fixture.orchestrator.handleEvent(fixture.repository, fixture.event);
    if (!queued) throw new Error("the event queued no job");
    await assert.rejects(() => queued.completed);
    assert.equal(jobStatus(fixture.store.db, queued.jobId), "failed");
    const failedAttempt = fixture.store.db
      .prepare("SELECT failure_stage, failure_reason, pushed FROM attempts WHERE job_id = ?")
      .get(queued.jobId) as { failure_stage: string; failure_reason: string; pushed: number };
    assert.equal(failedAttempt.failure_stage, "running");
    assert.equal(failedAttempt.failure_reason, "agent-nonzero-exit");
    assert.equal(failedAttempt.pushed, 0);

    // Only the committed job failure is eligible — the agent exit alone never
    // cues — and the request travels the fixed helper vector, never a real
    // PowerShell spawn (the lane's own launcher is injected).
    fixture.outcomes.scan(true, false);
    fixture.outcomes.scan(true, false);
    assert.equal(launcher.calls.length, 1);
    assert.deepEqual(launcher.calls[0]!.args, soundHelperArgs("failure", ASSETS_DIR));
    assert.deepEqual(cues, ["failure"]);
    launcher.lastChild?.emitClose(0);

    // Explicit retry reaches a new terminal success and is eligible for its
    // own distinct cue.
    const retried = await fixture.orchestrator.retry(queued.jobId);
    fixture.executor.outcome = "files-modified";
    assert.equal((await retried.completed).kind, "completed");
    fixture.outcomes.scan(true, false);
    assert.equal(launcher.calls.length, 2);
    assert.deepEqual(launcher.calls[1]!.args, soundHelperArgs("success", ASSETS_DIR));
    assert.deepEqual(cues, ["failure", "success"]);
    launcher.lastChild?.emitClose(0);
    fixture.outcomes.scan(true, false);
    assert.deepEqual(cues, ["failure", "success"], "consumed transitions never re-cue");

    const attempts = fixture.store.db
      .prepare(
        "SELECT attempt_number, outcome, failure_reason, commit_sha, pushed FROM attempts WHERE job_id = ? ORDER BY attempt_number",
      )
      .all(queued.jobId) as {
      attempt_number: number;
      outcome: string;
      failure_reason: string | null;
      commit_sha: string | null;
      pushed: number;
    }[];
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.outcome, "failed");
    assert.equal(attempts[1]!.outcome, "succeeded");
    assert.ok(attempts[1]!.commit_sha);
    assert.equal(attempts[1]!.pushed, 1);
    assert.notEqual(
      await remoteSha(fixture.gitRepo.remotePath, fixture.gitRepo.headBranch),
      fixture.initialSha,
    );
    assert.equal(fixture.github.replies.length, 2);

    // A restarted daemon baselines existing history: nothing is replayed.
    const replayed: Cue[] = [];
    const restarted = new OutcomeObserver(fixture.store.db, (cue) => replayed.push(cue));
    restarted.scan(true, false);
    restarted.scan(true, false);
    assert.deepEqual(replayed, []);

    queue.dispose();
    assert.equal(queue.pendingCount, 0);
    assert.doesNotThrow(() => queue.dispose());
  } finally {
    queue.dispose();
    fixture.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Interrupted baseline recovery
 * ------------------------------------------------------------------ */

test("startup interruption recovery baselines history before the observer; only new terminal outcomes cue", async () => {
  const fixture = await createDaemon({ sound: true, concurrency: 2 });
  try {
    const jobs = new JobStore(fixture.store.db);
    // A previous daemon crashed while a job was mid-flight. The production
    // persistence API leaves exactly this state behind.
    const before = jobs.createJob({
      repoId: fixture.repository.id,
      prNumber: 29,
      commentId: 780,
      command: "RESOLVE",
      authorLogin: "developer",
      observedAt: "2026-08-27T00:10:00.000Z",
    });
    assert.equal(before.kind, "created");
    if (before.kind !== "created") return;
    const attempt = jobs.createAttempt({
      jobId: before.jobId,
      agent: "fake",
      model: "fixture/model",
      provider: "fixture",
      effort: "xhigh",
    });
    jobs.setStatus(before.jobId, "preparing", attempt.attemptId);
    jobs.setStatus(before.jobId, "running", attempt.attemptId);

    // The restart sweep (src/index.ts) marks the in-flight job interrupted.
    assert.deepEqual(jobs.interruptIncompleteJobs(), [before.jobId]);
    assert.equal(jobs.getJob(before.jobId).status, "interrupted");
    assert.equal(jobs.getAttempt(attempt.attemptId).outcome, "interrupted");

    // A restarted daemon constructs its OutcomeObserver AFTER recovery, so the
    // interrupted transition is history: silent and never replayed.
    const restartedCues: Cue[] = [];
    const restarted = new OutcomeObserver(fixture.store.db, (cue) => restartedCues.push(cue));
    const interruptedEvent = fixture.store.db
      .prepare(
        "SELECT MAX(id) AS id FROM status_events WHERE job_id = ? AND status = 'interrupted'",
      )
      .get(before.jobId) as { id: number | null };
    assert.ok(interruptedEvent.id !== null);
    assert.ok(restarted.lastConsumedEventId >= interruptedEvent.id);
    restarted.scan(true, false);
    restarted.scan(true, false);
    assert.deepEqual(restartedCues, []);

    // A live scan also consumes the interrupted transition silently.
    fixture.outcomes.scan(true, false);
    assert.deepEqual(fixture.cues, []);

    // New work after the restart contributes its own cue only.
    const [queued] = await fixture.orchestrator.handleEvent(fixture.repository, fixture.event);
    if (!queued) throw new Error("the event queued no job");
    assert.equal((await queued.completed).kind, "completed");
    fixture.outcomes.scan(true, false);
    assert.deepEqual(fixture.cues, ["success"]);
    restarted.scan(true, false);
    assert.deepEqual(restartedCues, ["success"]);
    restarted.scan(true, false);
    assert.deepEqual(restartedCues, ["success"]);

    // The interrupted job is untouched: no attempt succeeded and nothing was
    // published for it.
    assert.equal(jobs.getJob(before.jobId).status, "interrupted");
    const succeeded = fixture.store.db
      .prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ? AND outcome = 'succeeded'")
      .get(before.jobId) as { count: number };
    assert.equal(succeeded.count, 0);
  } finally {
    fixture.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Shutdown disposal / repeated stop
 * ------------------------------------------------------------------ */

test("daemon shutdown disposes presentation before the store, survives disposal errors and repeats safely", async () => {
  const fixture = await createDaemon({ sound: true });
  const events: string[] = [];
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    fixture.store.close();
  };
  const stop = createShutdownHandler({
    clearTimer: () => events.push("timer"),
    stopObservation: () => {
      events.push("observation");
      fixture.presentation.dispose();
      fixture.presentation.dispose();
      // A disposal defect must never prevent the store from closing.
      throw new Error("disposer defect");
    },
    endStreams: () => events.push("streams"),
    closeConsole: async () => {
      events.push("console");
    },
    closeStore: () => {
      events.push("store");
      closeStore();
    },
    release: () => events.push("release"),
    exit: (code) => events.push(`exit:${code}`),
  });

  await stop();
  assert.deepEqual(events, ["timer", "observation", "streams", "console", "store"]);
  assert.equal(storeClosed, true);
  assert.equal(fixture.stream.listenerCount("error"), 0);

  // A repeated stop escalates release + exit without touching the closed store.
  await stop();
  assert.deepEqual(events, [
    "timer",
    "observation",
    "streams",
    "console",
    "store",
    "release",
    "exit:1",
  ]);

  // Presentation disposal is idempotent and a late attach is a no-op.
  assert.doesNotThrow(() => {
    fixture.presentation.dispose();
    fixture.presentation.dispose();
  });
  fixture.presentation.attach(fixture.store.db, 60, () => undefined);
});
