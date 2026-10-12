/**
 * Tests for change tasks 1.1-1.3 (make-agent-activation-explicit): the
 * redacted, executor-alias-aware repository agent-workflow projection
 * (`RepositoryWorkflowSummary` via `readDashboard`), the bounded batched
 * latest-launched-invocation query (`RepositoryLastLaunchSummary`), and the
 * job captured-versus-actual workflow projection (`JobWorkflowSummary` via
 * `readJobDetail`) in `src/console/queries.ts`.
 *
 * Owned query-surface scope only: no routes, views, assets or store writes are
 * exercised; persisted profile/selection rows are never modified by a read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import {
  readDashboard,
  readJobDetail,
  type ExecutorKindResolver,
  type RepositoryWorkflowSummary,
} from "../src/console/queries.js";

const SECRET = "vault-secret-9";
const PRIVATE_INSTRUCTION = "replace the widget renderer and never mention the vault key";

interface Fixture {
  store: Store;
  opencodeRepoId: number;
  secondRepoId: number;
  clineRepoId: number;
}

function openFixture(): Fixture {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const insert = (owner: string, name: string, agent: string, sourcePath: string): number =>
    Number(
      store.db
        .prepare(
          `INSERT INTO repositories
             (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          owner,
          name,
          sourcePath,
          "workspaces",
          agent,
          agent === "opencode" ? "opencode/gpt-5.4" : "gpt-5.4",
          agent === "opencode" ? "" : "provider",
          "high",
        ).lastInsertRowid,
    );
  return {
    store,
    opencodeRepoId: insert("acme", "opencode-widgets", "opencode", "source-a"),
    secondRepoId: insert("acme", "opencode-docs", "opencode", "source-b"),
    clineRepoId: insert("acme", "docs", "cline", "source-cline"),
  };
}

interface SaveResult {
  revision: number;
}

function saveTeam(
  db: Store["db"],
  repoId: number,
  revision: number,
  overrides: Record<string, unknown> = {},
  executorKind?: string,
): SaveResult {
  const result = saveOpenCodeAgentProfile(db, {
    repoId,
    expectedRevision: revision,
    executorKind,
    candidate: {
      version: 1,
      primary: {
        id: "primary",
        description: "Primary",
        permissions: ["edit"],
      },
      subagents: [],
      ...overrides,
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(`profile save failed: ${result.reason}`);
  return { revision: result.revision };
}

function selectManaged(
  db: Store["db"],
  repoId: number,
  profileRevision: number,
  executorKind?: string,
): void {
  assert.equal(
    saveOpenCodeSelection(db, {
      repoId,
      expectedRevision: 0,
      executorKind,
      candidate: { source: "managed" },
      expectedProfileRevision: profileRevision,
    }).ok,
    true,
  );
}

function selectNative(
  db: Store["db"],
  repoId: number,
  agentId: string,
  expectedRevision = 0,
  executorKind?: string,
): void {
  assert.equal(
    saveOpenCodeSelection(db, {
      repoId,
      expectedRevision,
      executorKind,
      candidate: { source: "native", agentId },
    }).ok,
    true,
  );
}

function createJob(fixture: Fixture, repoId: number, prNumber: number): number {
  const created = new JobStore(fixture.store.db).createJob({
    repoId,
    prNumber,
    commentId: prNumber * 100,
    command: "RESOLVE",
    threadId: String(prNumber * 100),
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("job not created");
  return created.jobId;
}

function insertAttempt(db: Store["db"], jobId: number, attemptNumber: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO attempts (job_id, attempt_number, agent, model, provider, effort)
         VALUES (?, ?, 'opencode', 'opencode/gpt-5.4', '', 'high')`,
      )
      .run(jobId, attemptNumber).lastInsertRowid,
  );
}

function insertInvocation(
  db: Store["db"],
  attemptId: number,
  ordinal: number,
  fields: {
    status?: string;
    requestedSource?: string;
    requestedNativeAgentId?: string | null;
    requestedProfileRevision?: number | null;
    actualPrimaryAgent?: string | null;
    actualModel?: string | null;
    launchedAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO opencode_invocations
       (attempt_id, invocation_ordinal, status, ownership_state, requested_source,
        requested_native_agent_id, requested_profile_revision, parent_session_id,
        actual_primary_agent, actual_model, launched_at)
     VALUES (?, ?, ?, 'settled', ?, ?, ?, 'ses_parent', ?, ?, ?)`,
  ).run(
    attemptId,
    ordinal,
    fields.status ?? "settled",
    fields.requestedSource ?? "default",
    fields.requestedNativeAgentId ?? null,
    fields.requestedProfileRevision ?? null,
    fields.actualPrimaryAgent ?? null,
    fields.actualModel ?? null,
    fields.launchedAt ?? null,
  );
}

function repoWorkflow(
  model: ReturnType<typeof readDashboard>,
  repoId: number,
): RepositoryWorkflowSummary {
  const workflow = model.repositories.find((repo) => repo.id === repoId)?.agentWorkflow;
  assert.ok(workflow, `repository ${repoId} should project an agent workflow`);
  return workflow as RepositoryWorkflowSummary;
}

// ---------------------------------------------------------------------------
// 1.1 Repository agent-workflow projection
// ---------------------------------------------------------------------------

test("no saved team and default source is an ordinary no-team workflow, not an error", () => {
  const fixture = openFixture();
  const model = readDashboard(fixture.store.db, []);
  const workflow = repoWorkflow(model, fixture.opencodeRepoId);
  assert.equal(workflow.executorKind, "opencode");
  assert.equal(workflow.applicable, true);
  assert.equal(workflow.state, "no-team");
  assert.equal(workflow.source, "default");
  assert.equal(workflow.selectionRevision, 0);
  assert.equal(workflow.nativeAgentId, null);
  assert.equal(workflow.team, null);
  assert.equal(workflow.teamCorrupt, false);
  assert.equal(workflow.teamUnavailable, false);
  assert.equal(workflow.lastLaunch, null);
  fixture.store.close();
});

test("a saved team under default or native source is inactive and never changes its source", () => {
  const fixture = openFixture();
  saveTeam(fixture.store.db, fixture.opencodeRepoId, 0);
  const model = readDashboard(fixture.store.db, []);
  const workflow = repoWorkflow(model, fixture.opencodeRepoId);
  assert.equal(workflow.state, "inactive-team");
  assert.equal(workflow.source, "default");
  assert.equal(workflow.team?.active, false);
  assert.equal(workflow.team?.revision, 1);

  selectNative(fixture.store.db, fixture.secondRepoId, "native-reviewer");
  const native = repoWorkflow(readDashboard(fixture.store.db, []), fixture.secondRepoId);
  // No saved team under native source: ordinary no-team, not an error.
  assert.equal(native.state, "no-team");
  assert.equal(native.source, "native");
  assert.equal(native.nativeAgentId, "native-reviewer");
  assert.equal(native.team, null);

  // A retained saved team under native source stays inactive and labeled.
  saveTeam(fixture.store.db, fixture.secondRepoId, 0);
  const retained = repoWorkflow(readDashboard(fixture.store.db, []), fixture.secondRepoId);
  assert.equal(retained.state, "inactive-team");
  assert.equal(retained.source, "native");
  assert.equal(retained.nativeAgentId, "native-reviewer");
  assert.equal(retained.team?.active, false);
  fixture.store.close();
});

test("an active managed team names its primary, revision and enabled children", () => {
  const fixture = openFixture();
  const saved = saveTeam(fixture.store.db, fixture.opencodeRepoId, 0, {
    subagents: [
      { id: "reviewer", enabled: true, description: "Reviews specs", permissions: ["web"] },
      { id: "architect", enabled: false, description: "Designs", permissions: ["edit"] },
    ],
  });
  selectManaged(fixture.store.db, fixture.opencodeRepoId, saved.revision);
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  assert.equal(workflow.state, "active-managed");
  assert.equal(workflow.applicable, true);
  assert.equal(workflow.source, "managed");
  assert.equal(workflow.team?.active, true);
  assert.equal(workflow.team?.primaryId, "primary");
  assert.equal(workflow.team?.revision, saved.revision);
  assert.equal(workflow.team?.subagentCount, 2);
  assert.equal(workflow.team?.enabledSubagentCount, 1);
  assert.equal(workflow.teamUnavailable, false);
  fixture.store.close();
});

test("an active team with zero enabled children still discloses that state", () => {
  const fixture = openFixture();
  const saved = saveTeam(fixture.store.db, fixture.opencodeRepoId, 0, {
    subagents: [{ id: "architect", enabled: false, description: "Designs", permissions: ["edit"] }],
  });
  selectManaged(fixture.store.db, fixture.opencodeRepoId, saved.revision);
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  assert.equal(workflow.state, "active-managed");
  assert.equal(workflow.team?.subagentCount, 1);
  assert.equal(workflow.team?.enabledSubagentCount, 0);
  fixture.store.close();
});

test("managed selection without a readable team is unavailable, not active", () => {
  const fixture = openFixture();
  // Managed with no profile bytes at all: the selection row is inserted
  // directly because the store refuses to bind managed to a missing team.
  fixture.store.db
    .prepare(
      `INSERT INTO opencode_primary_selections (repo_id, source, native_agent_id, revision)
       VALUES (?, 'managed', NULL, 1)`,
    )
    .run(fixture.opencodeRepoId);
  const missing = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  assert.equal(missing.state, "unavailable-managed");
  assert.equal(missing.team, null);
  assert.equal(missing.teamUnavailable, true);
  assert.equal(missing.teamCorrupt, false);

  // Managed pointing at stored bytes that no longer parse is equally unusable.
  const saved = saveTeam(fixture.store.db, fixture.secondRepoId, 0);
  selectManaged(fixture.store.db, fixture.secondRepoId, saved.revision);
  fixture.store.db
    .prepare("UPDATE opencode_agent_profiles SET profile_json = ? WHERE repo_id = ?")
    .run("not valid json", fixture.secondRepoId);
  const corrupt = repoWorkflow(readDashboard(fixture.store.db, []), fixture.secondRepoId);
  assert.equal(corrupt.state, "unavailable-managed");
  assert.equal(corrupt.team, null);
  assert.equal(corrupt.teamCorrupt, true);
  assert.equal(corrupt.teamUnavailable, true);
  fixture.store.close();
});

test("a corrupt dormant team still reads as a saved, unreadable inactive team", () => {
  const fixture = openFixture();
  saveTeam(fixture.store.db, fixture.opencodeRepoId, 0);
  fixture.store.db
    .prepare("UPDATE opencode_agent_profiles SET profile_json = ? WHERE repo_id = ?")
    .run("not valid json", fixture.opencodeRepoId);
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  assert.equal(workflow.state, "inactive-team");
  assert.equal(workflow.team, null);
  assert.equal(workflow.teamCorrupt, true);
  assert.equal(workflow.teamUnavailable, false);
  assert.equal(workflow.source, "default");
  fixture.store.close();
});

test("non-OpenCode executors project an unsupported workflow without touching stored rows", () => {
  const fixture = openFixture();
  const selectionCount = (): number =>
    (
      fixture.store.db.prepare("SELECT COUNT(*) AS n FROM opencode_primary_selections").get() as {
        n: number;
      }
    ).n;
  const profileCount = (): number =>
    (
      fixture.store.db.prepare("SELECT COUNT(*) AS n FROM opencode_agent_profiles").get() as {
        n: number;
      }
    ).n;
  const before = { selections: selectionCount(), profiles: profileCount() };
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.clineRepoId);
  assert.equal(workflow.executorKind, "cline");
  assert.equal(workflow.applicable, false);
  assert.equal(workflow.state, "unsupported-executor");
  assert.equal(workflow.source, "default");
  assert.equal(workflow.team, null);
  // Projection is strictly read-only: no selection or profile row is created.
  assert.equal(selectionCount(), before.selections);
  assert.equal(profileCount(), before.profiles);
  fixture.store.close();
});

test("executor aliases resolve by kind, never by literal name", () => {
  const fixture = openFixture();
  const aliasRepoId = Number(
    fixture.store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', 'alias-widgets', 'source-alias', 'workspaces',
                 'gremlyn-alias', 'opencode/gpt-5.4', '', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  const resolve: ExecutorKindResolver = (agentId) =>
    agentId === "gremlyn-alias" ? "opencode" : agentId;
  saveTeam(fixture.store.db, aliasRepoId, 0, {}, "opencode");
  selectManaged(fixture.store.db, aliasRepoId, 1, "opencode");
  const model = readDashboard(fixture.store.db, [], {}, resolve);
  const workflow = repoWorkflow(model, aliasRepoId);
  assert.equal(workflow.executorKind, "opencode");
  assert.equal(workflow.applicable, true);
  assert.equal(workflow.state, "active-managed");

  const clineAliasRepoId = Number(
    fixture.store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', 'alias-docs', 'source-alias-docs', 'workspaces',
                 'cli-alias', 'gpt-5.4', 'provider', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  const unsupported = repoWorkflow(
    readDashboard(fixture.store.db, [], {}, resolve),
    clineAliasRepoId,
  );
  assert.equal(unsupported.executorKind, "cli-alias");
  assert.equal(unsupported.applicable, false);
  assert.equal(unsupported.state, "unsupported-executor");
  fixture.store.close();
});

test("the workflow projection redacts team identity text", () => {
  const fixture = openFixture();
  saveTeam(fixture.store.db, fixture.opencodeRepoId, 0, {
    primary: {
      id: "primary",
      description: `Primary with ${SECRET}`,
      permissions: ["edit"],
    },
  });
  const model = readDashboard(fixture.store.db, [SECRET]);
  const workflow = repoWorkflow(model, fixture.opencodeRepoId);
  assert.equal(workflow.team?.primaryDescription.includes(SECRET), false);
  assert.equal(JSON.stringify(model.repositories).includes(PRIVATE_INSTRUCTION), false);
  fixture.store.close();
});

// ---------------------------------------------------------------------------
// 1.2 Bounded batched latest-launched-invocation query
// ---------------------------------------------------------------------------

test("each repository's last launch is scoped to its own jobs, attempts and invocations", () => {
  const fixture = openFixture();
  const jobA = createJob(fixture, fixture.opencodeRepoId, 1);
  const attemptA = insertAttempt(fixture.store.db, jobA, 1);
  insertInvocation(fixture.store.db, attemptA, 1, {
    requestedSource: "default",
    actualPrimaryAgent: "runner-a",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const jobB = createJob(fixture, fixture.secondRepoId, 2);
  const attemptB = insertAttempt(fixture.store.db, jobB, 1);
  insertInvocation(fixture.store.db, attemptB, 1, {
    requestedSource: "native",
    requestedNativeAgentId: "builder-b",
    actualPrimaryAgent: "runner-b",
    launchedAt: "2026-09-01T00:00:01.000Z",
  });
  const model = readDashboard(fixture.store.db, []);
  const workflowA = repoWorkflow(model, fixture.opencodeRepoId);
  const workflowB = repoWorkflow(model, fixture.secondRepoId);
  assert.equal(workflowA.lastLaunch?.jobId, jobA);
  assert.equal(workflowA.lastLaunch?.jobHref, `/jobs/${String(jobA)}`);
  assert.equal(workflowA.lastLaunch?.attemptId, attemptA);
  assert.equal(workflowA.lastLaunch?.actualPrimaryAgent, "runner-a");
  assert.equal(workflowA.lastLaunch?.requestedSource, "default");
  assert.equal(workflowB.lastLaunch?.jobId, jobB);
  assert.equal(workflowB.lastLaunch?.actualPrimaryAgent, "runner-b");
  assert.equal(workflowB.lastLaunch?.requestedNativeAgentId, "builder-b");
  // Histories never cross: summary A carries none of B's job identity.
  assert.notEqual(workflowA.lastLaunch?.jobId, jobB);
  fixture.store.close();
});

test("a newer unlaunched preparation failure is excluded from the last launch", () => {
  const fixture = openFixture();
  const job = createJob(fixture, fixture.opencodeRepoId, 3);
  const attemptOne = insertAttempt(fixture.store.db, job, 1);
  insertInvocation(fixture.store.db, attemptOne, 1, {
    requestedSource: "native",
    requestedNativeAgentId: "native-reviewer",
    actualPrimaryAgent: "known-runner",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  // Retry attempt journaled an invocation but failed preparing before launch.
  const attemptTwo = insertAttempt(fixture.store.db, job, 2);
  insertInvocation(fixture.store.db, attemptTwo, 1, {
    status: "failed",
    requestedSource: "native",
    requestedNativeAgentId: "native-reviewer",
    actualPrimaryAgent: null,
    launchedAt: null,
  });
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  assert.equal(workflow.lastLaunch?.attemptId, attemptOne);
  assert.equal(workflow.lastLaunch?.actualPrimaryAgent, "known-runner");
  assert.equal(workflow.lastLaunch?.requestedNativeAgentId, "native-reviewer");
  fixture.store.close();
});

test("a newest unknown identity never borrows older known evidence", () => {
  const fixture = openFixture();
  const job = createJob(fixture, fixture.opencodeRepoId, 4);
  const attemptOne = insertAttempt(fixture.store.db, job, 1);
  insertInvocation(fixture.store.db, attemptOne, 1, {
    requestedSource: "default",
    actualPrimaryAgent: "older-known",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const attemptTwo = insertAttempt(fixture.store.db, job, 2);
  insertInvocation(fixture.store.db, attemptTwo, 1, {
    requestedSource: "default",
    actualPrimaryAgent: null,
    launchedAt: "2026-09-01T00:00:05.000Z",
  });
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  assert.equal(workflow.lastLaunch?.attemptId, attemptTwo);
  assert.equal(workflow.lastLaunch?.actualPrimaryAgent, null);
  assert.equal(workflow.lastLaunch?.actualModel, null);
  assert.notEqual(workflow.lastLaunch?.actualPrimaryAgent, "older-known");
  fixture.store.close();
});

test("the per-repository last launch is deterministic when launch times tie", () => {
  const fixture = openFixture();
  const job = createJob(fixture, fixture.opencodeRepoId, 5);
  const attemptOne = insertAttempt(fixture.store.db, job, 1);
  insertInvocation(fixture.store.db, attemptOne, 1, {
    requestedSource: "default",
    actualPrimaryAgent: "first",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const attemptTwo = insertAttempt(fixture.store.db, job, 2);
  insertInvocation(fixture.store.db, attemptTwo, 1, {
    requestedSource: "default",
    actualPrimaryAgent: "second",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  // Same launch time: the invocation-id tie-breaker picks the later row.
  assert.equal(workflow.lastLaunch?.attemptId, attemptTwo);
  assert.equal(workflow.lastLaunch?.actualPrimaryAgent, "second");
  fixture.store.close();
});

test("last-launch identities are redacted at the projection boundary", () => {
  const fixture = openFixture();
  const job = createJob(fixture, fixture.opencodeRepoId, 6);
  const attempt = insertAttempt(fixture.store.db, job, 1);
  insertInvocation(fixture.store.db, attempt, 1, {
    requestedSource: "native",
    requestedNativeAgentId: "native-reviewer",
    actualPrimaryAgent: `runner-${SECRET}`,
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const model = readDashboard(fixture.store.db, [SECRET]);
  const workflow = repoWorkflow(model, fixture.opencodeRepoId);
  assert.equal(workflow.lastLaunch?.actualPrimaryAgent.includes(SECRET), false);
  assert.equal(JSON.stringify(model.repositories).includes(SECRET), false);
  fixture.store.close();
});

test("a repository with no launch evidence reports no last launch", () => {
  const fixture = openFixture();
  const workflow = repoWorkflow(readDashboard(fixture.store.db, []), fixture.opencodeRepoId);
  assert.equal(workflow.lastLaunch, null);
  fixture.store.close();
});

// ---------------------------------------------------------------------------
// 1.3 Job captured-versus-actual workflow projection
// ---------------------------------------------------------------------------

test("a queued managed job projects its capture and identical current settings", () => {
  const fixture = openFixture();
  const saved = saveTeam(fixture.store.db, fixture.opencodeRepoId, 0);
  selectManaged(fixture.store.db, fixture.opencodeRepoId, saved.revision);
  const jobId = createJob(fixture, fixture.opencodeRepoId, 101);
  const model = readJobDetail(fixture.store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.workflow.applicable, true);
  assert.equal(model.workflow.captured?.source, "managed");
  assert.equal(model.workflow.captured?.profileRevision, saved.revision);
  assert.equal(model.workflow.capturedTeam?.primaryId, "primary");
  assert.equal(model.workflow.currentAttempt, null);
  assert.equal(model.workflow.difference, "none");
  assert.equal(model.workflow.settingsDiffer, false);
  assert.equal(model.workflow.currentSettings?.source, "managed");
  assert.equal(model.workflow.currentSettings?.primaryId, "primary");
  fixture.store.close();
});

test("a preparing retry says not started while preserving earlier attempt history", () => {
  const fixture = openFixture();
  selectNative(fixture.store.db, fixture.opencodeRepoId, "native-reviewer");
  const jobId = createJob(fixture, fixture.opencodeRepoId, 102);
  const attemptOne = insertAttempt(fixture.store.db, jobId, 1);
  insertInvocation(fixture.store.db, attemptOne, 1, {
    requestedSource: "native",
    requestedNativeAgentId: "native-reviewer",
    actualPrimaryAgent: "observed-runner",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const attemptTwo = insertAttempt(fixture.store.db, jobId, 2);
  const model = readJobDetail(fixture.store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.workflow.currentAttempt?.attemptId, attemptTwo);
  assert.equal(model.workflow.currentAttempt?.attemptNumber, 2);
  assert.equal(model.workflow.currentAttempt?.launched, false);
  assert.equal(model.workflow.currentAttempt?.latestInvocation, null);
  assert.equal(model.workflow.currentAttempt?.actualPrimaryAgent, null);
  assert.equal(model.workflow.currentAttempt?.discrepancy, false);
  assert.equal(model.workflow.difference, "none");
  // The earlier attempt's invocation remains in history.
  assert.equal(model.attempts[0]?.invocations[0]?.actualPrimaryAgent, "observed-runner");
  fixture.store.close();
});

test("a native selection change is a difference while the job keeps its captured id", () => {
  const fixture = openFixture();
  selectNative(fixture.store.db, fixture.opencodeRepoId, "native-reviewer");
  const jobId = createJob(fixture, fixture.opencodeRepoId, 103);
  const attempt = insertAttempt(fixture.store.db, jobId, 1);
  insertInvocation(fixture.store.db, attempt, 1, {
    requestedSource: "native",
    requestedNativeAgentId: "native-reviewer",
    actualPrimaryAgent: "native-reviewer",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  // The operator switches the repository to a different native agent.
  selectNative(fixture.store.db, fixture.opencodeRepoId, "newer-native", 1);
  const model = readJobDetail(fixture.store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.workflow.captured?.source, "native");
  assert.equal(model.workflow.captured?.nativeAgentId, "native-reviewer");
  assert.equal(model.workflow.currentSettings?.nativeAgentId, "newer-native");
  assert.equal(model.workflow.difference, "native-changed");
  assert.equal(model.workflow.settingsDiffer, true);
  // Runtime evidence is untouched by the settings change.
  assert.equal(
    model.workflow.currentAttempt?.latestInvocation?.actualPrimaryAgent,
    "native-reviewer",
  );
  fixture.store.close();
});

test("a default job predating activation never borrows the current managed team", () => {
  const fixture = openFixture();
  const jobId = createJob(fixture, fixture.opencodeRepoId, 104);
  const attempt = insertAttempt(fixture.store.db, jobId, 1);
  insertInvocation(fixture.store.db, attempt, 1, {
    requestedSource: "default",
    actualPrimaryAgent: "build",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  // The repository activates a managed team after the job was created.
  const saved = saveTeam(fixture.store.db, fixture.opencodeRepoId, 0);
  selectManaged(fixture.store.db, fixture.opencodeRepoId, saved.revision);
  const model = readJobDetail(fixture.store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.workflow.captured?.source, "default");
  assert.equal(model.workflow.capturedTeam, null);
  assert.equal(model.workflow.currentSettings?.source, "managed");
  assert.equal(model.workflow.currentSettings?.primaryId, "primary");
  assert.equal(model.workflow.difference, "source-changed");
  assert.equal(model.workflow.settingsDiffer, true);
  // Default resolution to build is ordinary behavior, never a discrepancy.
  assert.equal(model.workflow.currentAttempt?.discrepancy, false);
  assert.equal(model.workflow.currentAttempt?.actualPrimaryAgent, "build");
  fixture.store.close();
});

test("a managed revision change is reported without rewriting the job capture", () => {
  const fixture = openFixture();
  const first = saveTeam(fixture.store.db, fixture.opencodeRepoId, 0);
  selectManaged(fixture.store.db, fixture.opencodeRepoId, first.revision);
  const jobId = createJob(fixture, fixture.opencodeRepoId, 105);
  const second = saveTeam(fixture.store.db, fixture.opencodeRepoId, first.revision);
  const model = readJobDetail(fixture.store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.workflow.captured?.source, "managed");
  assert.equal(model.workflow.captured?.profileRevision, first.revision);
  assert.equal(model.workflow.capturedTeam?.revision, first.revision);
  assert.equal(model.workflow.currentSettings?.revision, 1);
  assert.equal(model.workflow.currentSettings?.profileRevision, second.revision);
  assert.equal(model.workflow.difference, "managed-revision-changed");
  assert.equal(model.workflow.settingsDiffer, true);
  fixture.store.close();
});

test("an explicit native request observed as a different primary is a visible discrepancy", () => {
  const fixture = openFixture();
  selectNative(fixture.store.db, fixture.opencodeRepoId, "native-reviewer");
  const jobId = createJob(fixture, fixture.opencodeRepoId, 106);
  const attempt = insertAttempt(fixture.store.db, jobId, 1);
  insertInvocation(fixture.store.db, attempt, 1, {
    requestedSource: "native",
    requestedNativeAgentId: "native-reviewer",
    actualPrimaryAgent: "unexpected-runner",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const model = readJobDetail(fixture.store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.workflow.currentAttempt?.requestedPrimaryId, "native-reviewer");
  assert.equal(model.workflow.currentAttempt?.actualPrimaryAgent, "unexpected-runner");
  assert.equal(model.workflow.currentAttempt?.discrepancy, true);
  fixture.store.close();
});

test("a managed discrepancy uses the captured primary only at its exact revision", () => {
  const fixture = openFixture();
  const saved = saveTeam(fixture.store.db, fixture.opencodeRepoId, 0, {
    primary: { id: "managed-primary", description: "Managed", permissions: ["edit"] },
  });
  selectManaged(fixture.store.db, fixture.opencodeRepoId, saved.revision);
  const jobId = createJob(fixture, fixture.opencodeRepoId, 107);
  const attempt = insertAttempt(fixture.store.db, jobId, 1);
  insertInvocation(fixture.store.db, attempt, 1, {
    requestedSource: "managed",
    requestedProfileRevision: saved.revision,
    actualPrimaryAgent: "different-runner",
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const model = readJobDetail(fixture.store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.workflow.currentAttempt?.requestedPrimaryId, "managed-primary");
  assert.equal(model.workflow.currentAttempt?.actualPrimaryAgent, "different-runner");
  assert.equal(model.workflow.currentAttempt?.discrepancy, true);
  fixture.store.close();
});

test("unsupported and unknown jobs keep historical evidence and project no fabricated capture", () => {
  const fixture = openFixture();
  // Non-OpenCode job: no OpenCode workflow semantics at all.
  const clineJob = createJob(fixture, fixture.clineRepoId, 108);
  const clineAttempt = insertAttempt(fixture.store.db, clineJob, 1);
  fixture.store.db.prepare("UPDATE attempts SET agent = 'cline' WHERE id = ?").run(clineAttempt);
  const cline = readJobDetail(fixture.store.db, clineJob, []);
  assert.ok(cline);
  assert.equal(cline.workflow.applicable, false);
  assert.equal(cline.workflow.captured, null);
  assert.equal(cline.workflow.capturedTeam, null);
  assert.equal(cline.workflow.difference, "none");

  // Legacy OpenCode job with a corrupt recorded source projects nothing.
  const legacyJob = createJob(fixture, fixture.opencodeRepoId, 109);
  fixture.store.db.prepare("UPDATE jobs SET opencode_source = 'weird' WHERE id = ?").run(legacyJob);
  const legacy = readJobDetail(fixture.store.db, legacyJob, []);
  assert.ok(legacy);
  assert.equal(legacy.workflow.captured, null);
  assert.equal(legacy.workflow.difference, "none");

  // A launched invocation with unknown identity stays "not observed".
  const unknownJob = createJob(fixture, fixture.opencodeRepoId, 110);
  const attempt = insertAttempt(fixture.store.db, unknownJob, 1);
  insertInvocation(fixture.store.db, attempt, 1, {
    requestedSource: "default",
    actualPrimaryAgent: null,
    launchedAt: "2026-09-01T00:00:00.000Z",
  });
  const unknown = readJobDetail(fixture.store.db, unknownJob, []);
  assert.ok(unknown);
  assert.equal(unknown.workflow.currentAttempt?.launched, true);
  assert.equal(unknown.workflow.currentAttempt?.latestInvocation?.actualPrimaryAgent, null);
  assert.equal(unknown.workflow.currentAttempt?.actualPrimaryAgent, null);
  assert.equal(unknown.workflow.currentAttempt?.discrepancy, false);
  fixture.store.close();
});
