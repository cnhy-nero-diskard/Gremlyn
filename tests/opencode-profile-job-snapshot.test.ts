/**
 * Tests for task 2.4: the OpenCode profile snapshot captured in the
 * job-creation transaction (`src/store/jobs.ts`, design D2, capability
 * `opencode-agent-profiles`).
 *
 * Covers the task's verification points: a queued job and its retry retain
 * profile A after profile B is saved, while a new job uses B; a repository
 * without a profile creates a job with no snapshot (nothing is synthesized);
 * a non-OpenCode repository cannot carry a profile snapshot; and file
 * configuration synchronization cannot overwrite the operator's profile or a
 * job's captured snapshot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import {
  canonicalOpenCodeProfileJson,
  parseOpenCodeAgentProfile,
} from "../src/config/opencode-profile.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { RepoConfig } from "../src/config/loader.js";

function openStore(): Store {
  return new Store({ dataDir: ".", file: ":memory:" });
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

function profileInput(primaryDescription = "Primary review agent"): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description: primaryDescription,
      permissions: ["edit", "shell", "web", "skill"],
    },
    subagents: [{ id: "reviewer", description: "Reviewer", enabled: true, permissions: [] }],
  };
}

function canonicalProfileJson(input: Record<string, unknown>): string {
  return canonicalOpenCodeProfileJson(parseOpenCodeAgentProfile(input));
}

function saveProfile(db: Store["db"], repoId: number, candidate: Record<string, unknown>): number {
  const result = saveOpenCodeAgentProfile(db, { repoId, expectedRevision: 0, candidate });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(`profile save failed: ${result.reason}`);
  return result.revision;
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
  if (created.kind !== "created") throw new Error("job fixture was duplicate");
  return created.jobId;
}

function repoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    owner: "acme",
    name: "web",
    sourcePath: "/src/web",
    workspaceRoot: "/workspaces/web",
    agent: "opencode",
    provider: "opencode",
    model: "opencode/gpt-5.4",
    effort: "xhigh",
    enabled: true,
    validationCommands: [],
    allowedModels: [],
    ...overrides,
  };
}

test("a new job captures the saved profile and revision at creation", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const revision = saveProfile(store.db, repoId, profileInput());
  assert.equal(revision, 1);

  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  const job = jobs.getJob(jobId);

  assert.equal(job.opencode_profile_json, canonicalProfileJson(profileInput()));
  assert.equal(job.opencode_profile_revision, 1);

  store.close();
});

test("a queued job retains profile A after profile B is saved, while a new job uses B", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, profileInput("Profile A"));
  const jobs = new JobStore(store.db);

  // Job 1 is queued under profile A.
  const jobA = createJob(jobs, repoId, 1001);
  assert.equal(jobs.getJob(jobA).opencode_profile_revision, 1);
  assert.equal(
    jobs.getJob(jobA).opencode_profile_json,
    canonicalProfileJson(profileInput("Profile A")),
  );

  // The operator saves profile B (revision 2) before job 1 runs.
  const result = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: profileInput("Profile B"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.revision, 2);

  // Job 1 still carries profile A.
  assert.equal(jobs.getJob(jobA).opencode_profile_revision, 1);
  assert.equal(
    jobs.getJob(jobA).opencode_profile_json,
    canonicalProfileJson(profileInput("Profile A")),
  );

  // A new job created after the save uses profile B.
  const jobB = createJob(jobs, repoId, 1002);
  assert.equal(jobs.getJob(jobB).opencode_profile_revision, 2);
  assert.equal(
    jobs.getJob(jobB).opencode_profile_json,
    canonicalProfileJson(profileInput("Profile B")),
  );

  store.close();
});

test("a retry retains the queued job's captured profile after a later save", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, profileInput("Profile A"));
  const jobs = new JobStore(store.db);

  const jobId = createJob(jobs, repoId, 1001);
  const firstAttempt = jobs.createAttempt({
    jobId,
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "xhigh",
  });
  jobs.finishFailure(jobId, firstAttempt.attemptId, "preparing", "agent-cli-missing");
  assert.equal(jobs.getJob(jobId).status, "failed");

  // The operator saves profile B while the job is failed; the retry happens next.
  const result = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: profileInput("Profile B"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.revision, 2);

  const secondAttempt = jobs.retryJob({
    jobId,
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "xhigh",
  });

  // The retry keeps the job's captured profile — still A, still revision 1 —
  // and creates a second attempt under the same snapshot.
  assert.equal(secondAttempt.attemptNumber, 2);
  assert.equal(jobs.getJob(jobId).opencode_profile_revision, 1);
  assert.equal(
    jobs.getJob(jobId).opencode_profile_json,
    canonicalProfileJson(profileInput("Profile A")),
  );

  store.close();
});

test("a repository with no saved profile creates a job with no snapshot", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  const job = jobs.getJob(jobId);

  assert.equal(job.opencode_profile_json, null);
  assert.equal(job.opencode_profile_revision, null);

  store.close();
});

test("a non-OpenCode repository cannot carry an OpenCode profile snapshot", () => {
  const store = openStore();
  const repoId = insertRepository(store.db, "cline", "docs");

  // The save is rejected outright for a Cline repository...
  const refused = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: profileInput(),
  });
  assert.deepEqual(refused, { ok: false, reason: "not-opencode", currentRevision: 0 });

  // ...so its job has no profile snapshot.
  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, repoId, 1001);
  assert.equal(jobs.getJob(jobId).opencode_profile_json, null);
  assert.equal(jobs.getJob(jobId).opencode_profile_revision, null);

  store.close();
});

test("file configuration synchronization cannot overwrite the operator profile or a job snapshot", () => {
  const store = openStore();
  const [registered] = syncRepositories(store.db, [repoConfig()]);
  assert.ok(registered);

  saveProfile(store.db, registered.id, profileInput("Profile A"));
  const jobs = new JobStore(store.db);
  const jobId = createJob(jobs, registered.id, 1001);
  assert.equal(jobs.getJob(jobId).opencode_profile_revision, 1);

  // File config reload with a different agent id: `repositories` is upserted,
  // but the profile row and the job's captured snapshot stay untouched.
  const [resynced] = syncRepositories(store.db, [
    repoConfig({ agent: "cline", provider: "anthropic", model: "anthropic/claude-sonnet-4-5" }),
  ]);
  assert.ok(resynced);
  assert.equal(resynced.agent, "cline");

  const profileRow = store.db
    .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(registered.id) as { profile_json: string | null; revision: number };
  assert.equal(profileRow.profile_json, canonicalProfileJson(profileInput("Profile A")));
  assert.equal(profileRow.revision, 1);

  const job = jobs.getJob(jobId);
  assert.equal(job.opencode_profile_json, canonicalProfileJson(profileInput("Profile A")));
  assert.equal(job.opencode_profile_revision, 1);

  // Switching away from OpenCode makes the saved profile dormant for new jobs.
  const dormantJob = createJob(jobs, registered.id, 1002);
  assert.equal(jobs.getJob(dormantJob).opencode_profile_json, null);
  assert.equal(jobs.getJob(dormantJob).opencode_profile_revision, null);

  store.close();
});

test("configured OpenCode executor aliases capture a profile without giving Cline aliases one", () => {
  const store = openStore();
  const repoId = insertRepository(store.db, "review-agent");
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    executorKind: "opencode",
    candidate: profileInput(),
  });
  assert.equal(saved.ok, true);
  const jobs = new JobStore(store.db);
  const base = {
    repoId,
    prNumber: 42,
    command: "RESOLVE",
    authorLogin: "owner",
    observedAt: "2026-01-01T00:00:00Z",
  };
  const openCodeJob = jobs.createJob({ ...base, commentId: 1001, executorKind: "opencode" });
  assert.equal(openCodeJob.kind, "created");
  if (openCodeJob.kind !== "created") throw new Error("duplicate test job");
  assert.equal(jobs.getJob(openCodeJob.jobId).opencode_profile_revision, 1);
  const clineJob = jobs.createJob({ ...base, commentId: 1002, executorKind: "cline" });
  assert.equal(clineJob.kind, "created");
  if (clineJob.kind !== "created") throw new Error("duplicate test job");
  assert.equal(jobs.getJob(clineJob.jobId).opencode_profile_json, null);
  store.close();
});
