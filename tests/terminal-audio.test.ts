import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import {
  AUDIO_QUEUE_CEILINGS,
  AudioQueue,
  type AudioClock,
  type Cue,
  isCue,
  OutcomeObserver,
  type PlaybackChild,
  type ProcessLauncher,
  cueAssetPath,
  resolveAudioQueueLimits,
  resolvePowerShell,
  resolveTerminalAssetsDir,
  soundHelperArgs,
  soundHelperPath,
  terminalAssetsDir,
} from "../src/terminal/audio.js";

/**
 * Committed outcome dispatch and bounded audio behavior (tasks 4.1/4.2/4.3/4.4).
 * No test launches a real helper: the process launcher and clock are injected.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeDb(): Database.Database {
  return new Store({ dataDir: ".", file: ":memory:" }).db;
}

function insertRepository(db: Database.Database, id = 1): number {
  db.prepare(
    `INSERT INTO repositories
       (id, owner, name, source_path, workspace_root, agent, model, effort, enabled)
     VALUES (?, 'acme', 'widget', 'C:/src', 'C:/ws', 'cline', 'model', 'high', 1)`,
  ).run(id);
  return id;
}

function insertJob(db: Database.Database, repoId: number, prNumber = 1): number {
  const result = db
    .prepare(
      `INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at)
       VALUES (?, ?, 1, 'RESOLVE', 'queued', ?)`,
    )
    .run(repoId, prNumber, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function insertEvent(db: Database.Database, jobId: number, status: string): number {
  const result = db
    .prepare("INSERT INTO status_events (job_id, attempt_id, status, at) VALUES (?, NULL, ?, ?)")
    .run(jobId, status, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

/** Drive a job through the allowed lifecycle up to `reporting`. */
function reachReporting(jobs: JobStore, jobId: number, attemptId: number): void {
  jobs.setStatus(jobId, "preparing", attemptId);
  jobs.setStatus(jobId, "running", attemptId);
  jobs.setStatus(jobId, "validating", attemptId);
  jobs.setStatus(jobId, "publishing", attemptId);
  jobs.setStatus(jobId, "reporting", attemptId);
}

class FakeClock implements AudioClock {
  private time = 0;
  private nextId = 1;
  private timers: { id: number; at: number; callback: () => void }[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= this.time)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) return;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      due.callback();
    }
  }
}

class FakeChild implements PlaybackChild {
  killed = false;
  killResult = true;
  killThrows = false;
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly closeListeners: ((code: number | null) => void)[] = [];

  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  once(
    event: "error" | "close",
    listener: ((error: Error) => void) | ((code: number | null) => void),
  ): this {
    if (event === "error") this.errorListeners.push(listener as (error: Error) => void);
    else this.closeListeners.push(listener as (code: number | null) => void);
    return this;
  }

  kill(): boolean {
    if (this.killThrows) throw new Error("kill failed");
    this.killed = true;
    return this.killResult;
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners.splice(0)) listener(error);
  }

  emitClose(code: number | null): void {
    for (const listener of this.closeListeners.splice(0)) listener(code);
  }
}

class FakeLauncher {
  readonly calls: { file: string; args: readonly string[] }[] = [];
  readonly children: FakeChild[] = [];
  throwOnLaunch: Error | null = null;

  readonly launch: ProcessLauncher = (file, args) => {
    if (this.throwOnLaunch !== null) throw this.throwOnLaunch;
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

/* ------------------------------------------------------------------ *
 * OutcomeObserver
 * ------------------------------------------------------------------ */

test("observer baselines after construction and never replays history", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  insertEvent(db, jobId, "succeeded");
  insertEvent(db, jobId, "failed");

  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue));
  observer.scan(true, false);
  assert.deepEqual(cues, [], "historical terminal outcomes are baselined");

  insertEvent(db, jobId, "succeeded");
  observer.scan(true, false);
  assert.deepEqual(cues, ["success"]);
});

test("duplicate scans and a restart cannot replay a consumed transition", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue));
  insertEvent(db, jobId, "failed");
  observer.scan(true, false);
  observer.scan(true, false);
  assert.deepEqual(cues, ["failure"]);

  const restarted: Cue[] = [];
  const second = new OutcomeObserver(db, (cue) => restarted.push(cue));
  second.scan(true, false);
  assert.deepEqual(restarted, [], "a restart baselines existing history");
});

test("uncommitted rows are skipped while in a transaction and never consumed on rollback", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue));

  assert.throws(() => {
    db.transaction(() => {
      insertEvent(db, jobId, "succeeded");
      // The same connection can see uncommitted rows; a scan must refuse them.
      observer.scan(true, false);
      assert.deepEqual(cues, [], "an in-transaction scan dispatches nothing");
      throw new Error("rollback");
    })();
  }, /rollback/);

  observer.scan(true, false);
  assert.deepEqual(cues, [], "rolled-back rows were never claimed");

  insertEvent(db, jobId, "succeeded");
  observer.scan(true, false);
  assert.deepEqual(cues, ["success"]);
});

test("only committed success/failure transitions request cues; other stages are silent", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  for (const status of [
    "queued",
    "preparing",
    "running",
    "validating",
    "publishing",
    "reporting",
    "cancelled",
    "interrupted",
  ]) {
    insertEvent(db, jobId, status);
  }
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue));
  insertEvent(db, jobId, "succeeded");
  insertEvent(db, jobId, "failed");
  observer.scan(true, false);
  assert.deepEqual(cues, ["success", "failure"]);
  observer.scan(true, false);
  assert.deepEqual(cues, ["success", "failure"]);
});

test("agent exit and internal retries do not cue; an explicit retry can cue again", () => {
  const db = makeDb();
  const repoId = insertRepository(db);
  const jobs = new JobStore(db);
  const created = jobs.createJob({
    repoId,
    prNumber: 9,
    commentId: 900,
    command: "RESOLVE",
    authorLogin: "octocat",
    observedAt: new Date().toISOString(),
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") return;
  const jobId = created.jobId;

  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue));
  observer.scan(true, false);

  const first = jobs.createAttempt({
    jobId,
    agent: "cline",
    model: "model",
    provider: "provider",
    effort: "high",
  });
  jobs.setStatus(jobId, "preparing", first.attemptId);
  jobs.setStatus(jobId, "running", first.attemptId);
  jobs.recordAgentResult(first.attemptId, {
    stdout: "",
    stderr: "",
    exitCode: 0,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    timedOut: false,
  });
  // The agent exited successfully, but the committed job failure is validating.
  jobs.finishFailure(jobId, first.attemptId, "validating", "validation failed");
  observer.scan(true, false);
  assert.deepEqual(cues, ["failure"], "only the committed job failure cues");

  const retry = jobs.retryJob({
    jobId,
    agent: "cline",
    model: "model",
    provider: "provider",
    effort: "high",
  });
  reachReporting(jobs, jobId, retry.attemptId);
  jobs.finishSuccess(jobId, retry.attemptId);
  observer.scan(true, false);
  assert.deepEqual(cues, ["failure", "success"], "the retried terminal transition cues again");
});

test("events are consumed in ordered bounded batches across successive scans", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue), { batchSize: 2 });
  const ids: number[] = [];
  for (const status of ["succeeded", "queued", "failed", "cancelled", "succeeded"]) {
    ids.push(insertEvent(db, jobId, status));
  }

  observer.scan(true, false);
  assert.deepEqual(cues, ["success"], "one scan processes only the capped batch");
  assert.equal(observer.lastConsumedEventId, ids[1]);
  observer.scan(true, false);
  assert.deepEqual(cues, ["success", "failure"]);
  assert.equal(observer.lastConsumedEventId, ids[3]);
  observer.scan(true, false);
  assert.deepEqual(cues, ["success", "failure", "success"]);
  assert.equal(observer.lastConsumedEventId, ids[4]);
  observer.scan(true, false);
  assert.deepEqual(cues, ["success", "failure", "success"], "a drained backlog stays consumed");
});

test("a single scan never exceeds its capped batch (busy bound)", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue), { batchSize: 3 });
  const ids: number[] = [];
  for (let index = 0; index < 10; index += 1) ids.push(insertEvent(db, jobId, "succeeded"));

  observer.scan(true, false);
  assert.equal(cues.length, 3, "a single scan does bounded observational work");
  assert.equal(observer.lastConsumedEventId, ids[2]);

  let ticks = 0;
  while (cues.length < 10 && ticks < 10) {
    observer.scan(true, false);
    ticks += 1;
  }
  assert.equal(cues.length, 10);
  assert.equal(observer.lastConsumedEventId, ids[9]);
});

test("scan batch size is clamped into a hard ceiling", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue), { batchSize: -5 });
  for (let index = 0; index < 3; index += 1) insertEvent(db, jobId, "succeeded");
  observer.scan(true, false);
  assert.equal(cues.length, 1, "a non-positive batch size clamps to one row");
});

test("a suppressed backlog larger than one batch never replays on unmute", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue), { batchSize: 3 });
  const ids: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    ids.push(insertEvent(db, jobId, index % 2 === 0 ? "succeeded" : "failed"));
  }

  // One suppressed scan records the whole backlog's high-water while draining
  // only a single bounded batch.
  observer.scan(true, true);
  assert.equal(observer.suppressedThroughEventId, ids[9]);
  assert.equal(observer.lastConsumedEventId, ids[2]);

  // Unmute and drain across bounded ticks: nothing from the suppressed state
  // can ever dispatch, however the backlog drains.
  for (let tick = 0; tick < 6; tick += 1) observer.scan(true, false);
  assert.deepEqual(cues, []);
  assert.equal(observer.lastConsumedEventId, ids[9]);

  // A transition committed after suppression ends remains eligible.
  const after = insertEvent(db, jobId, "succeeded");
  observer.scan(true, false);
  assert.deepEqual(cues, ["success"]);
  assert.equal(observer.lastConsumedEventId, after);
});

test("muted and disabled scans consume without dispatching and never replay", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => cues.push(cue));

  insertEvent(db, jobId, "succeeded");
  observer.scan(false, false);
  observer.scan(true, false);
  assert.deepEqual(cues, [], "a disabled period consumes the outcome");

  insertEvent(db, jobId, "failed");
  observer.scan(true, true);
  observer.scan(true, false);
  assert.deepEqual(cues, [], "a muted period consumes the outcome without replay");

  insertEvent(db, jobId, "succeeded");
  observer.scan(true, false);
  assert.deepEqual(cues, ["success"]);
});

test("a dispatch failure does not stop later observations", () => {
  const db = makeDb();
  const jobId = insertJob(db, insertRepository(db));
  const cues: Cue[] = [];
  const observer = new OutcomeObserver(db, (cue) => {
    cues.push(cue);
    if (cue === "success") throw new Error("dispatch defect");
  });
  insertEvent(db, jobId, "succeeded");
  insertEvent(db, jobId, "failed");
  assert.doesNotThrow(() => observer.scan(true, false));
  assert.deepEqual(cues, ["success", "failure"]);
});

/* ------------------------------------------------------------------ *
 * AudioQueue
 * ------------------------------------------------------------------ */

test("requests play one at a time with a fixed, non-interpolated helper vector", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
  });

  queue.request("success");
  assert.equal(launcher.calls.length, 1);
  assert.deepEqual(launcher.calls[0]?.args, soundHelperArgs("success", ASSETS_DIR));
  assert.ok(launcher.calls[0]?.file.endsWith("powershell.exe"));
  assert.equal(queue.pendingCount, 0);

  queue.request("failure");
  assert.equal(launcher.calls.length, 1, "one helper runs at a time");
  assert.equal(queue.pendingCount, 1);

  launcher.lastChild?.emitClose(0);
  assert.equal(launcher.calls.length, 2);
  assert.deepEqual(launcher.calls[1]?.args, soundHelperArgs("failure", ASSETS_DIR));
  assert.deepEqual(warnings, []);
});

test("a full queue drops excess requests with one rate-limited warning", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
    warnIntervalMs: 10_000,
  });

  for (let index = 0; index < 18; index += 1) {
    queue.request(index % 2 === 0 ? "success" : "failure");
  }
  assert.equal(launcher.calls.length, 1);
  assert.equal(queue.pendingCount, 16);
  assert.equal(warnings.length, 1, "overload warns once per interval");

  for (let index = 0; index < 25 && launcher.calls.length < 17; index += 1) {
    launcher.lastChild?.emitClose(0);
  }
  assert.equal(launcher.calls.length, 17, "only the first 17 requests were ever played");
  assert.equal(queue.pendingCount, 0);
});

test("a helper error is consumed, warns, and does not block the next request", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
  });

  queue.request("success");
  launcher.lastChild?.emitError(new Error("spawn failed"));
  assert.equal(warnings.length, 1);
  queue.request("failure");
  assert.equal(launcher.calls.length, 2);
});

test("a helper that cannot launch warns and drops the request without retry", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  launcher.throwOnLaunch = new Error("ENOENT");
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
  });

  assert.doesNotThrow(() => queue.request("success"));
  assert.equal(launcher.calls.length, 0);
  assert.equal(queue.pendingCount, 0);
  assert.equal(warnings.length, 1);
});

test("a hung helper is killed at the timeout but keeps the lane until close", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
    timeoutMs: 3_000,
  });

  queue.request("success");
  queue.request("failure");
  const child = launcher.lastChild;
  clock.advance(2_999);
  assert.equal(child?.killed, false);
  clock.advance(1);
  assert.equal(child?.killed, true);
  assert.ok(warnings.some((message) => message.includes("timed out")));
  assert.equal(launcher.calls.length, 1, "the next helper must wait for close confirmation");

  child?.emitClose(null);
  assert.equal(launcher.calls.length, 2, "the lane continues only after the child closes");
});

test("kill returning false or throwing keeps zero overlap until close", () => {
  for (const mode of ["false", "throw"] as const) {
    const clock = new FakeClock();
    const launcher = new FakeLauncher();
    const queue = new AudioQueue({
      platform: "win32",
      process: launcher.launch,
      clock,
      assetsDir: ASSETS_DIR,
      timeoutMs: 3_000,
    });
    queue.request("success");
    queue.request("failure");
    const child = launcher.lastChild;
    assert.ok(child);
    if (mode === "false") child.killResult = false;
    else child.killThrows = true;

    clock.advance(3_000);
    assert.equal(launcher.calls.length, 1, `${mode}: no second helper may start`);
    clock.advance(60_000);
    queue.request("success");
    assert.equal(launcher.calls.length, 1, `${mode}: the lane stays occupied without close`);

    child.emitClose(0);
    assert.equal(launcher.calls.length, 2, `${mode}: close releases the lane`);
  }
});

test("a helper that never closes never overlaps another helper and pending stays bounded", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    assetsDir: ASSETS_DIR,
  });
  queue.request("success");
  for (let index = 0; index < 20; index += 1) queue.request("failure");
  assert.equal(queue.pendingCount, 16, "pending work is hard-bounded");
  assert.equal(launcher.calls.length, 1);

  clock.advance(60_000);
  queue.request("success");
  assert.equal(launcher.calls.length, 1, "no close means no second helper");
  assert.ok(queue.pendingCount <= 1, "expired pending requests are dropped, not retried");
});

test("a non-zero helper close warns once and continues the queue", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
  });
  queue.request("success");
  launcher.lastChild?.emitClose(1);
  assert.equal(warnings.length, 1);
  queue.request("failure");
  assert.equal(launcher.calls.length, 2);
});

test("late close and error after dispose are suppressed and start nothing", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
  });
  queue.request("success");
  queue.request("failure");
  const child = launcher.lastChild;
  queue.dispose();
  const before = warnings.length;
  child?.emitError(new Error("late error"));
  child?.emitClose(3);
  assert.equal(warnings.length, before, "diagnostics are suppressed after dispose");
  assert.equal(launcher.calls.length, 1, "no helper may start after dispose");
});

test("pending requests expire and are never played", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    assetsDir: ASSETS_DIR,
    pendingExpiryMs: 10_000,
  });

  queue.request("success");
  queue.request("failure");
  assert.equal(queue.pendingCount, 1);
  clock.advance(10_000);
  launcher.lastChild?.emitClose(0);
  assert.equal(launcher.calls.length, 1, "the expired request is dropped, not played");
  assert.equal(queue.pendingCount, 0);
});

test("a kill error after timeout does not prove exit or release the playback lane", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    assetsDir: ASSETS_DIR,
  });
  queue.request("success");
  const child = launcher.lastChild!;
  queue.request("failure");
  clock.advance(3_000);
  child.emitError(new Error("fixture kill failure"));
  assert.equal(launcher.calls.length, 1);
  child.emitClose(1);
  assert.equal(launcher.calls.length, 2);
  queue.dispose();
});

test("mute drops pending cues and never replays them on unmute", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    assetsDir: ASSETS_DIR,
  });

  queue.request("success");
  queue.request("failure");
  queue.setMuted(true);
  assert.equal(queue.pendingCount, 0);
  queue.setMuted(false);
  launcher.lastChild?.emitClose(0);
  assert.equal(launcher.calls.length, 1, "the suppressed cue is not replayed");

  queue.setMuted(true);
  queue.request("success");
  queue.setMuted(false);
  assert.equal(launcher.calls.length, 1, "requests made while muted are dropped");
});

test("dispose kills the in-flight helper, drops pending, and is idempotent", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    assetsDir: ASSETS_DIR,
  });

  queue.request("success");
  queue.request("failure");
  const child = launcher.lastChild;
  queue.dispose();
  assert.equal(child?.killed, true);
  assert.equal(queue.pendingCount, 0);
  const callsAfterDispose = launcher.calls.length;
  queue.request("success");
  assert.equal(launcher.calls.length, callsAfterDispose);
  assert.doesNotThrow(() => queue.dispose());
});

test("an unsupported platform is a silent no-op", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "linux",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
  });

  assert.equal(queue.supported, false);
  queue.request("success");
  assert.equal(launcher.calls.length, 0);
  assert.deepEqual(warnings, []);
  assert.doesNotThrow(() => {
    queue.setMuted(true);
    queue.setMuted(false);
    queue.dispose();
  });
});

test("a throwing warning sink is swallowed", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  launcher.throwOnLaunch = new Error("ENOENT");
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: () => {
      throw new Error("sink defect");
    },
    assetsDir: ASSETS_DIR,
  });
  assert.doesNotThrow(() => queue.request("success"));
});

test("the warning rate limit spaces repeated diagnostics", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  launcher.throwOnLaunch = new Error("ENOENT");
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
    warnIntervalMs: 10_000,
  });

  queue.request("success");
  queue.request("success");
  assert.equal(warnings.length, 1);
  clock.advance(10_000);
  queue.request("success");
  assert.equal(warnings.length, 2);
});

test("a malformed cue is rejected at runtime even through a JS caller", () => {
  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const warnings: string[] = [];
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    warn: (message) => warnings.push(message),
    assetsDir: ASSETS_DIR,
  });

  queue.request('success"; evil' as unknown as Cue);
  assert.equal(launcher.calls.length, 0);
  assert.equal(queue.pendingCount, 0);
  assert.match(warnings[0] ?? "", /invalid audio cue/);

  assert.throws(() => soundHelperArgs("bogus" as unknown as Cue, ASSETS_DIR), TypeError);
  assert.throws(() => cueAssetPath("bogus" as unknown as Cue), TypeError);
  assert.equal(isCue("success"), true);
  assert.equal(isCue(42), false);
  assert.equal(isCue(undefined), false);
});

test("injected queue knobs are clamped to hard finite ceilings", () => {
  const limits = resolveAudioQueueLimits({
    maxPending: Number.POSITIVE_INFINITY,
    pendingExpiryMs: Number.NaN,
    timeoutMs: -1,
    warnIntervalMs: 1e12,
  });
  assert.equal(limits.maxPending, AUDIO_QUEUE_CEILINGS.maxPending);
  assert.equal(limits.pendingExpiryMs, 10_000, "NaN falls back to the default");
  assert.equal(limits.timeoutMs, 0, "a negative knob clamps to zero");
  assert.equal(limits.warnIntervalMs, AUDIO_QUEUE_CEILINGS.warnIntervalMs);

  const clock = new FakeClock();
  const launcher = new FakeLauncher();
  const queue = new AudioQueue({
    platform: "win32",
    process: launcher.launch,
    clock,
    assetsDir: ASSETS_DIR,
    maxPending: Number.POSITIVE_INFINITY,
    timeoutMs: Number.POSITIVE_INFINITY,
  });
  for (let index = 0; index < 5; index += 1) queue.request("success");
  assert.equal(queue.pendingCount, 4, "pending work stays bounded under oversized knobs");
  assert.equal(launcher.calls.length, 1);
});

/* ------------------------------------------------------------------ *
 * Packaged assets
 * ------------------------------------------------------------------ */

test("packaged cue assets are valid, distinct and under one second", () => {
  const successPath = cueAssetPath("success");
  const failurePath = cueAssetPath("failure");
  assert.notEqual(successPath, failurePath);

  const success = readFileSync(successPath);
  const failure = readFileSync(failurePath);
  for (const buffer of [success, failure]) {
    assert.equal(buffer.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(buffer.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(buffer.readUInt16LE(20), 1, "PCM");
    assert.equal(buffer.readUInt16LE(22), 1, "mono");
    assert.equal(buffer.readUInt32LE(24), 44_100);
    const byteRate = buffer.readUInt32LE(28);
    const dataBytes = buffer.readUInt32LE(40);
    assert.ok(dataBytes > 0);
    const seconds = dataBytes / byteRate;
    assert.ok(seconds > 0 && seconds < 1, `duration ${seconds}s is under one second`);
  }
  assert.notDeepEqual(success, failure, "success and failure cues are distinct");
});

test("the packaged PowerShell helper is fixed and enum-bounded", () => {
  const helper = soundHelperPath();
  assert.ok(existsSync(helper));
  const script = readFileSync(helper, "utf8");
  assert.match(script, /ValidateSet\('success', 'failure'\)/);
  assert.match(script, /System\.Media\.SoundPlayer/);
  assert.match(script, /PlaySync\(\)/);
});

test("source and built module locations resolve the same packaged assets", () => {
  const root = resolveTerminalAssetsDir();
  assert.equal(root, terminalAssetsDir());
  assert.ok(existsSync(join(root, "success.wav")));

  // Simulate the compiled layout: dist/terminal/audio.js one level below src.
  const builtModuleUrl = pathToFileURL(join(root, "..", "..", "dist", "terminal", "audio.js")).href;
  assert.equal(resolveTerminalAssetsDir({ moduleUrl: builtModuleUrl }), root);
  assert.ok(existsSync(cueAssetPath("success", { moduleUrl: builtModuleUrl })));

  assert.equal(resolveTerminalAssetsDir({ assetsDir: "C:/injected" }), "C:/injected");
});

test("the helper argument vector is fixed and free of dynamic strings", () => {
  const args = soundHelperArgs("failure", ASSETS_DIR);
  assert.deepEqual(args.slice(0, 5), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ]);
  assert.equal(args[5], soundHelperPath({ assetsDir: ASSETS_DIR }));
  assert.equal(args[6], "-Cue");
  assert.equal(args[7], "failure");
  assert.equal(args[8], "-AssetDir");
  assert.equal(args[9], ASSETS_DIR);
  assert.equal(args.length, 10);

  assert.ok(resolvePowerShell("win32").endsWith("powershell.exe"));
  assert.equal(resolvePowerShell("linux"), "powershell.exe");
});
