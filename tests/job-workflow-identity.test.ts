/**
 * Tests for change tasks 4.1-4.2 (make-agent-activation-explicit): the job
 * view renders captured workflow and current actual-primary identity
 * prominently near the job title, names the new-jobs/retry boundary when
 * current settings differ, and places a concise observed-delegation status
 * beside that identity while retaining the existing expandable
 * attempt/invocation trees.
 *
 * Owned view scope only: fixtures build `JobDetail` through `readJobDetail`
 * (whose `JobDetail.workflow` projection supplies the facts) and assert on the
 * rendered `job-detail-region` HTML. No routes, stores, assets or dashboard
 * surfaces are exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import {
  recordDelegationCoverage,
  recordDelegationObservation,
  reportDelegationGap,
} from "../src/store/delegation-observations.js";
import { readJobDetail } from "../src/console/queries.js";
import { jobRegions } from "../src/console/views/job.js";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const SECRET = "vault-secret";

function iso(): string {
  return new Date(T0).toISOString();
}

function openStore(): Store {
  return new Store({ dataDir: ".", file: ":memory:" });
}

function insertRepository(store: Store, agent: string): number {
  const plain = agent !== "opencode";
  return Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', ?, 'source', 'workspaces', ?, ?, ?, 'high', 1)`,
      )
      .run(
        agent === "opencode" ? "widgets" : "docs",
        agent,
        plain ? "gpt-5.4" : "opencode/gpt-5.4",
        plain ? "openai" : "opencode",
      ).lastInsertRowid,
  );
}

let jobSequence = 0;

function createJob(store: Store, repoId: number, status = "succeeded"): number {
  jobSequence += 1;
  const pr = 200 + jobSequence;
  const created = new JobStore(store.db).createJob({
    repoId,
    prNumber: pr,
    commentId: pr * 100,
    command: "RESOLVE",
    threadId: String(pr * 100),
    authorLogin: "owner",
    observedAt: iso(),
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
        `INSERT INTO attempts (job_id, attempt_number, agent, model, provider, effort)
         VALUES (?, ?, ?, 'opencode/gpt-5.4', '', 'high')`,
      )
      .run(jobId, number, agent).lastInsertRowid,
  );
}

function insertInvocation(
  store: Store,
  attemptId: number,
  ordinal: number,
  fields: {
    source?: string;
    nativeId?: string | null;
    profileRevision?: number | null;
    primary?: string | null;
    model?: string | null;
    launchedAt?: string | null;
  } = {},
): void {
  store.db
    .prepare(
      `INSERT INTO opencode_invocations
         (attempt_id, invocation_ordinal, status, ownership_state, requested_source,
          requested_native_agent_id, requested_profile_revision, parent_session_id,
          actual_primary_agent, actual_model, launched_at)
       VALUES (?, ?, 'settled', 'settled', ?, ?, ?, 'ses_parent', ?, ?, ?)`,
    )
    .run(
      attemptId,
      ordinal,
      fields.source ?? "default",
      fields.nativeId ?? null,
      fields.profileRevision ?? null,
      fields.primary ?? null,
      fields.model ?? null,
      fields.launchedAt ?? null,
    );
}

function saveTeam(store: Store, repoId: number, subagents: unknown[] = []): number {
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: {
      version: 1,
      primary: { id: "primary-reviewer", description: "Primary", permissions: ["edit"] },
      subagents,
    },
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error(`profile save failed: ${saved.reason}`);
  return saved.revision;
}

function selectManaged(store: Store, repoId: number, profileRevision: number): void {
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId,
      expectedRevision: 0,
      expectedProfileRevision: profileRevision,
      candidate: { source: "managed" },
    }).ok,
    true,
  );
}

function selectNative(store: Store, repoId: number, agentId: string): void {
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId,
      expectedRevision: 0,
      candidate: { source: "native", agentId },
    }).ok,
    true,
  );
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
    observedAt: iso(),
    sourceKind: "session-poll",
    ...extra,
  });
  assert.equal(result.ok, true, `observation ${sessionId} should persist`);
}

function detailRegion(store: Store, jobId: number, secrets: (string | undefined)[] = []): string {
  const model = readJobDetail(
    store.db,
    jobId,
    secrets.filter((v): v is string => v !== undefined),
    ".gremlyn",
    undefined,
    new Date(T0 + 1_000).toISOString(),
  );
  assert.ok(model);
  return jobRegions(model)["job-detail-region"];
}

/** The band's HTML only: from `data-job-workflow` up to the job links. */
function bandHtml(html: string): string {
  const start = html.indexOf("data-job-workflow");
  const end = html.indexOf('class="job-links"');
  assert.ok(start >= 0, "the workflow band must be present");
  assert.ok(end > start, "the band must sit before the links");
  return html.slice(start, end);
}

/** The requested-runner cell only, so assertions never leak into the notes. */
function requestedRunnerCell(band: string): string {
  const match = band.match(/Requested runner<\/dt><dd>([\s\S]*?)<\/dd>/u);
  return match?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// 4.1 Captured workflow and current actual-primary identity
// ---------------------------------------------------------------------------

test("the band names the captured runner and the observed actual primary near the title", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const revision = saveTeam(store, repoId);
  selectManaged(store, repoId, revision);
  const jobId = createJob(store, repoId);
  const attemptId = insertAttempt(store, jobId, "opencode");
  insertInvocation(store, attemptId, 1, {
    source: "managed",
    profileRevision: revision,
    primary: "primary-reviewer",
    model: "opencode/gpt-5.4",
    launchedAt: iso(),
  });

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  // Prominent and near the title: before the links and the stat strip.
  assert.ok(html.indexOf("data-job-workflow") < html.indexOf("job-links"));
  assert.ok(html.indexOf("data-job-workflow") < html.indexOf("stat-strip"));
  // Captured runner names the captured team revision and primary.
  assert.match(band, /Requested runner/u);
  assert.match(band, /Gremlyn-managed team <code>primary-reviewer<\/code> · revision 1/u);
  // Actual identity is observed, with provenance and model.
  assert.match(band, /Actual primary <span class="muted">attempt 1 · invocation 1<\/span>/u);
  assert.match(band, /data-job-actual-state="observed"/u);
  assert.match(band, /data-job-actual-primary="primary-reviewer"/u);
  assert.match(band, /model <code>opencode\/gpt-5\.4<\/code>/u);
  // Settings match, so no new-jobs/retry note and no discrepancy note.
  assert.doesNotMatch(band, /data-job-settings-differ/u);
  assert.doesNotMatch(band, /data-job-discrepancy/u);
  assert.doesNotMatch(band, /New jobs use the current settings/u);
  store.close();
});

test("a pre-activation default job keeps default as its captured runner after activation", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const jobId = createJob(store, repoId);
  const attemptId = insertAttempt(store, jobId, "opencode");
  insertInvocation(store, attemptId, 1, { source: "default", primary: "build", launchedAt: iso() });
  // The repository activates a managed team after the job was created.
  const revision = saveTeam(store, repoId);
  selectManaged(store, repoId, revision);

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  // The captured runner is still OpenCode default — never the current team.
  assert.match(requestedRunnerCell(band), /^OpenCode default$/u);
  assert.doesNotMatch(requestedRunnerCell(band), /Gremlyn-managed team|primary-reviewer/u);
  // The boundary is stated; default resolution to build is not a discrepancy.
  assert.match(band, /data-job-settings-differ/u);
  assert.match(
    band,
    /Current repository settings now select the Gremlyn-managed team at revision 1/u,
  );
  assert.match(
    band,
    /New jobs use the current settings; retrying this job keeps its recorded selection\./u,
  );
  assert.match(band, /data-job-actual-state="observed" data-job-actual-primary="build"/u);
  assert.doesNotMatch(band, /data-job-discrepancy/u);
  store.close();
});

test("a native selection change is a difference while the job keeps its captured id", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  selectNative(store, repoId, "native-reviewer");
  const jobId = createJob(store, repoId);
  const attemptId = insertAttempt(store, jobId, "opencode");
  insertInvocation(store, attemptId, 1, {
    source: "native",
    nativeId: "native-reviewer",
    primary: "native-reviewer",
    launchedAt: iso(),
  });
  // The repository switches to a different native agent afterwards.
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId,
      expectedRevision: 1,
      candidate: { source: "native", agentId: "newer-native" },
    }).ok,
    true,
  );

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  assert.match(
    band,
    /Requested runner<\/dt><dd>Existing OpenCode agent <code>native-reviewer<\/code><\/dd>/u,
  );
  assert.match(band, /data-job-settings-differ/u);
  assert.match(
    band,
    /Current repository settings now select Existing OpenCode agent <code>newer-native<\/code>/u,
  );
  // Runtime evidence is untouched by the settings change.
  assert.match(band, /data-job-actual-primary="native-reviewer"/u);
  assert.doesNotMatch(band, /data-job-discrepancy/u);
  store.close();
});

test("a preparing retry says Not started while earlier attempt identities stay in history", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  selectNative(store, repoId, "native-reviewer");
  const jobId = createJob(store, repoId, "running");
  const firstAttempt = insertAttempt(store, jobId, "opencode", 1);
  insertInvocation(store, firstAttempt, 1, {
    source: "native",
    nativeId: "native-reviewer",
    primary: "observed-runner",
    launchedAt: iso(),
  });
  // The current retry is still preparing: journaled, never launched.
  insertAttempt(store, jobId, "opencode", 2);

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  assert.match(band, /data-job-actual-state="not-started"/u);
  assert.match(band, />Not started<\/span>/u);
  assert.doesNotMatch(band, /Not observed/u);
  // The panel history preserves the earlier attempt's identity.
  assert.match(html, /attempt 1<\/span><span class="chip">invocation 1/u);
  assert.match(html, /<code>observed-runner<\/code>/u);
  store.close();
});

test("launched but unobserved identity reads Not observed and borrows no older evidence", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const jobId = createJob(store, repoId);
  const firstAttempt = insertAttempt(store, jobId, "opencode", 1);
  insertInvocation(store, firstAttempt, 1, { primary: "older-known", launchedAt: iso() });
  const secondAttempt = insertAttempt(store, jobId, "opencode", 2);
  insertInvocation(store, secondAttempt, 1, { primary: null, launchedAt: iso() });

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  assert.match(band, /data-job-actual-state="not-observed"/u);
  assert.match(band, />Not observed<\/span>/u);
  // The current identity never becomes the earlier known runner.
  assert.doesNotMatch(band, /older-known/u);
  assert.doesNotMatch(band, /data-job-actual-state="observed"/u);
  // History still shows the older known identity.
  assert.match(html, /<code>older-known<\/code>/u);
  store.close();
});

test("an explicit native discrepancy shows both requested and observed identities", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  selectNative(store, repoId, "native-reviewer");
  const jobId = createJob(store, repoId);
  const attemptId = insertAttempt(store, jobId, "opencode");
  insertInvocation(store, attemptId, 1, {
    source: "native",
    nativeId: "native-reviewer",
    primary: "unexpected-runner",
    launchedAt: iso(),
  });

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  assert.match(
    band,
    /data-job-actual-state="observed" data-job-actual-primary="unexpected-runner"/u,
  );
  assert.match(band, /data-job-discrepancy/u);
  assert.match(
    band,
    /The observed primary <code>unexpected-runner<\/code> differs from the requested <code>native-reviewer<\/code>\./u,
  );
  // Neither value is overwritten; the panel keeps both too.
  assert.match(html, /requested native <code>native-reviewer<\/code>/u);
  assert.match(html, /effective <code>unexpected-runner<\/code>/u);
  store.close();
});

test("an unavailable selected team is named and its repair boundary is stated", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const revision = saveTeam(store, repoId);
  selectManaged(store, repoId, revision);
  const jobId = createJob(store, repoId);
  // The selected team is corrupted after the job captured a valid revision.
  store.db
    .prepare("UPDATE opencode_agent_profiles SET profile_json = ? WHERE repo_id = ?")
    .run("not valid json", repoId);

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  // The job's own capture stays intact and valid.
  assert.match(
    requestedRunnerCell(band),
    /^Gremlyn-managed team <code>primary-reviewer<\/code> · revision 1$/u,
  );
  // The boundary names the unavailable team and never suggests a usable
  // workflow or "new jobs use the current settings".
  assert.match(band, /data-job-settings-differ/u);
  assert.match(
    band,
    /Current repository settings now select the selected Gremlyn-managed team, which is currently unavailable/u,
  );
  assert.match(
    band,
    /New jobs cannot safely use the selected team until it is repaired or the source is changed; retrying this job keeps its recorded selection\./u,
  );
  assert.doesNotMatch(band, /New jobs use the current settings/u);
  assert.doesNotMatch(
    band,
    /select the Gremlyn-managed team at revision/u,
    "an unavailable team must not be named with a usable revision",
  );
  store.close();
});

test("a managed discrepancy names the captured primary and the observed runner", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const revision = saveTeam(store, repoId);
  selectManaged(store, repoId, revision);
  const jobId = createJob(store, repoId);
  const attemptId = insertAttempt(store, jobId, "opencode");
  insertInvocation(store, attemptId, 1, {
    source: "managed",
    profileRevision: revision,
    primary: "different-runner",
    launchedAt: iso(),
  });

  const band = bandHtml(detailRegion(store, jobId));
  assert.match(
    band,
    /The observed primary <code>different-runner<\/code> differs from the requested <code>primary-reviewer<\/code>\./u,
  );
  store.close();
});

test("workflow identities are redacted and non-OpenCode jobs get no band", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  selectNative(store, repoId, `native-${SECRET}`);
  const jobId = createJob(store, repoId);
  const attemptId = insertAttempt(store, jobId, "opencode");
  insertInvocation(store, attemptId, 1, {
    source: "native",
    nativeId: `native-${SECRET}`,
    primary: `runner-${SECRET}`,
    launchedAt: iso(),
  });

  const html = detailRegion(store, jobId, [SECRET]);
  assert.equal(html.includes(SECRET), false);
  const band = bandHtml(html);
  assert.match(band, /Existing OpenCode agent <code>native-\[redacted\]<\/code>/u);
  assert.match(band, /data-job-actual-primary="runner-\[redacted\]"/u);
  assert.match(
    band,
    /The observed primary <code>runner-\[redacted\]<\/code> differs from the requested <code>native-\[redacted\]<\/code>\./u,
  );
  store.close();

  // A non-OpenCode job renders no workflow band at all.
  const clineStore = openStore();
  const clineRepoId = insertRepository(clineStore, "cline");
  const clineJob = createJob(clineStore, clineRepoId);
  insertAttempt(clineStore, clineJob, "cline");
  const clineHtml = detailRegion(clineStore, clineJob);
  assert.doesNotMatch(clineHtml, /data-job-workflow/u);
  assert.doesNotMatch(clineHtml, /Requested runner/u);
  clineStore.close();
});

// ---------------------------------------------------------------------------
// 4.2 Concise observed-delegation status beside the identity
// ---------------------------------------------------------------------------

test("the delegation cell counts only observed children beside the identity", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const revision = saveTeam(store, repoId, [
    { id: "spec-checker", enabled: true, description: "Checks specs", permissions: [] },
  ]);
  selectManaged(store, repoId, revision);
  const jobId = createJob(store, repoId, "running");
  const attemptId = insertAttempt(store, jobId, "opencode");
  const namespace = `attempt-${String(attemptId)}`;
  observe(store, attemptId, 1, "ses_root", {
    rootSessionId: "ses_root",
    depth: 0,
    agent: `${namespace}/primary-reviewer`,
    active: true,
  });
  observe(store, attemptId, 1, "ses_child_active", {
    rootSessionId: "ses_root",
    parentSessionId: "ses_root",
    depth: 1,
    agent: `${namespace}/spec-checker`,
    active: true,
  });
  observe(store, attemptId, 1, "ses_child_done", {
    rootSessionId: "ses_root",
    parentSessionId: "ses_root",
    depth: 1,
    agent: `${namespace}/spec-checker`,
    active: false,
    outcome: "succeeded",
  });

  const html = detailRegion(store, jobId);
  const band = bandHtml(html);
  assert.match(band, /data-delegation-availability="observed"/u);
  assert.match(band, /2 observed · 1 active · 1 completed/u);
  // The root is visible in the tree but never counted as a delegation.
  assert.match(html, /data-delegation-root>invocation root/u);
  assert.doesNotMatch(band, /3 observed/u);
  // The expandable keyed tree is retained for live updates.
  assert.match(html, new RegExp(`data-live-key="delegation-attempt-${String(attemptId)}"`, "u"));
  assert.match(html, /data-live-key="delegation-invocation-/u);
  store.close();
});

test("an active team that has not delegated reads no delegations observed yet", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const revision = saveTeam(store, repoId);
  selectManaged(store, repoId, revision);
  const jobId = createJob(store, repoId, "running");
  const attemptId = insertAttempt(store, jobId, "opencode");
  // Healthy observation has seen only the root invocation — no children.
  observe(store, attemptId, 1, "ses_root", {
    rootSessionId: "ses_root",
    depth: 0,
    agent: `attempt-${String(attemptId)}/primary-reviewer`,
    active: true,
  });

  const band = bandHtml(detailRegion(store, jobId));
  // Activation never reads as evidence that a child ran.
  assert.match(band, /data-delegation-availability="observed"/u);
  assert.match(band, />No delegations observed yet<\/dd>/u);
  assert.doesNotMatch(band, /1 active/u);
  assert.doesNotMatch(band, /completed/u);
  store.close();
});

test("partial observation disclosure is kept beside the identity", () => {
  const store = openStore();
  const repoId = insertRepository(store, "opencode");
  const jobId = createJob(store, repoId, "running");
  const attemptId = insertAttempt(store, jobId, "opencode");
  assert.equal(
    recordDelegationCoverage(store.db, {
      attemptId,
      invocationOrdinal: 1,
      at: iso(),
      transport: "polling",
      transportState: "degraded",
    }).ok,
    true,
  );
  assert.equal(
    reportDelegationGap(store.db, {
      attemptId,
      invocationOrdinal: 1,
      signature: "active-map-scope-limited",
      detail: "delegation observation gap: active-map-scope-limited",
      at: iso(),
    }).ok,
    true,
  );

  const band = bandHtml(detailRegion(store, jobId));
  assert.match(band, /data-delegation-availability="partial"/u);
  assert.match(band, />No delegations observed yet \(partial coverage\)<\/dd>/u);
  // The drilldown disclosure is retained.
  assert.match(band, /partial coverage/u);
  store.close();
});

test("unsupported executors stay limited-data and never masquerade as an empty team", () => {
  const store = openStore();
  const repoId = insertRepository(store, "cline");
  const jobId = createJob(store, repoId);
  insertAttempt(store, jobId, "cline");

  const html = detailRegion(store, jobId);
  // No workflow band (no OpenCode semantics), but the delegation panel
  // discloses limited observability rather than claiming no subagents.
  assert.doesNotMatch(html, /data-job-workflow/u);
  assert.match(html, /Delegation not observable for this executor/u);
  store.close();
});
