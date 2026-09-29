/**
 * Focused integration tests for tasks 3.2-3.5: wiring the managed OpenCode
 * lifecycle into the attempt orchestrator (`src/orchestrator/resolution.ts`).
 *
 * These tests drive the real `ResolutionOrchestrator` with a real git
 * worktree and the real materialize/preflight/settlement modules, replacing
 * only the three external seams that spawn processes: the executor (a fake
 * `opencode`-id executor), the preflight inventory source (read from the
 * materialized files on disk), and the child-session transport (a scripted
 * fake of the pinned `opencode api` surface). The standalone modules' own
 * behavior is covered by their dedicated test files; here the concern is the
 * ordering and fail-closed wiring:
 *
 * - job profile snapshot parsed fail-closed, only when the actual executor is
 *   the `opencode` one;
 * - generated files journaled/materialized after workspace preparation and
 *   before the run, namespaced by attempt id;
 * - preflight under the exact cwd/env, verified before any agent work;
 * - `opencode run` receives the verified primary agent id;
 * - parent/children settled BEFORE cleanup and validation; cleanup only when
 *   quiescence is proven; never validate/publish on unknown;
 * - timeout/cancel/nonzero/throw settle first, then fail with a distinct
 *   reason; the manifest and data dir survive on uncertainty;
 * - managed attempts never relaunch the parent (invocation retries disabled).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { MANAGED_OPENCODE_MANIFEST_FILE } from "../src/agent/managed-files.js";
import type { AgentPermissionRule } from "../src/agent/materialize.js";
import type {
  AgentInventoryReader,
  AgentInventoryRecord,
  AgentInventoryRule,
} from "../src/agent/managed-preflight.js";
import type {
  ManagedHttpResult,
  ManagedSessionHttp,
  OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger, type LogFields } from "../src/log/logger.js";
import { ResolutionOrchestrator } from "../src/orchestrator/resolution.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { AgentExecutor, AgentResult, AgentRunOptions, NormalizedEvent } from "../src/types.js";
import { workspacePathFor } from "../src/workspace/worktree.js";
import { createTempRepo, remoteSha } from "./helpers/gitrepo.js";

/** The merged base header the pinned CLI reports before generated rules. */
const HEADER: readonly AgentInventoryRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
];

/** A valid dashboard profile; instructions carry an unmistakably private marker. */
function profileCandidate(): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description: "Primary review agent",
      permissions: ["edit", "shell"],
      instructions: "PRIVATE-PRIMARY-INSTRUCTIONS",
    },
    subagents: [
      {
        id: "reviewer",
        description: "Reviewer child",
        enabled: true,
        permissions: ["edit"],
        instructions: "PRIVATE-CHILD-INSTRUCTIONS",
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Fake executor with id "opencode" (the snapshot gate)
 * ------------------------------------------------------------------ */

class FakeOpenCodeExecutor implements AgentExecutor {
  readonly id = "opencode";
  readonly usesSharedCredentials = true;
  readonly honorsRetries = false;
  readonly runs: AgentRunOptions[] = [];

  constructor(
    private readonly behavior: {
      sessionId?: string;
      exitCode?: number;
      edits?: Record<string, string>;
      delayMs?: number;
    } = {},
    private readonly events?: string[],
  ) {}

  async checkVersion(): Promise<void> {
    // A fake CLI is always the pinned release.
  }

  additionalEnvironment(): Record<string, string> {
    return {};
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    this.events?.push("run");
    const startedAt = new Date().toISOString();
    const b = this.behavior;
    const failed = b.exitCode !== undefined && b.exitCode !== 0;
    if (!failed) {
      for (const [rel, content] of Object.entries(b.edits ?? {})) {
        const abs = join(opts.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }
    }
    if (b.delayMs !== undefined) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, b.delayMs);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
    const result: AgentResult = {
      stdout: b.sessionId === undefined ? "" : `{"type":"session","sessionID":"${b.sessionId}"}\n`,
      stderr: "",
      exitCode: b.exitCode ?? 0,
      ...(b.sessionId === undefined ? {} : { sessionId: b.sessionId }),
      startedAt,
      endedAt: new Date().toISOString(),
      timedOut: false,
    };
    this.runs.push(opts);
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * Scripted fake of the pinned OpenCode session surface
 * ------------------------------------------------------------------ */

function sessionIdFromPath(path: string): string | undefined {
  const prefix = "/api/session/";
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  return rest.length === 0 ? undefined : rest;
}

class FakeSessionServer implements ManagedSessionHttp {
  readonly calls: Array<{
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
  }> = [];
  private readonly running = new Set<string>();
  private readonly outcomes = new Map<string, OpenCodeSessionOutcome>();
  private readonly settleOnInterrupt: boolean;

  constructor(
    private readonly opts: {
      parentId: string;
      directory: string;
      childIds: readonly string[];
      /** Children that never reach a terminal outcome (stay in the active map). */
      runningChildIds?: readonly string[];
      /** Children whose record contradicts the active map (unknown state). */
      contradictoryChildIds?: readonly string[];
      /** Flip interrupted children to a settled `interrupted` outcome. */
      settleOnInterrupt?: boolean;
      /** Shared ordering log; every transport call is recorded. */
      events: string[];
    },
  ) {
    for (const id of opts.childIds) this.outcomes.set(id, "succeeded");
    for (const id of opts.runningChildIds ?? []) {
      this.outcomes.delete(id);
      this.running.add(id);
    }
    for (const id of opts.contradictoryChildIds ?? []) this.running.add(id);
    this.settleOnInterrupt = opts.settleOnInterrupt ?? false;
  }

  private recordOf(id: string): Record<string, unknown> {
    const record: Record<string, unknown> = {
      id,
      projectID: "proj",
      cost: 0,
      tokens: { input: 0, output: 0 },
      time: { created: 1, updated: 2 },
      location: { directory: this.opts.directory },
      ...(id === this.opts.parentId ? {} : { parentID: this.opts.parentId }),
    };
    const outcome = id === this.opts.parentId ? "succeeded" : this.outcomes.get(id);
    if (outcome !== undefined) record.outcome = outcome;
    return record;
  }

  async get(path: string, query?: Record<string, string>): Promise<ManagedHttpResult> {
    this.calls.push({
      method: "GET",
      path,
      ...(query === undefined ? {} : { query }),
    });
    this.opts.events.push(`settle:${path}`);
    if (path === "/api/session/active") {
      const data: Record<string, unknown> = {};
      for (const id of this.running) data[id] = { type: "running" };
      return { status: 200, body: { data } };
    }
    if (query !== undefined && query.parentID !== undefined) {
      const data = [...this.opts.childIds].map((id) => this.recordOf(id));
      return { status: 200, body: { data, cursor: { previous: null, next: null } } };
    }
    const id = sessionIdFromPath(path);
    if (id === undefined) return { status: 404, body: undefined };
    return { status: 200, body: { data: this.recordOf(id) } };
  }

  async post(path: string): Promise<ManagedHttpResult> {
    this.calls.push({ method: "POST", path });
    this.opts.events.push(`settle:${path}`);
    const id = sessionIdFromPath(path)?.replace(/\/interrupt$/u, "");
    if (id !== undefined && this.settleOnInterrupt && this.running.has(id)) {
      // The probe observed interrupt flipping the child to a terminal outcome
      // and removing it from the active map.
      this.running.delete(id);
      this.outcomes.set(id, "interrupted");
    }
    return { status: 200, body: { interrupted: true } };
  }
}

/* ------------------------------------------------------------------ *
 * Preflight inventory sources
 * ------------------------------------------------------------------ */

/**
 * Reads the effective inventory from the materialized files on disk: exactly
 * what the preflight must prove, derived from the attempt's own serialization.
 */
function inventoryFromWorkspace(events: string[]): AgentInventoryReader {
  return async (input) => {
    events.push("preflight");
    const records: AgentInventoryRecord[] = [];
    const agentsRoot = join(input.cwd, ".opencode", "agents");
    for (const namespace of readdirSync(agentsRoot)) {
      const nsDir = join(agentsRoot, namespace);
      for (const name of readdirSync(nsDir)) {
        if (!name.endsWith(".md")) continue;
        const content = readFileSync(join(nsDir, name), "utf8");
        const close = content.indexOf("\n---\n");
        assert.ok(close !== -1, "generated file must have closing frontmatter");
        const frontmatter = parseYaml(content.slice(0, close + 1)) as Record<string, unknown>;
        const permissions = frontmatter.permissions as unknown as AgentPermissionRule[];
        const rules: AgentInventoryRule[] = permissions.map((rule) => ({
          action: rule.action,
          resource: rule.resource,
          effect: rule.effect,
        }));
        const id = `${namespace}/${name.slice(0, -".md".length)}`;
        const hasModel = frontmatter.model !== undefined;
        const base: AgentInventoryRecord = {
          id,
          mode: frontmatter.mode as string,
          hasModel,
          permissions: [...HEADER, ...rules],
        };
        records.push(hasModel ? { ...base, model: frontmatter.model as string } : base);
      }
    }
    return { records };
  };
}

/** An inventory that never proves the primary agent: fails the preflight. */
const NEVER_PROVES_INVENTORY: AgentInventoryReader = async () => ({ records: [] });

/* ------------------------------------------------------------------ *
 * Orchestrator fixture
 * ------------------------------------------------------------------ */

class CancellingLogger extends Logger {
  cancelAt: string | undefined;
  cancel: ((jobId: number) => void) | undefined;

  override info(event: string, fields: LogFields = {}): void {
    super.info(event, fields);
    if (event === this.cancelAt && typeof fields.jobId === "number") this.cancel?.(fields.jobId);
  }
}

interface ManagedFixtureOptions {
  childIds?: readonly string[];
  runningChildIds?: readonly string[];
  contradictoryChildIds?: readonly string[];
  settleOnInterrupt?: boolean;
  executor?: {
    sessionId?: string;
    exitCode?: number;
    edits?: Record<string, string>;
    delayMs?: number;
  };
  /** Defaults to true; false exercises the no-profile unchanged path. */
  withProfile?: boolean;
  retries?: number;
  timeoutSec?: number;
  cancelAt?: string;
  inventory?: "golden" | "never-proves";
  settlePollIntervalMs?: number;
  settleInterruptGraceMs?: number;
}

async function setupManaged(opts: ManagedFixtureOptions = {}) {
  const gitRepo = await createTempRepo();
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-managed-"));
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
    opts.timeoutSec,
  );
  assert.ok(repository);
  if (opts.withProfile !== false) {
    const saved = saveOpenCodeAgentProfile(store.db, {
      repoId: repository.id,
      expectedRevision: 0,
      candidate: profileCandidate(),
      executorKind: "opencode",
    });
    assert.ok(saved.ok, "profile save must succeed");
  }
  const prNumber = 27;
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
  const events: string[] = [];
  const executor = new FakeOpenCodeExecutor(opts.executor, events);
  const workspace = workspacePathFor(gitRepo.workspaceRoot, prNumber);
  const server =
    opts.childIds !== undefined
      ? new FakeSessionServer({
          parentId: opts.executor?.sessionId ?? "ses_parent",
          directory: workspace,
          childIds: opts.childIds,
          runningChildIds: opts.runningChildIds,
          contradictoryChildIds: opts.contradictoryChildIds,
          settleOnInterrupt: opts.settleOnInterrupt,
          events,
        })
      : undefined;
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
    timeoutSec: opts.timeoutSec ?? 30,
    retries: opts.retries ?? 1,
    github,
    registry: createDefaultCommandRegistry(),
    executors: new Map([["opencode", executor]]),
    logger,
    secrets: ["fixture-secret"],
    concurrency: 2,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    operatorActions,
    managedOpenCode: {
      preflightInventory:
        opts.inventory === "never-proves" ? NEVER_PROVES_INVENTORY : inventoryFromWorkspace(events),
      ...(opts.inventory === "never-proves"
        ? { preflightPollIntervalMs: 5, preflightPollBudgetMs: 30 }
        : {}),
      ...(server === undefined ? {} : { sessionHttp: () => server }),
      ...(opts.settlePollIntervalMs === undefined
        ? {}
        : { settlePollIntervalMs: opts.settlePollIntervalMs }),
      ...(opts.settleInterruptGraceMs === undefined
        ? {}
        : { settleInterruptGraceMs: opts.settleInterruptGraceMs }),
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
    repo: "widgets",
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
    server,
    gitRepo,
    initialSha,
    workspace,
  };
}

type Fixture = Awaited<ReturnType<typeof setupManaged>>;

async function resolveEvent(data: Fixture) {
  const [queued] = await data.orchestrator.handleEvent(data.repository, data.event);
  if (!queued) throw new Error("the event queued no job");
  return queued;
}

function workspaceAttemptDir(workspace: string, attemptId: number): string {
  return join(workspace, ".opencode", "agents", `attempt-${attemptId}`);
}

function manifestPath(attemptDataDir: string): string {
  return join(attemptDataDir, MANAGED_OPENCODE_MANIFEST_FILE);
}

function timelineOf(data: Fixture, jobId: number): string[] {
  const rows = data.store.db
    .prepare("SELECT status FROM status_events WHERE job_id = ? ORDER BY id")
    .all(jobId) as { status: string }[];
  return rows.map((row) => row.status);
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("managed attempt runs ordered lifecycle: preflight, run with primary, settle, cleanup, then validate and publish", async () => {
  const data = await setupManaged({
    executor: { sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } },
    childIds: ["ses_child"],
    settlePollIntervalMs: 5,
  });
  const queued = await resolveEvent(data);
  const completed = await queued.completed;
  assert.equal(completed.kind, "completed");

  // The generated namespace is derived from the attempt id and the run
  // received the verified primary agent id.
  const primaryAgentId = data.executor.runs[0]?.primaryAgentId;
  assert.equal(primaryAgentId, `attempt-${queued.attemptId}/primary`);

  // Ordering: preflight inventory read, then the parent run, then the child
  // settlement transport — never settlement before the run.
  const ordered = data.events
    .filter((event) => event === "preflight" || event === "run" || event.startsWith("settle:"))
    .map((event) => (event === "preflight" ? "preflight" : event === "run" ? "run" : "settle"));
  assert.deepEqual(ordered.slice(0, 2), ["preflight", "run"]);
  assert.ok(ordered.slice(2).includes("settle"));

  // Settlement proved quiescence and cleanup removed the generated files
  // before validation and publication proceeded.
  assert.deepEqual(timelineOf(data, queued.jobId), [
    "queued",
    "preparing",
    "running",
    "validating",
    "publishing",
    "reporting",
    "succeeded",
  ]);
  assert.equal(existsSync(workspaceAttemptDir(data.workspace, queued.attemptId)), false);
  assert.equal(existsSync(join(data.dataDir, "attempts", String(queued.attemptId))), false);
  assert.notEqual(
    await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
    data.initialSha,
  );
  assert.match(data.github.replies[0]!.body, /Resolved in commit/);
  data.store.close();
});

test("an opencode attempt without a profile snapshot is unchanged: no primary id, no preflight, no settlement", async () => {
  const data = await setupManaged({
    withProfile: false,
    executor: { sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } },
  });
  const queued = await resolveEvent(data);
  assert.equal((await queued.completed).kind, "completed");
  assert.equal(data.executor.runs.length, 1);
  assert.equal(data.executor.runs[0]!.primaryAgentId, undefined);
  // No managed wiring touched any seam.
  assert.equal(data.events.filter((event) => event === "preflight").length, 0);
  assert.equal(data.server, undefined);
  assert.equal(existsSync(workspaceAttemptDir(data.workspace, queued.attemptId)), false);
  const attempt = data.store.db
    .prepare("SELECT outcome FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { outcome: string };
  assert.equal(attempt.outcome, "succeeded");
  data.store.close();
});

test("failed preflight never runs the agent, leaves a clean worktree, and records a distinct config reason", async () => {
  const data = await setupManaged({
    inventory: "never-proves",
    executor: { sessionId: "ses_parent" },
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  assert.equal(data.executor.runs.length, 0, "preflight failure must precede any agent work");
  const attempt = data.store.db
    .prepare("SELECT failure_stage, failure_reason FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { failure_stage: string; failure_reason: string };
  assert.equal(attempt.failure_stage, "running");
  assert.equal(attempt.failure_reason, "managed-preflight-failed");
  // Nothing spawned, so no child settlement was attempted.
  assert.equal(data.server, undefined);
  // The generated files were cleaned after the preflight failure, and the
  // attempt data dir was released normally.
  assert.equal(existsSync(workspaceAttemptDir(data.workspace, queued.attemptId)), false);
  assert.equal(existsSync(join(data.dataDir, "attempts", String(queued.attemptId))), false);
  assert.deepEqual(timelineOf(data, queued.jobId), ["queued", "preparing", "running", "failed"]);
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  data.store.close();
});

test("a nonzero managed run settles its children and cleans up before the agent failure is recorded", async () => {
  const data = await setupManaged({
    executor: { sessionId: "ses_parent", exitCode: 1 },
    childIds: ["ses_child"],
    settlePollIntervalMs: 5,
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  assert.ok(data.server!.calls.length > 0, "settlement must run before the failure verdict");
  assert.equal(data.executor.runs.length, 1);
  const attempt = data.store.db
    .prepare("SELECT failure_stage, failure_reason FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { failure_stage: string; failure_reason: string };
  // Settlement proved quiescence, so the recorded reason is the agent's own
  // nonzero exit — retriable — not a quiescence failure.
  assert.equal(attempt.failure_stage, "running");
  assert.equal(attempt.failure_reason, "agent-nonzero-exit");
  // Proven quiescent and cleaned: the generated files and data dir are gone.
  assert.equal(existsSync(workspaceAttemptDir(data.workspace, queued.attemptId)), false);
  assert.equal(existsSync(join(data.dataDir, "attempts", String(queued.attemptId))), false);
  data.store.close();
});

test("a background child that never settles blocks validation and preserves the manifest and data dir", async () => {
  const data = await setupManaged({
    executor: { sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } },
    childIds: ["ses_child"],
    runningChildIds: ["ses_child"],
    timeoutSec: 0.25,
    settlePollIntervalMs: 5,
    settleInterruptGraceMs: 20,
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  const attempt = data.store.db
    .prepare("SELECT failure_stage, failure_reason FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { failure_stage: string; failure_reason: string };
  assert.equal(attempt.failure_stage, "running");
  assert.equal(attempt.failure_reason, "managed-child-unsettled");
  // Never validated or published: the timeline stops at running.
  assert.deepEqual(timelineOf(data, queued.jobId), ["queued", "preparing", "running", "failed"]);
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  assert.equal(data.github.replies.length, 1, "only the failure reply, never a success reply");
  assert.match(data.github.replies[0]!.body, /managed-child-unsettled/);
  // Cleanup was not proven: the generated files and the manifest/data dir
  // survive for recovery.
  const attemptDir = join(data.dataDir, "attempts", String(queued.attemptId));
  assert.equal(
    existsSync(join(workspaceAttemptDir(data.workspace, queued.attemptId), "primary.md")),
    true,
  );
  assert.equal(existsSync(manifestPath(attemptDir)), true);
  data.store.close();
});

test("an unknown child state blocks cleanup and publication and preserves the manifest", async () => {
  const data = await setupManaged({
    executor: { sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } },
    childIds: ["ses_child"],
    contradictoryChildIds: ["ses_child"],
    settlePollIntervalMs: 5,
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  const attempt = data.store.db
    .prepare("SELECT failure_stage, failure_reason FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { failure_stage: string; failure_reason: string };
  assert.equal(attempt.failure_stage, "running");
  assert.equal(attempt.failure_reason, "managed-child-unsettled");
  assert.deepEqual(timelineOf(data, queued.jobId), ["queued", "preparing", "running", "failed"]);
  // An unknown child must never be declared clean: no cleanup, no publish,
  // manifest preserved for recovery.
  const attemptDir = join(data.dataDir, "attempts", String(queued.attemptId));
  assert.equal(
    existsSync(join(workspaceAttemptDir(data.workspace, queued.attemptId), "primary.md")),
    true,
  );
  assert.equal(existsSync(manifestPath(attemptDir)), true);
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  data.store.close();
});

test("a managed attempt is never relaunched: invocation retries are disabled", async () => {
  const data = await setupManaged({
    executor: { sessionId: "ses_parent", exitCode: 1 },
    childIds: ["ses_child"],
    retries: 3,
    settlePollIntervalMs: 5,
  });
  const queued = await resolveEvent(data);
  await assert.rejects(() => queued.completed);
  assert.equal(data.executor.runs.length, 1, "the parent must not launch twice unsettled");
  const attempt = data.store.db
    .prepare("SELECT failure_reason FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { failure_reason: string };
  assert.equal(attempt.failure_reason, "agent-nonzero-exit");
  data.store.close();
});

test("a cancel during a managed run still interrupts children first, then cancels with no publish", async () => {
  const data = await setupManaged({
    executor: { sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } },
    childIds: ["ses_child"],
    runningChildIds: ["ses_child"],
    settleOnInterrupt: true,
    cancelAt: "agent exited",
    settlePollIntervalMs: 5,
  });
  const queued = await resolveEvent(data);
  assert.equal((await queued.completed).kind, "cancelled");
  // The child was interrupted through the pinned route before the cancel
  // could be recorded — settlement always precedes the stop.
  assert.ok(
    data.server!.calls.some((call) => call.method === "POST" && call.path.endsWith("/interrupt")),
    "the child must be interrupted on cancel",
  );
  const attempt = data.store.db
    .prepare("SELECT outcome, failure_reason FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { outcome: string; failure_reason: string | null };
  assert.equal(attempt.outcome, "cancelled");
  assert.equal(attempt.failure_reason, null);
  assert.deepEqual(data.github.replies, []);
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  // Quiescence was proven, so the generated files and the data dir were
  // released normally despite the cancel.
  assert.equal(existsSync(workspaceAttemptDir(data.workspace, queued.attemptId)), false);
  assert.equal(existsSync(join(data.dataDir, "attempts", String(queued.attemptId))), false);
  data.store.close();
});

test("a cancelled run with an unsettled child records failure and retains recovery evidence", async () => {
  const data = await setupManaged({
    executor: { sessionId: "ses_parent", edits: { "resolved.txt": "resolved\n" } },
    childIds: ["ses_child"],
    runningChildIds: ["ses_child"],
    cancelAt: "agent exited",
    settlePollIntervalMs: 5,
    settleInterruptGraceMs: 20,
  });
  const queued = await resolveEvent(data);
  assert.equal((await queued.completed).kind, "cancelled");
  const attempt = data.store.db
    .prepare("SELECT outcome, failure_reason FROM attempts WHERE id = ?")
    .get(queued.attemptId) as { outcome: string; failure_reason: string | null };
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.failure_reason, "managed-child-unsettled");
  assert.equal(
    existsSync(manifestPath(join(data.dataDir, "attempts", String(queued.attemptId)))),
    true,
  );
  assert.equal(await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch), data.initialSha);
  data.store.close();
});
