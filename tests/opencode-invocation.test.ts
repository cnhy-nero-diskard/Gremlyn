/**
 * Tests for task 2.3 (generic ownership): the per-invocation OpenCode
 * ownership/identity table and its JobStore APIs (`src/store/jobs.ts`,
 * design D4). Only safe identifiers, states and paths are stored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";

function openStore(): Store {
  return new Store({ dataDir: ".", file: ":memory:" });
}

function seedAttempt(store: Store): { jobId: number; attemptId: number } {
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', 'web', 's', 'w', 'opencode', 'm', 'p', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  const jobs = new JobStore(store.db);
  const created = jobs.createJob({
    repoId,
    prNumber: 42,
    commentId: 1001,
    command: "RESOLVE",
    authorLogin: "owner",
    observedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("duplicate fixture");
  const attempt = jobs.createAttempt({
    jobId: created.jobId,
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "xhigh",
  });
  return { jobId: created.jobId, attemptId: attempt.attemptId };
}

test("an invocation is journaled before launch with safe context", () => {
  const store = openStore();
  const { attemptId } = seedAttempt(store);
  const jobs = new JobStore(store.db);

  const journaled = jobs.journalOpenCodeInvocation({
    attemptId,
    requestedSource: "native",
    requestedNativeAgentId: "reviewer",
    binary: "/usr/local/bin/opencode",
    workspacePath: "/ws/attempt",
  });
  assert.equal(journaled.ordinal, 1);
  const row = jobs.getOpenCodeInvocation(journaled.invocationId);
  assert.equal(row?.status, "journaled");
  assert.equal(row?.ownership_state, "pending");
  assert.equal(row?.requested_source, "native");
  assert.equal(row?.requested_native_agent_id, "reviewer");
  assert.equal(row?.binary, "/usr/local/bin/opencode");
  assert.equal(row?.workspace_path, "/ws/attempt");
  assert.equal(row?.parent_session_id, null);
  assert.equal(row?.launched_at, null);
  store.close();
});

test("early launch evidence persists the parent session and actual identity", () => {
  const store = openStore();
  const { attemptId } = seedAttempt(store);
  const jobs = new JobStore(store.db);
  const { invocationId } = jobs.journalOpenCodeInvocation({
    attemptId,
    requestedSource: "managed",
    requestedProfileRevision: 4,
  });

  jobs.recordOpenCodeInvocationLaunch({
    invocationId,
    parentSessionId: "ses_parent_1",
    actualPrimaryAgent: "primary",
    actualModel: "opencode/gpt-5.4",
  });

  const row = jobs.getOpenCodeInvocation(invocationId);
  assert.equal(row?.status, "launched");
  assert.equal(row?.ownership_state, "captured");
  assert.equal(row?.parent_session_id, "ses_parent_1");
  assert.equal(row?.actual_primary_agent, "primary");
  assert.equal(row?.actual_model, "opencode/gpt-5.4");
  assert.ok(row?.launched_at);
  store.close();
});

test("a launched invocation without a parent keeps an explicit missing marker", () => {
  const store = openStore();
  const { attemptId } = seedAttempt(store);
  const jobs = new JobStore(store.db);
  const { invocationId } = jobs.journalOpenCodeInvocation({
    attemptId,
    requestedSource: "default",
  });

  jobs.recordOpenCodeInvocationLaunch({ invocationId });
  const row = jobs.getOpenCodeInvocation(invocationId);
  assert.equal(row?.status, "launched");
  assert.equal(row?.ownership_state, "missing");
  assert.equal(row?.parent_session_id, null);

  // Identity learned later upgrades the marker without rewriting launch time.
  const launchedAt = row?.launched_at;
  jobs.recordOpenCodeInvocationIdentity({
    invocationId,
    parentSessionId: "ses_late",
    actualPrimaryAgent: "primary",
  });
  const updated = jobs.getOpenCodeInvocation(invocationId);
  assert.equal(updated?.ownership_state, "captured");
  assert.equal(updated?.parent_session_id, "ses_late");
  assert.equal(updated?.launched_at, launchedAt);
  assert.equal(updated?.status, "launched");
  store.close();
});

test("a second invocation in one attempt preserves the first's evidence", () => {
  const store = openStore();
  const { attemptId } = seedAttempt(store);
  const jobs = new JobStore(store.db);
  const first = jobs.journalOpenCodeInvocation({ attemptId, requestedSource: "native" });
  jobs.recordOpenCodeInvocationLaunch({
    invocationId: first.invocationId,
    parentSessionId: "ses_first",
    actualPrimaryAgent: "one",
  });
  const second = jobs.journalOpenCodeInvocation({ attemptId, requestedSource: "native" });
  assert.equal(second.ordinal, 2);
  jobs.recordOpenCodeInvocationLaunch({
    invocationId: second.invocationId,
    parentSessionId: "ses_second",
    actualPrimaryAgent: "two",
  });

  const all = jobs.listOpenCodeInvocations(attemptId);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((row) => [row.invocation_ordinal, row.parent_session_id, row.actual_primary_agent]),
    [
      [1, "ses_first", "one"],
      [2, "ses_second", "two"],
    ],
  );
  store.close();
});

test("settlement records a terminal state and unresolved ownership stays visible", () => {
  const store = openStore();
  const { attemptId } = seedAttempt(store);
  const jobs = new JobStore(store.db);
  const { invocationId } = jobs.journalOpenCodeInvocation({
    attemptId,
    requestedSource: "default",
  });
  jobs.recordOpenCodeInvocationLaunch({ invocationId });

  jobs.settleOpenCodeInvocation({
    invocationId,
    status: "failed",
    ownershipState: "quarantined",
    detail: "child ses_child still active",
  });
  const row = jobs.getOpenCodeInvocation(invocationId);
  assert.equal(row?.status, "failed");
  assert.equal(row?.ownership_state, "quarantined");
  assert.equal(row?.detail, "child ses_child still active");
  assert.ok(row?.settled_at);

  // Settling the same row again is idempotent and does not throw.
  jobs.settleOpenCodeInvocation({ invocationId, status: "failed" });
  store.close();
});

test("known launch identity is write-once and rejects contradictions before writing", () => {
  const store = openStore();
  const { attemptId } = seedAttempt(store);
  const jobs = new JobStore(store.db);
  const { invocationId } = jobs.journalOpenCodeInvocation({
    attemptId,
    requestedSource: "native",
  });
  jobs.recordOpenCodeInvocationLaunch({
    invocationId,
    parentSessionId: "ses_a",
    actualPrimaryAgent: "one",
    actualModel: "opencode/model",
  });

  assert.throws(
    () => jobs.recordOpenCodeInvocationLaunch({ invocationId, parentSessionId: "ses_b" }),
    /different parent session id/u,
  );
  assert.throws(
    () => jobs.recordOpenCodeInvocationIdentity({ invocationId, actualPrimaryAgent: "two" }),
    /different actual primary agent/u,
  );
  assert.throws(
    () => jobs.recordOpenCodeInvocationIdentity({ invocationId, actualModel: "other/model" }),
    /different actual model/u,
  );

  // No contradiction wrote anything.
  const row = jobs.getOpenCodeInvocation(invocationId);
  assert.equal(row?.parent_session_id, "ses_a");
  assert.equal(row?.actual_primary_agent, "one");
  assert.equal(row?.actual_model, "opencode/model");

  // Repeating the same values is idempotent; an absent/null incoming value
  // never clears a recorded one.
  jobs.recordOpenCodeInvocationIdentity({
    invocationId,
    parentSessionId: "ses_a",
    actualPrimaryAgent: "one",
  });
  jobs.recordOpenCodeInvocationIdentity({ invocationId, parentSessionId: null });
  const after = jobs.getOpenCodeInvocation(invocationId);
  assert.equal(after?.parent_session_id, "ses_a");
  assert.equal(after?.actual_primary_agent, "one");
  store.close();
});

test("settling an unknown invocation id throws instead of silently no-op", () => {
  const store = openStore();
  const jobs = new JobStore(store.db);
  assert.throws(
    () => jobs.settleOpenCodeInvocation({ invocationId: 999_999, status: "settled" }),
    /not found/u,
  );
  store.close();
});

test("launched_at is stamped only by a launched-status write", () => {
  const store = openStore();
  const { attemptId } = seedAttempt(store);
  const jobs = new JobStore(store.db);
  const { invocationId } = jobs.journalOpenCodeInvocation({
    attemptId,
    requestedSource: "default",
  });

  // A non-launched status override records the state but not a launch time.
  jobs.recordOpenCodeInvocationLaunch({ invocationId, status: "failed", detail: "spawn failed" });
  assert.equal(jobs.getOpenCodeInvocation(invocationId)?.launched_at, null);

  // A later launched-status write stamps it.
  jobs.recordOpenCodeInvocationLaunch({
    invocationId,
    status: "launched",
    parentSessionId: "ses_1",
  });
  assert.ok(jobs.getOpenCodeInvocation(invocationId)?.launched_at);
  store.close();
});

test("the invocation table stores no prompt, instruction or credential columns", () => {
  const store = openStore();
  const columns = (
    store.db.prepare("PRAGMA table_info(opencode_invocations)").all() as { name: string }[]
  ).map((column) => column.name);
  for (const forbidden of ["prompt", "instructions", "token", "credential", "secret", "env"]) {
    assert.equal(columns.includes(forbidden), false, `unexpected column ${forbidden}`);
  }
  store.close();
});
