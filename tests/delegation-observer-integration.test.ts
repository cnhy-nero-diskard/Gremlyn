/**
 * Integration tests for the live delegation observer wired into the resolution
 * orchestrator (tasks 3.1-3.4).
 *
 * These drive the real `ResolutionOrchestrator` through a real git worktree,
 * replacing only the process-spawning seams: a scripted `opencode` executor,
 * the pinned session transport, and the observation sink. The concern here is
 * the orchestration contract:
 *
 * - the root is attached and observed while the parent is still running, and a
 *   final reconcile runs after safety settlement;
 * - each parent invocation gets its own observer/ordinal and root, and a retry
 *   never merges or overwrites the earlier tree;
 * - an observation (sink) failure can never change the job outcome or any
 *   safety record;
 * - the durable-store adapter persists observation rows without writing safety
 *   tables.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createStoreDelegationSink,
  ResolutionOrchestrator,
} from "../src/orchestrator/resolution.js";
import type {
  DelegationCoverageRecord,
  DelegationInvocationEnd,
  DelegationInvocationRecord,
  DelegationObservedNode,
  DelegationObservationSink,
} from "../src/agent/delegation-observer.js";
import type { ManagedHttpResult, ManagedSessionHttp } from "../src/agent/managed-sessions.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger } from "../src/log/logger.js";
import { Store } from "../src/store/db.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { AgentExecutor, AgentResult, AgentRunOptions, NormalizedEvent } from "../src/types.js";
import { workspacePathFor } from "../src/workspace/worktree.js";
import { createTempRepo, remoteSha } from "./helpers/gitrepo.js";

/* ------------------------------------------------------------------ *
 * Scripted executor: one run per invocation, distinct session ids
 * ------------------------------------------------------------------ */

interface RunStep {
  sessionId?: string;
  exitCode: number;
  delayMs?: number;
  edit?: Record<string, string>;
}

class SequencedOpenCodeExecutor implements AgentExecutor {
  readonly id = "opencode";
  readonly usesSharedCredentials = true;
  readonly honorsRetries = false;
  private index = 0;

  constructor(
    private readonly steps: readonly RunStep[],
    private readonly events: string[],
    private readonly onRunStart?: (sessionId: string | undefined) => void,
    private readonly onRunEnd?: (sessionId: string | undefined) => void,
  ) {}

  async checkVersion(): Promise<void> {}

  additionalEnvironment(): Record<string, string> {
    return {};
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const step = this.steps[Math.min(this.index, this.steps.length - 1)]!;
    this.index += 1;
    this.events.push(`run:start:${String(this.index)}`);
    this.onRunStart?.(step.sessionId);
    if (step.sessionId !== undefined) {
      opts.onLine?.(JSON.stringify({ type: "session", sessionID: step.sessionId }));
    }
    if (step.delayMs !== undefined) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, step.delayMs);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    this.onRunEnd?.(step.sessionId);
    if (step.exitCode === 0) {
      for (const [relative, content] of Object.entries(step.edit ?? {})) {
        const absolute = join(opts.cwd, relative);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content, "utf8");
      }
    }
    this.events.push(`run:end:${String(this.index)}`);
    return {
      stdout: "",
      stderr: "",
      exitCode: step.exitCode,
      ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      timedOut: false,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Scripted session surface: terminal roots, no children
 * ------------------------------------------------------------------ */

class RootOnlySessionServer implements ManagedSessionHttp {
  readonly sessions = new Map<string, { outcome?: "succeeded" | "failed" | "interrupted" }>();
  readonly active = new Set<string>();

  addRunning(id: string): void {
    this.sessions.set(id, {});
    this.active.add(id);
  }

  finish(id: string, outcome: "succeeded" | "failed" | "interrupted" = "succeeded"): void {
    this.sessions.set(id, { outcome });
    this.active.delete(id);
  }

  private body(id: string): Record<string, unknown> {
    const session = this.sessions.get(id)!;
    return {
      id,
      location: { directory: this.directory },
      ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
    };
  }

  constructor(private readonly directory: string) {}

  async get(path: string, _query?: Record<string, string>): Promise<ManagedHttpResult> {
    if (path === "/api/session/active") {
      const data: Record<string, unknown> = {};
      for (const id of this.active) data[id] = { type: "running" };
      return { status: 200, body: { data } };
    }
    if (path === "/api/session") {
      return {
        status: 200,
        body: { data: [], cursor: { previous: null, next: null } },
      };
    }
    if (path.endsWith("/message")) return { status: 404, body: undefined };
    const id = path.slice("/api/session/".length);
    if (!this.sessions.has(id)) return { status: 404, body: undefined };
    return { status: 200, body: { data: this.body(id) } };
  }

  async post(): Promise<ManagedHttpResult> {
    return { status: 200, body: { interrupted: true } };
  }
}

/* ------------------------------------------------------------------ *
 * Recording sink
 * ------------------------------------------------------------------ */

class EventSink implements DelegationObservationSink {
  constructor(
    private readonly label: string,
    private readonly events: string[],
    private readonly throwing = false,
  ) {}

  private fail(): void {
    if (this.throwing) throw new Error(`sink ${this.label} failed`);
  }

  begin(record: DelegationInvocationRecord): void {
    this.fail();
    this.events.push(`obs:begin:${this.label}:${String(record.ordinal)}`);
  }
  upsert(node: DelegationObservedNode): void {
    this.fail();
    const cancel = node.cancellationRequested ? ":cancel" : "";
    const presence = node.presence === "missing" ? ":missing" : "";
    this.events.push(
      `obs:upsert:${this.label}:${node.sessionId}:${node.state}${presence}${cancel}`,
    );
  }
  coverage(record: DelegationCoverageRecord): void {
    this.fail();
    this.events.push(`obs:coverage:${this.label}:${record.status}`);
  }
  end(record: DelegationInvocationEnd): void {
    this.fail();
    this.events.push(`obs:end:${this.label}:${String(record.ordinal)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Orchestrator fixture
 * ------------------------------------------------------------------ */

async function setup(options: {
  steps: readonly RunStep[];
  retries: number;
  observe: "events" | "throwing" | "store";
}) {
  const gitRepo = await createTempRepo();
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-delegation-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const [repository] = syncRepositories(
    store.db,
    [
      {
        owner: "acme",
        name: "widgets",
        sourcePath: gitRepo.sourcePath,
        workspaceRoot: gitRepo.workspaceRoot,
        agent: "opencode",
        provider: "opencode",
        model: "opencode/fake-model",
        effort: "xhigh",
        enabled: true,
        validationCommands: [],
        allowedModels: ["opencode/fake-model"],
      },
    ],
    30,
  );
  assert.ok(repository);

  const prNumber = 42;
  const workspace = workspacePathFor(gitRepo.workspaceRoot, prNumber);
  const server = new RootOnlySessionServer(workspace);
  const events: string[] = [];
  // Both invocations start running; the executor flips each to terminal right
  // before it returns, so observation sees "running" live and settlement sees
  // a provably quiescent root.
  server.addRunning("ses_root_1");
  server.addRunning("ses_root_2");

  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: prNumber,
        title: "Delegation integration",
        state: "open",
        merged: false,
        headBranch: gitRepo.headBranch,
        headSha: initialSha,
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRepoOwner: "acme",
        baseRepoName: "widgets",
        htmlUrl: "https://example.test/acme/widgets/pull/42",
      },
    ],
    comments: [
      {
        id: 700,
        inReplyToId: null,
        path: "feature.txt",
        diffHunk: "@@ -1 +1 @@",
        body: "Please address this review.",
        authorLogin: "reviewer",
        createdAt: "2026-08-27T00:00:00.000Z",
        prNumber,
      },
      {
        id: 701,
        inReplyToId: 700,
        path: "feature.txt",
        diffHunk: "@@ -1 +1 @@",
        body: "!RESOLVE\nmake the tests pass",
        authorLogin: "developer",
        createdAt: "2026-08-27T00:01:00.000Z",
        prNumber,
      },
    ],
  });

  const executor = new SequencedOpenCodeExecutor(
    options.steps,
    events,
    () => {},
    (sessionId) => {
      if (sessionId !== undefined) server.finish(sessionId);
    },
  );

  const logger = new Logger({ level: "error", secrets: ["fixture-secret"], db: store.db });
  const observation = {
    createSink: (input: { attemptId: number; ordinal: number; workspacePath: string }) => {
      if (options.observe === "store") {
        return createStoreDelegationSink(store.db, {
          attemptId: input.attemptId,
          ordinal: input.ordinal,
        });
      }
      const label = `${String(input.attemptId)}/${String(input.ordinal)}`;
      return new EventSink(label, events, options.observe === "throwing");
    },
    pollIntervalMs: 5,
  };

  const orchestrator = new ResolutionOrchestrator({
    db: store.db,
    dataDir,
    allowedAuthors: ["developer"],
    orchestratorLogin: "gremlyn-bot",
    timeoutSec: 30,
    retries: options.retries,
    github,
    registry: createDefaultCommandRegistry(),
    executors: new Map([["opencode", executor]]),
    logger,
    secrets: ["fixture-secret"],
    concurrency: 2,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    managedOpenCode: { sessionHttp: () => server },
    delegationObservation: observation,
  });
  orchestrator.registerRepository(repository);

  const event: NormalizedEvent = {
    owner: "acme",
    repo: "widgets",
    kind: "review-comment",
    commentId: 701,
    authorLogin: "developer",
    body: "!RESOLVE\nmake the tests pass",
    prNumber,
    observedAt: "2026-08-27T00:01:00.000Z",
  };
  const [queued] = await orchestrator.handleEvent(repository, event);
  assert.ok(queued);
  return { store, queued, events, server, workspace, gitRepo, dataDir, orchestrator };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("observes the root live and reconciles after settlement, per invocation", async () => {
  const data = await setup({
    steps: [
      { sessionId: "ses_root_1", exitCode: 1, delayMs: 40 },
      { sessionId: "ses_root_2", exitCode: 0, delayMs: 40, edit: { "resolved.txt": "done\n" } },
    ],
    retries: 2,
    observe: "events",
  });
  const completed = await data.queued.completed;
  assert.equal(completed.kind, "completed");

  // Each invocation got its own observer ordinal.
  assert.ok(data.events.includes("obs:begin:1/1:1"), "invocation 1 observer started");
  assert.ok(data.events.includes("obs:begin:1/2:2"), "invocation 2 observer started");

  // The root was observed WHILE the parent ran (between run:start and run:end),
  // for both invocations, and each observer saw only its own root.
  const indexOf = (needle: string): number => data.events.indexOf(needle);
  assert.ok(indexOf("obs:upsert:1/1:ses_root_1:running") > indexOf("run:start:1"));
  assert.ok(indexOf("obs:upsert:1/1:ses_root_1:running") < indexOf("run:end:1"));
  assert.ok(indexOf("obs:upsert:1/2:ses_root_2:running") > indexOf("run:start:2"));
  assert.ok(indexOf("obs:upsert:1/2:ses_root_2:running") < indexOf("run:end:2"));
  assert.equal(
    data.events.some((event) => event.includes("1/1:ses_root_2")),
    false,
    "invocation 1 must never observe invocation 2's root",
  );

  // A final reconcile after settlement captured the terminal outcome, and both
  // observers ended.
  assert.ok(data.events.includes("obs:upsert:1/1:ses_root_1:succeeded"));
  assert.ok(data.events.includes("obs:upsert:1/2:ses_root_2:succeeded"));
  assert.ok(data.events.includes("obs:end:1/1:1"));
  assert.ok(data.events.includes("obs:end:1/2:2"));

  // Safety tables are unaffected by observation.
  const childRows = data.store.db
    .prepare("SELECT COUNT(*) AS n FROM managed_child_sessions")
    .get() as { n: number };
  assert.equal(childRows.n, 0);
  data.store.close();
});

test("a throwing observation sink cannot change the job outcome or safety rows", async () => {
  const data = await setup({
    steps: [
      { sessionId: "ses_root_1", exitCode: 0, delayMs: 30, edit: { "resolved.txt": "ok\n" } },
    ],
    retries: 1,
    observe: "throwing",
  });
  const completed = await data.queued.completed;
  assert.equal(completed.kind, "completed");

  // Observation is not a safety record: nothing landed in the safety tables.
  const childRows = data.store.db
    .prepare("SELECT COUNT(*) AS n FROM managed_child_sessions")
    .get() as { n: number };
  assert.equal(childRows.n, 0);
  data.store.close();
});

test("the durable-store adapter persists observation rows without touching safety tables", async () => {
  const data = await setup({
    steps: [
      { sessionId: "ses_root_1", exitCode: 0, delayMs: 30, edit: { "resolved.txt": "ok\n" } },
    ],
    retries: 1,
    observe: "store",
  });
  const completed = await data.queued.completed;
  assert.equal(completed.kind, "completed");

  const nodes = data.store.db
    .prepare(
      `SELECT session_id, root_session_id, last_state FROM delegation_observation_nodes
       ORDER BY session_id`,
    )
    .all() as Array<{ session_id: string; root_session_id: string | null; last_state: string }>;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.session_id, "ses_root_1");
  assert.equal(nodes[0]?.root_session_id, "ses_root_1");
  assert.equal(nodes[0]?.last_state, "succeeded");

  const coverage = data.store.db
    .prepare("SELECT COUNT(*) AS n FROM delegation_invocation_coverage")
    .get() as { n: number };
  assert.ok(coverage.n >= 1);

  // The observation store never writes the managed child-settlement evidence.
  const childRows = data.store.db
    .prepare("SELECT COUNT(*) AS n FROM managed_child_sessions")
    .get() as { n: number };
  assert.equal(childRows.n, 0);
  data.store.close();
});

test("the store adapter writes missing evidence without resurrecting a live state", async () => {
  const data = await setup({
    steps: [
      { sessionId: "ses_root_1", exitCode: 0, delayMs: 20, edit: { "resolved.txt": "ok\n" } },
    ],
    retries: 1,
    observe: "events",
  });
  await data.queued.completed;

  const sink = createStoreDelegationSink(data.store.db, {
    attemptId: data.queued.attemptId,
    ordinal: 99,
  });
  const now = Date.now();
  const base = {
    sessionId: "ses_root_1",
    rootSessionId: "ses_root_1",
    depth: 0,
    role: "root" as const,
    identity: { agentId: "reviewer", model: "anthropic/claude" },
    firstObservedAt: now,
    lastObservedAt: now,
    cancellationRequested: false,
  };
  sink.upsert({
    ...base,
    presence: "observed",
    state: "running",
    contradiction: false,
    active: true,
  });

  const running = data.store.db
    .prepare(
      `SELECT last_state, evidence_presence, last_active, actual_agent
       FROM delegation_observation_nodes WHERE invocation_ordinal = 99`,
    )
    .get() as {
    last_state: string;
    evidence_presence: string;
    last_active: number | null;
    actual_agent: string | null;
  };
  assert.equal(running.last_state, "running");
  assert.equal(running.last_active, 1);

  // A failed refresh / vanished session must overwrite the current evidence as
  // `missing`, null out active, and never resurrect the old running state while
  // retaining the identity history.
  sink.upsert({ ...base, presence: "missing", state: "unknown", contradiction: false });

  const missing = data.store.db
    .prepare(
      `SELECT last_state, evidence_presence, last_active, actual_agent
       FROM delegation_observation_nodes WHERE invocation_ordinal = 99`,
    )
    .get() as {
    last_state: string;
    evidence_presence: string;
    last_active: number | null;
    actual_agent: string | null;
  };
  assert.equal(missing.evidence_presence, "missing");
  assert.equal(missing.last_state, "unknown");
  assert.equal(missing.last_active, null);
  assert.equal(missing.actual_agent, "reviewer", "identity history is retained");
  data.store.close();
});

test("a cancellation request is observed without stopping observation", async () => {
  const data = await setup({
    steps: [{ sessionId: "ses_root_1", exitCode: 0, delayMs: 500 }],
    retries: 1,
    observe: "events",
  });

  // Wait until the root has been observed running, then request cancellation.
  const deadline = Date.now() + 3_000;
  while (
    Date.now() < deadline &&
    !data.events.some((event) => event.includes("ses_root_1:running"))
  ) {
    await new Promise<void>((done) => setTimeout(done, 5));
  }
  assert.ok(
    data.events.some((event) => event.includes("ses_root_1:running")),
    "the root must be observed running before cancellation",
  );
  assert.equal(data.orchestrator.cancel(data.queued.jobId), true);
  await data.queued.completed.catch(() => undefined);

  // Observation kept running and recorded the request independently of outcome.
  assert.ok(
    data.events.some((event) => event.endsWith(":cancel")),
    "the cancellation request must be observed",
  );
  const job = data.store.db
    .prepare("SELECT status FROM jobs WHERE id = ?")
    .get(data.queued.jobId) as { status: string };
  assert.equal(job.status, "cancelled");
  data.store.close();
});

test("the store adapter does not reopen reconciled historical gaps on a healthy poll", async () => {
  const data = await setup({
    steps: [
      { sessionId: "ses_root_1", exitCode: 0, delayMs: 20, edit: { "resolved.txt": "ok\n" } },
    ],
    retries: 1,
    observe: "events",
  });
  await data.queued.completed;
  const attemptId = data.queued.attemptId;

  const sink = createStoreDelegationSink(data.store.db, { attemptId, ordinal: 77 });
  const countOpen = (): number =>
    (
      data.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM delegation_observation_gaps
           WHERE attempt_id = ? AND invocation_ordinal = 77 AND closed_at IS NULL`,
        )
        .get(attemptId) as { n: number }
    ).n;
  const countAll = (): number =>
    (
      data.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM delegation_observation_gaps
           WHERE attempt_id = ? AND invocation_ordinal = 77`,
        )
        .get(attemptId) as { n: number }
    ).n;

  const base: DelegationCoverageRecord = {
    attemptId,
    ordinal: 77,
    observedAt: Date.now(),
    status: "partial",
    partial: true,
    gaps: ["transport-error"],
    currentGaps: ["transport-error"],
    nodeCount: 0,
    truncated: false,
    transport: "polling",
  };
  sink.coverage(base);
  assert.equal(countOpen(), 1, "the current round's gap is opened");

  // A healthy round has NO current gaps but still carries the historical gap in
  // `gaps`. It must close the open gap without reopening it.
  const healthy: DelegationCoverageRecord = {
    ...base,
    status: "healthy",
    partial: false,
    currentGaps: [],
  };
  sink.coverage(healthy);
  assert.equal(countOpen(), 0, "a healthy poll reconciles the open gap");
  const rowsAfterHealthy = countAll();
  assert.equal(rowsAfterHealthy, 1);

  // A SECOND healthy poll must not reopen the reconciled historical gap (the
  // regression this guards: iterating cumulative `gaps` did exactly that).
  sink.coverage({ ...healthy, observedAt: base.observedAt + 1_000 });
  assert.equal(countOpen(), 0);
  assert.equal(countAll(), rowsAfterHealthy, "no gap row may be reopened or duplicated");
  data.store.close();
});
