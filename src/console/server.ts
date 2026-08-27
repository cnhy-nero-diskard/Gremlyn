import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { createRedactor } from "../log/redact.js";
import type { OperatorActionStore } from "../store/actions.js";

interface ConsoleActions {
  retry?: (jobId: number) => Promise<unknown> | unknown;
  cancel?: (jobId: number) => Promise<unknown> | unknown;
  resetWorkspace?: (repoId: number, prNumber: number) => Promise<unknown> | unknown;
}

export interface ConsoleOptions {
  db: Database.Database;
  token: string;
  secrets: readonly string[];
  operatorActions: Pick<OperatorActionStore, "record">;
  actions?: ConsoleActions;
}

export function consoleListenOptions(input: { host?: string; port: number }): {
  host: string;
  port: number;
} {
  return { host: input.host ?? "127.0.0.1", port: input.port };
}

export function buildConsoleServer(options: ConsoleOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const redact = createRedactor(options.secrets);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/auth") return;
    const authorization = request.headers.authorization;
    const cookieToken = readCookie(request.headers.cookie, "gremlyn_console_token");
    if (authorization !== `Bearer ${options.token}` && cookieToken !== options.token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (authorization === `Bearer ${options.token}`) {
      reply.header(
        "set-cookie",
        `gremlyn_console_token=${encodeURIComponent(options.token)}; HttpOnly; SameSite=Strict; Path=/`,
      );
    }
  });

  app.get("/auth", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        page(
          "Gremlyn sign in",
          `<h1>Gremlyn console</h1><label>Console token <input id="token" type="password"></label><button id="sign-in">Sign in</button><script>document.getElementById('sign-in').addEventListener('click',async()=>{const token=document.getElementById('token').value;const response=await fetch('/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});if(response.ok)location.href='/';else document.body.insertAdjacentHTML('beforeend','<p>Invalid token</p>');});</script>`,
        ),
      ),
  );

  app.post<{ Body: { token?: string } }>("/auth", async (request, reply) => {
    if (request.body?.token !== options.token)
      return reply.code(401).send({ error: "unauthorized" });
    return reply
      .header(
        "set-cookie",
        `gremlyn_console_token=${encodeURIComponent(options.token)}; HttpOnly; SameSite=Strict; Path=/`,
      )
      .send({ ok: true });
  });

  app.get("/", async (_request, reply) => {
    const repositories = options.db
      .prepare("SELECT id, owner, name, enabled FROM repositories ORDER BY owner, name")
      .all() as RepositorySummary[];
    const jobs = options.db
      .prepare(
        `SELECT jobs.*, repositories.owner, repositories.name
         FROM jobs JOIN repositories ON repositories.id = jobs.repo_id
         ORDER BY jobs.id DESC LIMIT 50`,
      )
      .all() as JobSummary[];
    const running = jobs.filter((job) => RUNNING_STATUSES.has(job.status));
    const queued = jobs.filter((job) => job.status === "queued");
    const recent = jobs.filter((job) => TERMINAL_STATUSES.has(job.status));
    return reply.type("text/html").send(
      page(
        "Gremlyn",
        `<h1>Gremlyn operator console</h1>
         <p>Orchestrator status: <strong>running</strong></p>
         ${repositoryTable(repositories)}
         ${jobSection("Running", running)}
         ${jobSection("Queued", queued)}
         ${jobSection("Recent successes and failures", recent)}`,
      ),
    );
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const jobId = positiveInteger(request.params.id);
    const model = readJobDetail(options.db, jobId, redact);
    if (model === undefined) return reply.code(404).send({ error: "job-not-found" });
    return reply.type("text/html").send(page(`Job ${jobId}`, renderJobDetail(model)));
  });

  app.get<{ Params: { id: string }; Querystring: { snapshot?: string } }>(
    "/jobs/:id/stream",
    async (request, reply) => {
      const jobId = positiveInteger(request.params.id);
      let model = readJobDetail(options.db, jobId, redact);
      if (model === undefined) return reply.code(404).send({ error: "job-not-found" });
      if (request.query.snapshot !== "1") {
        const initialSignature = jobSignature(model);
        model = await waitForJobChange(options.db, jobId, initialSignature, redact);
        if (model === undefined) {
          return reply
            .header("cache-control", "no-cache")
            .type("text/event-stream")
            .send(": keepalive\n\n");
        }
      }
      const payload = JSON.stringify({
        status: model.job.status,
        timeline: model.timeline,
        attempts: model.attempts.map((attempt) => ({
          id: attempt.id,
          outcome: attempt.outcome,
          output: attempt.output,
        })),
      });
      return reply
        .header("cache-control", "no-cache")
        .type("text/event-stream")
        .send(`event: job-update\ndata: ${payload}\n\n`);
    },
  );

  app.get<{ Params: { id: string } }>("/jobs/:id/log", async (request, reply) => {
    const jobId = positiveInteger(request.params.id);
    const rows = options.db
      .prepare("SELECT * FROM log_entries WHERE job_id = ? ORDER BY id")
      .all(jobId) as LogRow[];
    return reply.send(
      rows.map((row) => ({
        ...row,
        event: redact(row.event),
        fields: redact(row.fields ?? "{}"),
      })),
    );
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/retry", async (request, reply) => {
    const jobId = positiveInteger(request.params.id);
    if (!options.actions?.retry) return reply.code(501).send({ error: "retry-unavailable" });
    await options.actions.retry(jobId);
    options.operatorActions.record({
      action: "retry",
      target: `job:${jobId}`,
      effect: "queued",
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/cancel", async (request, reply) => {
    const jobId = positiveInteger(request.params.id);
    if (!options.actions?.cancel) return reply.code(501).send({ error: "cancel-unavailable" });
    await options.actions.cancel(jobId);
    options.operatorActions.record({
      action: "cancel",
      target: `job:${jobId}`,
      effect: "requested",
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/repos/:id/toggle", async (request, reply) => {
    const repoId = positiveInteger(request.params.id);
    const repo = options.db.prepare("SELECT enabled FROM repositories WHERE id = ?").get(repoId) as
      { enabled: number } | undefined;
    if (!repo) return reply.code(404).send({ error: "repository-not-found" });
    const enabled = repo.enabled === 0 ? 1 : 0;
    options.db.prepare("UPDATE repositories SET enabled = ? WHERE id = ?").run(enabled, repoId);
    options.operatorActions.record({
      action: "repository-toggle",
      target: `repository:${repoId}`,
      effect: enabled === 1 ? "enabled" : "disabled",
    });
    return reply.send({ ok: true, enabled: enabled === 1 });
  });

  app.post<{
    Params: { id: string };
    Body: { confirm?: string; prNumber?: number };
  }>("/workspaces/:id/reset", async (request, reply) => {
    const repoId = positiveInteger(request.params.id);
    const prNumber = request.body?.prNumber;
    if (request.body?.confirm !== "RESET" || !Number.isInteger(prNumber) || (prNumber ?? 0) < 1) {
      return reply.code(400).send({ error: "explicit-reset-confirmation-required" });
    }
    if (!options.actions?.resetWorkspace) {
      return reply.code(501).send({ error: "workspace-reset-unavailable" });
    }
    await options.actions.resetWorkspace(repoId, prNumber as number);
    options.operatorActions.record({
      action: "workspace-reset",
      target: `repository:${repoId}/pr:${prNumber}`,
      effect: "recreated",
    });
    return reply.send({ ok: true });
  });

  return app;
}

interface RepositorySummary {
  id: number;
  owner: string;
  name: string;
  enabled: number;
}

interface JobSummary {
  id: number;
  repo_id: number;
  pr_number: number;
  comment_id: number;
  command: string;
  status: string;
  owner: string;
  name: string;
}

interface AttemptDetail {
  id: number;
  attempt_number: number;
  agent: string;
  model: string;
  effort: string;
  workspace_path: string | null;
  outcome: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
  commit_sha: string | null;
  report_status: string | null;
  output_ref: string | null;
  output: string;
}

interface JobDetail {
  job: JobSummary & { review_context: string | null; thread_id: string | null };
  attempts: AttemptDetail[];
  timeline: unknown[];
  validation: unknown[];
  logs: unknown[];
}

interface LogRow {
  id: number;
  at: string;
  level: string;
  event: string;
  job_id: number | null;
  attempt_id: number | null;
  fields: string | null;
}

const RUNNING_STATUSES = new Set(["preparing", "running", "validating", "publishing", "reporting"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function readJobDetail(
  db: Database.Database,
  jobId: number,
  redact: (value: string) => string,
): JobDetail | undefined {
  const job = db
    .prepare(
      `SELECT jobs.*, repositories.owner, repositories.name
       FROM jobs JOIN repositories ON repositories.id = jobs.repo_id
       WHERE jobs.id = ?`,
    )
    .get(jobId) as JobDetail["job"] | undefined;
  if (!job) return undefined;
  const attempts = db
    .prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number")
    .all(jobId) as Omit<AttemptDetail, "output">[];
  const withOutput = attempts.map((attempt) => ({
    ...attempt,
    output: redact(readOutput(attempt.output_ref)),
  }));
  const timeline = db
    .prepare("SELECT status, at, attempt_id FROM status_events WHERE job_id = ? ORDER BY id")
    .all(jobId);
  const validationRows = db
    .prepare(
      `SELECT validation_runs.* FROM validation_runs
       JOIN attempts ON attempts.id = validation_runs.attempt_id
       WHERE attempts.job_id = ? ORDER BY attempts.attempt_number, validation_runs.seq`,
    )
    .all(jobId) as { output_ref: string | null; [key: string]: unknown }[];
  const validation = validationRows.map((row) => ({
    ...row,
    output: redact(readOutput(row.output_ref)),
  }));
  const logRows = db.prepare("SELECT * FROM log_entries WHERE job_id = ? ORDER BY id").all(jobId);
  const logs = JSON.parse(redact(JSON.stringify(logRows))) as unknown[];
  const safeJob = {
    ...job,
    review_context: job.review_context === null ? null : redact(job.review_context),
  };
  return { job: safeJob, attempts: withOutput, timeline, validation, logs };
}

function readOutput(path: string | null): string {
  if (!path || !existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "[output unavailable]";
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function repositoryTable(repositories: RepositorySummary[]): string {
  const rows = repositories
    .map(
      (repository) =>
        `<tr><td>${escapeHtml(`${repository.owner}/${repository.name}`)}</td><td>${repository.enabled === 1 ? "enabled" : "disabled"}</td></tr>`,
    )
    .join("");
  return `<h2>Repositories</h2><table><tbody>${rows}</tbody></table>`;
}

function jobSection(title: string, jobs: JobSummary[]): string {
  const rows = jobs
    .map(
      (job) =>
        `<li><a href="/jobs/${job.id}">${escapeHtml(`${job.owner}/${job.name} PR #${job.pr_number}`)}</a> — ${escapeHtml(job.status)}</li>`,
    )
    .join("");
  return `<section><h2>${escapeHtml(title)}</h2><ul>${rows || "<li>None</li>"}</ul></section>`;
}

function renderJobDetail(model: JobDetail): string {
  const context = model.job.review_context ?? "Review context not captured";
  const attempts = model.attempts
    .map(
      (attempt) => `<article>
        <h2>Attempt ${attempt.attempt_number}</h2>
        <dl>
          <dt>Agent/model/effort</dt><dd>${escapeHtml(`${attempt.agent} / ${attempt.model} / ${attempt.effort}`)}</dd>
          <dt>Workspace</dt><dd>${escapeHtml(attempt.workspace_path ?? "not prepared")}</dd>
          <dt>Outcome</dt><dd>${escapeHtml(attempt.outcome ?? "pending")}</dd>
          <dt>Failure</dt><dd>${escapeHtml(`${attempt.failure_stage ?? "none"}: ${attempt.failure_reason ?? "none"}`)}</dd>
          <dt>Commit</dt><dd>${escapeHtml(attempt.commit_sha ?? "none")}</dd>
          <dt>Reporting</dt><dd>${escapeHtml(attempt.report_status ?? "pending")}</dd>
        </dl>
        <h3>Agent output</h3><pre>${escapeHtml(attempt.output)}</pre>
      </article>`,
    )
    .join("");
  return `<h1>Job ${model.job.id}: ${escapeHtml(`${model.job.owner}/${model.job.name} PR #${model.job.pr_number}`)}</h1>
    <p>Command ${escapeHtml(model.job.command)} from comment <a href="https://github.com/${encodeURIComponent(model.job.owner)}/${encodeURIComponent(model.job.name)}/pull/${model.job.pr_number}#discussion_r${model.job.comment_id}">${model.job.comment_id}</a></p>
    <h2>Review feedback</h2><pre>${escapeHtml(context)}</pre>
    <h2>Timeline</h2><pre>${escapeHtml(JSON.stringify(model.timeline, null, 2))}</pre>
    ${attempts}
    <h2>Validation results</h2><pre>${escapeHtml(JSON.stringify(model.validation, null, 2))}</pre>
    <h2>Structured log</h2><pre>${escapeHtml(JSON.stringify(model.logs, null, 2))}</pre>
    <section><h2>Routine actions</h2><button data-action="retry">Retry</button><button data-action="cancel">Cancel</button></section>
    <section class="danger"><h2>Destructive actions</h2><p>Workspace reset requires typing RESET.</p><button data-action="reset" disabled>Reset workspace</button></section>
    <script>const stream=new EventSource('/jobs/${model.job.id}/stream');stream.addEventListener('job-update',()=>location.reload());</script>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

function jobSignature(model: JobDetail): string {
  return JSON.stringify({
    status: model.job.status,
    timeline: model.timeline,
    attempts: model.attempts.map((attempt) => ({
      id: attempt.id,
      outcome: attempt.outcome,
      output: attempt.output,
    })),
  });
}

async function waitForJobChange(
  db: Database.Database,
  jobId: number,
  initialSignature: string,
  redact: (value: string) => string,
): Promise<JobDetail | undefined> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const model = readJobDetail(db, jobId, redact);
    if (model === undefined || jobSignature(model) !== initialSignature) return model;
  }
  return undefined;
}
