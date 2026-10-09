/**
 * Seam integration for tasks 3.2/3.3/4.2/4.3 and 6.1: native/default OpenCode
 * primary selection and the generalized invocation ownership/settlement
 * boundary wired through the real `ResolutionOrchestrator`.
 *
 * The external process seams are replaced: the executor (a fake OpenCode-id
 * executor, or the real `OpenCodeExecutor` with a recording runner for the
 * actual-argv proof), the effective inventory source, and the pinned session
 * surface. The standalone modules have their own tests; here the concern is the
 * ordering, fail-closed wiring and per-repository isolation:
 *
 * - the captured native id is revalidated against the actual prepared
 *   workspace inventory before EVERY primary invocation;
 * - ownership is journaled (filesystem + database) before launch, parent ids
 *   are captured from the run stream, and ordinals are never overwritten;
 * - every OpenCode parent exit settles a fresh complete tree before retry,
 *   validation, commit or push â€” a live native descendant blocks publication;
 * - timeout/cancellation carry through settlement with the 60s fallback;
 * - two repository aliases run their own captured native ids, verified through
 *   the actual argv rather than the saved label.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInventoryReader, AgentInventoryRecord } from "../src/agent/agent-inventory.js";
import { OpenCodeExecutor } from "../src/agent/opencode.js";
import {
  beginOpenCodeInvocation,
  opencodeOwnershipPath,
  readOpenCodeOwnership,
} from "../src/agent/opencode-ownership.js";
import type { ProcessRunner } from "../src/agent/launcher.js";
import type {
  ManagedHttpResult,
  ManagedSessionHttp,
  OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger, type LogFields } from "../src/log/logger.js";
import { StageFailure } from "../src/orchestrator/failures.js";
import { ResolutionOrchestrator } from "../src/orchestrator/resolution.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { AgentExecutor, AgentResult, AgentRunOptions, NormalizedEvent } from "../src/types.js";
import { workspacePathFor } from "../src/workspace/worktree.js";
import { createTempRepo, remoteSha } from "./helpers/gitrepo.js";

/* ------------------------------------------------------------------ *
 * Scripted pinned-session surface
 * ------------------------------------------------------------------ */

interface SessionNode {
  directory: string;
  parentId?: string;
  outcome?: OpenCodeSessionOutcome;
  running: boolean;
  agent?: string;
  model?: string;
}

/** A minimal scripted `opencode api` session surface shared per fixture. */
class SessionFixture implements ManagedSessionHttp {
  readonly calls: Array<{ method: "GET" | "POST"; path: string }> = [];
  private readonly sessions = new Map<string, SessionNode>();
  interruptSettles = true;
  /** Test hook invoked at the start of every transport call. */
  onCall: ((method: "GET" | "POST", path: string) => void) | undefined;

  addParent(id: string, directory: string, identity?: { agent?: string; model?: string }): void {
    this.sessions.set(id, {
      directory,
      outcome: "succeeded",
      running: false,
      ...(identity?.agent === undefined ? {} : { agent: identity.agent }),
      ...(identity?.model === undefined ? {} : { model: identity.model }),
    });
  }

  addChild(parentId: string, id: string, opts: { running?: boolean } = {}): void {
    const parent = this.sessions.get(parentId);
    assert.ok(parent, `parent ${parentId} must exist before its child`);
    this.sessions.set(id, {
      directory: parent.directory,
      parentId,
      ...(opts.running === true ? { running: true } : { outcome: "succeeded", running: false }),
    });
  }

  private record(id: string): Record<string, unknown> {
    const node = this.sessions.get(id)!;
    return {
      id,
      location: { directory: node.directory },
      ...(node.parentId === undefined ? {} : { parentID: node.parentId }),
      ...(node.outcome === undefined ? {} : { outcome: node.outcome }),
    };
  }

  async get(path: string, query?: Record<string, string>): Promise<ManagedHttpResult> {
    this.calls.push({ method: "GET", path });
    this.onCall?.("GET", path);
    if (path === "/api/session/active") {
      const data: Record<string, unknown> = {};
      for (const [id, node] of this.sessions) if (node.running) data[id] = { type: "running" };
      return { status: 200, body: { data } };
    }
    if (path.endsWith("/message")) {
      const id = path.slice("/api/session/".length, -"/message".length);
      const node = this.sessions.get(id);
      if (node === undefined || node.agent === undefined)
        return { status: 200, body: { data: [] } };
      return {
        status: 200,
        body: {
          data: [
            {
              type: "assistant",
              agent: node.agent,
              ...(node.model === undefined
                ? {}
                : {
                    model: { providerID: node.model.split("/")[0], id: node.model.split("/")[1] },
                  }),
            },
          ],
        },
      };
    }
    const id = path.slice("/api/session/".length);
    if (query?.parentID !== undefined) {
      const data = [...this.sessions.entries()]
        .filter(([, node]) => node.parentId === query.parentID)
        .map(([childId]) => this.record(childId));
      return { status: 200, body: { data, cursor: { previous: null, next: null } } };
    }
    const node = this.sessions.get(id);
    if (node === undefined) return { status: 404, body: undefined };
    return { status: 200, body: { data: this.record(id) } };
  }

  async post(path: string): Promise<ManagedHttpResult> {
    this.calls.push({ method: "POST", path });
    this.onCall?.("POST", path);
    const id = path.slice("/api/session/".length, -"/interrupt".length);
    const node = this.sessions.get(id);
    if (node === undefined) return { status: 404, body: undefined };
    if (this.interruptSettles && node.running) {
      node.running = false;
      node.outcome = "interrupted";
    }
    return { status: 200, body: { interrupted: true } };
  }

  get interrupted(): boolean {
    return this.calls.some((call) => call.method === "POST");
  }
}

/* ------------------------------------------------------------------ *
 * Fake OpenCode executor
 * ------------------------------------------------------------------ */

interface RunBehavior {
  sessionId?: string;
  exitCode?: number;
  edits?: Record<string, string>;
  /** Delete this attempt's invocation row just before emitting its session id. */
  corruptInvocationRow?: boolean;
  /** Simulate losing the terminal runner result after an attributable stream id. */
  throwAfterSessionLine?: boolean;
}

class FakeOpenCodeExecutor implements AgentExecutor {
  readonly id = "opencode";
  readonly usesSharedCredentials = true;
  readonly honorsRetries = false;
  readonly runs: AgentRunOptions[] = [];
  private index = 0;

  constructor(
    private readonly behaviors: readonly RunBehavior[],
    private readonly events: string[] = [],
    private readonly onRunStart?: () => void,
  ) {}

  async checkVersion(): Promise<void> {}

  additionalEnvironment(): Record<string, string> {
    return {};
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    this.events.push("run");
    this.onRunStart?.();
    const behavior = this.behaviors[Math.min(this.index, this.behaviors.length - 1)] ?? {};
    this.index += 1;
    if (behavior.corruptInvocationRow === true) {
      this.events.push("corrupt-invocation");
    }
    for (const [rel, content] of Object.entries(behavior.edits ?? {})) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const abs = join(opts.cwd, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
    const startedAt = new Date().toISOString();
    const sessionLine =
      behavior.sessionId === undefined
        ? undefined
        : `{"type":"step_start","sessionID":"${behavior.sessionId}"}`;
    if (sessionLine !== undefined) opts.onLine?.(sessionLine);
    this.runs.push(opts);
    if (behavior.throwAfterSessionLine === true) {
      throw new Error("simulated executor result was lost");
    }
    return {
      stdout: sessionLine === undefined ? "" : `${sessionLine}\n`,
      stderr: "",
      exitCode: behavior.exitCode ?? 0,
      ...(behavior.sessionId === undefined ? {} : { sessionId: behavior.sessionId }),
      startedAt,
      endedAt: new Date().toISOString(),
      timedOut: false,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Inventory sources
 * ------------------------------------------------------------------ */

function nativeRecord(id: string, mode = "primary"): AgentInventoryRecord {
  return { id, mode, permissions: [], hasModel: false };
}

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

const PR_NUMBER = 27;

interface NativeFixtureOptions {
  source?: "native" | "default";
  nativeId?: string;
  inventory?: readonly AgentInventoryRecord[];
  behaviors?: readonly RunBehavior[];
  timeoutSec?: number;
  optionTimeoutSec?: number;
  retries?: number;
  cancelAt?: string;
  repositoryAgent?: string;
  /** Per-repository alias override for the two-repository seam test. */
  name?: string;
  events?: string[];
  corruptInvocationRow?: boolean;
}

async function setupNative(opts: NativeFixtureOptions = {}) {
  const gitRepo = await createTempRepo();
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-native-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const repositoryAgent = opts.repositoryAgent ?? "opencode";
  const [repository] = syncRepositories(
    store.db,
    [
      {
        owner: "acme",
        name: opts.name ?? "widgets",
        sourcePath: gitRepo.sourcePath,
        workspaceRoot: gitRepo.workspaceRoot,
        agent: repositoryAgent,
        provider: "opencode",
        model: "opencode/fake-model",
        effort: "xhigh",
        enabled: true,
        validationCommands: [],
        allowedModels: ["opencode/fake-model"],
      },
    ],
    opts.timeoutSec,
  );
  assert.ok(repository);
  const nativeId = opts.nativeId ?? "native-reviewer";
  if (opts.source !== "default") {
    const saved = saveOpenCodeSelection(store.db, {
      repoId: repository.id,
      expectedRevision: 0,
      candidate: { source: "native", agentId: nativeId },
      executorKind: "opencode",
    });
    assert.ok(saved.ok, "native selection must save");
  }
  const prNumber = PR_NUMBER;
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: prNumber,
        title: "Handle $() safely",
        state: "open",
        merged: false,
        headBranch: gitRepo.headBranch,
        headSha: initialSha,
        headRepoOwner: "acme",
        headRepoName: opts.name ?? "widgets",
        baseRepoOwner: "acme",
        baseRepoName: opts.name ?? "widgets",
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
        prNumber,
      },
      {
        id: 501,
        inReplyToId: 500,
        path: "feature.txt",
        diffHunk: "@@ -1 +1 @@",
        body: "!RESOLVE\nmake the tests pass",
        authorLogin: "developer",
        createdAt: "2026-08-27T00:01:00.000Z",
        prNumber,
      },
    ],
  });
  const events = opts.events ?? [];
  const executor = new FakeOpenCodeExecutor(
    opts.behaviors ?? [{ sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } }],
    events,
    opts.corruptInvocationRow === true
      ? () => {
          store.db.prepare("DELETE FROM opencode_invocations").run();
        }
      : undefined,
  );
  const workspace = workspacePathFor(gitRepo.workspaceRoot, prNumber);
  const session = new SessionFixture();
  // Register a root session for every scripted invocation so settlement can
  // attribute it; individual tests may add children or override the root.
  session.addParent("ses_parent", workspace);
  for (const behavior of opts.behaviors ?? []) {
    if (behavior.sessionId !== undefined) session.addParent(behavior.sessionId, workspace);
  }
  const records = opts.inventory ?? [nativeRecord(nativeId)];
  const inventory: AgentInventoryReader = async () => {
    events.push("preflight");
    return { records: [...records] };
  };
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
    ...(opts.optionTimeoutSec === undefined ? {} : { timeoutSec: opts.optionTimeoutSec }),
    retries: opts.retries ?? 1,
    github,
    registry: createDefaultCommandRegistry(),
    executors: new Map([[repositoryAgent, executor]]),
    logger,
    secrets: ["fixture-secret"],
    concurrency: 2,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    operatorActions,
    managedOpenCode: {
      preflightInventory: inventory,
      nativePreflightBudgetMs: 30,
      nativePreflightPollIntervalMs: 5,
      settlePollIntervalMs: 5,
      settleInterruptGraceMs: 20,
      sessionHttp: () => session,
      resolveWorker: () => ({ binary: "opencode" }),
    },
  });
  orchestrator.registerRepository(repository);
  if (opts.cancelAt !== undefined) {
    logger.cancelAt = opts.cancelAt;
    logger.cancel = (jobId) => {
      orchestrator.cancel(jobId);
    };
  }
  const event: NormalizedEvent = {
    owner: "acme",
    repo: opts.name ?? "widgets",
    kind: "review-comment",
    commentId: 501,
    authorLogin: "developer",
    body: "!RESOLVE\nmake the tests pass",
    prNumber,
    observedAt: "2026-08-27T00:01:00.000Z",
  };
  return {
    dataDir,
    store,
    repository,
    github,
    executor,
    orchestrator,
    logger,
    event,
    events,
    session,
    gitRepo,
    initialSha,
    workspace,
    nativeId,
  };
}

class CancellingLogger extends Logger {
  cancelAt: string | undefined;
  cancel: ((jobId: number) => void) | undefined;

  override info(event: string, fields: LogFields = {}): void {
    super.info(event, fields);
    if (event === this.cancelAt && typeof fields.jobId === "number") this.cancel?.(fields.jobId);
  }
}

type Fixture = Awaited<ReturnType<typeof setupNative>>;

async function resolveEvent(data: Fixture) {
  const [queued] = await data.orchestrator.handleEvent(data.repository, data.event);
  if (!queued) throw new Error("the event queued no job");
  return queued;
}

function attemptRow(
  data: Fixture,
  attemptId: number,
): {
  outcome: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
} {
  return data.store.db
    .prepare("SELECT outcome, failure_stage, failure_reason FROM attempts WHERE id = ?")
    .get(attemptId) as {
    outcome: string | null;
    failure_stage: string | null;
    failure_reason: string | null;
  };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("admission refuses a workspace owned by an unresolved journal even without a recovery record", async () => {
  const data = await setupNative();
  // A prior invocation left its ownership journal unresolved and named this
  // workspace, but no start-up recovery record exists yet. Admission must still
  // refuse reuse rather than run over a possibly-live tree.
  const staleDir = join(data.dataDir, "attempts", "9999");
  mkdirSync(staleDir, { recursive: true });
  beginOpenCodeInvocation({
    attemptDataDir: staleDir,
    attemptId: 9999,
    descriptor: {
      executor: "opencode",
      binary: "opencode",
      version: "2.0.16",
      workspacePath: data.workspace,
      source: "native",
      nativeId: "native-reviewer",
    },
  });
  const queued = await resolveEvent(data);
  await assert.rejects(
    () => queued.completed,
    (error: unknown) => {
      assert.ok(error instanceof StageFailure, `expected StageFailure, got ${String(error)}`);
      assert.equal(error.reason, "workspace-quarantined");
      assert.equal(error.stage, "preparing");
      return true;
    },
  );
  assert.equal(data.executor.runs.length, 0, "no agent may run over unresolved ownership");
  data.store.close();
});

test("a native selection is revalidated in the attempt workspace and explicitly selected", async () => {
  const data = await setupNative();
  const queued = await resolveEvent(data);
  assert.equal((await queued.completed).kind, "completed");
  assert.equal(data.executor.runs.length, 1);
  assert.deepEqual(data.executor.runs[0]!.openCodeSelection, {
    source: "native",
    agentId: "native-reviewer",
  });
  assert.equal(data.executor.runs[0]!.primaryAgentId, undefined);
  const row = attemptRow(data, queued.attemptId);
  assert.equal(row.outcome, "succeeded");
  data.store.close();
});

test("an ineligible native id cannot spawn and records a distinct configuration reason", async () => {
  const data = await setupNative({ inventory: [nativeRecord("some-other-agent")] });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  assert.equal(data.executor.runs.length, 0, "preflight must precede any agent work");
  const row = attemptRow(data, queued.attemptId);
  assert.equal(row.failure_stage, "running");
  assert.equal(row.failure_reason, "managed-preflight-failed");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  data.store.close();
});

test("default source omits an explicit primary and still settles its tree", async () => {
  const data = await setupNative({ source: "default", inventory: [] });
  const queued = await resolveEvent(data);
  assert.equal((await queued.completed).kind, "completed");
  assert.deepEqual(data.executor.runs[0]!.openCodeSelection, { source: "default" });
  assert.equal(data.executor.runs[0]!.primaryAgentId, undefined);
  assert.ok(data.session.calls.length > 0, "the default tree must be settled");
  data.store.close();
});

test("a live native descendant blocks retry and publication and preserves ownership evidence", async () => {
  const data = await setupNative({
    behaviors: [
      { sessionId: "ses_native", exitCode: 1 },
      { sessionId: "ses_native_2", edits: { "should-not.txt": "no\n" } },
    ],
    retries: 3,
  });
  data.session.addParent("ses_native", data.workspace);
  data.session.addChild("ses_native", "ses_child", { running: true });
  data.session.interruptSettles = false;
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  // The parent exited nonzero, but the live descendant means no retry was
  // permitted: a second parent must never launch over an unsettled tree.
  assert.equal(data.executor.runs.length, 1);
  const row = attemptRow(data, queued.attemptId);
  assert.equal(row.failure_reason, "managed-child-unsettled");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  assert.equal(existsSync(join(data.workspace, "should-not.txt")), false);
  // The durable ownership journal stays unresolved for recovery.
  const attemptDir = join(data.dataDir, "attempts", String(queued.attemptId));
  assert.equal(existsSync(opencodeOwnershipPath(attemptDir)), true);
  const journal = readOpenCodeOwnership(attemptDir);
  assert.equal(journal?.invocations[0]?.settled, false);
  data.store.close();
});

test("a nonzero native invocation retries only after its tree is proven quiescent, preserving ordinals", async () => {
  const data = await setupNative({
    behaviors: [
      { sessionId: "ses_first", exitCode: 1 },
      { sessionId: "ses_second", edits: { "resolved.txt": "resolved\n" } },
    ],
    retries: 2,
  });
  data.session.addParent("ses_first", data.workspace);
  data.session.addParent("ses_second", data.workspace);
  const queued = await resolveEvent(data);
  assert.equal((await queued.completed).kind, "completed");
  assert.equal(data.executor.runs.length, 2, "the transient failure is retried");
  assert.equal(
    (data.events as string[]).filter((event) => event === "preflight").length,
    2,
    "the native id is revalidated against the actual workspace before EVERY invocation",
  );
  const jobs = new JobStore(data.store.db);
  const invocations = jobs.listOpenCodeInvocations(queued.attemptId);
  assert.deepEqual(
    invocations.map((row) => [row.invocation_ordinal, row.parent_session_id, row.ownership_state]),
    [
      [1, "ses_first", "proven"],
      [2, "ses_second", "proven"],
    ],
  );
  data.store.close();
});

test("a launched native invocation with no attributable parent fails closed and is quarantined", async () => {
  const data = await setupNative({
    behaviors: [{ exitCode: 0 }],
    inventory: [nativeRecord("native-reviewer")],
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  const row = attemptRow(data, queued.attemptId);
  assert.equal(row.failure_reason, "managed-session-discovery-failed");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  const attemptDir = join(data.dataDir, "attempts", String(queued.attemptId));
  assert.equal(existsSync(opencodeOwnershipPath(attemptDir)), true);
  assert.equal(readOpenCodeOwnership(attemptDir)?.invocations[0]?.settled, false);
  data.store.close();
});

test("a thrown executor result preserves unresolved ownership even after a parent id was observed", async () => {
  const data = await setupNative({
    behaviors: [{ sessionId: "ses_parent", throwAfterSessionLine: true }],
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  const row = attemptRow(data, queued.attemptId);
  assert.equal(row.failure_reason, "managed-session-discovery-failed");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  const attemptDir = join(data.dataDir, "attempts", String(queued.attemptId));
  const journal = readOpenCodeOwnership(attemptDir);
  assert.equal(journal?.invocations[0]?.parentSessionId, "ses_parent");
  assert.equal(journal?.invocations[0]?.settled, false);
  assert.equal(existsSync(attemptDir), true, "unproven ownership evidence must remain available");
  data.store.close();
});

test("a contradictory observed initial identity settles first, then fails without publishing", async () => {
  const data = await setupNative();
  data.session.addParent("ses_parent", data.workspace, { agent: "some-agent" });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  const row = attemptRow(data, queued.attemptId);
  assert.equal(row.failure_reason, "managed-preflight-failed");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  data.store.close();
});

test("an early ownership-persistence failure aborts the run and retains the durable journal", async () => {
  const data = await setupNative({
    behaviors: [{ sessionId: "ses_parent" }],
    corruptInvocationRow: true,
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  const row = attemptRow(data, queued.attemptId);
  assert.equal(row.failure_reason, "managed-session-discovery-failed");
  const attemptDir = join(data.dataDir, "attempts", String(queued.attemptId));
  assert.equal(existsSync(opencodeOwnershipPath(attemptDir)), true);
  assert.equal(readOpenCodeOwnership(attemptDir)?.invocations[0]?.settled, false);
  data.store.close();
});

test("cancellation interrupts the attributed native tree within the grace bound", async () => {
  const data = await setupNative({
    behaviors: [{ sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } }],
  });
  data.session.addParent("ses_parent", data.workspace);
  data.session.addChild("ses_parent", "ses_child", { running: true });
  const queued = await resolveEvent(data);
  // Cancel from inside the session surface: the operator's stop must interrupt
  // the attributed tree rather than leave it running.
  let cancelled = false;
  data.session.onCall = () => {
    if (!cancelled) {
      cancelled = true;
      data.orchestrator.cancel(queued.jobId);
    }
  };
  assert.equal((await queued.completed).kind, "cancelled");
  assert.equal(data.session.interrupted, true, "the child is interrupted on cancel");
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  data.store.close();
});

test("the remaining configured timeout bounds settlement, and a running child is interrupted", async () => {
  const data = await setupNative({
    behaviors: [{ sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } }],
    timeoutSec: 0.25,
  });
  data.session.addParent("ses_parent", data.workspace);
  data.session.addChild("ses_parent", "ses_child", { running: true });
  data.session.interruptSettles = true;
  const queued = await resolveEvent(data);
  assert.equal((await queued.completed).kind, "completed");
  assert.equal(data.session.interrupted, true, "the running child is interrupted within the bound");
  data.store.close();
});

test("two repository aliases run their own captured native ids across retry, restart and switching", async () => {
  const alphaRepo = await createTempRepo();
  const betaRepo = await createTempRepo();
  const alphaSha = await remoteSha(alphaRepo.remotePath, alphaRepo.headBranch);
  const betaSha = await remoteSha(betaRepo.remotePath, betaRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-native-seam-"));
  const alphaPr = 27;
  const betaPr = 28;
  const workspaceAlpha = workspacePathFor(alphaRepo.workspaceRoot, alphaPr);
  const workspaceBeta = workspacePathFor(betaRepo.workspaceRoot, betaPr);

  const calls: Array<{ repo: string; args: string[] }> = [];
  const alphaSessions = ["ses_alpha_1", "ses_alpha_2"];
  let alphaCalls = 0;
  const alphaRunner: ProcessRunner = async (_binary, args, options) => {
    const sessionId = alphaSessions[Math.min(alphaCalls, alphaSessions.length - 1)]!;
    const fail = alphaCalls === 0;
    alphaCalls += 1;
    if (!fail && options.cwd !== undefined) {
      writeFileSync(join(options.cwd, "resolved.txt"), "resolved\n", "utf8");
    }
    calls.push({ repo: "alpha", args: [...args] });
    return {
      stdout: `{"type":"step_start","sessionID":"${sessionId}"}\n`,
      stderr: "",
      exitCode: fail ? 1 : 0,
      timedOut: false,
      isCanceled: false,
    };
  };
  const betaRunner: ProcessRunner = async (_binary, args, options) => {
    if (options.cwd !== undefined) {
      writeFileSync(join(options.cwd, "resolved.txt"), "resolved\n", "utf8");
    }
    calls.push({ repo: "beta", args: [...args] });
    return {
      stdout: '{"type":"step_start","sessionID":"ses_beta"}\n',
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isCanceled: false,
    };
  };

  const session = new SessionFixture();
  session.addParent("ses_alpha_1", workspaceAlpha);
  session.addParent("ses_alpha_2", workspaceAlpha);
  session.addParent("ses_beta", workspaceBeta);

  const repoConfig = (
    name: "alpha" | "beta",
    repo: Awaited<ReturnType<typeof createTempRepo>>,
    agent: string,
  ) => ({
    owner: "acme",
    name,
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    agent,
    provider: "opencode",
    model: "opencode/fake-model",
    effort: "xhigh" as const,
    enabled: true,
    validationCommands: [] as string[],
    allowedModels: ["opencode/fake-model"],
  });

  let store = new Store({ dataDir, file: join(dataDir, "g.db") });
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: alphaPr,
        title: "alpha",
        state: "open",
        merged: false,
        headBranch: alphaRepo.headBranch,
        headSha: alphaSha,
        headRepoOwner: "acme",
        headRepoName: "alpha",
        baseRepoOwner: "acme",
        baseRepoName: "alpha",
        htmlUrl: "https://example.test/acme/alpha/pull/27",
      },
      {
        number: betaPr,
        title: "beta",
        state: "open",
        merged: false,
        headBranch: betaRepo.headBranch,
        headSha: betaSha,
        headRepoOwner: "acme",
        headRepoName: "beta",
        baseRepoOwner: "acme",
        baseRepoName: "beta",
        htmlUrl: "https://example.test/acme/beta/pull/28",
      },
    ],
    comments: [
      {
        id: 501,
        inReplyToId: null,
        path: "feature.txt",
        diffHunk: "@@ -1 +1 @@",
        body: "!RESOLVE\nmake the tests pass",
        authorLogin: "developer",
        createdAt: "2026-08-27T00:01:00.000Z",
        prNumber: alphaPr,
      },
      {
        id: 502,
        inReplyToId: null,
        path: "feature.txt",
        diffHunk: "@@ -1 +1 @@",
        body: "!RESOLVE\nmake the tests pass",
        authorLogin: "developer",
        createdAt: "2026-08-27T00:01:00.000Z",
        prNumber: betaPr,
      },
    ],
  });
  const build = (): {
    orchestrator: ResolutionOrchestrator;
    repos: ReturnType<typeof syncRepositories>;
  } => {
    const repos = syncRepositories(store.db, [
      repoConfig("alpha", alphaRepo, "opencode-a"),
      repoConfig("beta", betaRepo, "opencode-b"),
    ]);
    const orchestrator = new ResolutionOrchestrator({
      db: store.db,
      dataDir,
      allowedAuthors: ["developer"],
      orchestratorLogin: "gremlyn-bot",
      retries: 1,
      github,
      registry: createDefaultCommandRegistry(),
      executors: new Map<string, AgentExecutor>([
        ["opencode-a", new OpenCodeExecutor("opencode-a", alphaRunner)],
        ["opencode-b", new OpenCodeExecutor("opencode-b", betaRunner)],
      ]),
      logger: new Logger({ level: "error", secrets: [], db: store.db }),
      secrets: [],
      concurrency: 1,
      commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
      operatorActions: new OperatorActionStore(store.db),
      managedOpenCode: {
        preflightInventory: (async (input) => ({
          records: [nativeRecord(input.cwd === workspaceAlpha ? "repair-alpha" : "repair-beta")],
          directory: input.cwd,
        })) as AgentInventoryReader,
        nativePreflightBudgetMs: 30,
        nativePreflightPollIntervalMs: 5,
        settlePollIntervalMs: 5,
        settleInterruptGraceMs: 20,
        sessionHttp: () => session,
        resolveWorker: (input) => ({ binary: input.executorId }),
      },
    });
    for (const repository of repos) orchestrator.registerRepository(repository);
    return { orchestrator, repos };
  };

  // Seed each repository's own native selection.
  const seeded = syncRepositories(store.db, [
    repoConfig("alpha", alphaRepo, "opencode-a"),
    repoConfig("beta", betaRepo, "opencode-b"),
  ]);
  const alphaId = seeded.find((repo) => repo.name === "alpha")!.id;
  const betaId = seeded.find((repo) => repo.name === "beta")!.id;
  for (const [repoId, agentId] of [
    [alphaId, "repair-alpha"],
    [betaId, "repair-beta"],
  ] as const) {
    assert.equal(
      saveOpenCodeSelection(store.db, {
        repoId,
        expectedRevision: 0,
        candidate: { source: "native", agentId },
        executorKind: "opencode",
      }).ok,
      true,
    );
  }

  const first = build();
  const alphaRepoRuntime = first.repos.find((repo) => repo.name === "alpha")!;
  const betaRepoRuntime = first.repos.find((repo) => repo.name === "beta")!;
  const [alphaJob] = await first.orchestrator.handleEvent(alphaRepoRuntime, {
    owner: "acme",
    repo: "alpha",
    kind: "review-comment",
    commentId: 501,
    authorLogin: "developer",
    body: "!RESOLVE\nmake the tests pass",
    prNumber: alphaPr,
    observedAt: "2026-08-27T00:01:00.000Z",
  });
  assert.ok(alphaJob);
  await assert.rejects(() => alphaJob!.completed, "the first alpha attempt fails transiently");
  const [betaJob] = await first.orchestrator.handleEvent(betaRepoRuntime, {
    owner: "acme",
    repo: "beta",
    kind: "review-comment",
    commentId: 502,
    authorLogin: "developer",
    body: "!RESOLVE\nmake the tests pass",
    prNumber: betaPr,
    observedAt: "2026-08-27T00:01:00.000Z",
  });
  assert.ok(betaJob);
  assert.equal((await betaJob!.completed).kind, "completed");

  // The operator switches alpha's repository selection to default; the queued
  // job's captured native id must still win on retry.
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId: alphaId,
      expectedRevision: 1,
      candidate: { source: "default" },
      executorKind: "opencode",
    }).ok,
    true,
  );

  // Restart: close and reopen the database, then rebuild the runtime.
  store.close();
  store = new Store({ dataDir, file: join(dataDir, "g.db") });
  const second = build();
  const retried = await second.orchestrator.retry(alphaJob!.jobId);
  assert.equal((await retried.completed).kind, "completed");

  const agentArg = (entry: { args: string[] }): string | undefined => {
    const index = entry.args.indexOf("--agent");
    return index < 0 ? undefined : entry.args[index + 1];
  };
  const alphaRuns = calls.filter((entry) => entry.repo === "alpha");
  assert.equal(alphaRuns.length, 2);
  for (const run of alphaRuns) assert.equal(agentArg(run), "repair-alpha");
  const betaRuns = calls.filter((entry) => entry.repo === "beta");
  assert.equal(betaRuns.length, 1);
  assert.equal(agentArg(betaRuns[0]!), "repair-beta");
  store.close();
});
