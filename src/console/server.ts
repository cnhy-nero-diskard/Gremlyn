import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import type { OperatorActionStore } from "../store/actions.js";
import { createConsoleQueries, type ConsoleQueries } from "./queries.js";
import { stylesheet, clientScript, stylesheetPath, clientScriptPath } from "./assets.js";
import { authLayout, layout } from "./views/layout.js";
import { dashboardView, dashboardRegions } from "./views/dashboard.js";
import { jobView, jobRegions } from "./views/job.js";
import { commandsView, auditView } from "./views/commands.js";
import { repositoryExists, toggleRepository } from "./mutations.js";
import { openSseStream, SharedChangeTicker } from "./stream.js";

export interface ConsoleActions {
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
  pollIntervalSec?: number;
  concurrency?: number;
}
export function consoleListenOptions(input: { host?: string; port: number }): {
  host: string;
  port: number;
} {
  return { host: input.host ?? "127.0.0.1", port: input.port };
}

export function buildConsoleServer(options: ConsoleOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const queries: ConsoleQueries = createConsoleQueries({
    db: options.db,
    secrets: options.secrets,
    pollIntervalSec: options.pollIntervalSec ?? 60,
    concurrency: options.concurrency ?? 1,
  });
  const ticker = new SharedChangeTicker(options.db);
  const publicAssetPaths = new Set([
    "/assets/app.css",
    "/assets/app.js",
    stylesheetPath,
    clientScriptPath,
  ]);
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?", 1)[0] ?? "";
    if (requestPath === "/auth" || publicAssetPaths.has(requestPath)) return;
    const authorization = request.headers.authorization;
    const cookieToken = readCookie(request.headers.cookie, "gremlyn_console_token");
    if (authorization !== `Bearer ${options.token}` && cookieToken !== options.token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (authorization === `Bearer ${options.token}`)
      reply.header("set-cookie", cookie(options.token));
  });
  app.get("/auth", async (_request, reply) => reply.type("text/html").send(authLayout()));
  app.post<{ Body: { token?: string } }>("/auth", async (request, reply) =>
    request.body?.token !== options.token
      ? reply.code(401).send({ error: "unauthorized" })
      : reply.header("set-cookie", cookie(options.token)).send({ ok: true }),
  );
  app.get("/assets/app.css", async (_request, reply) =>
    reply
      .type("text/css")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(stylesheet),
  );
  app.get("/assets/app.js", async (_request, reply) =>
    reply
      .type("application/javascript")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(clientScript),
  );
  app.get(stylesheetPath, async (_request, reply) =>
    reply
      .type("text/css")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(stylesheet),
  );
  app.get(clientScriptPath, async (_request, reply) =>
    reply
      .type("application/javascript")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(clientScript),
  );
  app.get("/", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        layout("Gremlyn dashboard", dashboardView(queries.readDashboard()), { stream: "/stream" }),
      ),
  );
  app.get<{ Querystring: { snapshot?: string } }>("/stream", async (request, reply) => {
    const fragments = () => {
      const regions = dashboardRegions(queries.readDashboard());
      return {
        "health-region": regions.health,
        repositories: regions.repositories,
        "job-lanes": regions.jobs,
      };
    };
    reply.hijack();
    openSseStream({
      request: request.raw,
      response: reply.raw,
      ticker,
      event: "dashboard-update",
      initial: fragments(),
      render: fragments,
      snapshot: request.query.snapshot === "1",
    });
  });
  app.get<{ Querystring: { snapshot?: string } }>("/dashboard/stream", async (request, reply) => {
    const fragments = () => {
      const regions = dashboardRegions(queries.readDashboard());
      return {
        "health-region": regions.health,
        repositories: regions.repositories,
        "job-lanes": regions.jobs,
      };
    };
    reply.hijack();
    openSseStream({
      request: request.raw,
      response: reply.raw,
      ticker,
      event: "dashboard-update",
      initial: fragments(),
      render: fragments,
      snapshot: request.query.snapshot === "1",
    });
  });
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const id = positiveInteger(request.params.id);
    const model = queries.readJobDetail(id);
    if (!model) return reply.code(404).send({ error: "job-not-found" });
    return reply
      .type("text/html")
      .send(layout(`Job ${id}`, jobView(model), { stream: `/jobs/${id}/stream` }));
  });
  app.get<{ Params: { id: string }; Querystring: { snapshot?: string } }>(
    "/jobs/:id/stream",
    async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const model = queries.readJobDetail(id);
      if (!model) return reply.code(404).send({ error: "job-not-found" });
      const fragments = () => {
        const current = queries.readJobDetail(id);
        return current ? jobRegions(current) : {};
      };
      reply.hijack();
      openSseStream({
        request: request.raw,
        response: reply.raw,
        ticker,
        event: "job-update",
        initial: jobRegions(model),
        render: fragments,
        snapshot: request.query.snapshot === "1",
      });
    },
  );
  app.get<{ Params: { id: string } }>("/jobs/:id/log", async (request, reply) =>
    reply.send(queries.readJobLog(positiveInteger(request.params.id))),
  );
  app.get("/commands", async (_request, reply) =>
    reply
      .type("text/html")
      .send(layout("Command ingestion", commandsView(queries.readProcessedCommands()))),
  );
  app.get("/audit", async (_request, reply) =>
    reply
      .type("text/html")
      .send(layout("Operator audit", auditView(queries.readOperatorActions()))),
  );
  app.post<{ Params: { id: string } }>("/jobs/:id/retry", async (request, reply) => {
    const id = positiveInteger(request.params.id);
    if (!options.actions?.retry) return reply.code(501).send({ error: "retry-unavailable" });
    try {
      await options.actions.retry(id);
      options.operatorActions.record({ action: "retry", target: `job:${id}`, effect: "queued" });
      return reply.send({ ok: true });
    } catch (error) {
      return reply.code(501).send({ error: errorMessage(error) });
    }
  });
  app.post<{ Params: { id: string } }>("/jobs/:id/cancel", async (request, reply) => {
    const id = positiveInteger(request.params.id);
    if (!options.actions?.cancel) return reply.code(501).send({ error: "cancel-unavailable" });
    try {
      await options.actions.cancel(id);
      options.operatorActions.record({
        action: "cancel",
        target: `job:${id}`,
        effect: "requested",
      });
      return reply.send({ ok: true });
    } catch (error) {
      return reply.code(501).send({ error: errorMessage(error) });
    }
  });
  app.post<{ Params: { id: string } }>("/repos/:id/toggle", async (request, reply) => {
    const id = positiveInteger(request.params.id);
    if (!repositoryExists(options.db, id))
      return reply.code(404).send({ error: "repository-not-found" });
    const enabled = toggleRepository(options.db, id);
    options.operatorActions.record({
      action: "repository-toggle",
      target: `repository:${id}`,
      effect: enabled ? "enabled" : "disabled",
    });
    return reply.send({ ok: true, enabled });
  });
  app.post<{ Params: { id: string }; Body: { confirm?: string; prNumber?: number } }>(
    "/workspaces/:id/reset",
    async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const pr = request.body?.prNumber;
      if (request.body?.confirm !== "RESET" || !Number.isInteger(pr) || (pr ?? 0) < 1)
        return reply.code(400).send({ error: "explicit-reset-confirmation-required" });
      if (!options.actions?.resetWorkspace)
        return reply.code(501).send({ error: "workspace-reset-unavailable" });
      try {
        await options.actions.resetWorkspace(id, pr as number);
        options.operatorActions.record({
          action: "workspace-reset",
          target: `repository:${id}/pr:${pr}`,
          effect: "recreated",
        });
        return reply.send({ ok: true });
      } catch (error) {
        return reply.code(501).send({ error: errorMessage(error) });
      }
    },
  );
  app.addHook("onClose", async () => ticker.stop());
  return app;
}
function cookie(token: string): string {
  return `gremlyn_console_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}
function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
