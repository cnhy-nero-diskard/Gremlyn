/**
 * Focused tests for task 3.6: startup recovery of stale managed OpenCode
 * attempts (`src/orchestrator/attempt-recovery.ts`), the legacy sweep
 * refactor (`cleanupStaleAttemptDirs` in `src/index.ts`), and the orchestrator
 * admission that prevents a quarantined workspace from being reused by a
 * retry (`src/orchestrator/resolution.ts`).
 *
 * Each scenario builds a real git workspace, a real DB attempt row (marked
 * interrupted the way the startup sweep does), and a real journaled manifest
 * with materialized generated files, then scripts the pinned session API to
 * prove or refuse child quiescence:
 *
 * - crash-before-run: materialized but never launched -> no parent id;
 *   quarantine preserves the manifest, files, and evidence.
 * - crash-with-active-child: a child is still running and cannot be settled ->
 *   quarantine with the session ids preserved and the workspace barred.
 * - confirmed-inactive cleanup: parent + children provably quiescent ->
 *   generated files removed, data dir retired, retry becomes possible again.
 * - invalid manifest: journal unreadable -> nothing is deleted or cleaned.
 * - subsequent retry refusal: after a quarantine, an operator retry is refused
 *   at workspace admission and no agent runs or publishes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOpenCodeAgentProfile } from "../src/config/opencode-profile.js";
import {
  MANAGED_OPENCODE_MANIFEST_FILE,
  managedOpencodeManifestPath,
  materializeManagedOpencodeFiles,
} from "../src/agent/managed-files.js";
import { serializeOpenCodeAgents } from "../src/agent/materialize.js";
import type {
  ManagedHttpResult,
  ManagedSessionHttp,
  OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";
import { retainArtifacts } from "../src/artifact-retention.js";
import {
  AttemptRecoveryFatalError,
  attemptDataDirFor,
  quarantineRecordsForWorkspace,
  readAttemptRecoveryRecord,
  recoverStaleManagedAttempts,
} from "../src/orchestrator/attempt-recovery.js";
import { StageFailure } from "../src/orchestrator/failures.js";
import { ResolutionOrchestrator } from "../src/orchestrator/resolution.js";
import { cleanupStaleAttemptDirs } from "../src/index.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger } from "../src/log/logger.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { AgentExecutor, AgentResult, AgentRunOptions, NormalizedEvent } from "../src/types.js";
import { prepareWorkspace, workspacePathFor } from "../src/workspace/worktree.js";
import { git } from "../src/workspace/gitops.js";
import { createTempRepo, pushCommit, remoteSha } from "./helpers/gitrepo.js";

/** The merged base header the pinned CLI reports before generated rules. */
const PROFILE = {
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

const PR_NUMBER = 27;
const REPO_CONFIG = {
  owner: "acme",
  name: "widgets",
  agent: "opencode",
  provider: "opencode",
  model: "opencode/fake-model",
  effort: "xhigh",
  enabled: true,
  validationCommands: [] as string[],
  allowedModels: ["opencode/fake-model"],
};

function sessionIdFromPath(path: string): string | undefined {
  const prefix = "/api/session/";
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  return rest.length === 0 ? undefined : rest;
}

/**
 * Scripted fake of the pinned `opencode api` session surface. Responds to the
 * same routes the runtime settlement uses; an optional `runningChildIds` set
 * keeps a child in the active map and (unless `settleOnInterrupt`) never lets
 * it reach a terminal outcome.
 */
class FakeSessionServer implements ManagedSessionHttp {
  readonly calls: Array<{ method: "GET" | "POST"; path: string }> = [];
  private readonly running = new Set<string>();
  private readonly outcomes = new Map<string, OpenCodeSessionOutcome>();

  constructor(
    private readonly opts: {
      parentId: string;
      directory: string;
      childIds: readonly string[];
      runningChildIds?: readonly string[];
      settleOnInterrupt?: boolean;
    },
  ) {
    for (const id of opts.childIds) this.outcomes.set(id, "succeeded");
    for (const id of opts.runningChildIds ?? []) {
      this.outcomes.delete(id);
      this.running.add(id);
    }
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
    this.calls.push({ method: "GET", path });
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
    const id = sessionIdFromPath(path)?.replace(/\/interrupt$/u, "");
    if (id !== undefined && this.opts.settleOnInterrupt && this.running.has(id)) {
      this.running.delete(id);
      this.outcomes.set(id, "interrupted");
    }
    return { status: 200, body: { interrupted: true } };
  }
}

/** A deterministic clock+sleeper so settlement bounds don't depend on wall time. */
function fakeClock(startMs = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = startMs;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fixture: real workspace, real DB rows, real journaled manifest
 * ------------------------------------------------------------------ */

interface RecoveryFixture {
  dataDir: string;
  store: Store;
  workspace: string;
  attemptId: number;
  jobId: number;
  initialSha: string;
  gitRepo: Awaited<ReturnType<typeof createTempRepo>>;
  actions: OperatorActionStore;
  interrupted: number[];
  repository: Awaited<ReturnType<typeof syncRepositories>>[number];
}

async function setupRecovery(options: {
  agentSessionId?: string;
  materialize: boolean;
  /** Commit a `.gitignore` (ignoring `.opencode/`) so generated files are git-invisible. */
  gitignore?: boolean;
}): Promise<RecoveryFixture> {
  const gitRepo = await createTempRepo();
  let initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  if (options.gitignore === true) {
    await pushCommit(
      gitRepo.sourcePath,
      gitRepo.headBranch,
      ".gitignore",
      ".opencode/\n",
      "ignore generated agent files",
    );
    initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  }
  const workspace = workspacePathFor(gitRepo.workspaceRoot, PR_NUMBER);
  await prepareWorkspace({
    sourcePath: gitRepo.sourcePath,
    workspaceRoot: gitRepo.workspaceRoot,
    prNumber: PR_NUMBER,
    headBranch: gitRepo.headBranch,
    headSha: initialSha,
  });
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-recovery-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const [repository] = syncRepositories(
    store.db,
    [{ ...REPO_CONFIG, sourcePath: gitRepo.sourcePath, workspaceRoot: gitRepo.workspaceRoot }],
    30,
  );
  assert.ok(repository);
  const jobs = new JobStore(store.db);
  const claimed = jobs.createJob({
    repoId: repository.id,
    executorKind: "opencode",
    prNumber: PR_NUMBER,
    commentId: 501,
    command: "resolve",
    threadId: "501",
    authorLogin: "developer",
    observedAt: "2026-08-27T00:01:00.000Z",
  });
  if (claimed.kind !== "created") throw new Error("job already claimed");
  const created = jobs.createAttempt({
    jobId: claimed.jobId,
    agent: "opencode",
    model: "opencode/fake-model",
    provider: "opencode",
    effort: "xhigh",
  });
  jobs.setStatus(claimed.jobId, "preparing", created.attemptId);
  jobs.setStatus(claimed.jobId, "running", created.attemptId);
  jobs.recordPreparation(created.attemptId, workspace, initialSha);
  if (options.agentSessionId !== undefined) {
    store.db
      .prepare("UPDATE attempts SET agent_session_id = ? WHERE id = ?")
      .run(options.agentSessionId, created.attemptId);
  }
  const interrupted = jobs.interruptIncompleteJobs();
  const actions = new OperatorActionStore(store.db);
  if (options.materialize) {
    const profile = parseOpenCodeAgentProfile(PROFILE);
    const serialized = serializeOpenCodeAgents({
      profile,
      namespace: `attempt-${created.attemptId}`,
    });
    await materializeManagedOpencodeFiles({
      workspacePath: workspace,
      manifestPath: managedOpencodeManifestPath(attemptDataDirFor(dataDir, created.attemptId)),
      serialized,
    });
  }
  return {
    dataDir,
    store,
    workspace,
    attemptId: created.attemptId,
    jobId: claimed.jobId,
    initialSha,
    gitRepo,
    actions,
    interrupted,
    repository,
  };
}

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function generatedPrimaryPath(fixture: RecoveryFixture): string {
  return join(
    fixture.workspace,
    ".opencode",
    "agents",
    `attempt-${fixture.attemptId}`,
    "primary.md",
  );
}

async function runRecovery(
  fixture: RecoveryFixture,
  server?: FakeSessionServer,
  clock = fakeClock(),
) {
  return recoverStaleManagedAttempts({
    dataDir: fixture.dataDir,
    db: fixture.store.db,
    actions: fixture.actions,
    logger: quietLogger,
    resolveWorker: () => ({ cwd: fixture.workspace, env: {} }),
    ...(server === undefined ? {} : { sessionHttp: () => server }),
    settleTimeoutMs: 60,
    settlePollIntervalMs: 5,
    settleInterruptGraceMs: 20,
    now: clock.now,
    sleep: clock.sleep,
  });
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("crash-before-run: no parent session id quarantines the attempt and preserves the manifest and files", async () => {
  const fixture = await setupRecovery({ materialize: true });
  try {
    const report = await runRecovery(fixture);
    assert.equal(report.candidates, 1);
    assert.equal(report.recovered.length, 0);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0]!.reason, "missing-parent-id");

    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    const record = readAttemptRecoveryRecord(attemptDir);
    assert.ok(record, "durable quarantine record must be journaled");
    assert.equal(record.status, "quarantined");
    assert.equal(record.reason, "missing-parent-id");
    assert.equal(record.workspacePath, fixture.workspace);

    // The manifest, the generated files, and the data dir all survive.
    assert.equal(existsSync(managedOpencodeManifestPath(attemptDir)), true);
    assert.equal(existsSync(generatedPrimaryPath(fixture)), true);
    assert.equal(existsSync(attemptDir), true);
    // The operator action audit records the quarantine by reason, without
    // printing instruction text.
    const rows = fixture.store.db
      .prepare("SELECT effect, detail FROM operator_actions WHERE action = 'attempt-recovery'")
      .all() as { effect: string; detail: string }[];
    assert.equal(rows[0]?.effect, "quarantined");
    assert.equal(JSON.parse(rows[0]!.detail).reason, "missing-parent-id");
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("crash-with-active-child: an unsettled child quarantines and preserves the session ids and workspace", async () => {
  const fixture = await setupRecovery({ materialize: true, agentSessionId: "ses_parent" });
  try {
    const server = new FakeSessionServer({
      parentId: "ses_parent",
      directory: fixture.workspace,
      childIds: ["ses_child"],
      runningChildIds: ["ses_child"],
      settleOnInterrupt: false,
    });
    const report = await runRecovery(fixture, server);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0]!.reason, "child-state-unknown");

    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    const record = readAttemptRecoveryRecord(attemptDir);
    assert.ok(record);
    assert.equal(record.status, "quarantined");
    assert.equal(record.reason, "child-state-unknown");
    assert.ok(record.sessionIds.includes("ses_parent"));
    assert.ok(record.sessionIds.includes("ses_child"), "the unresolved child id must be recorded");
    // The child was interrupted through the pinned route before the quarantine.
    assert.ok(
      server.calls.some((call) => call.method === "POST" && call.path.endsWith("/interrupt")),
      "the unresolved child must be interrupted before the attempt is quarantined",
    );
    assert.equal(existsSync(generatedPrimaryPath(fixture)), true);
    assert.equal(existsSync(attemptDir), true);
    assert.equal(existsSync(managedOpencodeManifestPath(attemptDir)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("confirmed-inactive cleanup: quiescent parent and children recover the workspace and retire the data dir", async () => {
  const fixture = await setupRecovery({ materialize: true, agentSessionId: "ses_parent" });
  try {
    const server = new FakeSessionServer({
      parentId: "ses_parent",
      directory: fixture.workspace,
      childIds: ["ses_child"],
    });
    const report = await runRecovery(fixture, server);
    assert.equal(report.recovered.length, 1);
    assert.equal(report.recovered[0]!.reason, "recovered-quiescent");
    assert.equal(report.quarantined.length, 0);

    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    // The data dir (manifest, record, seeded state) is retired; the workspace
    // no longer contains any generated agent file.
    assert.equal(existsSync(attemptDir), false);
    assert.equal(existsSync(generatedPrimaryPath(fixture)), false);
    assert.equal(existsSync(join(fixture.workspace, ".opencode", "agents")), false);
    // The recovery is audited.
    const rows = fixture.store.db
      .prepare("SELECT effect, detail FROM operator_actions WHERE action = 'attempt-recovery'")
      .all() as { effect: string; detail: string }[];
    assert.equal(rows[0]?.effect, "recovered");
    assert.equal(JSON.parse(rows[0]!.detail).reason, "recovered-quiescent");
    // Nothing was published and the remote head is untouched.
    assert.equal(
      await remoteSha(fixture.gitRepo.remotePath, fixture.gitRepo.headBranch),
      fixture.initialSha,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("invalid manifest: an unreadable journal quarantines without deleting or cleaning anything", async () => {
  const fixture = await setupRecovery({ materialize: true, agentSessionId: "ses_parent" });
  try {
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    const manifestPath = managedOpencodeManifestPath(attemptDir);
    writeFileSync(manifestPath, "{\n  not valid json\n", "utf8");

    const report = await runRecovery(fixture);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0]!.reason, "manifest-corrupt");
    const record = readAttemptRecoveryRecord(attemptDir);
    assert.ok(record);
    assert.equal(record.reason, "manifest-corrupt");
    // The journal is unreadable, but the attempt row still records the
    // workspace: the quarantine must fall back to that trustworthy path so the
    // contaminated workspace stays attributed and gated.
    assert.equal(record.workspacePath, fixture.workspace);
    assert.deepEqual(
      quarantineRecordsForWorkspace(fixture.dataDir, fixture.workspace).map(
        (entry) => entry.status,
      ),
      ["quarantined"],
    );
    // Nothing was modified: the corrupt journal and the generated files remain.
    assert.equal(existsSync(attemptDir), true);
    assert.equal(existsSync(manifestPath), true);
    assert.equal(existsSync(generatedPrimaryPath(fixture)), true);

    // The legacy startup sweep must also leave this dir alone.
    cleanupStaleAttemptDirs(fixture.dataDir, fixture.store.db, fixture.interrupted);
    assert.equal(
      existsSync(attemptDir),
      true,
      "the managed dir must be skipped by the legacy sweep",
    );
    assert.equal(existsSync(manifestPath), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("an unreadable journal with no DB workspace path fails startup globally", async () => {
  // A managed attempt dir whose journal cannot be read AND whose attempt row is
  // absent (so no `workspace_path` exists to attribute it) is an unaccountable
  // contamination: the process refuses to start rather than risk reusing it.
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-recovery-fatal-"));
  try {
    const store = new Store({ dataDir, file: ":memory:" });
    const attemptDir = attemptDataDirFor(dataDir, 999);
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(attemptDir, MANAGED_OPENCODE_MANIFEST_FILE), "{ not valid json\n", "utf8");
    await assert.rejects(
      recoverStaleManagedAttempts({
        dataDir,
        db: store.db,
        resolveWorker: () => ({ cwd: "C:\\unused", env: {} }),
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof AttemptRecoveryFatalError,
          `expected AttemptRecoveryFatalError, got ${String(error)}`,
        );
        return true;
      },
    );
    // Nothing was deleted or cleaned on the fatal path.
    assert.equal(existsSync(attemptDir), true);
    assert.equal(existsSync(join(attemptDir, MANAGED_OPENCODE_MANIFEST_FILE)), true);
    store.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failed recovery-record write fails startup instead of silently losing the quarantine gate", async () => {
  const fixture = await setupRecovery({ materialize: true });
  try {
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    // Occupy the record target with a directory so the atomic rename cannot
    // install the journal. Without a durable record the workspace would be
    // silently reusable, so the process must refuse to start.
    mkdirSync(join(attemptDir, "recovery.json"), { recursive: true });
    await assert.rejects(
      () => runRecovery(fixture),
      (error: unknown) => {
        assert.ok(
          error instanceof AttemptRecoveryFatalError,
          `expected AttemptRecoveryFatalError, got ${String(error)}`,
        );
        return true;
      },
    );
    // Nothing was cleaned or deleted while the gate could not be journaled.
    assert.equal(existsSync(attemptDir), true);
    assert.equal(existsSync(generatedPrimaryPath(fixture)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("legacy sweep preserves a dir that carries only a recovery record", async () => {
  const fixture = await setupRecovery({ materialize: true });
  try {
    await runRecovery(fixture); // journals recovery.json
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    assert.ok(existsSync(join(attemptDir, "recovery.json")), "the record must exist");
    // Simulate a lost/renamed journal: the record alone must still preserve
    // the dir from the legacy sweep.
    rmSync(join(attemptDir, MANAGED_OPENCODE_MANIFEST_FILE), { force: true });
    cleanupStaleAttemptDirs(fixture.dataDir, fixture.store.db, fixture.interrupted);
    assert.equal(existsSync(attemptDir), true, "a recovery record alone must preserve the dir");
    assert.equal(existsSync(join(attemptDir, "recovery.json")), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("artifact retention preserves a managed attempt dir before recovery has written a record", async () => {
  // The manifest-only dir (recovery has not run yet) holds the only record of
  // what the attempt owned; age/size trimming must never remove it.
  const fixture = await setupRecovery({ materialize: true });
  try {
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    assert.ok(existsSync(attemptDir));
    assert.equal(existsSync(join(attemptDir, "recovery.json")), false, "no record yet");
    const report = await retainArtifacts({
      dataDir: fixture.dataDir,
      db: fixture.store.db,
      maximumAgeMs: 0,
      maximumTotalBytes: 1,
      now: Date.now() + 3_600_000, // everything terminal is far past the cutoff
      actions: fixture.actions,
    });
    assert.equal(
      report.decisions.some(
        (decision) =>
          decision.kind === "attempt-state" && resolve(decision.path) === resolve(attemptDir),
      ),
      false,
      "the managed attempt dir must not be a retention candidate",
    );
    assert.equal(existsSync(attemptDir), true, "the managed attempt dir must survive retention");
    assert.equal(existsSync(generatedPrimaryPath(fixture)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("legacy sweep still deletes an interrupted Cline attempt dir (backward compatibility)", async () => {
  // A non-managed attempt: same lifecycle, but no manifest was ever journaled.
  const fixture = await setupRecovery({ materialize: false });
  try {
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    // The runtime created this dir and seeded credentials in it; re-create both
    // so the hook has something to rescue.
    mkdirSync(attemptDir, { recursive: true });
    const seeded = join(attemptDir, "secrets.json");
    // The runtime would seed credentials and possibly rotate them before a
    // crash; the startup sweep must still rescue rotated credentials via the
    // hook before removing the dir.
    writeFileSync(seeded, '{"apiKey":"rotated-token"}\n', "utf8");

    const removed: string[] = [];
    cleanupStaleAttemptDirs(fixture.dataDir, fixture.store.db, fixture.interrupted, {
      onRemoveAttempt: ({ attemptId, attemptDataDir: dir }) => {
        removed.push(`attempt-${attemptId}`);
        readFileSync(join(dir, "secrets.json"), "utf8"); // hook sees the dir before removal
      },
    });
    // The Cline attempt dir is deleted exactly as before the refactor.
    assert.deepEqual(removed, [`attempt-${fixture.attemptId}`]);
    assert.equal(existsSync(attemptDir), false);
    // The workspace had no generated files, so nothing is quarantined.
    assert.equal(existsSync(join(fixture.workspace, ".opencode")), false);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Workspace admission (orchestrator gates)
 * ------------------------------------------------------------------ */

class RecordingOpenCodeExecutor implements AgentExecutor {
  readonly id = "opencode";
  readonly usesSharedCredentials = true;
  readonly honorsRetries = false;
  readonly runs: AgentRunOptions[] = [];

  async checkVersion(): Promise<void> {}

  additionalEnvironment(): Record<string, string> {
    return {};
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    this.runs.push(opts);
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      timedOut: false,
    };
  }
}

/** One `!RESOLVE` review-comment event for the fixture repository. */
function newJobEvent(): NormalizedEvent {
  return {
    owner: "acme",
    repo: "widgets",
    kind: "review-comment",
    commentId: 501,
    authorLogin: "developer",
    body: "!RESOLVE\nmake the tests pass",
    prNumber: PR_NUMBER,
    observedAt: "2026-08-27T00:01:00.000Z",
  };
}

function buildOrchestrator(
  fixture: RecoveryFixture,
  headSha: string,
): { orchestrator: ResolutionOrchestrator; executor: RecordingOpenCodeExecutor } {
  const executor = new RecordingOpenCodeExecutor();
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: PR_NUMBER,
        title: "Handle $() safely",
        state: "open",
        merged: false,
        headBranch: fixture.gitRepo.headBranch,
        headSha,
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRepoOwner: "acme",
        baseRepoName: "widgets",
        htmlUrl: "https://example.test/acme/widgets/pull/27",
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
        prNumber: PR_NUMBER,
      },
    ],
  });
  const logger = new Logger({
    level: "error",
    secrets: ["fixture-secret"],
    db: fixture.store.db,
  });
  const orchestrator = new ResolutionOrchestrator({
    db: fixture.store.db,
    dataDir: fixture.dataDir,
    allowedAuthors: ["developer"],
    orchestratorLogin: "gremlyn-bot",
    timeoutSec: 30,
    retries: 1,
    github,
    registry: createDefaultCommandRegistry(),
    executors: new Map([["opencode", executor]]),
    logger,
    secrets: ["fixture-secret"],
    concurrency: 2,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    operatorActions: fixture.actions,
  });
  orchestrator.registerRepository(fixture.repository);
  return { orchestrator, executor };
}

test("subsequent retry refusal: a quarantined workspace is never resumed or run", async () => {
  const fixture = await setupRecovery({ materialize: true });
  try {
    // Startup recovery quarantines the crash-before-run attempt (no parent id).
    await runRecovery(fixture);
    assert.equal(
      readAttemptRecoveryRecord(attemptDataDirFor(fixture.dataDir, fixture.attemptId))?.status,
      "quarantined",
    );

    const { orchestrator, executor } = buildOrchestrator(fixture, fixture.initialSha);
    const queued = await orchestrator.retry(fixture.jobId);
    // The retry is admitted to the queue but refused at workspace admission:
    // the workspace is dirty with a prior attempt's generated files and that
    // attempt is quarantined, so it must never resume them.
    await assert.rejects(
      () => queued.completed,
      (error: unknown) => {
        assert.ok(error instanceof StageFailure, `expected StageFailure, got ${String(error)}`);
        assert.equal(error.reason, "workspace-quarantined");
        assert.equal(error.stage, "preparing");
        return true;
      },
    );
    assert.equal(executor.runs.length, 0, "no agent may run over a quarantined workspace");
    assert.equal(
      await remoteSha(fixture.gitRepo.remotePath, fixture.gitRepo.headBranch),
      fixture.initialSha,
      "nothing may be published from a quarantined attempt",
    );
    const attempt = fixture.store.db
      .prepare("SELECT failure_stage, failure_reason FROM attempts WHERE attempt_number = ?")
      .get(2) as { failure_stage: string; failure_reason: string };
    assert.equal(attempt.failure_stage, "preparing");
    assert.equal(attempt.failure_reason, "workspace-quarantined");
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("new job on an ignored generated path is refused at admission, never reusing the workspace", async () => {
  // `.opencode/` is gitignored, so the materialized old-profile files are
  // invisible to git and a fresh job would otherwise treat the workspace as
  // clean and reuse it — possibly discovering or publishing the stale profile.
  const fixture = await setupRecovery({ materialize: true, gitignore: true });
  try {
    const { stdout } = await git(["status", "--porcelain=v1", "-uall"], {
      cwd: fixture.workspace,
    });
    assert.equal(
      stdout.trim(),
      "",
      "the workspace is git-clean despite the ignored generated files",
    );

    // Startup recovery quarantines the crash-before-run attempt and names the
    // workspace in the durable record.
    await runRecovery(fixture);
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    assert.equal(readAttemptRecoveryRecord(attemptDir)?.status, "quarantined");
    assert.ok(
      quarantineRecordsForWorkspace(fixture.dataDir, fixture.workspace).length === 1,
      "the durable record must attribute the contaminated workspace",
    );

    // A brand-new job (a fresh comment, not a retry) is refused before
    // preparation: no agent runs, nothing is published.
    const { orchestrator, executor } = buildOrchestrator(fixture, fixture.initialSha);
    const [queued] = await orchestrator.handleEvent(fixture.repository, newJobEvent());
    assert.ok(queued, "the fresh job must be queued before the admission gate refuses it");
    await assert.rejects(
      () => queued!.completed,
      (error: unknown) => {
        assert.ok(error instanceof StageFailure, `expected StageFailure, got ${String(error)}`);
        assert.equal(error.reason, "workspace-quarantined");
        assert.equal(error.stage, "preparing");
        return true;
      },
    );
    assert.equal(executor.runs.length, 0, "no agent may run over a quarantined workspace");
    assert.equal(
      await remoteSha(fixture.gitRepo.remotePath, fixture.gitRepo.headBranch),
      fixture.initialSha,
      "nothing may be published from a quarantined attempt",
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});
