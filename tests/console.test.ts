import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { runInNewContext } from "node:vm";
import {
  buildConsoleServer,
  consoleListenOptions,
  type ConsoleOptions,
} from "../src/console/server.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { JOB_LOG_TAIL, readHealth, readJobDetail } from "../src/console/queries.js";
import { SharedChangeTicker } from "../src/console/stream.js";
import { jobRegions } from "../src/console/views/job.js";
import {
  assetHash,
  clientScript,
  clientScriptPath,
  stylesheetPath,
} from "../src/console/assets.js";
import {
  attemptCard,
  dangerZone,
  duration,
  escapeHtml,
  agentActivity,
  clockTime,
  keyValueTable,
  logClock,
  logEntries,
  relativeTimestamp,
  statusPill,
  timeElement,
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
    { method: "POST" as const, url: `/repos/${data.repoId}/effort`, payload: { effort: "high" } },
    { method: "GET" as const, url: "/model-catalog" },
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
  assert.match(response.body, /data-repo-picker/);
  assert.match(response.body, /data-saved-provider=/);
  assert.match(response.body, /data-saved-model=/);
  assert.match(response.body, /data-saved-effort=/);
  assert.match(response.body, /data-repo-effort/);
  assert.match(response.body, /data-repo-timeout/);
  assert.match(response.body, /Blank timeout means no limit/);
  assert.match(response.body, />Extra high<\/option>/);
  assert.match(response.body, /<optgroup label="Cline/);
  assert.match(response.body, /data-model-description=/);
  assert.match(response.body, /ID: model/);
  assert.match(response.body, /OpenAI Codex/);
  assert.match(response.body, /gpt-5\.6-sol/);
  assert.match(response.body, /moonshotai\/kimi-k3/);
  assert.match(response.body, /provider-qualified ids/);
  assert.match(response.body, /Running/);
  assert.match(response.body, /Queued/);
  assert.match(response.body, /Recent successes and failures/);
  assert.ok(
    response.body.indexOf('class="health-summary"') > response.body.indexOf('id="health-region"'),
  );
  assert.match(response.headers["set-cookie"] as string, /HttpOnly/);
  await app.close();
  data.store.close();
});

test("an OpenCode repository renders on the dashboard and its settings are configurable through the console", async () => {
  // OpenCode has no ProviderCatalog entries (design D-opencode's non-goal), so
  // its repository must be configurable purely through the existing
  // agent-agnostic "Custom provider" free-text path — the same route used
  // above for Cline — with no console-side change.
  const data = fixture();
  const opencodeRepoId = Number(
    data.store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        "acme",
        "opencode-widgets",
        "source-2",
        "workspaces-2",
        "opencode",
        "opencode/claude-sonnet-5",
        "",
        "high",
      ).lastInsertRowid,
  );
  const app = buildConsoleServer(data.options);
  const dashboard = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(dashboard.statusCode, 200);
  assert.match(dashboard.body, /acme\/opencode-widgets/);
  assert.match(dashboard.body, /opencode\/claude-sonnet-5/);

  const updated = await app.inject({
    method: "POST",
    url: `/repos/${opencodeRepoId}/model-provider`,
    headers: AUTH,
    payload: { provider: "opencode", model: "opencode/gpt-5.4", effort: "xhigh" },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(
    data.store.db
      .prepare("SELECT provider, model, effort FROM repositories WHERE id = ?")
      .get(opencodeRepoId),
    { provider: "opencode", model: "opencode/gpt-5.4", effort: "xhigh" },
  );
  await app.close();
  data.store.close();
});

const CONSOLE_AGENTS = {
  cline: {
    id: "cline",
    kind: "cline",
    binary: "cline",
    efforts: ["none", "low", "medium", "high", "xhigh"] as const,
    credentialSource: "/tmp/cline-data",
    credentialFiles: ["secrets.json", "settings/providers.json"],
  },
  opencode: {
    id: "opencode",
    kind: "opencode",
    binary: "opencode",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"] as const,
    credentialSource: "/tmp/opencode-data",
    credentialFiles: ["auth.json"],
  },
};

test("an empty provider is saved for provider-optional agents and refused for Cline", async () => {
  const data = fixture();
  data.options.agents = CONSOLE_AGENTS;
  const opencodeRepoId = Number(
    data.store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        "acme",
        "opencode-widgets",
        "source-2",
        "workspaces-2",
        "opencode",
        "opencode/claude-sonnet-5",
        "",
        "high",
      ).lastInsertRowid,
  );
  const app = buildConsoleServer(data.options);
  // OpenCode folds the provider into the model id, so provider "" is a valid
  // state and the save must not be rejected as provider-required.
  const saved = await app.inject({
    method: "POST",
    url: `/repos/${opencodeRepoId}/model-provider`,
    headers: AUTH,
    payload: { provider: "", model: "opencode/gpt-5.4", effort: "max" },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(
    data.store.db
      .prepare("SELECT provider, model, effort FROM repositories WHERE id = ?")
      .get(opencodeRepoId),
    { provider: "", model: "opencode/gpt-5.4", effort: "max" },
  );
  // Cline still requires a provider argument on its argv.
  const refused = await app.inject({
    method: "POST",
    url: `/repos/${data.repoId}/model-provider`,
    headers: AUTH,
    payload: { provider: "", model: "gpt-5.6-sol", effort: "high" },
  });
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(refused.json(), { error: "provider-required" });
  await app.close();
  data.store.close();
});

test("the dashboard drives effort tiers and provider semantics from each repository's agent", async () => {
  const data = fixture();
  data.options.agents = CONSOLE_AGENTS;
  data.store.db
    .prepare(
      `INSERT INTO repositories
         (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      "acme",
      "opencode-widgets",
      "source-2",
      "workspaces-2",
      "opencode",
      "opencode/claude-sonnet-5",
      "",
      "max",
    );
  const app = buildConsoleServer(data.options);
  const dashboard = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(dashboard.statusCode, 200);
  const body = dashboard.body;
  // Only the OpenCode agent declares "max", so exactly one card offers it —
  // a Cline card must not present a tier its agent does not support.
  assert.equal((body.match(/<option value="max"/gu) ?? []).length, 1);
  // Only the provider-optional card renders the empty-provider option and flag.
  assert.equal((body.match(/None — provider is folded into the model id/gu) ?? []).length, 1);
  assert.equal((body.match(/data-provider-optional/gu) ?? []).length, 1);
  await app.close();
  data.store.close();
});

test("the dashboard filters the provider catalog by each repository's agent kind", async () => {
  const data = fixture();
  data.options.agents = CONSOLE_AGENTS;
  data.store.db
    .prepare(
      `INSERT INTO repositories
         (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      "acme",
      "opencode-widgets",
      "source-2",
      "workspaces-2",
      "opencode",
      "opencode/claude-sonnet-5",
      "",
      "max",
    );
  const app = buildConsoleServer(data.options);
  const dashboard = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(dashboard.statusCode, 200);
  const cards = dashboard.body.match(/<article class="card repo-card">[\s\S]*?<\/article>/gu) ?? [];
  assert.equal(cards.length, 2);
  const clineCard = cards.find((card) => card.includes('data-agent-kind="cline"'));
  const opencodeCard = cards.find((card) => card.includes('data-agent-kind="opencode"'));
  assert.ok(clineCard);
  assert.ok(opencodeCard);
  // A Cline card offers the Cline-owned entries and never the OpenCode Zen
  // gateway, whose credentials its executor does not hold.
  assert.match(clineCard, /<option value="cline">/);
  assert.match(clineCard, /<option value="cline-pass">/);
  assert.match(clineCard, /<option value="openai-codex">/);
  assert.doesNotMatch(clineCard, /<option value="opencode">/);
  // An OpenCode card offers only the Zen gateway; the Cline-only entries are
  // not selectable for a provider-optional executor. "Custom provider" stays
  // for intentionally opaque values.
  assert.match(opencodeCard, /<option value="opencode">/);
  assert.doesNotMatch(opencodeCard, /<option value="cline">/);
  assert.doesNotMatch(opencodeCard, /<option value="cline-pass">/);
  assert.doesNotMatch(opencodeCard, /<option value="openai-codex">/);
  assert.match(opencodeCard, /Custom provider/);
  // The live-refresh payload carries the same kind mapping, so the client
  // script applies the identical filter when it fetches /model-catalog.
  const catalog = await app.inject({ method: "GET", url: "/model-catalog", headers: AUTH });
  assert.equal(catalog.statusCode, 200);
  const providers = (catalog.json() as { providers: Array<{ id: string; kinds: string[] }> })
    .providers;
  const kindsOf = (id: string) => providers.find((provider) => provider.id === id)?.kinds;
  assert.deepEqual(kindsOf("cline"), ["cline"]);
  assert.deepEqual(kindsOf("cline-pass"), ["cline"]);
  assert.deepEqual(kindsOf("openai-codex"), ["cline"]);
  assert.deepEqual(kindsOf("opencode"), ["opencode"]);
  await app.close();
  data.store.close();
});

test("a persisted provider mismatch stays visible and is not demoted to custom", async () => {
  const data = fixture();
  data.options.agents = CONSOLE_AGENTS;
  data.store.db
    .prepare(
      "UPDATE repositories SET agent = 'cline', provider = 'opencode', model = 'opencode/gpt-5.4' WHERE id = ?",
    )
    .run(data.repoId);
  const app = buildConsoleServer(data.options);
  const response = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(response.statusCode, 200);
  const card = (response.body.match(/<article class="card repo-card">[\s\S]*?<\/article>/u) ?? [
    "",
  ])[0];
  assert.match(card, /data-provider-mismatch/);
  assert.match(card, /Provider mismatch/);
  assert.match(card, /Current provider: opencode/);
  assert.match(card, /<option value="cline">/);
  assert.doesNotMatch(card, /value="__custom__" selected/);
  assert.match(card, /data-saved-provider="opencode"/);
  assert.match(card, /data-saved-model="opencode\/gpt-5\.4"/);
  await app.close();
  data.store.close();
});

test("a saved model absent from the catalog remains the selected current option", async () => {
  const data = fixture();
  data.store.db
    .prepare("UPDATE repositories SET provider = 'cline', model = 'retired/model-9' WHERE id = ?")
    .run(data.repoId);
  const app = buildConsoleServer(data.options);
  const response = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(response.statusCode, 200);
  assert.match(
    response.body,
    /<option value="retired\/model-9"[^>]*data-model-tags="CURRENT"[^>]* selected>/u,
  );
  assert.match(response.body, /data-saved-model="retired\/model-9"/u);
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
    "Live log",
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

test("job detail labels a trimmed captured artifact without losing its reference", async () => {
  const data = fixture();
  unlinkSync(data.outputPath);
  const model = readJobDetail(data.store.db, data.jobId, [SECRET]);
  assert.ok(model);
  assert.equal(model.attempts[0]?.output_ref, data.outputPath);
  assert.equal(model.attempts[0]?.outputRetained, false);

  const app = buildConsoleServer(data.options);
  const response = await app.inject({
    method: "GET",
    url: `/jobs/${data.jobId}`,
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Captured agent output is no longer retained by the disk policy\./u);
  assert.match(response.body, /Raw agent output/u);
  await app.close();
  data.store.close();
});

test("job detail marks an adopted attempt and leaves an ordinary attempt unmarked", () => {
  const data = fixture();
  const adoptedPath = join(
    mkdtempSync(join(tmpdir(), "gremlyn-adopted-console-")),
    "operator-checkout",
  );
  data.store.db
    .prepare(
      "UPDATE attempts SET workspace_path = ?, adopted = 1 WHERE id = (SELECT MAX(id) FROM attempts)",
    )
    .run(adoptedPath);
  const model = readJobDetail(data.store.db, data.jobId, [SECRET]);
  assert.ok(model);
  assert.equal(model.attempts[0]?.adopted, false);
  assert.equal(model.attempts[1]?.adopted, true);
  const html = jobRegions(model)["job-detail-region"];
  assert.equal((html.match(/adopted checkout/gu) ?? []).length, 1);
  assert.ok(html.includes(adoptedPath));
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

test("command and audit streams deliver newly recorded rows", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const readChange = async (
    path: string,
    mutate: () => void,
  ): Promise<{ kind: string; fragments: Record<string, string> }> => {
    return await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path,
        headers: AUTH,
      });
      let buffer = "";
      let initialSeen = false;
      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error(`stream did not deliver a change: ${path}`));
      }, 3_000);
      req.on("response", (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const events = buffer.split("\n\n").filter((event) => event.startsWith("event: "));
          if (!initialSeen && events.length >= 1) {
            initialSeen = true;
            mutate();
          }
          if (events.length < 2) return;
          clearTimeout(timeout);
          const line = events[1]!.split("\n").find((entry) => entry.startsWith("data: "));
          assert.ok(line);
          req.destroy();
          resolve(
            JSON.parse(line.slice("data: ".length)) as {
              kind: string;
              fragments: Record<string, string>;
            },
          );
        });
        response.on("error", reject);
      });
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      req.end();
    });
  };
  const command = await readChange("/commands/stream", () => {
    data.store.db
      .prepare(
        "INSERT INTO processed_commands (repo_id, pr_number, comment_id, command, author_login, observed_at, outcome) VALUES (?, 99, 999, 'RESOLVE', 'operator', ?, 'rejected')",
      )
      .run(data.repoId, "2026-08-27T00:00:01.000Z");
  });
  assert.equal(command.kind, "change");
  assert.match(command.fragments["commands-region"] ?? "", /<td>999<\/td>/);
  const audit = await readChange("/audit/stream", () => {
    data.options.operatorActions.record({
      action: "stream-test",
      target: "repository:1",
      effect: "recorded",
    });
  });
  assert.equal(audit.kind, "change");
  assert.match(audit.fragments["audit-region"] ?? "", /stream-test/);
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

test("ticker emits tagged heartbeats without database activity and changes when data moves", async () => {
  const data = fixture();
  const ticker = new SharedChangeTicker(data.store.db, 10);
  const changes: Array<{ kind: string; sequence: number }> = [];
  const unsubscribe = ticker.subscribe((change) => changes.push(change));
  const waitForChange = async (count: number): Promise<void> => {
    const deadline = Date.now() + 1_000;
    while (changes.filter((change) => change.kind === "change").length < count) {
      if (Date.now() >= deadline) throw new Error(`expected ${String(count)} ticker changes`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(changes.some((change) => change.kind === "heartbeat"));
  data.store.db
    .prepare("UPDATE repositories SET provider = 'changed' WHERE id = ?")
    .run(data.repoId);
  await waitForChange(1);
  data.store.db
    .prepare("UPDATE repositories SET model = 'changed-model' WHERE id = ?")
    .run(data.repoId);
  await waitForChange(2);
  data.store.db.prepare("UPDATE repositories SET effort = 'low' WHERE id = ?").run(data.repoId);
  await waitForChange(3);
  data.store.db
    .prepare("UPDATE repositories SET timeout_seconds = 123 WHERE id = ?")
    .run(data.repoId);
  await waitForChange(4);
  const attemptId = Number(
    (
      data.store.db
        .prepare("SELECT id FROM attempts WHERE job_id = ? ORDER BY id LIMIT 1")
        .get(data.jobId) as { id: number }
    ).id,
  );
  data.store.db
    .prepare(
      "INSERT INTO validation_runs (attempt_id, seq, command, exit_code, duration_ms, output_ref) VALUES (?, 2, '[]', 0, 1, NULL)",
    )
    .run(attemptId);
  await waitForChange(5);
  assert.ok(
    changes.every((change, index) => index === 0 || change.sequence > changes[index - 1]!.sequence),
  );
  unsubscribe();
  data.store.close();
});

test("dashboard heartbeats re-render health and surface polling staleness", async () => {
  const data = fixture();
  data.options.pollIntervalSec = 0.05;
  data.store.db
    .prepare("INSERT INTO ingestion_state (repo_id, last_polled_at) VALUES (?, ?)")
    .run(data.repoId, new Date(Date.now() - 10).toISOString());
  const app = buildConsoleServer(data.options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/stream",
      headers: AUTH,
    });
    let buffer = "";
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("dashboard heartbeat did not expose staleness"));
    }, 3_000);
    req.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        const events = buffer.split("\n\n").filter((event) => event.startsWith("event: "));
        if (events.length < 2) return;
        const line = events[1]!.split("\n").find((entry) => entry.startsWith("data: "));
        assert.ok(line);
        const payload = JSON.parse(line.slice("data: ".length)) as {
          kind: string;
          fragments: Record<string, string>;
        };
        if (payload.kind !== "heartbeat") return;
        clearTimeout(timeout);
        assert.match(payload.fragments["health-region"] ?? "", /status-stale/);
        assert.match(payload.fragments["health-region"] ?? "", /stale/);
        assert.equal(payload.fragments.repositories, undefined);
        req.destroy();
        resolve();
      });
      response.on("error", reject);
    });
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.end();
  });
  await app.close();
  data.store.close();
});

test("client time refresh uses carried instants without a database update", () => {
  const nodes = [
    {
      dataset: { timeFormat: "relative" },
      getAttribute: (name: string) => (name === "datetime" ? "2026-09-04T00:00:00.000Z" : null),
      textContent: "",
    },
    {
      dataset: { timeFormat: "elapsed", timeEnd: undefined },
      getAttribute: (name: string) => (name === "datetime" ? "2026-09-04T00:00:00.000Z" : null),
      textContent: "",
    },
  ];
  let refresh: (() => void) | undefined;
  class TestDate extends Date {
    static override now(): number {
      return now;
    }
    static override parse(value: string): number {
      return Date.parse(value);
    }
  }
  let now = Date.parse("2026-09-04T00:00:01.000Z");
  const start = clientScript.indexOf("  const relativeText");
  const end = clientScript.indexOf("  // The log region", start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(clientScript.slice(start, end), {
    Date: TestDate,
    Math,
    Number,
    document: { querySelectorAll: () => nodes },
    setInterval: (callback: () => void, delay: number) => {
      assert.equal(delay, 1000);
      refresh = callback;
      return 1;
    },
  });
  assert.equal(nodes[1]!.textContent, "1.0s");
  now += 1_000;
  refresh?.();
  assert.equal(nodes[1]!.textContent, "2.0s");
  assert.equal(nodes[0]!.textContent, "2s ago");
});

test("console shutdown drains every registered live-update stream", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");

  const open = (): Promise<import("node:http").IncomingMessage> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: `/jobs/${data.jobId}/stream`,
        headers: AUTH,
      });
      req.once("response", (response) => {
        response.setEncoding("utf8");
        response.once("error", reject);
        response.once("data", () => resolve(response));
      });
      req.once("error", reject);
      req.end();
    });
  const [first, second] = await Promise.all([open(), open()]);
  assert.equal(app.liveUpdateStreamCount, 2);
  const ended = Promise.all(
    [first, second].map(
      (response) => new Promise<void>((resolve) => response.once("end", () => resolve())),
    ),
  );
  app.endLiveUpdateStreams();
  await ended;
  assert.equal(app.liveUpdateStreamCount, 0);
  await app.close();
  data.store.close();
});

test("closing the console server resolves while a live-update stream is open", async () => {
  const data = fixture();
  const app = buildConsoleServer(data.options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: `/jobs/${data.jobId}/stream`,
      headers: AUTH,
    });
    req.once("response", (incoming) => {
      incoming.setEncoding("utf8");
      incoming.once("error", reject);
      incoming.once("data", () => resolve(incoming));
    });
    req.once("error", reject);
    req.end();
  });
  const responseEnded = new Promise<void>((resolve) => response.once("end", () => resolve()));
  await Promise.race([
    app.close(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("console close timed out")), 3_000),
    ),
  ]);
  await responseEnded;
  assert.equal(response.complete, true);
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

test("wall-clock helpers use the requested local timezone and retain the UTC instant", () => {
  const instant = "2026-08-28T18:05:44.524Z";
  assert.equal(clockTime(instant, "Asia/Taipei"), "02:05:44");
  assert.equal(logClock(instant, "Asia/Taipei"), "02:05:44.524");
  const html = timeElement(instant, "clock", clockTime(instant, "Asia/Taipei"), {
    timeZone: "Asia/Taipei",
  });
  assert.match(html, /data-time-format="clock"/u);
  assert.match(html, /data-time-zone="Asia\/Taipei"/u);
  assert.match(html, /datetime="2026-08-28T18:05:44.524Z"/u);
  assert.match(html, />02:05:44</u);
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

test("the job log tails a bounded number of newest entries in chronological order", () => {
  const data = fixture();
  const insert = data.store.db.prepare(
    "INSERT INTO log_entries (at, level, event, job_id, fields) VALUES (?, 'info', ?, ?, '{}')",
  );
  for (let i = 0; i < JOB_LOG_TAIL + 60; i += 1) {
    insert.run(`2026-08-28T18:00:00.000Z`, `bulk event ${String(i)}`, data.jobId);
  }
  const model = readJobDetail(data.store.db, data.jobId, [SECRET]);
  assert.ok(model);
  // Bounded, newest-last: an unbounded log is re-serialised on every stream
  // tick and buries the line the operator is actually watching.
  assert.equal(model.logs.length, JOB_LOG_TAIL);
  assert.ok(model.logTotal > JOB_LOG_TAIL);
  const events = model.logs.map((row) => row.event);
  assert.equal(events.at(-1), `bulk event ${String(JOB_LOG_TAIL + 60 - 1)}`);
  assert.ok(events.indexOf("bulk event 259") > events.indexOf("bulk event 200"));
  data.store.close();
});

test("log fields render as chips rather than a raw JSON blob", () => {
  const long = "x".repeat(200);
  const html = logEntries(
    [
      {
        id: 1,
        at: "2026-08-28T17:53:05.254Z",
        level: "error",
        event: "job failed",
        job_id: 1,
        attempt_id: 2,
        fields: JSON.stringify({ reason: "agent-auth-failed", detail: long }),
      },
    ],
    "UTC",
  );
  // Compact clock, not the full ISO stamp, with the exact value kept for hover.
  assert.match(html, /&gt;17:53:05\.254&lt;|>17:53:05\.254</u);
  assert.match(html, /title="2026-08-28T17:53:05\.254Z"/u);
  // Short values become chips; a long one keeps its own readable row.
  assert.match(html, /class="log-chip"><span class="log-key">reason<\/span>agent-auth-failed/u);
  assert.match(html, /class="log-detail"/u);
  // Level drives a styling hook so errors are visually distinct.
  assert.match(html, /class="log-line log-error"/u);
});

test("malformed log fields are shown verbatim rather than dropped", () => {
  const html = logEntries([
    {
      id: 1,
      at: "2026-08-28T17:53:05.254Z",
      level: "info",
      event: "odd",
      job_id: 1,
      attempt_id: null,
      fields: "not json at all",
    },
  ]);
  assert.match(html, /not json at all/u);
});

test("scrollable panels and keyed details survive a live region swap", () => {
  // The job region is replaced wholesale on every stream tick. Anything the
  // operator scrolled or expanded must be re-identified after the swap, or the
  // activity panel snaps back to the top several times a second.
  const model = jobRegions({
    job: {
      id: 1,
      repo_id: 1,
      pr_number: 2,
      comment_id: 3,
      command: "RESOLVE",
      status: "running",
      owner: "acme",
      name: "widgets",
      thread_id: null,
      review_context: null,
      created_at: "2026-08-28T18:00:00.000Z",
      finished_at: null,
    },
    attempts: [],
    timeline: [],
    validation: [],
    logs: [],
    logTotal: 0,
  } as never);
  assert.match(model["job-log-region"], /data-scroll-keep="log"/u);

  const html = agentActivity({
    blocks: [
      {
        seq: 1,
        kind: "reasoning",
        at: "2026-08-28T18:00:00.000Z",
        text: "**Planning**",
        done: true,
      },
      {
        seq: 2,
        kind: "text",
        at: "2026-08-28T18:00:01.000Z",
        text: "Plan: read the repo",
        done: false,
      },
    ],
    toolCalls: 2,
    iterations: 1,
    usage: null,
    updatedAt: "2026-08-28T18:00:02.000Z",
  });
  // The container is restorable, and each reasoning block has a stable key so
  // appending new blocks cannot shift which one is expanded.
  assert.match(html, /data-scroll-keep="activity"/u);
  assert.match(html, /data-details-key="activity-1"/u);
  // Reasoning is collapsed behind a <details>; narration is not.
  assert.match(html, /<details[^>]*>.*Thinking/su);
  assert.match(html, /activity-open/u, "an unfinished block says it is still writing");
});

test("an attempt card never presents an unpushed commit as published work", () => {
  const base = {
    id: 4,
    job_id: 1,
    attempt_number: 1,
    agent: "cline",
    model: "m",
    provider: "p",
    effort: "xhigh",
    workspace_path: "workspace-1",
    head_sha_at_prepare: "head-1",
    started_at: null,
    ended_at: null,
    agent_exit_code: 0,
    agent_session_id: null,
    outcome: "cancelled",
    failure_stage: null,
    failure_reason: null,
    commit_sha: "abc123",
    pushed: 0,
    report_status: null,
    has_uncommitted_changes: 0,
    output_ref: null,
    adopted: false,
    output: "",
    outputRetained: false,
    activity: null,
  };
  const unpushed = attemptCard(base, { showActivity: false });
  assert.match(unpushed, /abc123 \(unpushed\)/u);
  assert.match(unpushed, /<dt>Pushed<\/dt><dd>no<\/dd>/u);
  // A pushed commit is still shown bare, with no qualifier to explain away.
  const pushed = attemptCard({ ...base, pushed: 1, outcome: "succeeded" }, { showActivity: false });
  assert.match(pushed, /<dd>abc123<\/dd>/u);
  assert.equal(pushed.includes("unpushed"), false);
  // Nothing recorded reads as "none" rather than an empty cell.
  assert.match(
    attemptCard({ ...base, commit_sha: null }, { showActivity: false }),
    /<dt>Commit<\/dt><dd>none<\/dd>/u,
  );
});

test("the agent transcript leads the job page and each step states its kind", () => {
  const attempt = {
    id: 9,
    job_id: 1,
    attempt_number: 2,
    agent: "cline",
    model: "m",
    provider: "p",
    effort: "xhigh",
    workspace_path: null,
    head_sha_at_prepare: null,
    started_at: null,
    ended_at: null,
    agent_exit_code: null,
    agent_session_id: null,
    outcome: null,
    failure_stage: null,
    failure_reason: null,
    commit_sha: null,
    pushed: 0,
    report_status: null,
    has_uncommitted_changes: 0,
    output_ref: null,
    output: "",
    activity: {
      blocks: [
        {
          seq: 1,
          kind: "reasoning",
          at: "2026-08-29T06:28:20.000Z",
          text: "**Planning**",
          done: true,
        },
        {
          seq: 2,
          kind: "tool",
          at: "2026-08-29T06:28:21.000Z",
          text: 'run_commands\n{\n  "a": 1\n}',
          done: true,
        },
        {
          seq: 3,
          kind: "text",
          at: "2026-08-29T06:28:22.000Z",
          text: "Working on it",
          done: false,
        },
      ],
      toolCalls: 1,
      iterations: 1,
      usage: null,
      updatedAt: "2026-08-29T06:28:22.000Z",
    },
  };
  const regions = jobRegions({
    job: {
      id: 1,
      repo_id: 1,
      pr_number: 2,
      comment_id: 3,
      command: "RESOLVE",
      status: "running",
      owner: "acme",
      name: "widgets",
      thread_id: null,
      review_context: null,
      created_at: "2026-08-29T06:28:00.000Z",
      finished_at: null,
    },
    attempts: [attempt],
    timeline: [],
    validation: [],
    logs: [],
    logTotal: 0,
  } as never);
  const detail = regions["job-detail-region"];

  // Leads the page: what the agent is doing now must beat the review context
  // and the timeline, which is where it used to sit.
  assert.ok(
    detail.indexOf("activity-panel") < detail.indexOf("Review feedback"),
    "activity must precede review feedback",
  );
  // The newest attempt's transcript is not repeated on its own card.
  assert.equal(detail.split("activity-stream").length - 1, 1);
  // Kind is stated in text, never by colour alone.
  for (const label of ["Thinking", "Tool call", "Narration"]) {
    assert.ok(detail.includes(label), label);
  }
  // A tool step leads with its name and hides long arguments.
  assert.match(detail, /activity-tool-name.*run_commands/su);
  assert.match(detail, /activity-args/u);
  // Only the unfinished step animates.
  assert.equal(detail.split("is-open").length - 1, 1);
});

test("model/provider/effort updates are atomic, unrestricted, audited, and notify the runtime", async () => {
  const data = fixture();
  let settingsChanges = 0;
  data.options.actions = {
    ...data.options.actions,
    repositorySettingsChanged: () => {
      settingsChanges += 1;
    },
  };
  const app = buildConsoleServer(data.options);
  const updated = await app.inject({
    method: "POST",
    url: `/repos/${data.repoId}/model-provider`,
    headers: AUTH,
    payload: { provider: " openai-codex ", model: " gpt-5.6-sol ", effort: " high " },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json(), {
    ok: true,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  assert.deepEqual(
    data.store.db
      .prepare("SELECT provider, model, effort FROM repositories WHERE id = ?")
      .get(data.repoId),
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "high" },
  );
  assert.equal(settingsChanges, 1);

  const effortOnly = await app.inject({
    method: "POST",
    url: `/repos/${data.repoId}/effort`,
    headers: AUTH,
    payload: { effort: " medium " },
  });
  assert.equal(effortOnly.statusCode, 200);
  assert.deepEqual(effortOnly.json(), { ok: true, effort: "medium" });
  assert.deepEqual(
    data.store.db
      .prepare("SELECT provider, model, effort FROM repositories WHERE id = ?")
      .get(data.repoId),
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
  );
  assert.equal(settingsChanges, 2);

  const secondUpdate = await app.inject({
    method: "POST",
    url: `/repos/${data.repoId}/model-provider`,
    headers: AUTH,
    payload: { provider: "openai-codex", model: "gpt-5.6-terra", effort: "medium" },
  });
  assert.equal(secondUpdate.statusCode, 200);
  assert.deepEqual(secondUpdate.json(), {
    ok: true,
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    effort: "medium",
  });
  assert.equal(settingsChanges, 3);
  assert.equal(
    new OperatorActionStore(data.store.db).list()[0]?.action,
    "repository-model-provider",
  );
  await app.close();
  data.store.close();
});

test("repository agent timeout is configurable live and blank disables the limit", async () => {
  const data = fixture();
  let settingsChanges = 0;
  data.options.actions = {
    ...data.options.actions,
    repositorySettingsChanged: () => {
      settingsChanges += 1;
    },
  };
  const app = buildConsoleServer(data.options);
  const limited = await app.inject({
    method: "POST",
    url: `/repos/${data.repoId}/timeout`,
    headers: AUTH,
    payload: { timeoutSeconds: 3600 },
  });
  assert.equal(limited.statusCode, 200);
  assert.deepEqual(limited.json(), { ok: true, timeoutSeconds: 3600 });
  assert.equal(
    (
      data.store.db
        .prepare("SELECT timeout_seconds FROM repositories WHERE id = ?")
        .get(data.repoId) as { timeout_seconds: number | null }
    ).timeout_seconds,
    3600,
  );

  const unlimited = await app.inject({
    method: "POST",
    url: `/repos/${data.repoId}/timeout`,
    headers: AUTH,
    payload: { timeoutSeconds: null },
  });
  assert.equal(unlimited.statusCode, 200);
  assert.deepEqual(unlimited.json(), { ok: true, timeoutSeconds: null });
  assert.equal(
    (
      data.store.db
        .prepare("SELECT timeout_seconds FROM repositories WHERE id = ?")
        .get(data.repoId) as { timeout_seconds: number | null }
    ).timeout_seconds,
    null,
  );
  assert.equal(settingsChanges, 2);

  const invalid = await app.inject({
    method: "POST",
    url: `/repos/${data.repoId}/timeout`,
    headers: AUTH,
    payload: { timeoutSeconds: -1 },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
  data.store.close();
});
