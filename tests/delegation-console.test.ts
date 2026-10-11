/**
 * Focused tests for tasks 4.1, 4.2, 4.3 and 4.5: batched redacted console
 * projections, truthful dashboard/detail delegation views, the authenticated
 * live-update boundary and scoped announcements for the change
 * `observe-live-agent-delegation` (design D4/D5; capability
 * `agent-delegation-observability`).
 *
 * The console is a read-only observer here: every case seeds the durable
 * observation store and asserts the projection never invents execution, never
 * shows a completion percentage, keeps configured agents separate from observed
 * sessions, and stays quiet for routine ticks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import {
  importLegacyManagedChildObservations,
  reconcileDelegationGaps,
  recordDelegationCancellationRequest,
  recordDelegationCoverage,
  recordDelegationObservation,
  reportDelegationGap,
} from "../src/store/delegation-observations.js";
import { readDashboard, readJobDetail } from "../src/console/queries.js";
import { dashboardRegions } from "../src/console/views/dashboard.js";
import { jobRegions } from "../src/console/views/job.js";
import { SharedChangeTicker, type StreamChange } from "../src/console/stream.js";
import { buildConsoleServer } from "../src/console/server.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SECRET = "super-secret-token";

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function openStore(): Store {
  return new Store({ dataDir: ".", file: ":memory:" });
}

function insertRepository(store: Store, agent: string, name: string): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', ?, 'source', 'workspaces', ?, ?, ?, 'high', 1)`,
      )
      .run(
        name,
        agent,
        agent === "cline" ? "gpt-5.4" : "opencode/gpt-5.4",
        agent === "cline" ? "openai" : "opencode",
      ).lastInsertRowid,
  );
}

let jobSequence = 0;

function createJob(store: Store, repoId: number, status = "running"): number {
  jobSequence += 1;
  const prNumber = 100 + jobSequence;
  const commentId = 10_000 + jobSequence;
  const created = new JobStore(store.db).createJob({
    repoId,
    prNumber,
    commentId,
    command: "RESOLVE",
    threadId: String(commentId),
    authorLogin: "owner",
    observedAt: iso(0),
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("duplicate fixture job");
  store.db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, created.jobId);
  return created.jobId;
}

function insertAttempt(store: Store, jobId: number, agent: string, number = 1): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO attempts (job_id, attempt_number, agent, model, provider, effort, started_at)
         VALUES (?, ?, ?, ?, ?, 'high', ?)`,
      )
      .run(jobId, number, agent, "m", "p", iso(0)).lastInsertRowid,
  );
}

function managedProfile(): Record<string, unknown> {
  return {
    version: 1,
    primary: { id: "orchestrator", description: "Runs the team", permissions: ["edit"] },
    subagents: [
      { id: "spec-checker", description: "Checks specs", enabled: true, permissions: ["edit"] },
      { id: "web-research", description: "Reads the web", enabled: false, permissions: [] },
    ],
  };
}

function observe(
  store: Store,
  attemptId: number,
  ordinal: number,
  sessionId: string,
  extra: Record<string, unknown> = {},
): void {
  const result = recordDelegationObservation(store.db, {
    attemptId,
    invocationOrdinal: ordinal,
    sessionId,
    observedAt: iso(0),
    sourceKind: "session-poll",
    ...extra,
  });
  assert.equal(result.ok, true, `observation ${sessionId} should persist`);
}

/* ------------------------------------------------------------------ *
 * 4.1 Batched dashboard/detail queries
 * ------------------------------------------------------------------ */

test("dashboard delegation is batched and distinguishable: unavailable, no observations, observed, unsupported", () => {
  const store = openStore();
  const opencodeRepo = insertRepository(store, "opencode", "managed");
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId: opencodeRepo,
    expectedRevision: 0,
    candidate: managedProfile(),
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    saveOpenCodeSelection(store.db, {
      repoId: opencodeRepo,
      expectedRevision: 0,
      expectedProfileRevision: saved.revision,
      candidate: { source: "managed" },
    });
  }
  const emptyJob = createJob(store, opencodeRepo);
  insertAttempt(store, emptyJob, "opencode");

  const observedJob = createJob(store, opencodeRepo);
  const observedAttempt = insertAttempt(store, observedJob, "opencode");
  observe(store, observedAttempt, 1, "ses_running", { active: true, rootSessionId: "ses_root" });
  observe(store, observedAttempt, 1, "ses_done", { active: false, outcome: "succeeded" });

  const clineRepo = insertRepository(store, "cline", "plain");
  const clineJob = createJob(store, clineRepo);
  insertAttempt(store, clineJob, "cline");

  // One batched read feeds every row; no per-row session query is issued.
  let prepareCalls = 0;
  const patched = store.db as unknown as { prepare: typeof store.db.prepare };
  const originalPrepare = patched.prepare.bind(store.db);
  let model: ReturnType<typeof readDashboard> | undefined;
  try {
    patched.prepare = ((sql: string) => {
      prepareCalls += 1;
      return originalPrepare(sql);
    }) as typeof store.db.prepare;
    model = readDashboard(store.db, [], { now: iso(0) });
  } finally {
    patched.prepare = originalPrepare;
  }
  assert.ok(model);

  const byId = new Map(model.jobs.map((job) => [job.id, job]));
  // OpenCode with no coverage row is unavailable, never "no delegations".
  assert.equal(byId.get(emptyJob)?.delegation?.availability, "unavailable");
  assert.equal(byId.get(emptyJob)?.delegation?.coverage, "none");
  // Observed counts are truthful and never fold unknown into completed.
  const observed = byId.get(observedJob)?.delegation;
  assert.equal(observed?.availability, "observed");
  assert.equal(observed?.running, 1);
  assert.equal(observed?.succeeded, 1);
  assert.equal(observed?.unknown, 0);
  // A non-OpenCode executor is unsupported, not an empty tree.
  assert.equal(byId.get(clineJob)?.delegation?.availability, "unsupported");
  assert.equal(byId.get(clineJob)?.delegation?.executorKind, "cline");

  // The projection is bounded and batched, not a fan-out of per-row queries.
  assert.ok(
    prepareCalls <= 12,
    `expected a bounded number of prepares, got ${String(prepareCalls)}`,
  );

  const html = dashboardRegions(model).jobs;
  assert.match(html, /delegation: telemetry unavailable/u);
  assert.match(html, /delegation: 1 observed active · 1 observed completed/u);
  assert.match(html, /delegation: not observable for this executor/u);
  assert.doesNotMatch(html, /%/u, "no completion percentage is ever inferred");
  store.close();
});

test("a supported but empty observation reads 'no delegations observed yet'", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  assert.equal(
    recordDelegationCoverage(store.db, {
      attemptId: attempt,
      invocationOrdinal: 1,
      at: iso(1_000),
      transport: "polling",
      transportState: "ok",
    }).ok,
    true,
  );
  const model = readDashboard(store.db, [], { now: iso(1_000) });
  const summary = model.jobs.find((entry) => entry.id === job)?.delegation;
  assert.equal(summary?.availability, "observed");
  assert.equal(summary?.observed, 0);
  const html = dashboardRegions(model).jobs;
  assert.match(html, /delegation: no delegations observed yet/u);
  assert.doesNotMatch(html, /not observable/u);
  store.close();
});

test("detail keeps configured callable agents separate and labels only exact generated runtime ids", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId: repo,
    expectedRevision: 0,
    candidate: managedProfile(),
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    saveOpenCodeSelection(store.db, {
      repoId: repo,
      expectedRevision: 0,
      expectedProfileRevision: saved.revision,
      candidate: { source: "managed" },
    });
  }
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  const namespace = `attempt-${String(attempt)}`;

  // Two distinct sessions invoking the same configured agent must stay distinct.
  observe(store, attempt, 1, "ses_child_1", {
    agent: `${namespace}/spec-checker`,
    active: true,
    model: "opencode/gpt-5.4",
    sourceCreatedAt: iso(0),
    sourceUpdatedAt: iso(500),
    rootSessionId: "ses_parent",
  });
  observe(store, attempt, 1, "ses_child_2", {
    agent: `${namespace}/spec-checker`,
    active: false,
    outcome: "succeeded",
    rootSessionId: "ses_parent",
  });
  // A runtime id that is not an exact generated definition stays raw.
  observe(store, attempt, 1, "ses_child_3", { agent: "native-reviewer", active: false });
  // A record with no usable identity stays explicitly unknown.
  observe(store, attempt, 1, "ses_child_4", { active: false });

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(1_000));
  assert.ok(model);
  const delegation = model.attempts[0]?.delegation;
  assert.ok(delegation);
  const configured = delegation.configured;
  assert.deepEqual(
    configured.map((agent) => [agent.id, agent.callable]),
    [
      ["orchestrator", true],
      ["spec-checker", true],
      ["web-research", false],
    ],
  );
  const nodes = delegation.invocations.flatMap((invocation) => invocation.nodes);
  assert.equal(nodes.length, 4);
  const first = nodes.find((node) => node.sessionId === "ses_child_1");
  assert.equal(first?.agentFriendly, true);
  assert.equal(first?.agentLabel, "spec-checker");
  const raw = nodes.find((node) => node.sessionId === "ses_child_3");
  assert.equal(raw?.agentFriendly, false);
  assert.equal(raw?.agentLabel, "native-reviewer");
  const unknown = nodes.find((node) => node.sessionId === "ses_child_4");
  assert.equal(unknown?.agentId, null);
  assert.equal(unknown?.agentLabel, null);

  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.match(html, /data-delegation-configured="spec-checker"/u);
  assert.match(html, /data-delegation-configured="web-research"/u);
  assert.match(html, /<span class="chip">disabled<\/span>/u);
  assert.match(html, /data-delegation-identity="spec-checker"/u);
  assert.match(html, /data-delegation-identity-raw>native-reviewer/u);
  assert.match(html, /data-delegation-identity-unknown>unknown identity/u);
  // Attempt/invocation/session keyed trees.
  assert.match(
    html,
    new RegExp(`data-live-key="delegation-session-${String(attempt)}-1-ses_child_1"`, "u"),
  );
  assert.match(
    html,
    new RegExp(`data-details-key="delegation-session-${String(attempt)}-1-ses_child_1"`, "u"),
  );
  assert.match(html, new RegExp(`data-live-key="delegation-invocation-${String(attempt)}-1"`, "u"));
  assert.match(html, new RegExp(`data-live-key="delegation-attempt-${String(attempt)}"`, "u"));
  assert.doesNotMatch(html, /%/u);
  store.close();
});

test("a verified record with no activity evidence reads invoked, never running", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  // A record exists but the active map has not been read for it yet.
  observe(store, attempt, 1, "ses_invoked", { rootSessionId: "ses_parent" });

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(500));
  assert.ok(model);
  const delegation = model.attempts[0]?.delegation;
  assert.equal(delegation?.observed, 1);
  assert.equal(delegation?.invoked, 1);
  assert.equal(delegation?.running, 0);
  assert.equal(delegation?.invocations[0]?.nodes[0]?.state, "invoked");

  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.match(html, /data-status-value="invoked"/u);
  assert.match(html, /1 invoked/u);
  assert.doesNotMatch(html, /%/u);
  store.close();
});

test("a child absent from the foreground active map is visibly limited, never idle", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  observe(store, attempt, 1, "ses_background", {
    rootSessionId: "ses_root",
    parentSessionId: "ses_root",
  });
  assert.equal(
    recordDelegationCoverage(store.db, {
      attemptId: attempt,
      invocationOrdinal: 1,
      at: iso(0),
      transport: "polling",
      transportState: "degraded",
    }).ok,
    true,
  );
  assert.equal(
    reportDelegationGap(store.db, {
      attemptId: attempt,
      invocationOrdinal: 1,
      signature: "active-map-scope-limited",
      detail: "delegation observation gap: active-map-scope-limited",
      at: iso(0),
    }).ok,
    true,
  );

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(500));
  assert.ok(model);
  const delegation = model.attempts[0]?.delegation;
  assert.equal(delegation?.availability, "partial");
  assert.equal(delegation?.invoked, 1);
  assert.equal(delegation?.invocations[0]?.nodes[0]?.state, "invoked");

  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.match(html, /data-status-value="invoked"/u);
  assert.match(
    html,
    /Child activity is unknown when a session is absent from the foreground active map; absence does not establish idle or completion\./u,
  );
  assert.doesNotMatch(html, /data-status-value="idle"/u);
  store.close();
});

test("a healthy root with zero children reads 'no delegations observed yet'", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  // The root invocation session itself is observed, but no child is.
  observe(store, attempt, 1, "ses_root", {
    rootSessionId: "ses_root",
    depth: 0,
    agent: `attempt-${String(attempt)}/orchestrator`,
    active: true,
  });

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(500));
  assert.ok(model);
  const delegation = model.attempts[0]?.delegation;
  assert.equal(delegation?.observed, 0, "the root is not a delegation");
  assert.equal(delegation?.running, 0);
  assert.equal(delegation?.availability, "observed");

  const dashboard = readDashboard(store.db, [], { now: iso(500) });
  assert.equal(dashboard.jobs[0]?.delegation?.observed, 0);

  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.match(html, /No delegations observed yet/u);
  assert.match(html, /data-delegation-root>invocation root/u);
  // The root node stays visible (with its observed state) but is not counted.
  assert.match(html, /data-observed-session="ses_root"/u);
  assert.match(html, /data-observed-state="running"/u);
  assert.doesNotMatch(html, /1 active/u);
  store.close();
});

test("root plus two children counts only the children and keeps the root visible", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId: repo,
    expectedRevision: 0,
    candidate: managedProfile(),
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    saveOpenCodeSelection(store.db, {
      repoId: repo,
      expectedRevision: 0,
      expectedProfileRevision: saved.revision,
      candidate: { source: "managed" },
    });
  }
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  const namespace = `attempt-${String(attempt)}`;
  observe(store, attempt, 1, "ses_root", {
    rootSessionId: "ses_root",
    depth: 0,
    agent: `${namespace}/orchestrator`,
    active: true,
  });
  observe(store, attempt, 1, "ses_child_1", {
    rootSessionId: "ses_root",
    parentSessionId: "ses_root",
    depth: 1,
    agent: `${namespace}/spec-checker`,
    active: true,
  });
  observe(store, attempt, 1, "ses_child_2", {
    rootSessionId: "ses_root",
    parentSessionId: "ses_root",
    depth: 1,
    agent: `${namespace}/spec-checker`,
    active: false,
    outcome: "succeeded",
  });

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(500));
  assert.ok(model);
  const delegation = model.attempts[0]?.delegation;
  assert.equal(delegation?.observed, 2);
  assert.equal(delegation?.running, 1);
  assert.equal(delegation?.succeeded, 1);

  const html = jobRegions(model, "UTC")["job-detail-region"];
  // Root node remains visible and labeled, children are keyed separately.
  assert.match(html, /data-observed-session="ses_root"/u);
  assert.match(html, /data-delegation-root>invocation root/u);
  assert.match(html, new RegExp(`data-observed-session="ses_child_1"`, "u"));
  assert.match(html, new RegExp(`data-observed-session="ses_child_2"`, "u"));
  assert.match(
    html,
    /<ul class="child-sessions delegation-tree"><li><details class="delegation-session"[^>]*data-observed-session="ses_root"[\s\S]*?<\/details><ul class="child-sessions delegation-tree"><li><details class="delegation-session"[^>]*data-observed-session="ses_child_1"/u,
    "the root must contain its verified children in nested list markup",
  );
  assert.match(html, /2 observed/u);
  store.close();
});

test("node attributes carry a stable announcement label and explicit unknown model", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId: repo,
    expectedRevision: 0,
    candidate: managedProfile(),
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    saveOpenCodeSelection(store.db, {
      repoId: repo,
      expectedRevision: 0,
      expectedProfileRevision: saved.revision,
      candidate: { source: "managed" },
    });
  }
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  const friendly = `attempt-${String(attempt)}/spec-checker`;
  observe(store, attempt, 1, "ses_friendly", { agent: friendly, active: true });
  observe(store, attempt, 2, "ses_unknown", { active: false });

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(500));
  assert.ok(model);
  const html = jobRegions(model, "UTC")["job-detail-region"];

  // Acceptance attributes on the self-keyed details.
  assert.match(html, /data-observed-session="ses_friendly"/u);
  assert.match(html, /data-observed-state="running"/u);
  const label = `Attempt 1, invocation 1, agent spec-checker, session ses_friendly`;
  assert.match(html, new RegExp(`data-announcement-label="${label}"`, "u"));
  const unknownLabel = `Attempt 1, invocation 2, agent unknown, session ses_unknown`;
  assert.match(html, new RegExp(`data-announcement-label="${unknownLabel}"`, "u"));
  // The label is stable identity only: never a state, poll time or clock.
  assert.doesNotMatch(label, /running|unknown state|\d{2}:\d{2}|2026/u);
  // Unknown model is explicit, not silently omitted.
  assert.match(html, /data-delegation-model-unknown>unknown model/u);
  store.close();
});

test("dashboard summary is scoped to the latest attempt while detail keeps history", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const firstAttempt = insertAttempt(store, job, "opencode", 1);
  const secondAttempt = insertAttempt(store, job, "opencode", 2);
  observe(store, firstAttempt, 1, "ses_old", { active: false, outcome: "failed" });
  observe(store, secondAttempt, 1, "ses_new", { active: true });

  const model = readDashboard(store.db, [], { now: iso(500) });
  const summary = model.jobs.find((entry) => entry.id === job)?.delegation;
  assert.equal(summary?.scope, "latest-attempt");
  assert.equal(summary?.observed, 1, "only the latest attempt contributes to the dashboard");
  assert.equal(summary?.running, 1);
  assert.equal(summary?.failed, 0);

  const html = dashboardRegions(model).jobs;
  assert.match(html, /data-delegation-scope="latest-attempt"/u);

  // Job detail still shows the full captured attempt history.
  const detail = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(500));
  assert.ok(detail);
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.attempts[0]?.delegation?.failed, 1);
  assert.equal(detail.attempts[1]?.delegation?.running, 1);
  store.close();
});

test("repeated roots across attempts keep separate keys and legacy evidence stays limited", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const firstAttempt = insertAttempt(store, job, "opencode", 1);
  const secondAttempt = insertAttempt(store, job, "opencode", 2);
  observe(store, firstAttempt, 1, "ses_shared", { active: false, outcome: "succeeded" });
  observe(store, secondAttempt, 1, "ses_shared", { active: true });

  // An attributable legacy managed child for a third attempt is explicit,
  // limited historical evidence rather than a live invocation.
  const legacyAttempt = insertAttempt(store, job, "opencode", 3);
  store.db
    .prepare(
      `INSERT INTO opencode_invocations
         (attempt_id, invocation_ordinal, status, ownership_state, requested_source, parent_session_id)
       VALUES (?, 1, 'launched', 'captured', 'managed', 'ses_legacy_root')`,
    )
    .run(legacyAttempt);
  store.db
    .prepare(
      `INSERT INTO managed_child_sessions (attempt_id, session_id, outcome, state, interrupted)
       VALUES (?, 'ses_legacy', 'failed', 'settled', 0)`,
    )
    .run(legacyAttempt);
  assert.equal(
    importLegacyManagedChildObservations(store.db, { attemptId: legacyAttempt, at: iso(0) }).ok,
    true,
  );

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(1_000));
  assert.ok(model);
  const first = model.attempts.find((attempt) => attempt.id === firstAttempt)?.delegation;
  const second = model.attempts.find((attempt) => attempt.id === secondAttempt)?.delegation;
  // The same session id in two attempts is still two distinct nodes.
  assert.equal(first?.observed, 1);
  assert.equal(second?.observed, 1);
  assert.equal(first?.succeeded, 1);
  assert.equal(second?.running, 1);

  const legacy = model.attempts.find((attempt) => attempt.id === legacyAttempt)?.delegation;
  assert.equal(legacy?.observed, 1);
  assert.equal(legacy?.failed, 1);
  assert.equal(legacy?.availability, "partial");
  assert.equal(legacy?.invocations[0]?.nodes[0]?.limitedUncertainty, true);

  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.match(
    html,
    new RegExp(`data-live-key="delegation-session-${String(firstAttempt)}-1-ses_shared"`, "u"),
  );
  assert.match(
    html,
    new RegExp(`data-live-key="delegation-session-${String(secondAttempt)}-1-ses_shared"`, "u"),
  );
  assert.match(html, /limited evidence/u);
  store.close();
});

test("native and default OpenCode jobs show raw runtime ids without a configured team", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "native");
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId: repo,
      expectedRevision: 0,
      candidate: { source: "native", agentId: "reviewer" },
    }).ok,
    true,
  );
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  observe(store, attempt, 1, "ses_child", { agent: "reviewer", active: true });

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(1_000));
  assert.ok(model);
  assert.equal(model.job.opencodeSelection?.source, "native");
  const delegation = model.attempts[0]?.delegation;
  assert.equal(delegation?.configured.length, 0);
  const node = delegation?.invocations[0]?.nodes[0];
  assert.equal(node?.agentFriendly, false);
  assert.equal(node?.agentLabel, "reviewer");

  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.doesNotMatch(html, /data-delegation-configured/u);
  assert.match(html, /data-delegation-identity-raw>reviewer/u);
  store.close();
});

test("cline jobs disclose limited observability instead of no subagents", () => {
  const store = openStore();
  const repo = insertRepository(store, "cline", "plain");
  const job = createJob(store, repo);
  insertAttempt(store, job, "cline");
  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(1_000));
  assert.ok(model);
  const delegation = model.attempts[0]?.delegation;
  assert.equal(delegation?.availability, "unsupported");
  assert.equal(delegation?.observed, 0);
  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.match(html, /Delegation not observable for this executor/u);
  assert.doesNotMatch(html, /No child sessions recorded/u);
  assert.doesNotMatch(html, /%/u);
  store.close();
});

/* ------------------------------------------------------------------ *
 * 4.2 Partial coverage, gaps and observed-time copy
 * ------------------------------------------------------------------ */

test("unavailable coverage and open gaps render explicitly, with observed/source duration labels", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  observe(store, attempt, 1, "ses_child", {
    active: true,
    sourceCreatedAt: iso(0),
    sourceUpdatedAt: iso(400),
  });
  assert.equal(
    recordDelegationCoverage(store.db, {
      attemptId: attempt,
      invocationOrdinal: 1,
      at: iso(1_000),
      transportState: "unavailable",
    }).ok,
    true,
  );
  assert.equal(
    reportDelegationGap(store.db, {
      attemptId: attempt,
      invocationOrdinal: 1,
      signature: "source-lost",
      detail: `listing failed with ${SECRET}`,
      at: iso(1_000),
    }).ok,
    true,
  );

  const model = readJobDetail(store.db, job, [SECRET], ".gremlyn", undefined, iso(1_000));
  assert.ok(model);
  const delegation = model.attempts[0]?.delegation;
  assert.equal(delegation?.availability, "unavailable");
  assert.equal(delegation?.coverage, "unavailable");
  assert.equal(delegation?.invocations[0]?.openGaps.length, 1);
  assert.equal(JSON.stringify(model).includes(SECRET), false, "gap detail is redacted");

  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.match(html, /Observation source is unavailable/u);
  assert.match(html, /Observation gap: listing failed with \[redacted\]/u);
  // Honest durations: observed span first, source record span only when both
  // source bounds exist, and never a source "activity"/heartbeat claim.
  assert.match(html, /observed span<\/span>/u, "observed duration is labeled");
  assert.match(html, /source record span \(not execution end\)/u);
  assert.doesNotMatch(html, /source activity/u);
  assert.doesNotMatch(html, /heartbeat/u);

  // Reconciling the gap closes it but retains the historical note.
  assert.equal(
    reconcileDelegationGaps(store.db, { attemptId: attempt, invocationOrdinal: 1, at: iso(2_000) })
      .ok,
    true,
  );
  const reconciled = readJobDetail(store.db, job, [SECRET], ".gremlyn", undefined, iso(2_000));
  assert.ok(reconciled);
  assert.equal(reconciled.attempts[0]?.delegation?.invocations[0]?.openGaps.length, 0);
  assert.equal(reconciled.attempts[0]?.delegation?.invocations[0]?.reconciledGaps, 1);
  const reconciledHtml = jobRegions(reconciled, "UTC")["job-detail-region"];
  assert.match(reconciledHtml, /earlier observation gap reconciled/u);
  store.close();
});

/* ------------------------------------------------------------------ *
 * 4.3 Ticker and authenticated fragments
 * ------------------------------------------------------------------ */

test("a child-only observation change refreshes the shared ticker without any job change", async () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  const ticker = new SharedChangeTicker(store.db, 25, ".");
  const changes: StreamChange[] = [];
  const unsubscribe = ticker.subscribe((change) => changes.push(change));
  try {
    // Let the initial signature settle.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = changes.length;
    observe(store, attempt, 1, "ses_child", { active: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const changed = changes.slice(before).some((change) => change.kind === "change");
    assert.equal(changed, true, "a child-only observation change must emit a change tick");
  } finally {
    unsubscribe();
    ticker.stop();
    store.close();
  }
});

test("a live observation crossing the staleness window refreshes without a write", async () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  const ticker = new SharedChangeTicker(store.db, 25, ".");
  const changes: StreamChange[] = [];
  const unsubscribe = ticker.subscribe((change) => changes.push(change));
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Recorded 1.5s ago, so it is fresh now but crosses the 2s window shortly.
    assert.equal(
      recordDelegationObservation(store.db, {
        attemptId: attempt,
        invocationOrdinal: 1,
        sessionId: "ses_live",
        observedAt: new Date(Date.now() - 1_500).toISOString(),
        sourceKind: "session-poll",
        active: true,
      }).ok,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterWrite = changes.length;
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    assert.ok(
      changes.length > afterWrite,
      "the ticker must refresh when a live observation becomes stale",
    );
  } finally {
    unsubscribe();
    ticker.stop();
    store.close();
  }
});

test("a stale sibling expiry refreshes while another child stays fresh", async () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  const ticker = new SharedChangeTicker(store.db, 25, ".");
  const changes: StreamChange[] = [];
  const unsubscribe = ticker.subscribe((change) => changes.push(change));
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    // One child was observed 1.5s ago (expires in ~0.5s); the other just now.
    assert.equal(
      recordDelegationObservation(store.db, {
        attemptId: attempt,
        invocationOrdinal: 1,
        sessionId: "ses_expiring",
        observedAt: new Date(Date.now() - 1_500).toISOString(),
        sourceKind: "session-poll",
        active: true,
      }).ok,
      true,
    );
    assert.equal(
      recordDelegationObservation(store.db, {
        attemptId: attempt,
        invocationOrdinal: 1,
        sessionId: "ses_fresh",
        observedAt: new Date().toISOString(),
        sourceKind: "session-poll",
        active: true,
      }).ok,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterWrite = changes.length;
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    assert.ok(
      changes.length > afterWrite,
      "the expiring sibling must change the signature while the other stays fresh",
    );
  } finally {
    unsubscribe();
    ticker.stop();
    store.close();
  }
});

test("stale historical observations never cause constant ticker changes", async () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  // A long-stale unresolved record: it must not keep the signature moving and
  // its (bounded) history must not be rescanned into periodic changes.
  assert.equal(
    recordDelegationObservation(store.db, {
      attemptId: attempt,
      invocationOrdinal: 1,
      sessionId: "ses_historical",
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      sourceKind: "session-poll",
      active: true,
    }).ok,
    true,
  );
  const ticker = new SharedChangeTicker(store.db, 25, ".");
  const changes: StreamChange[] = [];
  const unsubscribe = ticker.subscribe((change) => changes.push(change));
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const settled = changes.length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after = changes.slice(settled).filter((change) => change.kind === "change");
    assert.equal(after.length, 0, "stale history must stay a quiet heartbeat");
  } finally {
    unsubscribe();
    ticker.stop();
    store.close();
  }
});

test("unauthenticated live streams expose no telemetry", async () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  observe(store, attempt, 1, "ses_secret_child", { active: true });
  const app = buildConsoleServer({
    db: store.db,
    token: "console-token",
    secrets: [],
    operatorActions: new OperatorActionStore(store.db),
    dataDir: ".",
  });
  try {
    const stream = await app.inject({ method: "GET", url: "/stream" });
    assert.equal(stream.statusCode, 401);
    assert.equal(stream.body.includes("ses_secret_child"), false);
    assert.equal(stream.body.includes("delegation"), false);
    const dashboard = await app.inject({ method: "GET", url: "/" });
    assert.equal(dashboard.statusCode, 401);
    assert.equal(dashboard.body.includes("ses_secret_child"), false);
  } finally {
    await app.close();
    store.close();
  }
});

/* ------------------------------------------------------------------ *
 * 4.5 Freshness, cancellation separation and scoped announcements
 * ------------------------------------------------------------------ */

test("a stale running node becomes unknown with no inferred cancellation", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  observe(store, attempt, 1, "ses_child", { active: true });

  // Ten seconds after the last observation the live state is no longer asserted.
  const stale = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(10_000));
  assert.ok(stale);
  const staleNode = stale.attempts[0]?.delegation?.invocations[0]?.nodes[0];
  assert.equal(staleNode?.state, "unknown");
  assert.equal(staleNode?.cancellationRequested, false);
  const staleHtml = jobRegions(stale, "UTC")["job-detail-region"];
  assert.match(staleHtml, /data-status-value="unknown"/u);
  assert.doesNotMatch(staleHtml, /cancellation requested/u);
  assert.doesNotMatch(staleHtml, /interrupted/u);

  // A cancellation request is separate from any confirmed interruption.
  assert.equal(
    recordDelegationCancellationRequest(store.db, {
      attemptId: attempt,
      invocationOrdinal: 1,
      sessionId: "ses_child",
      at: iso(1_500),
    }).ok,
    true,
  );
  const fresh = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(1_600));
  assert.ok(fresh);
  const freshNode = fresh.attempts[0]?.delegation?.invocations[0]?.nodes[0];
  assert.equal(freshNode?.state, "running");
  assert.equal(freshNode?.cancellationRequested, true);
  assert.equal(freshNode?.outcome, null);

  const freshHtml = jobRegions(fresh, "UTC")["job-detail-region"];
  assert.match(freshHtml, /data-cancellation-request>cancellation requested/u);
  assert.doesNotMatch(freshHtml, /outcome interrupted/u);
  store.close();
});

test("node state is the only semantic announcement hook; timestamps stay quiet", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  observe(store, attempt, 1, "ses_running", { active: true });
  observe(store, attempt, 1, "ses_done", { active: false, outcome: "failed" });

  const model = readJobDetail(store.db, job, [], ".gremlyn", undefined, iso(500));
  assert.ok(model);
  const html = jobRegions(model, "UTC")["job-detail-region"];
  // State transitions are announced through data-status-value...
  assert.match(html, /data-status-value="running"/u);
  assert.match(html, /data-status-value="failed"/u);
  // ...while observation timestamps are ordinary time elements, so routine
  // polls and clock ticks never announce.
  assert.ok((html.match(/data-console-time/gu) ?? []).length >= 1);
  assert.ok(
    (html.match(/data-status-value="(running|idle|succeeded|failed|interrupted|unknown)"/gu) ?? [])
      .length >= 2,
  );
  store.close();
});

test("observation reads are redacted and never leak configured instruction text", () => {
  const store = openStore();
  const repo = insertRepository(store, "opencode", "managed");
  const job = createJob(store, repo);
  const attempt = insertAttempt(store, job, "opencode");
  observe(store, attempt, 1, `ses_${SECRET}`, {
    agent: `raw-${SECRET}`,
    model: `provider/${SECRET}`,
    active: true,
  });
  const model = readJobDetail(store.db, job, [SECRET], ".gremlyn", undefined, iso(500));
  assert.ok(model);
  assert.equal(JSON.stringify(model).includes(SECRET), false);
  const html = jobRegions(model, "UTC")["job-detail-region"];
  assert.equal(html.includes(SECRET), false, "session/agent/model strings are redacted in HTML");
  // The redacted session still renders and remains keyed.
  assert.match(html, /delegation-session-/u);
  store.close();
});
