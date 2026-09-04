import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainArtifacts } from "../src/artifact-retention.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";

function makeStore(): { dataDir: string; store: Store; repoId: number } {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-retention-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', 'widgets', 'source', 'workspaces', 'cline', 'model', 'provider', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  return { dataDir, store, repoId };
}

function addAttempt(
  data: ReturnType<typeof makeStore>,
  input: { pr: number; status: string; outputRef: string },
): { jobId: number; attemptId: number } {
  const jobId = Number(
    data.store.db
      .prepare(
        `INSERT INTO jobs
           (repo_id, pr_number, comment_id, command, status, created_at, finished_at, current_attempt)
         VALUES (?, ?, ?, 'RESOLVE', ?, ?, ?, 1)`,
      )
      .run(
        data.repoId,
        input.pr,
        input.pr + 1000,
        input.status,
        "2026-09-05T00:00:00.000Z",
        input.status === "running" ? null : "2026-09-05T00:00:00.000Z",
      ).lastInsertRowid,
  );
  const attemptId = Number(
    data.store.db
      .prepare(
        `INSERT INTO attempts
           (job_id, attempt_number, agent, model, provider, effort, outcome, output_ref)
         VALUES (?, 1, 'cline', 'model', 'provider', 'high', ?, ?)`,
      )
      .run(jobId, input.status === "running" ? null : "succeeded", input.outputRef).lastInsertRowid,
  );
  return { jobId, attemptId };
}

function writeArtifact(path: string, contents: string, modifiedAtMs: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  const at = new Date(modifiedAtMs);
  utimesSync(path, at, at);
}

test("retention keeps live artifacts and trims terminal artifacts oldest-first", async () => {
  const data = makeStore();
  const outputDir = join(data.dataDir, "output");
  mkdirSync(outputDir, { recursive: true });
  const now = Date.now();
  const livePath = join(outputDir, "attempt-1.json");
  const oldestPath = join(outputDir, "attempt-2.json");
  const newestPath = join(outputDir, "attempt-3.json");
  writeArtifact(livePath, "live", now - 3_000);
  writeArtifact(oldestPath, "old!", now - 2_000);
  writeArtifact(newestPath, "new!", now - 1_000);
  addAttempt(data, { pr: 1, status: "running", outputRef: livePath });
  addAttempt(data, { pr: 2, status: "succeeded", outputRef: oldestPath });
  addAttempt(data, { pr: 3, status: "succeeded", outputRef: newestPath });

  const report = await retainArtifacts({
    dataDir: data.dataDir,
    db: data.store.db,
    maximumAgeMs: 60_000,
    maximumTotalBytes: 8,
    now,
    actions: new OperatorActionStore(data.store.db),
  });

  assert.equal(existsSync(livePath), true);
  assert.equal(existsSync(oldestPath), false);
  assert.equal(existsSync(newestPath), true);
  assert.equal(report.removed, 1);
  assert.equal(report.removedBytes, 4);
  assert.equal(report.remainingBytes, 8);
  assert.equal(
    (data.store.db
      .prepare("SELECT COUNT(*) AS count FROM operator_actions WHERE action = 'artifact-retention'")
      .get() as { count: number }).count,
    1,
  );
  data.store.close();
});

test("age retention removes terminal output, validation, and state but protects live jobs", async () => {
  const data = makeStore();
  const now = Date.now();
  const oldOutput = join(data.dataDir, "output", "attempt-1.json");
  const liveOutput = join(data.dataDir, "output", "attempt-2.json");
  const oldValidation = join(data.dataDir, "validation", "attempt-1-1.json");
  const oldState = join(data.dataDir, "attempts", "1");
  const liveState = join(data.dataDir, "attempts", "2");
  writeArtifact(oldOutput, "old output", now - 10_000);
  writeArtifact(liveOutput, "live output", now - 10_000);
  writeArtifact(oldValidation, "old validation", now - 10_000);
  mkdirSync(oldState, { recursive: true });
  writeFileSync(join(oldState, "session.json"), "old state", "utf8");
  utimesSync(oldState, new Date(now - 10_000), new Date(now - 10_000));
  mkdirSync(liveState, { recursive: true });
  writeFileSync(join(liveState, "session.json"), "live state", "utf8");
  utimesSync(liveState, new Date(now - 10_000), new Date(now - 10_000));
  const terminal = addAttempt(data, { pr: 1, status: "succeeded", outputRef: oldOutput });
  const live = addAttempt(data, { pr: 2, status: "running", outputRef: liveOutput });
  data.store.db
    .prepare(
      `INSERT INTO validation_runs
         (attempt_id, seq, command, exit_code, duration_ms, output_ref)
       VALUES (?, 1, '["npm","test"]', 0, 1, ?)`,
    )
    .run(terminal.attemptId, oldValidation);

  const report = await retainArtifacts({
    dataDir: data.dataDir,
    db: data.store.db,
    maximumAgeMs: 1_000,
    maximumTotalBytes: 1_000_000,
    now,
  });

  assert.equal(existsSync(oldOutput), false);
  assert.equal(existsSync(oldValidation), false);
  assert.equal(existsSync(oldState), false);
  assert.equal(existsSync(liveOutput), true);
  assert.equal(existsSync(liveState), true);
  assert.equal(report.removed, 3);
  assert.equal(readFileSync(liveOutput, "utf8"), "live output");
  assert.equal(
    (data.store.db.prepare("SELECT output_ref FROM attempts WHERE id = ?").get(terminal.attemptId) as { output_ref: string }).output_ref,
    oldOutput,
  );
  assert.equal(live.jobId > 0, true);
  data.store.close();
});
