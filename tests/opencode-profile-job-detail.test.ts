/**
 * Tests for task 4.4: job detail surfaces the captured OpenCode agent profile
 * name/revision, the delegated child-session outcomes, and the specific
 * configuration or unsettled-child failure details — while keeping full
 * private instructions out of the ordinary audit/status projections.
 *
 * Covers: the redacted profile summary projected from the job snapshot (never
 * the raw snapshot JSON); durable child outcomes grouped per attempt with
 * their terminal state and interrupt flag; fail-closed unsettled/unknown
 * children rendered with their ids; corrupt snapshots projecting nothing; and
 * the view rendering the profile chip and managed-agent panel only when
 * evidence exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { readDashboard, readJobDetail } from "../src/console/queries.js";
import { jobRegions } from "../src/console/views/job.js";

/** Instruction text that must never appear in a job-detail projection. */
const PRIVATE_INSTRUCTION = "PRIVATE-vault-key-fix-the-widget-renderer";

function openStore(): Store {
  return new Store({ dataDir: ".", file: ":memory:" });
}

function insertOpenCodeRepository(store: Store): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', 'opencode', 'opencode/gpt-5.4', 'opencode', 'xhigh', 1)`,
      )
      .run("acme", "widgets").lastInsertRowid,
  );
}

function profileInput(): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary-reviewer",
      description: "Primary review agent",
      instructions: PRIVATE_INSTRUCTION,
      permissions: ["edit", "shell"],
    },
    subagents: [
      {
        id: "spec-checker",
        description: "Spec checker child",
        instructions: PRIVATE_INSTRUCTION,
        enabled: true,
        permissions: ["edit"],
      },
      {
        id: "web-research",
        description: "Web research child",
        enabled: false,
        permissions: [],
      },
    ],
  };
}

function createCapturedJob(store: Store): { jobId: number; revision: number } {
  const repoId = insertOpenCodeRepository(store);
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: profileInput(),
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error(`profile save failed: ${saved.reason}`);
  const created = new JobStore(store.db).createJob({
    repoId,
    prNumber: 42,
    commentId: 1001,
    command: "RESOLVE",
    threadId: "1001",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("duplicate fixture job");
  return { jobId: created.jobId, revision: saved.revision };
}

function insertAttempt(store: Store, jobId: number, attemptNumber: number): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO attempts
           (job_id, attempt_number, agent, model, provider, effort)
         VALUES (?, ?, 'opencode', 'opencode/gpt-5.4', 'opencode', 'xhigh')`,
      )
      .run(jobId, attemptNumber).lastInsertRowid,
  );
}

test("job detail projects the captured primary and revision without the raw snapshot", () => {
  const store = openStore();
  const { jobId, revision } = createCapturedJob(store);
  const attemptId = insertAttempt(store, jobId, 1);
  store.db
    .prepare("UPDATE attempts SET agent_session_id = ?, outcome = 'succeeded' WHERE id = ?")
    .run("ses_parent", attemptId);

  const model = readJobDetail(store.db, jobId, []);
  assert.ok(model);
  const profile = model.job.opencodeProfile;
  assert.equal(profile?.primaryId, "primary-reviewer");
  assert.equal(profile?.revision, revision);
  assert.equal(profile?.subagents.length, 2);

  // The raw snapshot JSON — which carries the operator's private instructions —
  // is never part of the projection, and neither are the instructions.
  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes("opencode_profile_json"), false);
  assert.equal(serialized.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(JSON.stringify(profile).includes("instructions"), false);
  store.close();
});

test("a corrupt captured profile snapshot projects nothing rather than failing the page", () => {
  const store = openStore();
  const { jobId } = createCapturedJob(store);
  store.db
    .prepare("UPDATE jobs SET opencode_profile_json = ? WHERE id = ?")
    .run(">{ not json and certainly not a profile", jobId);

  const model = readJobDetail(store.db, jobId, []);
  assert.ok(model);
  assert.equal(model.job.opencodeProfile, null);
  store.close();
});

test("a job without a captured profile projects no managed agent summary", () => {
  const store = openStore();
  const repoId = insertOpenCodeRepository(store);
  const created = new JobStore(store.db).createJob({
    repoId,
    prNumber: 43,
    commentId: 1002,
    command: "RESOLVE",
    threadId: "1002",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");

  // An ordinary executor can have a parent session id without any managed
  // OpenCode profile; that alone must not create the managed evidence panel.
  const attemptId = insertAttempt(store, created.jobId, 1);
  store.db
    .prepare("UPDATE attempts SET agent_session_id = ? WHERE id = ?")
    .run("ses_plain", attemptId);

  const model = readJobDetail(store.db, created.jobId, []);
  assert.ok(model);
  assert.equal(model.job.opencodeProfile, null);
  const html = jobRegions(model)["job-detail-region"];
  assert.doesNotMatch(html, /Managed OpenCode agent/u);
  assert.doesNotMatch(html, /agent <code>/u);
  store.close();
});

test("settled child outcomes project per attempt with their terminal state", () => {
  const store = openStore();
  const { jobId } = createCapturedJob(store);
  const attemptId = insertAttempt(store, jobId, 1);
  store.db
    .prepare("UPDATE attempts SET agent_session_id = ? WHERE id = ?")
    .run("ses_parent", attemptId);
  store.db
    .prepare(
      `INSERT INTO managed_child_sessions (attempt_id, session_id, outcome, state, interrupted)
       VALUES (?, ?, 'succeeded', 'settled', 0), (?, ?, 'interrupted', 'settled', 1)`,
    )
    .run(attemptId, "ses_child_spec", attemptId, "ses_child_stray");

  const model = readJobDetail(store.db, jobId, []);
  assert.ok(model);
  assert.deepEqual(model.attempts[0]?.childSessions, [
    { sessionId: "ses_child_spec", outcome: "succeeded", state: "settled", interrupted: false },
    { sessionId: "ses_child_stray", outcome: "interrupted", state: "settled", interrupted: true },
  ]);

  const html = jobRegions(model)["job-detail-region"];
  assert.match(html, /Managed OpenCode agent/u);
  assert.match(html, /agent <code>primary-reviewer<\/code> · revision 1/u);
  assert.match(html, /1 enabled subagent/u);
  assert.match(html, /ses_child_spec/u);
  assert.match(html, /interrupted by Gremlyn/u);
  // The private instructions stay out of the rendered HTML too.
  assert.equal(html.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(html.includes("instructions"), false);
  store.close();
});

test("an unsettled or unknown child is shown fail-closed with its id and state", () => {
  const store = openStore();
  const { jobId } = createCapturedJob(store);
  const attemptId = insertAttempt(store, jobId, 1);
  store.db
    .prepare(
      `UPDATE attempts SET agent_session_id = ?, outcome = 'failed',
       failure_stage = 'running', failure_reason = 'managed-child-unsettled',
       failure_detail = ? WHERE id = ?`,
    )
    .run(
      "ses_parent",
      "child session ses_child_running is still running after interrupt within 5000ms grace; " +
        "child session ses_child_hidden returned a session record that cannot be attributed",
      attemptId,
    );
  store.db
    .prepare(
      `INSERT INTO managed_child_sessions (attempt_id, session_id, outcome, state, interrupted)
       VALUES (?, ?, NULL, 'unsettled', 0), (?, ?, NULL, 'unknown', 0)`,
    )
    .run(attemptId, "ses_child_running", attemptId, "ses_child_hidden");

  const model = readJobDetail(store.db, jobId, []);
  assert.ok(model);
  assert.deepEqual(model.attempts[0]?.childSessions, [
    { sessionId: "ses_child_running", outcome: null, state: "unsettled", interrupted: false },
    { sessionId: "ses_child_hidden", outcome: null, state: "unknown", interrupted: false },
  ]);
  const html = jobRegions(model)["job-detail-region"];
  assert.match(html, /ses_child_running/u);
  assert.match(html, /could not be confirmed stopped/u);
  assert.match(html, /ses_child_hidden/u);
  assert.match(html, /state could not be verified/u);
  // The specific failure detail is shown, without the profile's instruction text.
  assert.match(html, /Specific failure detail/u);
  assert.match(html, /still running after interrupt/u);
  assert.equal(html.includes(PRIVATE_INSTRUCTION), false);
  store.close();
});

test("managed failure details are redacted like every other projected string", () => {
  const store = openStore();
  const { jobId } = createCapturedJob(store);
  const attemptId = insertAttempt(store, jobId, 1);
  store.db
    .prepare(
      `UPDATE attempts SET outcome = 'failed', failure_stage = 'running',
       failure_reason = 'managed-preflight-failed',
       failure_detail = ? WHERE id = ?`,
    )
    .run(
      `the generated primary could not be verified; vault-secret leaked into detail; ${PRIVATE_INSTRUCTION}`,
      attemptId,
    );

  const model = readJobDetail(store.db, jobId, ["vault-secret"]);
  assert.ok(model);
  assert.equal(
    model.attempts[0]?.failure_detail,
    "the generated primary could not be verified; [redacted] leaked into detail; [redacted]",
  );
  const html = jobRegions(model)["job-detail-region"];
  assert.equal(html.includes("vault-secret"), false);
  assert.equal(html.includes(PRIVATE_INSTRUCTION), false);
  assert.match(html, /\[redacted\]/u);
  store.close();
});

test("dashboard status lanes never project the raw captured profile snapshot", () => {
  const store = openStore();
  const { jobId } = createCapturedJob(store);
  const model = readDashboard(store.db, []);
  const job = model.jobs.find((entry) => entry.id === jobId);
  assert.ok(job);
  // The job lane carries only the dashboard fields — never the snapshot JSON
  // whose content includes the operator's private instructions.
  assert.equal(JSON.stringify(job).includes("opencode_profile_json"), false);
  assert.equal(JSON.stringify(job).includes(PRIVATE_INSTRUCTION), false);
  store.close();
});
