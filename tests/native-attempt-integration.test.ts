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
import {
  createStoreDelegationSink,
  ResolutionOrchestrator,
} from "../src/orchestrator/resolution.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import {
  markDelegationObservationsUnknownOnRestart,
  readDelegationObservations,
  readDelegationTransitions,
  reportDelegationObservations,
  type DelegationObservationNode,
} from "../src/store/delegation-observations.js";
import { JobStore } from "../src/store/jobs.js";
import { saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { AgentExecutor, AgentResult, AgentRunOptions, NormalizedEvent } from "../src/types.js";
import { workspacePathFor } from "../src/workspace/worktree.js";
import {
  allObservationNodes,
  countOpenGaps,
  coverageTransportStates,
  disposeDelegationObservation,
  installObservationStorageFailureTrigger,
  observationGaps,
  removeObservationStorageFailureTrigger,
  waitFor,
} from "./helpers/delegation-integration.js";
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
  createdAt?: number;
  updatedAt?: number;
  idleAt?: number;
}

/** Options for a scripted child session. */
interface ChildOptions {
  running?: boolean;
  /** Force a nonterminal record (no `outcome`) even when not running. */
  nonterminal?: boolean;
  outcome?: OpenCodeSessionOutcome;
  directory?: string;
  agent?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  idleAt?: number;
}

/** A minimal scripted `opencode api` session surface shared per fixture. */
class SessionFixture implements ManagedSessionHttp {
  readonly calls: Array<{ method: "GET" | "POST"; path: string }> = [];
  private readonly sessions = new Map<string, SessionNode>();
  interruptSettles = true;
  /** Test hook invoked at the start of every transport call. */
  onCall: ((method: "GET" | "POST", path: string) => void) | undefined;
  /** Session ids whose own record read returns 503: simulated source loss. */
  readonly readFailures = new Set<string>();
  /** When true every session record read returns 503. */
  failRecordReads = false;
  /** When true every child listing returns 503. */
  failListings = false;
  /** When true the active map returns 503. */
  activeUnavailable = false;

  addParent(id: string, directory: string, identity?: { agent?: string; model?: string }): void {
    this.sessions.set(id, {
      directory,
      outcome: "succeeded",
      running: false,
      ...(identity?.agent === undefined ? {} : { agent: identity.agent }),
      ...(identity?.model === undefined ? {} : { model: identity.model }),
    });
  }

  addChild(parentId: string, id: string, opts: ChildOptions = {}): void {
    const parent = this.sessions.get(parentId);
    assert.ok(parent, `parent ${parentId} must exist before its child`);
    const running = opts.running === true;
    const outcome =
      opts.nonterminal === true ? undefined : (opts.outcome ?? (running ? undefined : "succeeded"));
    this.sessions.set(id, {
      directory: opts.directory ?? parent.directory,
      parentId,
      running,
      ...(outcome === undefined ? {} : { outcome }),
      ...(opts.agent === undefined ? {} : { agent: opts.agent }),
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
      ...(opts.updatedAt === undefined ? {} : { updatedAt: opts.updatedAt }),
      ...(opts.idleAt === undefined ? {} : { idleAt: opts.idleAt }),
    });
  }

  /** Flip a session to a terminal outcome and out of the active map. */
  finish(id: string, outcome: OpenCodeSessionOutcome = "succeeded"): void {
    const node = this.sessions.get(id);
    assert.ok(node, `session ${id} must exist`);
    node.running = false;
    node.outcome = outcome;
  }

  /** Promote a nonterminal session into the active map (still nonterminal). */
  start(id: string): void {
    const node = this.sessions.get(id);
    assert.ok(node, `session ${id} must exist`);
    node.running = true;
    delete node.outcome;
  }

  /** The pinned `model` reference shape: `{providerID, id, variant?}`. */
  private modelRef(value: string): Record<string, string> {
    const [core = "", variant] = value.split("#");
    const [providerID = "", ...rest] = core.split("/");
    const id = rest.join("/");
    return {
      providerID,
      ...(id === "" ? {} : { id }),
      ...(variant === undefined ? {} : { variant }),
    };
  }

  private record(id: string): Record<string, unknown> {
    const node = this.sessions.get(id)!;
    return {
      id,
      location: { directory: node.directory },
      ...(node.parentId === undefined ? {} : { parentID: node.parentId }),
      ...(node.outcome === undefined ? {} : { outcome: node.outcome }),
      ...(node.agent === undefined ? {} : { agent: node.agent }),
      ...(node.model === undefined ? {} : { model: this.modelRef(node.model) }),
      ...(node.createdAt === undefined && node.updatedAt === undefined && node.idleAt === undefined
        ? {}
        : {
            time: {
              ...(node.createdAt === undefined ? {} : { created: node.createdAt }),
              ...(node.updatedAt === undefined ? {} : { updated: node.updatedAt }),
              ...(node.idleAt === undefined ? {} : { idle: node.idleAt }),
            },
          }),
    };
  }

  async get(path: string, query?: Record<string, string>): Promise<ManagedHttpResult> {
    this.calls.push({ method: "GET", path });
    this.onCall?.("GET", path);
    if (path === "/api/session/active") {
      if (this.activeUnavailable) return { status: 503, body: undefined };
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
      if (this.failListings) return { status: 503, body: undefined };
      const data = [...this.sessions.entries()]
        .filter(([, node]) => node.parentId === query.parentID)
        .map(([childId]) => this.record(childId));
      return { status: 200, body: { data, cursor: { previous: null, next: null } } };
    }
    if (this.failRecordReads || this.readFailures.has(id)) return { status: 503, body: undefined };
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

/**
 * The fixture seams a test needs while the parent process is still "running".
 * `duringRun` is invoked AFTER the run stream has emitted the parent session id
 * (so the observer has attached the root) and before the executor returns, which
 * lets a test drive the shared session surface and assert live observation
 * deterministically.
 */
interface ObserverFixtureContext {
  store: Store;
  session: SessionFixture;
  workspace: string;
  events: string[];
}

interface RunBehavior {
  sessionId?: string;
  exitCode?: number;
  edits?: Record<string, string>;
  /** Delete this attempt's invocation row just before emitting its session id. */
  corruptInvocationRow?: boolean;
  /** Simulate losing the terminal runner result after an attributable stream id. */
  throwAfterSessionLine?: boolean;
  /** Async, test-controlled work while the parent "runs". */
  duringRun?: (context: ObserverFixtureContext) => Promise<void>;
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
    private readonly context?: ObserverFixtureContext,
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
    if (behavior.duringRun !== undefined) {
      if (this.context === undefined) {
        throw new Error("duringRun requires the observer fixture context");
      }
      await behavior.duringRun(this.context);
    }
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
  /**
   * Enable live delegation observation through the real durable sink. `true`
   * uses 5ms polls and a 100ms per-call bound; an object overrides either.
   */
  observe?:
    | boolean
    | { pollIntervalMs?: number; perCallTimeoutMs?: number; globalConcurrencyLimit?: number };
  /** Back the store with a file (defaults to the harness's temp data dir). */
  persistent?: boolean;
}

async function setupNative(opts: NativeFixtureOptions = {}) {
  const gitRepo = await createTempRepo();
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-native-"));
  const dbFile = opts.persistent === true ? join(dataDir, "gremlyn.db") : ":memory:";
  const store = new Store({ dataDir, file: dbFile });
  const observationOptions = typeof opts.observe === "object" ? opts.observe : {};
  const observeEnabled = opts.observe === true || typeof opts.observe === "object";
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
  const workspace = workspacePathFor(gitRepo.workspaceRoot, prNumber);
  const session = new SessionFixture();
  // Register a root session for every scripted invocation so settlement can
  // attribute it; individual tests may add children or override the root.
  session.addParent("ses_parent", workspace);
  for (const behavior of opts.behaviors ?? []) {
    if (behavior.sessionId !== undefined) session.addParent(behavior.sessionId, workspace);
  }
  const executor = new FakeOpenCodeExecutor(
    opts.behaviors ?? [{ sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } }],
    events,
    opts.corruptInvocationRow === true
      ? () => {
          store.db.prepare("DELETE FROM opencode_invocations").run();
        }
      : undefined,
    { store, session, workspace, events },
  );
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
    ...(observeEnabled
      ? {
          delegationObservation: {
            createSink: (identity: { attemptId: number; ordinal: number; workspacePath: string }) =>
              createStoreDelegationSink(store.db, {
                attemptId: identity.attemptId,
                ordinal: identity.ordinal,
              }),
            pollIntervalMs: observationOptions.pollIntervalMs ?? 5,
            perCallTimeoutMs: observationOptions.perCallTimeoutMs ?? 100,
            ...(observationOptions.globalConcurrencyLimit === undefined
              ? {}
              : { globalConcurrencyLimit: observationOptions.globalConcurrencyLimit }),
          },
        }
      : {}),
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
    dbFile,
    observeEnabled,
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

/** One observation node by session id, or undefined. */
function observationNode(data: Fixture, sessionId: string): DelegationObservationNode | undefined {
  return allObservationNodes(data.store.db).find((node) => node.sessionId === sessionId);
}

/** Dispose every live observer, then close the store (safe to call once). */
function closeObservedFixture(data: Fixture): void {
  disposeDelegationObservation(data.orchestrator);
  if (data.store.db.open) data.store.close();
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

/* ------------------------------------------------------------------ *
 * Task 5.1: broad real-orchestrator delegation-observation integration
 * ------------------------------------------------------------------ */

test("live observation sees concurrent foreground/background-shaped children before the parent exits, then one terminal while its sibling runs", async () => {
  const unrelatedDirectory = join(tmpdir(), "gremlyn-unrelated-job");
  const data = await setupNative({
    observe: true,
    // Bound the settlement wait so a live child is interrupted promptly.
    timeoutSec: 2,
    behaviors: [
      {
        sessionId: "ses_parent",
        edits: { "resolved.txt": "resolved\n" },
        duringRun: async (ctx) => {
          await waitFor(
            () =>
              allObservationNodes(ctx.store.db).filter((node) =>
                node.sessionId.startsWith("ses_child_"),
              ).length >= 2,
            { timeoutMs: 4_000, label: "both children observed while the parent runs" },
          );
          const live = new Map(
            allObservationNodes(ctx.store.db).map((node) => [node.sessionId, node]),
          );
          // The root was attached from the run stream before the parent exits.
          assert.equal(live.get("ses_parent")?.rootSessionId, "ses_parent");
          // Foreground-shaped: fresh active presence -> running.
          assert.equal(live.get("ses_child_fg")?.lastState, "running");
          // Background-shaped: nonterminal but absent from the active map ->
          // idle (explicitly NOT finished), never terminal.
          assert.equal(live.get("ses_child_bg")?.lastState, "idle");
          assert.equal(live.get("ses_child_bg")?.lastOutcome, null);
          // Same actual agent, distinct session ids (identity is the runtime's).
          assert.equal(live.get("ses_child_fg")?.agent, "reviewer");
          assert.equal(live.get("ses_child_bg")?.agent, "reviewer");
          // An unrelated running session in the shared service never attaches.
          assert.equal(live.has("ses_other_root"), false);

          // One child reaches a terminal outcome while its sibling is running.
          ctx.session.finish("ses_child_fg", "succeeded");
          ctx.session.start("ses_child_bg");
          await waitFor(
            () => {
              const now = new Map(
                allObservationNodes(ctx.store.db).map((node) => [node.sessionId, node]),
              );
              return (
                now.get("ses_child_fg")?.lastState === "succeeded" &&
                now.get("ses_child_bg")?.lastState === "running"
              );
            },
            { timeoutMs: 4_000, label: "one terminal child alongside a running sibling" },
          );
        },
      },
    ],
  });
  data.session.addChild("ses_parent", "ses_child_fg", {
    running: true,
    agent: "reviewer",
    model: "opencode/fake-model",
    createdAt: 1_788_408_300_000,
    updatedAt: 1_788_408_399_000,
  });
  data.session.addChild("ses_parent", "ses_child_bg", {
    nonterminal: true,
    agent: "reviewer",
    model: "opencode/fake-model",
    createdAt: 1_788_408_300_000,
    updatedAt: 1_788_408_395_000,
  });
  data.session.addParent("ses_other_root", unrelatedDirectory);
  data.session.start("ses_other_root");
  try {
    const queued = await resolveEvent(data);
    assert.equal((await queued.completed).kind, "completed");
    assert.notEqual(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      data.initialSha,
      "the legitimate job publishes to the local fixture remote",
    );

    const fg = observationNode(data, "ses_child_fg");
    const bg = observationNode(data, "ses_child_bg");
    assert.equal(fg?.rootSessionId, "ses_parent");
    assert.equal(fg?.parentSessionId, "ses_parent");
    assert.equal(fg?.agent, "reviewer");
    assert.equal(fg?.sourceCreatedAt, new Date(1_788_408_300_000).toISOString());
    assert.equal(bg?.parentSessionId, "ses_parent");
    // The running background sibling was interrupted to reach quiescence.
    assert.equal(bg?.lastOutcome, "interrupted");
    assert.equal(bg?.lastState, "interrupted");
    assert.equal(observationNode(data, "ses_other_root"), undefined);
  } finally {
    closeObservedFixture(data);
  }
});

test("source loss during a live parent run is projected unknown with an honest gap, then reconciliation restores running without duplicating the gap", async () => {
  const data = await setupNative({
    observe: true,
    // Bound the settlement wait so a live child is interrupted promptly.
    timeoutSec: 2,
    behaviors: [
      {
        sessionId: "ses_parent",
        edits: { "resolved.txt": "resolved\n" },
        duringRun: async (ctx) => {
          await waitFor(
            () =>
              allObservationNodes(ctx.store.db).some(
                (node) => node.sessionId === "ses_child" && node.lastState === "running",
              ),
            { timeoutMs: 4_000, label: "child observed running before source loss" },
          );
          ctx.session.readFailures.add("ses_child");
          await waitFor(
            () => {
              const node = allObservationNodes(ctx.store.db).find(
                (candidate) => candidate.sessionId === "ses_child",
              );
              return node?.presence === "missing" && node.lastState === "unknown";
            },
            { timeoutMs: 4_000, label: "source loss degrades the child to missing/unknown" },
          );
          const revoked = allObservationNodes(ctx.store.db).find(
            (candidate) => candidate.sessionId === "ses_child",
          )!;
          // A failed refresh revokes current presence but retains last-known
          // identity as history only; it never leaves a stale running assertion.
          assert.equal(revoked.agent, "reviewer");
          assert.equal(revoked.currentOutcome, null);
          assert.equal(revoked.lastOutcome, null);
          await waitFor(() => coverageTransportStates(ctx.store.db).includes("degraded"), {
            timeoutMs: 2_000,
            label: "loss degrades coverage",
          });
          await waitFor(() => countOpenGaps(ctx.store.db, "transport-error") === 1, {
            timeoutMs: 2_000,
            label: "one open transport-error gap during loss",
          });
          // Several more failing rounds must not accumulate duplicate open gaps.
          await waitFor(() => ctx.session.calls.length > 0, { timeoutMs: 1_000 });
          await new Promise((done) => setTimeout(done, 40));
          assert.equal(countOpenGaps(ctx.store.db, "transport-error"), 1);

          ctx.session.readFailures.delete("ses_child");
          await waitFor(
            () =>
              allObservationNodes(ctx.store.db).some(
                (node) =>
                  node.sessionId === "ses_child" &&
                  node.presence === "observed" &&
                  node.lastState === "running",
              ),
            { timeoutMs: 4_000, label: "reconciliation restores the child to running" },
          );
          // The gap is retained as closed history, not duplicated or deleted.
          assert.ok(
            observationGaps(ctx.store.db).some(
              (gap) => gap.signature === "transport-error" && gap.closedAt !== null,
            ),
            "the historical gap row survives reconciliation",
          );
          await waitFor(() => coverageTransportStates(ctx.store.db).every((s) => s === "ok"), {
            timeoutMs: 2_000,
            label: "a healthy round restores coverage",
          });
          assert.equal(countOpenGaps(ctx.store.db, "transport-error"), 0);
          // Repeated healthy rounds must NOT reopen the reconciled historical
          // gap: the sink opens gaps only from the round's own current gaps.
          await new Promise((done) => setTimeout(done, 40));
          assert.equal(
            countOpenGaps(ctx.store.db, "transport-error"),
            0,
            "a healthy round does not reopen a reconciled historical gap",
          );
        },
      },
    ],
  });
  data.session.addChild("ses_parent", "ses_child", { running: true, agent: "reviewer" });
  try {
    const queued = await resolveEvent(data);
    assert.equal((await queued.completed).kind, "completed");
    assert.notEqual(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      data.initialSha,
    );
    const node = observationNode(data, "ses_child");
    assert.equal(node?.presence, "observed");
    assert.equal(node?.lastState, "interrupted");
    assert.ok(observationGaps(data.store.db).some((gap) => gap.signature === "transport-error"));
    assert.deepEqual(coverageTransportStates(data.store.db), ["ok"]);
  } finally {
    closeObservedFixture(data);
  }
});

test("an internal retry keeps two distinct roots/ordinals and preserves each tree's child ownership", async () => {
  const data = await setupNative({
    observe: true,
    behaviors: [
      { sessionId: "ses_root_a", exitCode: 1 },
      { sessionId: "ses_root_b", edits: { "resolved.txt": "resolved\n" } },
    ],
    retries: 2,
  });
  data.session.addChild("ses_root_a", "ses_child_a", { agent: "reviewer" });
  data.session.addChild("ses_root_b", "ses_child_b", { agent: "reviewer" });
  try {
    const queued = await resolveEvent(data);
    assert.equal((await queued.completed).kind, "completed");

    const jobs = new JobStore(data.store.db);
    const invocations = jobs.listOpenCodeInvocations(queued.attemptId);
    assert.deepEqual(
      invocations.map((row) => [
        row.invocation_ordinal,
        row.parent_session_id,
        row.ownership_state,
      ]),
      [
        [1, "ses_root_a", "proven"],
        [2, "ses_root_b", "proven"],
      ],
    );

    const bucket = readDelegationObservations(data.store.db, [queued.attemptId]).get(
      queued.attemptId,
    )!;
    const first = bucket.nodes
      .filter((node) => node.invocationOrdinal === 1)
      .map((node) => node.sessionId)
      .sort();
    const second = bucket.nodes
      .filter((node) => node.invocationOrdinal === 2)
      .map((node) => node.sessionId)
      .sort();
    assert.deepEqual(first, ["ses_child_a", "ses_root_a"]);
    assert.deepEqual(second, ["ses_child_b", "ses_root_b"]);
    for (const node of bucket.nodes) {
      const expectedRoot = node.invocationOrdinal === 1 ? "ses_root_a" : "ses_root_b";
      assert.equal(node.rootSessionId, expectedRoot);
      if (node.sessionId !== expectedRoot) assert.equal(node.parentSessionId, expectedRoot);
    }
  } finally {
    closeObservedFixture(data);
  }
});

test("a failed job records the child's source outcome and never manufactures an interruption", async () => {
  const data = await setupNative({
    observe: true,
    behaviors: [{ sessionId: "ses_parent", exitCode: 1 }],
    retries: 1,
  });
  data.session.addChild("ses_parent", "ses_child", { agent: "reviewer", outcome: "succeeded" });
  try {
    const queued = await resolveEvent(data);
    await assert.rejects(() => queued.completed);
    const row = attemptRow(data, queued.attemptId);
    assert.equal(row.outcome, "failed");
    assert.equal(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      data.initialSha,
      "a failed job publishes nothing",
    );
    const node = observationNode(data, "ses_child");
    assert.equal(node?.lastOutcome, "succeeded");
    assert.equal(node?.currentOutcome, "succeeded");
    assert.equal(node?.lastState, "succeeded");
    assert.equal(node?.cancellationRequested, false);
  } finally {
    closeObservedFixture(data);
  }
});

test("a cancellation request is recorded independently and only a confirmed runtime interruption becomes terminal", async () => {
  let childObserved = false;
  let requestedWhileRunning = false;
  let requestedWithoutOutcome = false;
  const data = await setupNative({
    observe: true,
    behaviors: [
      {
        sessionId: "ses_parent",
        edits: { "resolved.txt": "resolved\n" },
        duringRun: async (ctx) => {
          await waitFor(
            () =>
              allObservationNodes(ctx.store.db).some(
                (node) => node.sessionId === "ses_child" && node.lastState === "running",
              ),
            { timeoutMs: 4_000, label: "child observed running before cancel" },
          );
          childObserved = true;
          await waitFor(
            () => {
              const node = allObservationNodes(ctx.store.db).find(
                (candidate) => candidate.sessionId === "ses_child",
              );
              return node?.cancellationRequested === true && node.currentOutcome === null;
            },
            { timeoutMs: 4_000, label: "cancellation requested before any terminal outcome" },
          );
          const node = allObservationNodes(ctx.store.db).find(
            (candidate) => candidate.sessionId === "ses_child",
          )!;
          requestedWhileRunning = node.lastState === "running";
          requestedWithoutOutcome = node.currentOutcome === null;
        },
      },
    ],
  });
  data.session.addChild("ses_parent", "ses_child", { running: true, agent: "reviewer" });
  try {
    const queued = await resolveEvent(data);
    await waitFor(() => childObserved, { timeoutMs: 4_000, label: "child observed before cancel" });
    data.orchestrator.cancel(queued.jobId);
    assert.equal((await queued.completed).kind, "cancelled");
    assert.equal(requestedWhileRunning, true, "the request was carried while the child still ran");
    assert.equal(
      requestedWithoutOutcome,
      true,
      "no terminal outcome was fabricated from the cancellation request",
    );
    assert.equal(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      data.initialSha,
      "a cancelled job publishes nothing",
    );
    const node = observationNode(data, "ses_child");
    assert.equal(node?.cancellationRequested, true);
    assert.equal(node?.currentOutcome, "interrupted");
    assert.equal(node?.lastOutcome, "interrupted");
  } finally {
    closeObservedFixture(data);
  }
});

test("restart marks unresolved observations unknown while retaining terminal history in a reopened file store", async () => {
  const data = await setupNative({
    observe: true,
    persistent: true,
    behaviors: [{ sessionId: "ses_parent", exitCode: 1 }],
    retries: 1,
    // Bound the settlement wait so the blocked job fails promptly.
    timeoutSec: 1,
  });
  data.session.addChild("ses_parent", "ses_child", { running: true, agent: "reviewer" });
  data.session.interruptSettles = false;
  try {
    const queued = await resolveEvent(data);
    await assert.rejects(() => queued.completed);
    const attemptId = queued.attemptId;
    const before = readDelegationObservations(data.store.db, [attemptId]).get(attemptId)!;
    const childBefore = before.nodes.find((node) => node.sessionId === "ses_child")!;
    const rootBefore = before.nodes.find((node) => node.sessionId === "ses_parent")!;
    assert.equal(childBefore.lastState, "running");
    assert.equal(rootBefore.lastState, "succeeded");
    const generationBefore = before.coverage[0]?.generation ?? 0;
    const transitionsBefore = readDelegationTransitions(data.store.db, {
      attemptId,
      invocationOrdinal: childBefore.invocationOrdinal,
      sessionId: "ses_child",
    }).length;
    assert.ok(transitionsBefore >= 1, "the child's bounded history was retained");

    data.orchestrator.disposeDelegationObservation();
    data.store.close();

    const reopened = new Store({ dataDir: data.dataDir, file: data.dbFile });
    try {
      const marked = markDelegationObservationsUnknownOnRestart(reopened.db);
      assert.equal(marked.ok, true);
      assert.ok(marked.marked >= 1, "the unresolved child was marked");
      const after = readDelegationObservations(reopened.db, [attemptId]).get(attemptId)!;
      const childAfter = after.nodes.find((node) => node.sessionId === "ses_child")!;
      const rootAfter = after.nodes.find((node) => node.sessionId === "ses_parent")!;
      assert.equal(childAfter.lastState, "unknown");
      // Restart revokes current presence (missing) rather than leaving a stale
      // live assertion; terminal historic evidence is untouched.
      assert.equal(childAfter.presence, "missing");
      assert.equal(childAfter.currentOutcome, null);
      assert.equal(childAfter.lastOutcome, null);
      assert.equal(rootAfter.lastState, "succeeded");
      assert.equal(rootAfter.presence, "observed");
      assert.equal(rootAfter.lastOutcome, "succeeded");
      assert.ok((after.coverage[0]?.generation ?? 0) > generationBefore);
      assert.equal(after.coverage[0]?.transportState, "degraded");
      assert.ok(
        observationGaps(reopened.db, attemptId).some(
          (gap) => gap.signature === "daemon-restart" && gap.closedAt === null,
        ),
        "restart records an explicit open daemon-restart gap",
      );
      assert.equal(
        readDelegationTransitions(reopened.db, {
          attemptId,
          invocationOrdinal: childAfter.invocationOrdinal,
          sessionId: "ses_child",
        }).length,
        transitionsBefore,
      );
    } finally {
      reopened.close();
    }
  } finally {
    closeObservedFixture(data);
  }
});

test("observation storage failures cannot block a legitimate job from publishing to the local fixture remote", async () => {
  const data = await setupNative({
    observe: true,
    behaviors: [{ sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } }],
  });
  data.session.addChild("ses_parent", "ses_child", { agent: "reviewer" });
  installObservationStorageFailureTrigger(data.store.db);
  try {
    const queued = await resolveEvent(data);
    assert.equal((await queued.completed).kind, "completed");
    const row = attemptRow(data, queued.attemptId);
    assert.equal(row.outcome, "succeeded");
    assert.notEqual(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      data.initialSha,
      "a legitimate job still publishes to the local fixture remote",
    );
    const nodes = data.store.db
      .prepare("SELECT COUNT(*) AS n FROM delegation_observation_nodes")
      .get() as { n: number };
    assert.equal(nodes.n, 0, "the failed observation store persisted nothing");
    // The independent safety settlement still recorded its own evidence.
    const safety = data.store.db
      .prepare("SELECT COUNT(*) AS n FROM managed_child_sessions")
      .get() as { n: number };
    assert.equal(safety.n, 1);
  } finally {
    removeObservationStorageFailureTrigger(data.store.db);
    closeObservedFixture(data);
  }
});

test("an unsettled child blocks publication even when every observation write fails", async () => {
  const data = await setupNative({
    observe: true,
    behaviors: [{ sessionId: "ses_parent", exitCode: 0 }],
    retries: 1,
    // Bound the settlement wait so the blocked job fails promptly.
    timeoutSec: 1,
  });
  data.session.addChild("ses_parent", "ses_child", { running: true, agent: "reviewer" });
  data.session.interruptSettles = false;
  installObservationStorageFailureTrigger(data.store.db);
  try {
    const queued = await resolveEvent(data);
    await assert.rejects(() => queued.completed);
    const row = attemptRow(data, queued.attemptId);
    assert.equal(row.failure_stage, "running");
    assert.equal(row.failure_reason, "managed-child-unsettled");
    assert.equal(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      data.initialSha,
      "observer storage errors must not authorize publication",
    );
  } finally {
    removeObservationStorageFailureTrigger(data.store.db);
    closeObservedFixture(data);
  }
});

test("a nonterminal child absent from the active map displays idle yet still blocks publication", async () => {
  const data = await setupNative({
    observe: true,
    behaviors: [{ sessionId: "ses_parent", exitCode: 0 }],
    retries: 1,
    // Bound the settlement wait so the blocked job fails promptly.
    timeoutSec: 1,
  });
  data.session.addChild("ses_parent", "ses_child", { nonterminal: true, agent: "reviewer" });
  data.session.interruptSettles = false;
  try {
    const queued = await resolveEvent(data);
    await assert.rejects(() => queued.completed);
    const row = attemptRow(data, queued.attemptId);
    assert.equal(row.failure_reason, "managed-child-unsettled");
    assert.equal(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      data.initialSha,
      "an unsettled child blocks publication regardless of the display state",
    );

    const bucket = readDelegationObservations(data.store.db, [queued.attemptId]).get(
      queued.attemptId,
    )!;
    const node = bucket.nodes.find((candidate) => candidate.sessionId === "ses_child")!;
    assert.equal(node.lastState, "idle");
    assert.equal(node.lastOutcome, null);
    const report = reportDelegationObservations(bucket, {
      now: Date.parse(node.lastObservedAt!),
    });
    assert.equal(report.running, 0, "the observer displayed no running child");
    assert.ok(report.idle >= 1, "the nonterminal child displayed as idle, not finished");
  } finally {
    closeObservedFixture(data);
  }
});
