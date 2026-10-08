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
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseOpenCodeAgentProfile } from "../src/config/opencode-profile.js";
import {
  MANAGED_OPENCODE_MANIFEST_FILE,
  managedOpencodeManifestPath,
  materializeManagedOpencodeFiles,
} from "../src/agent/managed-files.js";
import { serializeOpenCodeAgents } from "../src/agent/materialize.js";
import {
  beginOpenCodeInvocation,
  opencodeOwnershipPath,
  recordOpenCodeInvocation,
  settleOpenCodeInvocation,
  type OpenCodeOwnershipDescriptor,
} from "../src/agent/opencode-ownership.js";
import type {
  ManagedHttpResult,
  ManagedSessionHttp,
  OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";
import { retainArtifacts } from "../src/artifact-retention.js";
import {
  AttemptRecoveryFatalError,
  attemptDataDirFor,
  attemptRecoveryRecordPath,
  isAttemptQuarantined,
  quarantineRecordsForWorkspace,
  readAttemptRecoveryRecord,
  recoverStaleManagedAttempts,
  shouldDeferAttemptToRecovery,
  workspaceHasUnresolvedAttemptOwnership,
  type RecoverStaleManagedAttemptsInput,
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
      const data = [...this.opts.childIds]
        .map((id) => this.recordOf(id))
        .filter((record) => record.parentID === query.parentID);
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
  server?: ManagedSessionHttp,
  clock = fakeClock(),
  overrides: Partial<RecoverStaleManagedAttemptsInput> = {},
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
    ...overrides,
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
    // Mark the attempt as a genuine Cline run so the sweep's OpenCode-aware
    // classifier (once wired by the parent) does not defer it to recovery.
    fixture.store.db
      .prepare("UPDATE attempts SET agent = 'cline' WHERE id = ?")
      .run(fixture.attemptId);
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

/* ------------------------------------------------------------------ *
 * Generic (native/default) ownership recovery — task 3.3 / 4.4 / 4.5
 * ------------------------------------------------------------------ */

const OWNERSHIP_NOW = "2026-10-01T00:00:00.000Z";

function ownershipDescriptor(
  fixture: RecoveryFixture,
  patch: Partial<OpenCodeOwnershipDescriptor> = {},
): OpenCodeOwnershipDescriptor {
  return {
    executor: "opencode",
    binary: "opencode",
    version: "2.0.16",
    workspacePath: fixture.workspace,
    source: "native",
    nativeId: "build",
    ...patch,
  };
}

/**
 * Journal generic OpenCode ownership for the fixture attempt. Each entry is a
 * new invocation: omit `parentSessionId` to leave the pre-launch uncertainty,
 * pass `null` for a launched-but-unattributed invocation, or a session id to
 * record the early parent identity. `settled` marks the tree already proven.
 */
function writeOwnership(
  fixture: RecoveryFixture,
  invocations: ReadonlyArray<{
    parentSessionId?: string | null;
    settled?: boolean;
    descriptor?: Partial<OpenCodeOwnershipDescriptor>;
  }>,
): string {
  const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
  for (const invocation of invocations) {
    const journal = beginOpenCodeInvocation({
      attemptDataDir: attemptDir,
      attemptId: fixture.attemptId,
      descriptor: ownershipDescriptor(fixture, invocation.descriptor),
      now: OWNERSHIP_NOW,
    });
    const ordinal = journal.invocations.at(-1)!.ordinal;
    if (invocation.parentSessionId !== undefined) {
      recordOpenCodeInvocation({
        attemptDataDir: attemptDir,
        attemptId: fixture.attemptId,
        ordinal,
        parentSessionId: invocation.parentSessionId,
        observedPrimaryId: "build",
        now: OWNERSHIP_NOW,
      });
    }
    if (invocation.settled === true) {
      settleOpenCodeInvocation({
        attemptDataDir: attemptDir,
        attemptId: fixture.attemptId,
        ordinal,
        now: OWNERSHIP_NOW,
      });
    }
  }
  return attemptDir;
}

/**
 * A pinned-session fake supporting SEVERAL parent trees, so a multi-invocation
 * attempt can be settled as a whole. Every named parent is a root (no
 * parentID, terminal outcome); every child echoes its parent and is terminal
 * unless listed in `runningChildIds`.
 */
class MultiSessionServer implements ManagedSessionHttp {
  readonly calls: Array<{ method: "GET" | "POST"; path: string }> = [];
  private readonly parentIds = new Set<string>();
  private readonly childParent = new Map<string, string>();
  private readonly running = new Set<string>();

  constructor(
    private readonly directory: string,
    parents: ReadonlyArray<{
      id: string;
      childIds?: readonly string[];
      runningChildIds?: readonly string[];
    }>,
  ) {
    for (const parent of parents) {
      this.parentIds.add(parent.id);
      for (const child of parent.childIds ?? []) this.childParent.set(child, parent.id);
      for (const child of parent.runningChildIds ?? []) this.running.add(child);
    }
  }

  private recordOf(id: string): Record<string, unknown> {
    const record: Record<string, unknown> = { id, location: { directory: this.directory } };
    if (!this.parentIds.has(id)) {
      const parent = this.childParent.get(id);
      if (parent !== undefined) record.parentID = parent;
    }
    if (!this.running.has(id)) record.outcome = "succeeded";
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
      const ids = [...this.childParent.entries()]
        .filter(([, parent]) => parent === query.parentID)
        .map(([child]) => child);
      return {
        status: 200,
        body: { data: ids.map((id) => this.recordOf(id)), cursor: { previous: null, next: null } },
      };
    }
    const id = sessionIdFromPath(path);
    if (id === undefined) return { status: 404, body: undefined };
    return { status: 200, body: { data: this.recordOf(id) } };
  }

  async post(path: string): Promise<ManagedHttpResult> {
    this.calls.push({ method: "POST", path });
    return { status: 200, body: { interrupted: true } };
  }
}

test("generic ownership: a native pre-launch uncertainty quarantines with a durable record", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    writeOwnership(fixture, [{}]);
    const report = await runRecovery(fixture);
    assert.equal(report.candidates, 1);
    assert.equal(report.recovered.length, 0);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0]!.reason, "launched-uncertain");

    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    const record = readAttemptRecoveryRecord(attemptDir);
    assert.equal(record?.status, "quarantined");
    assert.equal(record?.workspacePath, fixture.workspace);
    assert.equal(existsSync(attemptDir), true, "the journal and dir must be preserved");
    assert.equal(
      workspaceHasUnresolvedAttemptOwnership(fixture.dataDir, fixture.workspace),
      true,
      "an unresolved ownership journal blocks workspace admission even without a prior record",
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: a launched native invocation without a parent id quarantines", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    writeOwnership(fixture, [{ parentSessionId: null }]);
    const report = await runRecovery(fixture);
    assert.equal(report.quarantined[0]?.reason, "missing-parent-id");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: a still-running native child quarantines the whole attempt and preserves every parent id", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    // Both invocations were journaled; even the one marked settled must be
    // re-proven fresh. The second has an unsettled child, so the attempt must
    // not be recovered just because the first tree's marker says done.
    writeOwnership(fixture, [
      { parentSessionId: "ses_first", settled: true },
      { parentSessionId: "ses_second" },
    ]);
    const server = new MultiSessionServer(fixture.workspace, [
      { id: "ses_first" },
      {
        id: "ses_second",
        childIds: ["ses_child"],
        runningChildIds: ["ses_child"],
      },
    ]);
    const report = await runRecovery(fixture, server);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0]!.reason, "child-state-unknown");

    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    const record = readAttemptRecoveryRecord(attemptDir);
    assert.ok(record);
    assert.ok(record.sessionIds.includes("ses_first"), "the first invocation's parent is retained");
    assert.ok(record.sessionIds.includes("ses_second"));
    assert.ok(record.sessionIds.includes("ses_child"));
    assert.ok(
      server.calls.some((call) => call.method === "POST" && call.path.endsWith("/interrupt")),
      "the unresolved child must be interrupted before quarantine",
    );
    // The re-proved first invocation was actually queried, not trusted.
    assert.ok(
      server.calls.some((call) => call.method === "GET" && call.path.includes("ses_first")),
      "a settled marker must still be re-read through the session API",
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: all invocation trees quiescent recover and never touch native config", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    // A developer's native agent definition lives in the workspace. Native
    // recovery must never remove it — only manifest-owned generated files are
    // ever cleaned.
    const nativeDir = join(fixture.workspace, ".opencode", "agents");
    mkdirSync(nativeDir, { recursive: true });
    const nativeFile = join(nativeDir, "native.md");
    writeFileSync(nativeFile, "# native operator agent\n", "utf8");

    writeOwnership(fixture, [
      { parentSessionId: "ses_one", settled: true },
      { parentSessionId: "ses_two" },
    ]);
    // Both invocations are re-proven (the settled marker is not trusted), so
    // both roots must be scripted.
    const server = new MultiSessionServer(fixture.workspace, [
      { id: "ses_one" },
      { id: "ses_two" },
    ]);
    const report = await runRecovery(fixture, server);

    assert.equal(report.recovered.length, 1);
    assert.equal(report.recovered[0]!.reason, "recovered-quiescent");
    assert.equal(report.quarantined.length, 0);
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), false);
    assert.equal(existsSync(nativeFile), true, "native configuration must survive recovery");
    assert.equal(readFileSync(nativeFile, "utf8"), "# native operator agent\n");
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: an unavailable worker context quarantines instead of deleting", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    writeOwnership(fixture, [{ parentSessionId: "ses_native" }]);
    const report = await runRecovery(fixture, undefined, fakeClock(), {
      resolveWorker: () => undefined,
    });
    assert.equal(report.quarantined[0]?.reason, "worker-unavailable");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: a mismatched binary context quarantines rather than retargeting recovery", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    writeOwnership(fixture, [
      { parentSessionId: "ses_native", descriptor: { binary: "opencode-native" } },
    ]);
    const report = await runRecovery(fixture, undefined, fakeClock(), {
      resolveWorker: () => ({ cwd: fixture.workspace, env: {}, binary: "opencode" }),
    });
    assert.equal(report.quarantined[0]?.reason, "worker-mismatch");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: a stale settled marker is not trusted when the tree is now active", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    // The journal says the invocation settled, but the pinned API now shows a
    // still-running descendant. A crashed attempt can retain a journal after an
    // earlier settlement, so startup reuse must fail closed.
    writeOwnership(fixture, [{ parentSessionId: "ses_stale", settled: true }]);
    const server = new MultiSessionServer(fixture.workspace, [
      { id: "ses_stale", childIds: ["ses_late"], runningChildIds: ["ses_late"] },
    ]);
    const report = await runRecovery(fixture, server);
    assert.equal(report.recovered.length, 0);
    assert.equal(report.quarantined[0]?.reason, "child-state-unknown");
    const record = readAttemptRecoveryRecord(attemptDataDirFor(fixture.dataDir, fixture.attemptId));
    assert.ok(record?.sessionIds.includes("ses_late"));
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: no worker availability quarantines even when every marker is settled", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    writeOwnership(fixture, [
      { parentSessionId: "ses_a", settled: true },
      { parentSessionId: "ses_b", settled: true },
    ]);
    const report = await runRecovery(fixture, undefined, fakeClock(), {
      resolveWorker: () => undefined,
    });
    assert.equal(report.recovered.length, 0);
    assert.equal(report.quarantined[0]?.reason, "worker-unavailable");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("workspace ownership: an unresolved journal blocks only its own workspace, and unaccountable markers block conservatively", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-ownership-scope-"));
  try {
    const workspaceA = join(dataDir, "workspaces", "repo-a", "pr-1");
    const workspaceB = join(dataDir, "workspaces", "repo-b", "pr-1");
    // Alias A journals an unresolved native invocation owning workspace A.
    beginOpenCodeInvocation({
      attemptDataDir: attemptDataDirFor(dataDir, 1),
      attemptId: 1,
      descriptor: {
        executor: "opencode-a",
        binary: "opencode-a",
        version: "2.0.16",
        workspacePath: workspaceA,
        source: "native",
        nativeId: "build",
      },
    });
    assert.equal(workspaceHasUnresolvedAttemptOwnership(dataDir, workspaceA), true);
    assert.equal(
      workspaceHasUnresolvedAttemptOwnership(dataDir, workspaceB),
      false,
      "an unresolved attempt in repository A must not block repository B",
    );

    // A present-but-malformed manifest with no readable workspace is
    // unaccountable and must fail closed.
    const unaccountableDir = attemptDataDirFor(dataDir, 2);
    mkdirSync(unaccountableDir, { recursive: true });
    writeFileSync(managedOpencodeManifestPath(unaccountableDir), "{ not valid json\n", "utf8");
    assert.equal(
      workspaceHasUnresolvedAttemptOwnership(dataDir, workspaceB),
      true,
      "a malformed manifest must not be silently treated as absent",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("workspace ownership conservatively blocks on a malformed recovery record", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-recovery-record-scope-"));
  const workspace = join(dataDir, "workspaces", "repo", "pr-1");
  try {
    const attemptDir = attemptDataDirFor(dataDir, 1);
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(attemptRecoveryRecordPath(attemptDir), "{ not valid json\n", "utf8");
    assert.equal(
      workspaceHasUnresolvedAttemptOwnership(dataDir, workspace),
      true,
      "an unreadable recovery record cannot silently admit an unrelated workspace",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("recovery never reports quiescent success when the ownership data dir remains", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    writeOwnership(fixture, [{ parentSessionId: "ses_retire" }]);
    const server = new MultiSessionServer(fixture.workspace, [{ id: "ses_retire" }]);
    const report = await runRecovery(fixture, server, fakeClock(), {
      removeAttemptDataDir: () => {
        // Simulate a locked/undeletable attempt directory.
      },
    });
    assert.equal(report.recovered.length, 0);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0]!.reason, "cleanup-failed");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
    assert.equal(isAttemptQuarantined(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: recovery cleans only manifest-owned generated files and leaves native changes", async () => {
  const fixture = await setupRecovery({ materialize: true });
  try {
    const nativeDir = join(fixture.workspace, ".opencode", "agents");
    const nativeFile = join(nativeDir, "operator-native.md");
    writeFileSync(nativeFile, "# operator-owned native agent\n", "utf8");
    writeOwnership(fixture, [{ parentSessionId: "ses_managed" }]);
    const server = new MultiSessionServer(fixture.workspace, [{ id: "ses_managed" }]);
    const report = await runRecovery(fixture, server);
    assert.equal(report.recovered.length, 1);
    assert.equal(report.recovered[0]!.reason, "recovered-quiescent");
    // Manifest-owned generated file removed; the developer's native file is not.
    assert.equal(existsSync(generatedPrimaryPath(fixture)), false);
    assert.equal(existsSync(nativeFile), true);
    assert.equal(readFileSync(nativeFile, "utf8"), "# operator-owned native agent\n");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), false);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("generic ownership: an unreadable journal with no attributable workspace is a fatal startup refusal", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-ownership-fatal-"));
  try {
    const store = new Store({ dataDir, file: ":memory:" });
    const attemptDir = attemptDataDirFor(dataDir, 999);
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(opencodeOwnershipPath(attemptDir), "{ not valid json\n", "utf8");
    await assert.rejects(
      recoverStaleManagedAttempts({
        dataDir,
        db: store.db,
        resolveWorker: () => ({ cwd: "C:\\unused", env: {} }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AttemptRecoveryFatalError, `got ${String(error)}`);
        return true;
      },
    );
    assert.equal(existsSync(opencodeOwnershipPath(attemptDir)), true);
    store.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("generic ownership: a failed durable quarantine record is fatal", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    writeOwnership(fixture, [{ parentSessionId: null }]);
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    // Occupy the record target with a directory so the atomic rename cannot
    // install the journal; without it the workspace would be silently reusable.
    mkdirSync(join(attemptDir, "recovery.json"), { recursive: true });
    await assert.rejects(
      () => runRecovery(fixture),
      (error: unknown) => {
        assert.ok(error instanceof AttemptRecoveryFatalError, `got ${String(error)}`);
        return true;
      },
    );
    assert.equal(existsSync(attemptDir), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("legacy unmanaged OpenCode attempt with evidence quarantines rather than being swept as Cline", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    // No journal, no manifest: a pre-journal OpenCode attempt. With a resolver
    // that maps its agent to OpenCode it must be recognized and quarantined.
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    mkdirSync(attemptDir, { recursive: true });
    const report = await runRecovery(fixture, undefined, fakeClock(), {
      resolveExecutorKind: (agent) => agent,
      resolveWorker: () => undefined,
    });
    assert.equal(report.candidates, 1);
    assert.equal(report.quarantined[0]?.reason, "legacy-ownership-unverifiable");
    assert.equal(readAttemptRecoveryRecord(attemptDir)?.status, "quarantined");
    assert.equal(existsSync(attemptDir), true);
    // The legacy-sweep classifier must defer the dir once the resolver is
    // supplied, so `cleanupStaleAttemptDirs` cannot delete it.
    const attemptRow = fixture.store.db
      .prepare("SELECT agent, workspace_path, agent_session_id FROM attempts WHERE id = ?")
      .get(fixture.attemptId) as {
      agent: string;
      workspace_path: string | null;
      agent_session_id: string | null;
    };
    assert.equal(
      shouldDeferAttemptToRecovery({
        attemptDataDir: attemptDir,
        attempt: attemptRow,
        resolveExecutorKind: (agent) => agent,
      }),
      true,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("legacy unmanaged OpenCode attempt with a proven-quiescent parent is recovered without touching the workspace", async () => {
  const fixture = await setupRecovery({ materialize: false, agentSessionId: "ses_legacy" });
  try {
    mkdirSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId), { recursive: true });
    const nativeFile = join(fixture.workspace, "operator-notes.txt");
    writeFileSync(nativeFile, "keep me\n", "utf8");
    const server = new MultiSessionServer(fixture.workspace, [{ id: "ses_legacy" }]);
    const report = await runRecovery(fixture, server, fakeClock(), {
      resolveExecutorKind: (agent) => agent,
    });
    assert.equal(report.recovered.length, 1);
    assert.equal(report.recovered[0]!.reason, "recovered-quiescent");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), false);
    assert.equal(readFileSync(nativeFile, "utf8"), "keep me\n");
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("legacy unmanaged OpenCode attempt that is not terminal is never retired, even with a quiescent tree", async () => {
  const fixture = await setupRecovery({ materialize: false, agentSessionId: "ses_live" });
  try {
    mkdirSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId), { recursive: true });
    // Simulate a live owner: no terminal outcome on the attempt row.
    fixture.store.db
      .prepare("UPDATE attempts SET outcome = NULL WHERE id = ?")
      .run(fixture.attemptId);
    const server = new MultiSessionServer(fixture.workspace, [{ id: "ses_live" }]);
    const report = await runRecovery(fixture, server, fakeClock(), {
      resolveExecutorKind: (agent) => agent,
    });
    assert.equal(report.recovered.length, 0);
    assert.equal(report.quarantined[0]?.reason, "owner-not-terminal");
    const attemptDir = attemptDataDirFor(fixture.dataDir, fixture.attemptId);
    assert.equal(existsSync(attemptDir), true, "a live owner's dir must never be retired");
    assert.equal(readAttemptRecoveryRecord(attemptDir)?.status, "quarantined");
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("legacy unmanaged OpenCode attempt with a stale worker cwd quarantines rather than proving an unrelated tree", async () => {
  const fixture = await setupRecovery({ materialize: false, agentSessionId: "ses_legacy" });
  try {
    mkdirSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId), { recursive: true });
    const report = await runRecovery(fixture, undefined, fakeClock(), {
      resolveExecutorKind: (agent) => agent,
      resolveWorker: () => ({ cwd: join(fixture.dataDir, "stale-directory"), env: {} }),
    });
    assert.equal(report.quarantined[0]?.reason, "worker-mismatch");
    assert.equal(existsSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("manifest-only recovery quarantines when the manifest workspace disagrees with the attempt row", async () => {
  const fixture = await setupRecovery({ materialize: true });
  try {
    fixture.store.db
      .prepare("UPDATE attempts SET workspace_path = ? WHERE id = ?")
      .run(join(fixture.dataDir, "elsewhere"), fixture.attemptId);
    const report = await runRecovery(fixture);
    assert.equal(report.recovered.length, 0);
    assert.equal(report.quarantined[0]?.reason, "worker-mismatch");
    // Nothing was cleaned: the generated file and manifest survive.
    assert.equal(existsSync(generatedPrimaryPath(fixture)), true);
    assert.equal(
      existsSync(
        managedOpencodeManifestPath(attemptDataDirFor(fixture.dataDir, fixture.attemptId)),
      ),
      true,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("manifest-only recovery quarantines a worker whose cwd is not the owned workspace", async () => {
  const fixture = await setupRecovery({ materialize: true, agentSessionId: "ses_managed" });
  try {
    const report = await runRecovery(fixture, undefined, fakeClock(), {
      resolveWorker: () => ({ cwd: join(fixture.dataDir, "stale-directory"), env: {} }),
    });
    assert.equal(report.quarantined[0]?.reason, "worker-mismatch");
    assert.equal(existsSync(generatedPrimaryPath(fixture)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("a Cline attempt is not a recovery candidate even with the resolver supplied", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    mkdirSync(attemptDataDirFor(fixture.dataDir, fixture.attemptId), { recursive: true });
    fixture.store.db
      .prepare("UPDATE attempts SET agent = 'cline' WHERE id = ?")
      .run(fixture.attemptId);
    const report = await runRecovery(fixture, undefined, fakeClock(), {
      resolveExecutorKind: (agent) => (agent === "opencode" ? "opencode" : "cline"),
    });
    assert.equal(report.candidates, 0);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});

test("artifact retention preserves an ownership-only attempt dir before recovery runs", async () => {
  const fixture = await setupRecovery({ materialize: false });
  try {
    const attemptDir = writeOwnership(fixture, [{ parentSessionId: "ses_native" }]);
    assert.equal(existsSync(opencodeOwnershipPath(attemptDir)), true);
    const report = await retainArtifacts({
      dataDir: fixture.dataDir,
      db: fixture.store.db,
      maximumAgeMs: 0,
      maximumTotalBytes: 1,
      now: Date.now() + 3_600_000,
      actions: fixture.actions,
    });
    assert.equal(
      report.decisions.some(
        (decision) =>
          decision.kind === "attempt-state" && resolve(decision.path) === resolve(attemptDir),
      ),
      false,
      "the ownership-only attempt dir must not be a retention candidate",
    );
    assert.equal(existsSync(attemptDir), true);
    assert.equal(existsSync(opencodeOwnershipPath(attemptDir)), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.gitRepo.root, { recursive: true, force: true });
  }
});
