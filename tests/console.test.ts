import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import {
  buildConsoleServer,
  consoleListenOptions,
  type ConsoleOptions,
} from "../src/console/server.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { readHealth } from "../src/console/queries.js";
import { SharedChangeTicker } from "../src/console/stream.js";
import { assetHash, clientScriptPath, stylesheetPath } from "../src/console/assets.js";
import {
  dangerZone,
  duration,
  escapeHtml,
  keyValueTable,
  relativeTimestamp,
  statusPill,
} from "../src/console/views/components.js";

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
  assert.match(response.body, /Orchestrator/);
  assert.match(response.body, /no poll recorded/);
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
    "Confirmation",
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

test("presentation assets and sign-in are available without a token while data routes remain protected", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  for (const asset of ["/assets/app.css", "/assets/app.js", stylesheetPath, clientScriptPath]) {
    const response = await app.inject({ method: "GET", url: asset });
    assert.equal(response.statusCode, 200, asset);
    assert.equal(response.body.includes(SECRET), false);
  }
  assert.match(stylesheetPath, new RegExp(`app\\.${assetHash}\\.css`));
  assert.match(clientScriptPath, new RegExp(`app\\.${assetHash}\\.js`));
  assert.match((await app.inject({ method: "GET", url: "/auth" })).body, /stylesheet/);
  assert.equal((await app.inject({ method: "GET", url: "/commands" })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "POST", url: "/auth", payload: { token: "wrong" } })).statusCode,
    401,
  );
  const signedIn = await app.inject({ method: "POST", url: "/auth", payload: { token: TOKEN } });
  assert.equal(signedIn.statusCode, 200);
  assert.match(signedIn.headers["set-cookie"] as string, /HttpOnly/);
  await app.close();
  data.store.close();
});

test("health projection distinguishes fresh, stale, and missing polling", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  store.db
    .prepare(
      `INSERT INTO repositories
         (owner, name, source_path, workspace_root, agent, model, provider, effort)
       VALUES ('health', 'fixture', 'source', 'workspace', 'cline', 'model', 'provider', 'high')`,
    )
    .run();
  const now = "2026-08-28T00:00:10.000Z";
  const fresh = readHealth(store.db, 60, 3, now);
  assert.equal(fresh.status, "unknown");
  store.db
    .prepare("INSERT INTO ingestion_state (repo_id, last_polled_at) VALUES (1, ?)")
    .run("2026-08-28T00:00:00.000Z");
  store.db
    .prepare(
      "INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at) VALUES (1, 1, 1, 'RESOLVE', 'queued', ?)",
    )
    .run(now);
  store.db
    .prepare(
      "INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at) VALUES (1, 2, 2, 'RESOLVE', 'running', ?)",
    )
    .run(now);
  const freshWithWork = readHealth(store.db, 60, 3, now);
  assert.deepEqual(
    {
      status: freshWithWork.status,
      queue: freshWithWork.queueDepth,
      active: freshWithWork.inFlight,
      concurrency: freshWithWork.concurrency,
    },
    { status: "running", queue: 1, active: 1, concurrency: 3 },
  );
  const stale = readHealth(store.db, 5, 3, now);
  assert.equal(stale.status, "stale");
  store.close();
});

test("commands and audit views expose outcomes and redacted action details", async () => {
  const data = fixture();
  data.store.db
    .prepare(
      "INSERT INTO processed_commands (repo_id, pr_number, comment_id, command, author_login, observed_at, outcome, reason) VALUES (?, 99, 901, 'RESOLVE', 'operator', ?, 'rejected', ?)",
    )
    .run(data.repoId, "2026-08-27T00:00:00.000Z", `secret ${SECRET}`);
  data.store.db
    .prepare(
      "INSERT INTO processed_commands (repo_id, pr_number, comment_id, command, author_login, observed_at, outcome, job_id) VALUES (?, 12, 902, 'RESOLVE', 'operator', ?, 'executed', ?)",
    )
    .run(data.repoId, "2026-08-27T00:00:00.000Z", data.jobId);
  data.options.operatorActions.record({
    action: "workspace-reset",
    target: "repository:1/pr:12",
    effect: "recreated",
    detail: { secret: SECRET },
  });
  const app = buildConsoleServer(data.options);
  const commands = await app.inject({ method: "GET", url: "/commands", headers: AUTH });
  const audit = await app.inject({ method: "GET", url: "/audit", headers: AUTH });
  assert.match(commands.body, /secret \[redacted\]/);
  assert.match(commands.body, new RegExp(`/jobs/${data.jobId}`));
  assert.match(audit.body, /workspace-reset/);
  assert.match(audit.body, /recreated/);
  assert.equal(commands.body.includes(SECRET), false);
  assert.equal(audit.body.includes(SECRET), false);
  await app.close();
  data.store.close();
});

test("ticker lifecycle is shared and held-open SSE emits a second event on one connection", async () => {
  const data = fixture();
  const ticker = new SharedChangeTicker(data.store.db, 20);
  assert.equal(ticker.isRunning, false);
  const unsubscribe = ticker.subscribe(() => undefined);
  assert.equal(ticker.subscriberCount, 1);
  assert.equal(ticker.isRunning, true);
  unsubscribe();
  assert.equal(ticker.subscriberCount, 0);
  assert.equal(ticker.isRunning, false);

  const app = buildConsoleServer(data.options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/jobs/${data.jobId}/stream`,
      headers: AUTH,
    });
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("held-open stream timed out"));
    }, 3_000);
    req.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        chunks.push(chunk);
        if (chunks.join("").match(/event: job-update/g)?.length === 1) {
          writeFileSync(data.outputPath, "output appended while running\n", "utf8");
        }
        if (chunks.join("").match(/event: job-update/g)?.length === 2) {
          clearTimeout(timeout);
          req.destroy();
          resolve();
        }
      });
      response.on("error", reject);
    });
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.end();
  });
  assert.equal(chunks.join("").match(/event: job-update/g)?.length, 2);
  await app.close();
  data.store.close();
});

test("job actions are state-gated and successful jobs expose neither routine action", async () => {
  const data = fixture();
  const succeeded = Number(
    data.store.db
      .prepare(
        "INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at, finished_at) VALUES (?, 15, 104, 'RESOLVE', 'succeeded', ?, ?)",
      )
      .run(data.repoId, "2026-08-27T00:00:00.000Z", "2026-08-27T00:01:00.000Z").lastInsertRowid,
  );
  const app = buildConsoleServer(data.options);
  const succeededBody = (
    await app.inject({ method: "GET", url: `/jobs/${succeeded}`, headers: AUTH })
  ).body;
  assert.doesNotMatch(succeededBody, /data-action="retry"/);
  assert.doesNotMatch(succeededBody, /data-action="cancel"/);
  const queuedBody = (
    await app.inject({ method: "GET", url: `/jobs/${data.queuedJobId}`, headers: AUTH })
  ).body;
  assert.match(queuedBody, /data-action="cancel"/);
  await app.close();
  data.store.close();
});

test("pure view helpers escape values and render absent values safely", () => {
  assert.equal(
    escapeHtml(`<script>alert('x')</script>`),
    "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
  );
  assert.match(statusPill("failed"), /status-failed/);
  assert.ok(statusPill("failed").includes(">failed</span>"));
  assert.equal(duration(null, null), "—");
  assert.equal(relativeTimestamp(null), "never");
  assert.match(keyValueTable({ "<unsafe>": null, value: "<script>" }), /&lt;unsafe&gt;/);
  assert.match(keyValueTable({ "<unsafe>": null, value: "<script>" }), /class="muted">—/);
  assert.match(keyValueTable({ "<unsafe>": null, value: "<script>" }), /&lt;script&gt;/);
  assert.match(dangerZone(1, 12), /data-reset-submit/);
  assert.match(dangerZone(1, 12), /disabled/);
});

test("terminal status treatments use distinct classes and non-colour cues", () => {
  const data = fixture();
  for (const status of ["succeeded", "failed", "cancelled", "interrupted"]) {
    data.store.db
      .prepare(
        "INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at) VALUES (?, ?, ?, 'RESOLVE', ?, ?)",
      )
      .run(
        data.repoId,
        100 + status.length,
        200 + status.length,
        status,
        "2026-08-27T00:00:00.000Z",
      );
  }
  const app = buildConsoleServer(data.options);
  return app.inject({ method: "GET", url: "/", headers: AUTH }).then(async (response) => {
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"]) {
      assert.match(response.body, new RegExp(`status-${status}`));
    }
    assert.match(response.body, /aria-label="Status: succeeded"/);
    assert.match(response.body, /aria-label="Status: failed"/);
    await app.close();
    data.store.close();
  });
});
