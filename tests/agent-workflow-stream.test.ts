import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { SharedChangeTicker, type StreamChange } from "../src/console/stream.js";

test("launch and late actual-primary/model evidence refresh workflow surfaces without unrelated writes", async () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('fixture', 'workflow-stream', 'source', 'workspaces', 'opencode', 'opencode/gpt-5.4', '', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  const jobs = new JobStore(store.db);
  const created = jobs.createJob({
    repoId,
    prNumber: 1,
    commentId: 1,
    command: "RESOLVE",
    authorLogin: "fixture",
    observedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("duplicate fixture");
  const attempt = jobs.createAttempt({
    jobId: created.jobId,
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "",
    effort: "high",
  });
  const invocation = jobs.journalOpenCodeInvocation({
    attemptId: attempt.attemptId,
    requestedSource: "default",
  });
  const ticker = new SharedChangeTicker(store.db, 10);
  async function observe(write: () => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("workflow evidence did not refresh"));
      }, 1_000);
      const unsubscribe = ticker.subscribe((change: StreamChange) => {
        if (change.kind !== "change") return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
      write();
    });
  }
  try {
    await observe(() =>
      jobs.recordOpenCodeInvocationLaunch({ invocationId: invocation.invocationId }),
    );
    await observe(() =>
      jobs.recordOpenCodeInvocationIdentity({
        invocationId: invocation.invocationId,
        actualPrimaryAgent: "build",
      }),
    );
    await observe(() =>
      jobs.recordOpenCodeInvocationIdentity({
        invocationId: invocation.invocationId,
        actualModel: "opencode/gpt-5.4",
      }),
    );
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM operator_actions").get() as { n: number }).n,
      0,
    );
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM log_entries").get() as { n: number }).n,
      0,
    );
  } finally {
    ticker.stop();
    store.close();
  }
});
