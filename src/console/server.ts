import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ProviderCatalog } from "../agent/provider-catalog.js";
import type { OperatorActionStore } from "../store/actions.js";
import { KINDS_REQUIRING_PROVIDER, type AgentDefinition } from "../config/loader.js";
import { createConsoleQueries, type ConsoleQueries } from "./queries.js";
import { stylesheet, clientScript, stylesheetPath, clientScriptPath } from "./assets.js";
import { authLayout, layout } from "./views/layout.js";
import { dashboardView, dashboardRegions } from "./views/dashboard.js";
import { jobView, jobRegions } from "./views/job.js";
import { commandsView, auditView } from "./views/commands.js";
import {
  repositoryAgent,
  repositoryExists,
  setRepositoryEffort,
  setRepositoryModel,
  setRepositoryModelProvider,
  setRepositoryProvider,
  setRepositoryTimeout,
  toggleRepository,
} from "./mutations.js";
import {
  openSseStream,
  SharedChangeTicker,
  type StreamEnd,
  type StreamRegistrar,
  type StreamChange,
} from "./stream.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../types.js";
import { CONSOLE_SESSION_COOKIE, ConsoleSessionStore, constantTimeEqual } from "./session.js";

export interface ConsoleActions {
  retry?: (jobId: number) => Promise<unknown> | unknown;
  cancel?: (jobId: number) => Promise<unknown> | unknown;
  resetWorkspace?: (repoId: number, prNumber: number) => Promise<unknown> | unknown;
  repositorySettingsChanged?: (repoId: number) => Promise<unknown> | unknown;
}
export interface ConsoleOptions {
  db: Database.Database;
  token: string;
  secrets: readonly string[];
  operatorActions: Pick<OperatorActionStore, "record">;
  actions?: ConsoleActions;
  pollIntervalSec?: number;
  concurrency?: number;
  /** Where attempt output and activity snapshots live; used for live tailing. */
  dataDir?: string;
  /** Optional IANA timezone used for server-rendered wall-clock values. */
  timezone?: string | undefined;
  /** Injectable process-local session store and clock/randomness for tests. */
  sessionStore?: ConsoleSessionStore;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  providerCatalog?: ProviderCatalog;
  /**
   * The configured agent definitions, keyed by the agent id repositories
   * reference. Provider semantics (whether an empty provider is valid) and
   * the selectable effort tiers are driven per repository from its agent's
   * kind and declared tiers, not from one global setting.
   */
  agents?: Record<string, AgentDefinition>;
}
export interface ConsoleServer extends FastifyInstance {
  endLiveUpdateStreams(): void;
  readonly liveUpdateStreamCount: number;
  sessionStore: ConsoleSessionStore;
}
/** Agent-aware defaults for a repository with no matching definition. */
function agentOptionsFor(
  agents: Record<string, AgentDefinition> | undefined,
  agentId: string | undefined,
): { efforts: readonly ReasoningEffort[]; providerRequired: boolean } {
  const definition = agentId === undefined ? undefined : agents?.[agentId];
  return {
    efforts: definition?.efforts ?? REASONING_EFFORTS,
    providerRequired: definition ? KINDS_REQUIRING_PROVIDER.has(definition.kind) : true,
  };
}
export function consoleListenOptions(input: { host?: string; port: number }): {
  host: string;
  port: number;
} {
  return { host: input.host ?? "127.0.0.1", port: input.port };
}

export function buildConsoleServer(options: ConsoleOptions): ConsoleServer {
  const app = Fastify({ logger: false }) as unknown as ConsoleServer;
  const sessionStore =
    options.sessionStore ??
    new ConsoleSessionStore({
      ...(options.now ? { now: options.now } : {}),
      ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
    });
  app.sessionStore = sessionStore;
  const liveStreams = new Set<StreamEnd>();
  const registerStream: StreamRegistrar = (end) => {
    liveStreams.add(end);
    return () => liveStreams.delete(end);
  };
  app.endLiveUpdateStreams = (): void => {
    for (const end of [...liveStreams]) end();
  };
  Object.defineProperty(app, "liveUpdateStreamCount", {
    configurable: false,
    enumerable: false,
    get: () => liveStreams.size,
  });
  const providerCatalog = options.providerCatalog ?? new ProviderCatalog();
  const queries: ConsoleQueries = createConsoleQueries({
    db: options.db,
    secrets: options.secrets,
    pollIntervalSec: options.pollIntervalSec ?? 60,
    concurrency: options.concurrency ?? 1,
    dataDir: options.dataDir ?? ".gremlyn",
  });
  const ticker = new SharedChangeTicker(options.db, 250, options.dataDir ?? ".gremlyn");
  const publicAssetPaths = new Set([
    "/assets/app.css",
    "/assets/app.js",
    stylesheetPath,
    clientScriptPath,
  ]);
  const publicPaths = new Set([
    "/auth",
    "/auth/sign-out",
    "/sign-out",
    "/session-status",
    ...publicAssetPaths,
  ]);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const params = new URLSearchParams(String(body));
      done(null, Object.fromEntries(params.entries()));
    },
  );
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?", 1)[0] ?? "";
    if (publicPaths.has(requestPath)) return;
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    const bearerValid = bearer !== undefined && constantTimeEqual(bearer, options.token);
    const sessionHandle = readCookie(request.headers.cookie, CONSOLE_SESSION_COOKIE);
    const sessionState = sessionStore.lookup(sessionHandle);
    if (!bearerValid && sessionState !== "active") {
      if (sessionHandle !== undefined && isDocumentNavigation(request)) {
        await reply
          .code(303)
          .header("location", "/auth?reason=expired")
          .header("set-cookie", expiredCookie(isHttpsRequest(request)))
          .send();
        return;
      }
      await reply
        .code(401)
        .send({ error: sessionHandle === undefined ? "unauthorized" : "session-expired" });
      return;
    }
  });
  app.get<{ Querystring: { reason?: string } }>("/auth", async (request, reply) =>
    reply.type("text/html").send(authLayout(authReason(request.query.reason))),
  );
  app.post("/auth", async (request, reply) => {
    const submitted = submittedToken(request.body);
    if (submitted === undefined || !constantTimeEqual(submitted, options.token)) {
      if (prefersHtmlAuth(request)) {
        return reply.code(401).type("text/html").send(authLayout("invalid"));
      }
      return reply.code(401).send({ error: "unauthorized" });
    }
    const session = sessionStore.create();
    const setCookie = sessionCookie(session.handle, isHttpsRequest(request));
    if (prefersHtmlAuth(request)) {
      return reply.code(303).header("location", "/").header("set-cookie", setCookie).send();
    }
    return reply.header("set-cookie", setCookie).send({ ok: true });
  });
  const signOut = async (request: FastifyRequest, reply: FastifyReply) => {
    sessionStore.revoke(readCookie(request.headers.cookie, CONSOLE_SESSION_COOKIE));
    const setCookie = expiredCookie(isHttpsRequest(request));
    if (prefersHtmlAuth(request)) {
      return reply
        .code(303)
        .header("location", "/auth?reason=signed-out")
        .header("set-cookie", setCookie)
        .send();
    }
    return reply.header("set-cookie", setCookie).send({ ok: true });
  };
  app.post("/auth/sign-out", signOut);
  app.post("/sign-out", signOut);
  app.get("/session-status", async (request, reply) => {
    const handle = readCookie(request.headers.cookie, CONSOLE_SESSION_COOKIE);
    const status = sessionStore.lookup(handle);
    if (status === "expired") reply.header("set-cookie", expiredCookie(isHttpsRequest(request)));
    return reply.send({ status });
  });
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
  app.get("/model-catalog", async (_request, reply) =>
    reply.type("application/json").send(await providerCatalog.refreshIfStale()),
  );
  app.get("/", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        layout(
          "Gremlyn dashboard",
          dashboardView(
            queries.readDashboard(),
            providerCatalog.snapshot(),
            options.agents,
            options.timezone,
          ),
          { stream: "/stream", wide: true, authenticated: true, section: "dashboard" },
        ),
      ),
  );
  app.get<{ Querystring: { snapshot?: string } }>("/stream", async (request, reply) => {
    const fragments = (change: StreamChange) => {
      const regions = dashboardRegions(
        queries.readDashboard(),
        providerCatalog.snapshot(),
        options.agents,
        options.timezone,
      );
      if (change.kind === "heartbeat") return { "health-region": regions.health };
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
      initial: fragments({ sequence: 0, kind: "change" }),
      render: fragments,
      snapshot: request.query.snapshot === "1",
      register: registerStream,
    });
  });
  app.get<{ Querystring: { snapshot?: string } }>("/dashboard/stream", async (request, reply) => {
    const fragments = (change: StreamChange) => {
      const regions = dashboardRegions(
        queries.readDashboard(),
        providerCatalog.snapshot(),
        options.agents,
        options.timezone,
      );
      if (change.kind === "heartbeat") return { "health-region": regions.health };
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
      initial: fragments({ sequence: 0, kind: "change" }),
      render: fragments,
      snapshot: request.query.snapshot === "1",
      register: registerStream,
    });
  });
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const id = positiveInteger(request.params.id);
    const model = queries.readJobDetail(id);
    if (!model) return reply.code(404).send({ error: "job-not-found" });
    return reply
      .type("text/html")
      .send(
        layout(
          `Job ${id} · ${model.job.owner}/${model.job.name} PR #${String(model.job.pr_number)}`,
          jobView(model, options.timezone),
          { stream: `/jobs/${id}/stream`, wide: true, authenticated: true, section: "dashboard" },
        ),
      );
  });
  app.get<{ Params: { id: string }; Querystring: { snapshot?: string } }>(
    "/jobs/:id/stream",
    async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const model = queries.readJobDetail(id);
      if (!model) return reply.code(404).send({ error: "job-not-found" });
      const fragments = (change: StreamChange) => {
        if (change.kind === "heartbeat") return {};
        const current = queries.readJobDetail(id);
        return current ? jobRegions(current, options.timezone) : {};
      };
      reply.hijack();
      openSseStream({
        request: request.raw,
        response: reply.raw,
        ticker,
        event: "job-update",
        initial: jobRegions(model, options.timezone),
        render: fragments,
        snapshot: request.query.snapshot === "1",
        register: registerStream,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/jobs/:id/log", async (request, reply) =>
    reply.send(queries.readJobLog(positiveInteger(request.params.id))),
  );
  app.get("/commands", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        layout(
          "Command ingestion",
          `<div id="commands-region">${commandsView(queries.readProcessedCommands(), options.timezone)}</div>`,
          { stream: "/commands/stream", authenticated: true, section: "commands" },
        ),
      ),
  );
  app.get<{ Querystring: { snapshot?: string } }>("/commands/stream", async (request, reply) => {
    const render = (change: StreamChange) =>
      change.kind === "heartbeat"
        ? {}
        : { "commands-region": commandsView(queries.readProcessedCommands(), options.timezone) };
    reply.hijack();
    openSseStream({
      request: request.raw,
      response: reply.raw,
      ticker,
      event: "commands-update",
      initial: render({ sequence: 0, kind: "change" }),
      render,
      snapshot: request.query.snapshot === "1",
      register: registerStream,
    });
  });
  app.get("/audit", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        layout(
          "Operator audit",
          `<div id="audit-region">${auditView(queries.readOperatorActions(), options.timezone)}</div>`,
          { stream: "/audit/stream", authenticated: true, section: "audit" },
        ),
      ),
  );
  app.get<{ Querystring: { snapshot?: string } }>("/audit/stream", async (request, reply) => {
    const render = (change: StreamChange) =>
      change.kind === "heartbeat"
        ? {}
        : { "audit-region": auditView(queries.readOperatorActions(), options.timezone) };
    reply.hijack();
    openSseStream({
      request: request.raw,
      response: reply.raw,
      ticker,
      event: "audit-update",
      initial: render({ sequence: 0, kind: "change" }),
      render,
      snapshot: request.query.snapshot === "1",
      register: registerStream,
    });
  });
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
  app.post<{ Params: { id: string }; Body: { model?: string } }>(
    "/repos/:id/model",
    async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const model = request.body?.model;
      if (typeof model !== "string" || model.length === 0)
        return reply.code(400).send({ error: "model-required" });
      const result = setRepositoryModel(options.db, id, model);
      if (!result.ok) {
        return reply.code(result.reason === "not-found" ? 404 : 400).send({ error: result.reason });
      }
      options.operatorActions.record({
        action: "repository-model",
        target: `repository:${id}`,
        effect: result.model,
      });
      await options.actions?.repositorySettingsChanged?.(id);
      return reply.send({ ok: true, model: result.model });
    },
  );
  app.post<{ Params: { id: string }; Body: { provider?: string } }>(
    "/repos/:id/provider",
    async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const provider = request.body?.provider;
      if (typeof provider !== "string") return reply.code(400).send({ error: "provider-required" });
      const { providerRequired } = agentOptionsFor(options.agents, repositoryAgent(options.db, id));
      const result = setRepositoryProvider(options.db, id, provider, providerRequired);
      if (!result.ok) {
        return reply.code(result.reason === "not-found" ? 404 : 400).send({ error: result.reason });
      }
      options.operatorActions.record({
        action: "repository-provider",
        target: `repository:${id}`,
        effect: result.provider,
      });
      await options.actions?.repositorySettingsChanged?.(id);
      return reply.send({ ok: true, provider: result.provider });
    },
  );
  app.post<{
    Params: { id: string };
    Body: { provider?: string; model?: string; effort?: string };
  }>("/repos/:id/model-provider", async (request, reply) => {
    const id = positiveInteger(request.params.id);
    const provider = request.body?.provider;
    const model = request.body?.model;
    const effort = request.body?.effort;
    if (typeof provider !== "string") return reply.code(400).send({ error: "provider-required" });
    if (typeof model !== "string") return reply.code(400).send({ error: "model-required" });
    if (typeof effort !== "string") return reply.code(400).send({ error: "effort-required" });
    // Effort tiers and provider semantics come from this repository's agent.
    const { efforts, providerRequired } = agentOptionsFor(
      options.agents,
      repositoryAgent(options.db, id),
    );
    const result = setRepositoryModelProvider(
      options.db,
      id,
      provider,
      model,
      effort,
      efforts,
      providerRequired,
    );
    if (!result.ok) {
      return reply.code(result.reason === "not-found" ? 404 : 400).send({ error: result.reason });
    }
    options.operatorActions.record({
      action: "repository-model-provider",
      target: `repository:${id}`,
      effect: `${result.provider}/${result.model}/${result.effort}`,
    });
    await options.actions?.repositorySettingsChanged?.(id);
    return reply.send({
      ok: true,
      provider: result.provider,
      model: result.model,
      effort: result.effort,
    });
  });
  app.post<{ Params: { id: string }; Body: { effort?: string } }>(
    "/repos/:id/effort",
    async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const effort = request.body?.effort;
      if (typeof effort !== "string") return reply.code(400).send({ error: "effort-required" });
      const { efforts } = agentOptionsFor(options.agents, repositoryAgent(options.db, id));
      const result = setRepositoryEffort(options.db, id, effort, efforts);
      if (!result.ok) {
        return reply.code(result.reason === "not-found" ? 404 : 400).send({ error: result.reason });
      }
      options.operatorActions.record({
        action: "repository-effort",
        target: `repository:${id}`,
        effect: result.effort,
      });
      await options.actions?.repositorySettingsChanged?.(id);
      return reply.send({ ok: true, effort: result.effort });
    },
  );
  app.post<{ Params: { id: string }; Body: { timeoutSeconds?: unknown } }>(
    "/repos/:id/timeout",
    async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const result = setRepositoryTimeout(options.db, id, request.body?.timeoutSeconds);
      if (!result.ok) {
        return reply.code(result.reason === "not-found" ? 404 : 400).send({ error: result.reason });
      }
      options.operatorActions.record({
        action: "repository-timeout",
        target: `repository:${id}`,
        effect: result.timeoutSeconds === null ? "unlimited" : String(result.timeoutSeconds),
      });
      await options.actions?.repositorySettingsChanged?.(id);
      return reply.send({ ok: true, timeoutSeconds: result.timeoutSeconds });
    },
  );
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
  app.addHook("preClose", async () => {
    app.endLiveUpdateStreams();
  });
  app.addHook("onClose", async () => {
    ticker.stop();
    sessionStore.clear();
  });
  return app;
}
function sessionCookie(handle: string, secure: boolean): string {
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(handle)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(8 * 60 * 60)}${secure ? "; Secure" : ""}`;
}
function expiredCookie(secure: boolean): string {
  return `${CONSOLE_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
function submittedToken(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const token = (body as { token?: unknown }).token;
  return typeof token === "string" ? token : undefined;
}
function authReason(reason: string | undefined): "invalid" | "expired" | "signed-out" | undefined {
  return reason === "invalid" || reason === "expired" || reason === "signed-out"
    ? reason
    : undefined;
}
function prefersHtmlAuth(request: FastifyRequest): boolean {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  return (
    contentType === "application/x-www-form-urlencoded" ||
    request.headers.accept?.includes("text/html") === true
  );
}
function isHttpsRequest(request: FastifyRequest): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  return (
    (request.raw.socket as { encrypted?: boolean }).encrypted === true ||
    forwarded === "https" ||
    (Array.isArray(forwarded) && forwarded.includes("https"))
  );
}
function isDocumentNavigation(request: FastifyRequest): boolean {
  if (request.method !== "GET") return false;
  const path = request.url.split("?", 1)[0] ?? "";
  return (
    request.headers.accept?.includes("text/html") === true ||
    path === "/" ||
    path === "/commands" ||
    path === "/audit" ||
    /^\/jobs\/\d+$/u.test(path)
  );
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
