import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConsoleServer,
  consoleListenOptions,
  type ConsoleOptions,
} from "../src/console/server.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";

const TOKEN = "console-token";
const SECRET = "super-secret";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function fixture(): {
  store: Store;
  options: ConsoleOptions;
  counts: { retry: number; cancel: number; reset: number };
  jobId: number;
  queuedJobId: number;
  repoId: number;
  outputPath: string;
} {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run("acme", "widgets", "source", "workspaces", "cline", "model", "provider", "xhigh")
      .lastInsertRowid,
  );
  const now = "2026-08-27T00:00:00.000Z";
  const jobId = Number(
    store.db
      .prepare(
        `INSERT INTO jobs
           (repo_id, pr_number, comment_id, command, thread_id, status, created_at,
            finished_at, current_attempt, review_context)
         VALUES (?, 12, 101, 'RESOLVE', '100', 'failed', ?, ?, 2, ?)`,
      )
      .run(repoId, now, now, JSON.stringify({ feedback: `<script>${SECRET}</script>` }))
      .lastInsertRowid,
  );
  const queuedJobId = Number(
    store.db
      .prepare(
        `INSERT INTO jobs
           (repo_id, pr_number, comment_id, command, status, created_at)
         VALUES (?, 13, 102, 'RESOLVE', 'queued', ?)`,
      )
      .run(repoId, now).lastInsertRowid,
  );
  store.db
    .prepare(
      `INSERT INTO jobs
         (repo_id, pr_number, comment_id, command, status, created_at)
       VALUES (?, 14, 103, 'RESOLVE', 'running', ?)`,
    )
    .run(repoId, now);

  const outputDir = mkdtempSync(join(tmpdir(), "gremlyn-console-"));
  const outputPath = join(outputDir, "attempt-2.json");
  writeFileSync(outputPath, `agent output contains ${SECRET}\n`, "utf8");
  const firstAttemptId = Number(
    store.db
      .prepare(
        `INSERT INTO attempts
           (job_id, attempt_number, agent, model, provider, effort, outcome,
            failure_stage, failure_reason, workspace_path, output_ref)
         VALUES (?, 1, 'cline', 'model', 'provider', 'high', 'failed',
                 'running', 'agent-nonzero-exit', 'workspace-1', ?)`,
      )
      .run(jobId, outputPath).lastInsertRowid,
  );
  const secondAttemptId = Number(
    store.db
      .prepare(
        `INSERT INTO attempts
           (job_id, attempt_number, agent, model, provider, effort, outcome,
            failure_stage, failure_reason, workspace_path, commit_sha, report_status, output_ref)
         VALUES (?, 2, 'cline', 'model', 'provider', 'xhigh', 'failed',
                 'validating', 'validation-failed', 'workspace-2', 'abc123', 'failed', ?)`,
      )
      .run(jobId, outputPath).lastInsertRowid,
  );
  store.db
    .prepare("INSERT INTO status_events (job_id, attempt_id, status, at) VALUES (?, ?, ?, ?)")
    .run(jobId, firstAttemptId, "running", now);
  store.db
    .prepare("INSERT INTO status_events (job_id, attempt_id, status, at) VALUES (?, ?, ?, ?)")
    .run(jobId, secondAttemptId, "validating", now);
  const validationPath = join(outputDir, "validation.json");
  writeFileSync(validationPath, `validation failed: ${SECRET}\n`, "utf8");
  store.db
    .prepare(
      `INSERT INTO validation_runs
         (attempt_id, seq, command, exit_code, duration_ms, output_ref)
       VALUES (?, 1, '["npm","test"]', 1, 50, ?)`,
    )
    .run(secondAttemptId, validationPath);
  store.db
    .prepare(
      `INSERT INTO log_entries (at, level, event, job_id, attempt_id, fields)
       VALUES (?, 'error', 'job failed', ?, ?, ?)`,
    )
    .run(now, jobId, secondAttemptId, JSON.stringify({ detail: SECRET }));
  store.db
    .prepare(
      `INSERT INTO log_entries (at, level, event, job_id, fields)
       VALUES (?, 'info', 'other job', ?, '{}')`,
    )
    .run(now, queuedJobId);

  const counts = { retry: 0, cancel: 0, reset: 0 };
  const operatorActions = new OperatorActionStore(store.db);
  const options: ConsoleOptions = {
    db: store.db,
    token: TOKEN,
    secrets: [SECRET],
    operatorActions,
    actions: {
      retry: () => {
        counts.retry += 1;
      },
      cancel: () => {
        counts.cancel += 1;
      },
      resetWorkspace: () => {
        counts.reset += 1;
      },
    },
  };
  return { store, options, counts, jobId, queuedJobId, repoId, outputPath };
}

test("console defaults to loopback and rejects every route without a token", async () => {
  assert.deepEqual(consoleListenOptions({ port: 4780 }), { host: "127.0.0.1", port: 4780 });
  const data = fixture();
  const app = buildConsoleServer(data.options);
  const requests = [
    { method: "GET" as const, url: "/" },
    { method: "GET" as const, url: `/jobs/${data.jobId}` },
    { method: "GET" as const, url: `/jobs/${data.jobId}/stream?snapshot=1` },
    { method: "GET" as const, url: `/jobs/${data.jobId}/log` },
    { method: "POST" as const, url: `/jobs/${data.jobId}/retry` },
    { method: "POST" as const, url: `/jobs/${data.queuedJobId}/cancel` },
    { method: "POST" as const, url: `/repos/${data.repoId}/toggle` },
    {
      method: "POST" as const,
      url: `/workspaces/${data.repoId}/reset`,
      payload: { confirm: "RESET", prNumber: 12 },
    },
  ];
  for (const request of requests) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    assert.equal(response.body, '{"error":"unauthorized"}');
  }
  assert.deepEqual(data.counts, { retry: 0, cancel: 0, reset: 0 });
  assert.equal(new OperatorActionStore(data.store.db).list().length, 0);
  await app.close();
  data.store.close();
});

test("dashboard shows repositories plus running, queued, success and failure sections", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  const response = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Orchestrator status: <strong>running<\/strong>/);
  assert.match(response.body, /acme\/widgets/);
  assert.match(response.body, /Running/);
  assert.match(response.body, /Queued/);
  assert.match(response.body, /Recent successes and failures/);
  assert.match(response.headers["set-cookie"] as string, /HttpOnly/);
  await app.close();
  data.store.close();
});

test("job detail separates attempts and shows context, failure, output, validation, commit, and reporting", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  const response = await app.inject({
    method: "GET",
    url: `/jobs/${data.jobId}`,
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  for (const expected of [
    "Review feedback",
    "Attempt 1",
    "Attempt 2",
    "agent-nonzero-exit",
    "validation-failed",
    "workspace-2",
    "abc123",
    "Validation results",
    "agent output contains [redacted]",
    "validation failed: [redacted]",
    "Structured log",
    "Destructive actions",
    "typing RESET",
    "discussion_r101",
  ]) {
    assert.ok(response.body.includes(expected), expected);
  }
  assert.equal(response.body.includes(SECRET), false);
  assert.match(response.body, /&lt;script&gt;\[redacted\]&lt;\/script&gt;/);
  await app.close();
  data.store.close();
});

test("SSE snapshots expose status and newly captured output without page interaction", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  const before = await app.inject({
    method: "GET",
    url: `/jobs/${data.jobId}/stream?snapshot=1`,
    headers: AUTH,
  });
  assert.match(before.body, /event: job-update/);
  writeFileSync(data.outputPath, "new live output\n", "utf8");
  data.store.db.prepare("UPDATE jobs SET status = 'reporting' WHERE id = ?").run(data.jobId);
  const after = await app.inject({
    method: "GET",
    url: `/jobs/${data.jobId}/stream?snapshot=1`,
    headers: AUTH,
  });
  assert.match(after.body, /reporting/);
  assert.match(after.body, /new live output/);
  await app.close();
  data.store.close();
});

test("routine actions and confirmed reset are audited while unconfirmed reset does nothing", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/workspaces/${data.repoId}/reset`,
        headers: AUTH,
        payload: { confirm: "no", prNumber: 12 },
      })
    ).statusCode,
    400,
  );
  assert.equal(data.counts.reset, 0);
  for (const request of [
    { url: `/jobs/${data.jobId}/retry` },
    { url: `/jobs/${data.queuedJobId}/cancel` },
    { url: `/repos/${data.repoId}/toggle` },
  ]) {
    const response = await app.inject({ method: "POST", headers: AUTH, ...request });
    assert.equal(response.statusCode, 200);
  }
  const reset = await app.inject({
    method: "POST",
    url: `/workspaces/${data.repoId}/reset`,
    headers: AUTH,
    payload: { confirm: "RESET", prNumber: 12 },
  });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(data.counts, { retry: 1, cancel: 1, reset: 1 });
  const actions = new OperatorActionStore(data.store.db).list();
  assert.deepEqual(
    new Set(actions.map((action) => action.action)),
    new Set(["retry", "cancel", "repository-toggle", "workspace-reset"]),
  );
  await app.close();
  data.store.close();
});

test("job-filtered structured log returns only the selected lifecycle with redaction", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  const response = await app.inject({
    method: "GET",
    url: `/jobs/${data.jobId}/log`,
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /job failed/);
  assert.match(response.body, /\[redacted\]/);
  assert.equal(response.body.includes(SECRET), false);
  assert.equal(response.body.includes("other job"), false);
  await app.close();
  data.store.close();
});
