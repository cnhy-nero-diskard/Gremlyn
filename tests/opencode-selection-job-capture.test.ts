/**
 * Tests for tasks 2.4/2.5: selection capture inside the command-claim
 * transaction and resolution from the job's own capture across retries and a
 * database reopen (`src/store/jobs.ts`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { JobStore, resolveCapturedOpenCodeSelection } from "../src/store/jobs.js";
import {
  canonicalOpenCodeProfileJson,
  parseOpenCodeAgentProfile,
} from "../src/config/opencode-profile.js";
import {
  clearOpenCodeAgentProfile,
  readOpenCodeProfile,
  saveOpenCodeAgentProfile,
} from "../src/store/opencode-profiles.js";
import { readOpenCodeSelection, saveOpenCodeSelection } from "../src/store/opencode-selections.js";

function openStore(dir?: string): Store {
  return dir === undefined
    ? new Store({ dataDir: ".", file: ":memory:" })
    : new Store({ dataDir: dir, file: join(dir, "gremlyn.db") });
}

function insertRepository(db: Store["db"], agent = "opencode", name = "web"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', ?, 'opencode/gpt-5.4', 'opencode', 'xhigh', 1)`,
      )
      .run("acme", name, agent).lastInsertRowid,
  );
}

function profileInput(description = "Profile A"): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description,
      permissions: ["edit", "shell", "web", "skill"],
    },
    subagents: [{ id: "reviewer", description: "Reviewer", enabled: true, permissions: [] }],
  };
}

function profileJson(description = "Profile A"): string {
  return canonicalOpenCodeProfileJson(parseOpenCodeAgentProfile(profileInput(description)));
}

function saveProfile(db: Store["db"], repoId: number, description = "Profile A"): number {
  const result = saveOpenCodeAgentProfile(db, {
    repoId,
    expectedRevision: 0,
    candidate: profileInput(description),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result.revision;
}

function activateManaged(db: Store["db"], repoId: number, expectedProfileRevision: number): void {
  const result = saveOpenCodeSelection(db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "managed" },
    expectedProfileRevision,
  });
  assert.equal(result.ok, true);
}

function createJob(jobs: JobStore, repoId: number, commentId: number): number {
  const created = jobs.createJob({
    repoId,
    prNumber: 42,
    commentId,
    command: "RESOLVE",
    threadId: String(commentId),
    authorLogin: "owner",
    observedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("duplicate job fixture");
  return created.jobId;
}

test("a managed job captures the active profile and selection revision at claim time", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  activateManaged(store.db, repoId, 1);

  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  const job = jobs.getJob(jobId);

  assert.equal(job.opencode_source, "managed");
  assert.equal(job.opencode_native_agent_id, null);
  assert.equal(job.opencode_selection_revision, 1);
  assert.equal(job.opencode_profile_json, profileJson());
  assert.equal(job.opencode_profile_revision, 1);
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "managed", profileRevision: 1 });
  store.close();
});

test("a native job captures the id and never materializes a dormant profile", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  activateManaged(store.db, repoId, 1);
  const switched = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: { source: "native", agentId: "reviewer" },
  });
  assert.equal(switched.ok, true);

  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  const job = jobs.getJob(jobId);
  assert.equal(job.opencode_source, "native");
  assert.equal(job.opencode_native_agent_id, "reviewer");
  assert.equal(job.opencode_selection_revision, 2);
  assert.equal(job.opencode_profile_json, null);
  assert.equal(job.opencode_profile_revision, null);
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "native", agentId: "reviewer" });
  store.close();
});

test("a default job captures default and omits any profile", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  const toDefault = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "default" },
  });
  assert.equal(toDefault.ok, true);

  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  const job = jobs.getJob(jobId);
  assert.equal(job.opencode_source, "default");
  assert.equal(job.opencode_native_agent_id, null);
  assert.equal(job.opencode_selection_revision, 1);
  assert.equal(job.opencode_profile_json, null);
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "default" });
  store.close();
});

test("a queued managed job retains profile A while a later save is used by new jobs", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, "Profile A");
  activateManaged(store.db, repoId, 1);
  const jobs = new JobStore(store.db);

  const jobA = createJob(jobs, repoId, 1001);
  assert.equal(jobs.getJob(jobA).opencode_profile_revision, 1);
  assert.equal(jobs.getJob(jobA).opencode_profile_json, profileJson("Profile A"));

  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: profileInput("Profile B"),
  });
  assert.equal(saved.ok, true);

  // Job A is untouched; a new job captures profile B.
  assert.equal(jobs.getJob(jobA).opencode_profile_revision, 1);
  assert.equal(jobs.getJob(jobA).opencode_profile_json, profileJson("Profile A"));
  const jobB = createJob(jobs, repoId, 1002);
  assert.equal(jobs.getJob(jobB).opencode_profile_revision, 2);
  assert.equal(jobs.getJob(jobB).opencode_profile_json, profileJson("Profile B"));
  store.close();
});

test("a managed selection without a saved profile fails closed at capture", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  // Force the incoherent state the store normally prevents: managed source with
  // no saved profile. Capture must fail closed rather than create a job that
  // cannot materialize its team.
  store.db
    .prepare(
      "INSERT INTO opencode_primary_selections (repo_id, source, native_agent_id, revision) VALUES (?, 'managed', NULL, 1)",
    )
    .run(repoId);
  const jobs = new JobStore(store.db);
  assert.throws(() => createJob(jobs, repoId, 1001), /no saved profile/u);

  // The command-claim transaction rolled back: neither a job nor a claim exists.
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) AS n FROM processed_commands").get() as { n: number }).n,
    0,
  );
  store.close();
});

test("a repository without a selection row is default and never materializes a retained profile", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  // A profile exists, but the repository has no explicit selection row.
  const revision = saveProfile(store.db, repoId);
  assert.equal(revision, 1);
  assert.equal(readOpenCodeSelection(store.db, repoId)?.explicit, false);

  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  const job = jobs.getJob(jobId);
  assert.equal(job.opencode_source, "default");
  assert.equal(job.opencode_native_agent_id, null);
  assert.equal(job.opencode_selection_revision, 0);
  assert.equal(job.opencode_profile_json, null);
  assert.equal(job.opencode_profile_revision, null);
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "default" });

  // The retained profile is untouched and still available for deliberate reuse.
  assert.equal(readOpenCodeProfile(store.db, repoId)?.revision, 1);
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile?.primary.description, "Profile A");
  store.close();
});

test("a dormant profile edit does not change a queued native job capture", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, "Profile A");
  const switched = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "reviewer" },
  });
  assert.equal(switched.ok, true);
  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);

  // A normal save of the dormant profile is retained but does not activate it.
  const edited = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: profileInput("Profile B"),
  });
  assert.equal(edited.ok, true);
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "native", agentId: "reviewer" });
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });
  store.close();
});

test("clearing an active profile does not rewrite a prior managed job capture", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, "Profile A");
  activateManaged(store.db, repoId, 1);
  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "managed", profileRevision: 1 });

  const cleared = clearOpenCodeAgentProfile(store.db, { repoId, expectedRevision: 1 });
  assert.equal(cleared.ok, true);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "default" });

  // The earlier job keeps its own captured managed snapshot; a new job is default.
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "managed", profileRevision: 1 });
  const later = createJob(jobs, repoId, 1002);
  assert.deepEqual(jobs.resolveCapturedSelection(later), { source: "default" });
  assert.equal(jobs.getJob(later).opencode_profile_json, null);
  store.close();
});

test("legacy jobs derive managed from their own profile and default otherwise", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const withProfile = store.db
    .prepare(
      `INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at,
                         opencode_profile_json, opencode_profile_revision)
       VALUES (?, 42, 1001, 'RESOLVE', 'queued', ?, ?, ?)`,
    )
    .run(repoId, "2026-01-01T00:00:00Z", profileJson("Legacy"), 3).lastInsertRowid as number;
  const withoutProfile = store.db
    .prepare(
      `INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at)
       VALUES (?, 42, 1002, 'RESOLVE', 'queued', ?)`,
    )
    .run(repoId, "2026-01-01T00:00:00Z").lastInsertRowid as number;
  const jobs = new JobStore(store.db);
  assert.deepEqual(jobs.resolveCapturedSelection(withProfile), {
    source: "managed",
    profileRevision: 3,
  });
  assert.deepEqual(jobs.resolveCapturedSelection(withoutProfile), { source: "default" });
  store.close();
});

test("a corrupt native capture fails closed rather than substituting an agent", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const jobId = Number(
    store.db
      .prepare(
        `INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at, opencode_source)
         VALUES (?, 42, 1001, 'RESOLVE', 'queued', ?, 'native')`,
      )
      .run(repoId, "2026-01-01T00:00:00Z").lastInsertRowid,
  );
  const jobs = new JobStore(store.db);
  assert.throws(() => jobs.resolveCapturedSelection(jobId));
  store.close();
});

test("an explicit retry resolves solely from the job capture after a repository edit", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  activateManaged(store.db, repoId, 1);
  saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: { source: "native", agentId: "reviewer" },
  });
  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);

  const first = jobs.createAttempt({
    jobId,
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "xhigh",
  });
  jobs.finishFailure(jobId, first.attemptId, "preparing", "agent-cli-missing");

  // The operator switches the repository back to default before retrying.
  const switched = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 2,
    candidate: { source: "default" },
  });
  assert.equal(switched.ok, true);

  const second = jobs.retryJob({
    jobId,
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "xhigh",
  });
  assert.equal(second.attemptNumber, 2);
  // The job still resolves its captured native id, not the new default.
  assert.deepEqual(jobs.resolveCapturedSelection(jobId), { source: "native", agentId: "reviewer" });
  assert.equal(jobs.getJob(jobId).opencode_native_agent_id, "reviewer");
  assert.equal(jobs.getJob(jobId).opencode_selection_revision, 2);
  // The retry policy (model/effort/provider) is untouched.
  assert.equal(jobs.getAttempt(second.attemptId).model, "opencode/gpt-5.4");
  assert.equal(jobs.getAttempt(second.attemptId).effort, "xhigh");
  store.close();
});

test("a captured selection is stable across a database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-selection-capture-"));
  let store = openStore(dir);
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  activateManaged(store.db, repoId, 1);
  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  store.close();

  store = openStore(dir);
  const reopened = new JobStore(store.db);
  assert.deepEqual(reopened.resolveCapturedSelection(jobId), {
    source: "managed",
    profileRevision: 1,
  });
  // Changing the repository after reopen does not rewrite the captured job.
  const switched = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: { source: "default" },
  });
  assert.equal(switched.ok, true);
  assert.deepEqual(reopened.resolveCapturedSelection(jobId), {
    source: "managed",
    profileRevision: 1,
  });
  store.close();
});

test("a non-OpenCode job captures no OpenCode selection", () => {
  const store = openStore();
  const repoId = insertRepository(store.db, "cline", "docs");
  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  const job = jobs.getJob(jobId);
  assert.equal(job.opencode_source, null);
  assert.equal(job.opencode_native_agent_id, null);
  assert.equal(job.opencode_selection_revision, null);
  assert.equal(job.opencode_profile_json, null);
  assert.deepEqual(resolveCapturedOpenCodeSelection(job), { source: "default" });
  store.close();
});
