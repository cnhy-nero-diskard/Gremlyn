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
import { defaultOpenCodeAgentProfile } from "../config/opencode-profile.js";
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
import {
  OPENCODE_EXECUTOR_ID,
  readOpenCodeProfile,
  saveOpenCodeAgentProfile,
} from "../store/opencode-profiles.js";
import { readOpenCodeSelection, saveOpenCodeSelection } from "../store/opencode-selections.js";
import {
  activateOpenCodeTeam,
  readOpenCodeActivationContext,
  type ActivateOpenCodeTeamResult,
} from "../store/opencode-activation.js";
import {
  discoverNativeAgents as defaultDiscoverNativeAgents,
  nativeAgentDiscoveryCache,
  type NativeAgentDiscoveryCache,
  type DiscoverNativeAgentsInput,
  type NativeDiscoveryOutcome,
} from "../agent/native-discovery.js";
import type { AgentInventoryReader } from "../agent/agent-inventory.js";
import type { OpenCodeWorker } from "../agent/opencode-worker.js";
import { createRedactor } from "../log/redact.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../types.js";
import { CONSOLE_SESSION_COOKIE, ConsoleSessionStore, constantTimeEqual } from "./session.js";

export interface ConsoleActions {
  retry?: (jobId: number) => Promise<unknown> | unknown;
  cancel?: (jobId: number) => Promise<unknown> | unknown;
  resetWorkspace?: (repoId: number, prNumber: number) => Promise<unknown> | unknown;
  repositorySettingsChanged?: (repoId: number) => Promise<unknown> | unknown;
}

/** The server-derived inputs a worker resolver receives for one repository. */
export interface OpenCodeWorkerResolverInput {
  repoId: number;
  /** The configured executor alias id (an `agents` key). */
  executorId: string;
  /** The alias's configured binary, defaulting to the alias id. */
  binary: string;
  /** The repository's server-derived source checkout; never a browser value. */
  cwd: string;
  /** The alias's configured credential source directory, when present. */
  credentialSource?: string;
}

/**
 * Resolve the exact OpenCode worker (binary, pinned version, cwd and the
 * sanitized environment including the configured executor's
 * `additionalEnvironment`) for one repository. When absent, the native-agent
 * discovery route reports that discovery is unavailable rather than guessing a
 * binary — the console never silently falls back to a default `opencode`.
 */
export type OpenCodeWorkerResolver = (
  input: OpenCodeWorkerResolverInput,
) => OpenCodeWorker | undefined;

/**
 * Injectable seams for the authenticated native-agent discovery route so tests
 * can fake discovery without credentials or subprocesses. Production uses the
 * shared bounded discovery and its advisory cache.
 */
export interface ConsoleNativeDiscovery {
  discover?: (input: DiscoverNativeAgentsInput) => Promise<NativeDiscoveryOutcome>;
  cache?: NativeAgentDiscoveryCache;
  /** Injectable inventory reader passed through to the discovery default. */
  inventory?: AgentInventoryReader;
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
  /**
   * Resolves the repository's exact OpenCode worker for advisory native-agent
   * discovery. Wired by the process entry point from the configured executor
   * alias (its `additionalEnvironment` and pinned binary). Omitting it disables
   * discovery with a safe error; the routes never fall back to another binary.
   */
  opencodeWorker?: OpenCodeWorkerResolver;
  /** Test seams for the discovery route (fake discovery/cache/inventory). */
  nativeDiscovery?: ConsoleNativeDiscovery;
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

/**
 * The executor kind a repository's configured agent runs as. An agent id is a
 * free operator label; its definition's kind selects the registered executor,
 * defaulting to the id itself — matching the config loader and the dashboard
 * view. This is the gate for the OpenCode profile editor routes.
 */
function resolvedExecutorKind(
  db: Database.Database,
  repoId: number,
  agents: Record<string, AgentDefinition> | undefined,
): string | undefined {
  const agent = repositoryAgent(db, repoId);
  if (agent === undefined) return undefined;
  return agents?.[agent]?.kind ?? agent;
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
    // Legacy job detail resolves whether a recorded attempt/agent is OpenCode
    // through the configured definitions rather than assuming the alias id.
    resolveExecutorKind: (agentId) =>
      agentId === undefined ? undefined : (options.agents?.[agentId]?.kind ?? agentId),
  });
  const ticker = new SharedChangeTicker(options.db, 250, options.dataDir ?? ".gremlyn");
  const redactDiscoveryReason = createRedactor(options.secrets);
  const discoverySeam = options.nativeDiscovery ?? {};
  const runNativeDiscovery = discoverySeam.discover ?? defaultDiscoverNativeAgents;
  const discoveryCache = discoverySeam.cache ?? nativeAgentDiscoveryCache;
  interface ConsoleRepositoryRow {
    id: number;
    agent: string;
    source_path: string;
  }
  const readRepositoryRow = (repoId: number): ConsoleRepositoryRow | undefined =>
    options.db
      .prepare("SELECT id, agent, source_path FROM repositories WHERE id = ?")
      .get(repoId) as ConsoleRepositoryRow | undefined;
  /**
   * Resolve the exact OpenCode worker for one repository using the injected
   * resolver and the repository's server-derived source path. Returns undefined
   * when the resolver is absent or declines, which the route reports as an
   * unavailable discovery source — never a silent default binary.
   */
  const openCodeWorkerFor = (repo: ConsoleRepositoryRow): OpenCodeWorker | undefined => {
    const definition = options.agents?.[repo.agent];
    const executorKind = definition?.kind ?? repo.agent;
    if (executorKind !== OPENCODE_EXECUTOR_ID) return undefined;
    if (!options.opencodeWorker) return undefined;
    return options.opencodeWorker({
      repoId: repo.id,
      executorId: repo.agent,
      binary: definition?.binary ?? repo.agent,
      cwd: repo.source_path,
      ...(definition?.credentialSource === undefined
        ? {}
        : { credentialSource: definition.credentialSource }),
    });
  };
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
    const id = repositoryIdParam(request.params.id);
    if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
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
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
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
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
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
    const id = repositoryIdParam(request.params.id);
    if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
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
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
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
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
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
  // Authenticated advisory discovery of the eligible existing OpenCode primary
  // agents for one repository's configured executor alias. Paths are derived on
  // the server from the repository row; a browser never supplies a cwd. The
  // response carries only safe projected metadata (id/name/bounded description/
  // mode/hidden/eligibility/evidenced origin) plus the saved source — never
  // permissions, prompts, credentials or arbitrary configuration contents.
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/repos/:id/opencode-agents",
    async (request, reply) => {
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
      const repo = readRepositoryRow(id);
      if (!repo) return reply.code(404).send({ error: "repository-not-found" });
      const kind = resolvedExecutorKind(options.db, id, options.agents);
      if (kind !== OPENCODE_EXECUTOR_ID) return reply.code(404).send({ error: "not-opencode" });
      const selectionRecord = readOpenCodeSelection(options.db, id);
      // A corrupt dormant profile must not break discovery; it reads as no
      // profile so the source/id projection stays available.
      const profile = tryReadOpenCodeProfile(options.db, id);
      const base = {
        repoId: id,
        selection: selectionRecord?.selection ?? { source: "default" },
        revision: selectionRecord?.revision ?? 0,
        explicit: selectionRecord?.explicit ?? false,
        profileRevision: savedProfileRevision(profile),
      };
      const worker = openCodeWorkerFor(repo);
      if (!worker) {
        return reply.code(503).send({
          ok: false,
          status: "unavailable",
          error: "discovery-unavailable",
          ...base,
        });
      }
      const outcome = await runNativeDiscovery({
        worker,
        repositoryId: String(id),
        cache: discoveryCache,
        ...(request.query.refresh === "1" ? { refresh: true } : {}),
        ...(discoverySeam.inventory === undefined ? {} : { inventory: discoverySeam.inventory }),
      });
      if (outcome.status === "failed") {
        return reply.code(502).send({
          ok: false,
          status: "failed",
          error: "discovery-failed",
          // Discovery reasons name the binary/context, never a prompt; redact
          // against the console's configured secrets anyway so a transport
          // diagnostic can never echo one back.
          reason: redactDiscoveryReason(outcome.reason),
          ...base,
        });
      }
      if (outcome.status === "pending") {
        // A cold location that never converged is neither an empty success nor
        // a transport error; the advisory picker can retry without pretending
        // the inventory is empty.
        return reply.send({
          ok: false,
          status: "pending",
          reason: "native agent discovery is still settling",
          ...base,
        });
      }
      return reply.send({
        ok: true,
        status: outcome.status,
        agents: outcome.agents,
        recordCount: outcome.recordCount,
        fromCache: outcome.fromCache,
        ...(outcome.directory === undefined ? {} : { directory: outcome.directory }),
        ...base,
      });
    },
  );
  // Authenticated, revisioned primary-source update for one repository. The
  // store validates the discriminated selection strictly, checks the selection
  // (and, for managed activation, the active profile) revision in one
  // transaction, and records exactly one scoped operator action. This route
  // records the runtime-settings notification the client and orchestrator
  // observe; a stale or conflicting update changes nothing.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/repos/:id/opencode-selection",
    async (request, reply) => {
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
      const repo = readRepositoryRow(id);
      if (!repo) return reply.code(404).send({ error: "repository-not-found" });
      const kind = resolvedExecutorKind(options.db, id, options.agents);
      if (kind !== OPENCODE_EXECUTOR_ID) return reply.code(404).send({ error: "not-opencode" });
      const body = request.body;
      if (!isRecord(body)) return invalidRequest(reply, "body", "body must be an object");
      const expectedRevision = body.expectedRevision;
      if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
        return invalidRequest(
          reply,
          "expectedRevision",
          "expectedRevision must be a non-negative integer",
        );
      }
      const selection = body.selection;
      if (!isRecord(selection)) {
        return invalidRequest(reply, "selection", "selection must be an object");
      }
      const expectedProfileRevision = body.expectedProfileRevision;
      if (
        expectedProfileRevision !== undefined &&
        (!Number.isInteger(expectedProfileRevision) || (expectedProfileRevision as number) < 0)
      ) {
        return invalidRequest(
          reply,
          "expectedProfileRevision",
          "expectedProfileRevision must be a non-negative integer when present",
        );
      }
      const result = saveOpenCodeSelection(options.db, {
        repoId: id,
        expectedRevision: expectedRevision as number,
        candidate: selection,
        executorKind: kind,
        ...(expectedProfileRevision === undefined
          ? {}
          : { expectedProfileRevision: expectedProfileRevision as number }),
      });
      if (result.ok) {
        await options.actions?.repositorySettingsChanged?.(id);
        // The selection is already committed; a corrupt dormant profile must
        // not turn a successful save into a 500. It simply reports no revision.
        const profile = tryReadOpenCodeProfile(options.db, id);
        return reply.send({
          ok: true,
          repoId: id,
          revision: result.revision,
          selection: result.selection,
          profileRevision: savedProfileRevision(profile),
        });
      }
      switch (result.reason) {
        case "not-found":
          return reply.code(404).send({ error: "repository-not-found" });
        case "not-opencode":
          return reply.code(404).send({ error: "not-opencode" });
        case "validation":
          return reply.code(400).send({
            error: "validation",
            currentRevision: result.currentRevision,
            issues: result.issues,
          });
        case "conflict":
          return reply
            .code(409)
            .send({ error: "conflict", currentRevision: result.currentRevision });
        case "no-profile":
          return reply.code(409).send({
            error: "no-profile",
            currentRevision: result.currentRevision,
            currentProfileRevision: result.currentProfileRevision,
          });
        case "profile-revision-required":
          return reply.code(400).send({
            error: "profile-revision-required",
            currentRevision: result.currentRevision,
            currentProfileRevision: result.currentProfileRevision,
          });
        case "profile-conflict":
          return reply.code(409).send({
            error: "profile-conflict",
            currentRevision: result.currentRevision,
            currentProfileRevision: result.currentProfileRevision,
          });
      }
      return reply.code(500).send({ error: "save-failed" });
    },
  );
  // Authenticated repository-local explicit team activation (design D2, tasks
  // 2.1-2.3). One strict discriminated body names either the already-reviewed
  // saved team (`activate-saved`, no profile) or a reviewed candidate (`profile`)
  // to be committed together with managed source (`save-and-activate`). The
  // store rechecks repository existence, the resolved executor kind (including
  // aliases) and both optimistic revisions inside one transaction, so a stale
  // baseline, invalid candidate or persistence failure changes neither the
  // profile nor the selection. A state-changing commit issues at most one
  // runtime notification; a notification failure is reported as a scoped
  // refresh problem with the reconciled committed state, never as a rollback.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/repos/:id/opencode-team-activation",
    async (request, reply) => {
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
      const repo = readRepositoryRow(id);
      if (!repo) return reply.code(404).send({ error: "repository-not-found" });
      const kind = resolvedExecutorKind(options.db, id, options.agents);
      if (kind !== OPENCODE_EXECUTOR_ID) return reply.code(404).send({ error: "not-opencode" });
      const parsed = parseActivationBody(request.body);
      if (!parsed.ok)
        return reply.code(400).send({ error: "invalid-request", issues: parsed.issues });
      const resolveKind = (agentId: string): string => options.agents?.[agentId]?.kind ?? agentId;
      let result: ActivateOpenCodeTeamResult;
      try {
        result =
          parsed.request.mode === "activate-saved"
            ? activateOpenCodeTeam(options.db, {
                repoId: id,
                resolveExecutorKind: resolveKind,
                mode: "activate-saved",
                expectedProfileRevision: parsed.request.expectedProfileRevision,
                expectedSelectionRevision: parsed.request.expectedSelectionRevision,
              })
            : activateOpenCodeTeam(options.db, {
                repoId: id,
                resolveExecutorKind: resolveKind,
                mode: "save-and-activate",
                expectedProfileRevision: parsed.request.expectedProfileRevision,
                expectedSelectionRevision: parsed.request.expectedSelectionRevision,
                candidate: parsed.request.profile,
              });
      } catch {
        // A persistence or audit failure rolls the whole transaction back.
        // Never echo the database error and issue no notification: nothing was
        // committed, so there is no runtime refresh to perform.
        return reply.code(500).send({ error: "activation-failed", repoId: id });
      }
      if (!result.ok) return sendActivationRefusal(reply, id, result);
      // Persistence is already committed. Notification follows commit and is
      // issued at most once for a state-changing activation; failure must not
      // masquerade as a rolled-back save or force a blind resubmission.
      const notifier = options.actions?.repositorySettingsChanged;
      let notification: "delivered" | "skipped" | "failed";
      if (!result.changed || !notifier) {
        notification = "skipped";
      } else {
        try {
          await notifier(id);
          notification = "delivered";
        } catch {
          notification = "failed";
        }
      }
      const context = safeReadActivationContext(options.db, id);
      const selection = activationSelectionSummary(context, result);
      const profileRevision = context?.profileRevision ?? result.profileRevision;
      const active = context?.active ?? true;
      return reply.send({
        ok: true,
        repoId: id,
        operation: result.operation,
        changed: result.changed,
        alreadyActive: !result.changed,
        active,
        // Both names expose the profile revision after commit so a client that
        // reviewed `revision` and one that reads `profileRevision` agree.
        revision: profileRevision,
        profileRevision,
        selectionRevision: selection.revision,
        selection,
        workflow: {
          operation: result.operation,
          active,
          changed: result.changed,
          selectionRevision: selection.revision,
          profileRevision,
          primaryId: context?.primaryId ?? result.primaryId,
          subagentIds: context?.subagentIds ?? result.subagentIds,
        },
        primaryId: context?.primaryId ?? result.primaryId,
        subagentIds: context?.subagentIds ?? result.subagentIds,
        notification,
        ...(notification === "failed" ? { refreshError: "notification-failed" } : {}),
      });
    },
  );
  // Authenticated editor access to the full OpenCode agent profile. The full
  // document — including the operators' private instruction text — is never
  // projected in ordinary dashboard HTML or live SSE fragments; it is read
  // here only when the operator explicitly opens the repository-local editor.
  app.get<{ Params: { id: string } }>("/repos/:id/opencode-profile", async (request, reply) => {
    const id = repositoryIdParam(request.params.id);
    if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
    const executorKind = resolvedExecutorKind(options.db, id, options.agents);
    if (executorKind === undefined) return reply.code(404).send({ error: "repository-not-found" });
    if (executorKind !== OPENCODE_EXECUTOR_ID)
      return reply.code(404).send({ error: "not-opencode" });
    // A stored payload that no longer parses is a scoped corruption error, not
    // a server crash and not a silent fallback to the default workflow. The
    // profile document and the selection/revision baselines are read from one
    // consistent snapshot so the editor reviews a coherent pair of counters.
    let snapshot: {
      record: ReturnType<typeof readOpenCodeProfile>;
      selection: ReturnType<typeof readOpenCodeSelection>;
    };
    try {
      snapshot = options.db.transaction(() => ({
        record: readOpenCodeProfile(options.db, id),
        selection: readOpenCodeSelection(options.db, id),
      }))();
    } catch {
      return reply
        .header("cache-control", "no-store")
        .code(422)
        .send({ error: "opencode-profile-corrupt", repoId: id });
    }
    const { record, selection } = snapshot;
    if (!record) return reply.code(404).send({ error: "repository-not-found" });
    const selectionView = selection?.selection ?? { source: "default" as const };
    const selectionSummary: ActivationSelectionSummary = {
      source: selectionView.source,
      nativeAgentId: selectionView.source === "native" ? selectionView.agentId : null,
      revision: selection?.revision ?? 0,
      profileRevision: record.profile !== null ? record.revision : null,
    };
    return reply.header("cache-control", "no-store").send({
      ok: true,
      repoId: id,
      // The profile document plus its revision (the `revision` baseline).
      revision: record.revision,
      profileRevision: record.revision,
      profile: record.profile,
      defaultProfile: defaultOpenCodeAgentProfile(),
      // The selection baseline: source, retained native id, selection revision
      // and the controlling managed-profile revision. Coherent with `revision`.
      selection: selectionSummary,
      selectionRevision: selectionSummary.revision,
      selectionExplicit: selection?.explicit ?? false,
      active: record.profile !== null && selectionSummary.source === "managed",
    });
  });
  // Compare-and-set save for one whole agent profile. `expectedRevision` is the
  // revision the operator's edit began from; a stale write conflicts with HTTP
  // 409 and the current revision, an invalid candidate returns HTTP 400 with
  // every field issue, and a successful save applies exactly one revision and
  // records exactly one operator action inside the store transaction. The live
  // SSE ticker observes that audit row and refreshes the persisted summary.
  app.post<{ Params: { id: string }; Body: { expectedRevision?: unknown; candidate?: unknown } }>(
    "/repos/:id/opencode-profile",
    async (request, reply) => {
      const id = repositoryIdParam(request.params.id);
      if (id === undefined) return reply.code(404).send({ error: "repository-not-found" });
      const executorKind = resolvedExecutorKind(options.db, id, options.agents);
      if (executorKind === undefined)
        return reply.code(404).send({ error: "repository-not-found" });
      if (executorKind !== OPENCODE_EXECUTOR_ID)
        return reply.code(404).send({ error: "not-opencode" });
      const expectedRevision = request.body?.expectedRevision;
      if (
        typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        return reply.code(400).send({
          error: "invalid-request",
          issues: [
            {
              path: "expectedRevision",
              message: "expectedRevision must be a non-negative integer",
            },
          ],
        });
      }
      const candidate = request.body?.candidate;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return reply.code(400).send({
          error: "invalid-request",
          issues: [{ path: "candidate", message: "candidate must be an object" }],
        });
      }
      // The save and the authoritative selection context commit in one
      // transaction, so the save-only feedback reflects the source exactly at
      // the transaction's outcome (design D3): a concurrent source switch is
      // never hidden behind a cached editor value. The response stays additive —
      // `revision` and the audit semantics are unchanged for save-only.
      const committed = options.db.transaction(() => {
        const result = saveOpenCodeAgentProfile(options.db, {
          repoId: id,
          expectedRevision,
          candidate,
          executorKind,
        });
        const context = readOpenCodeActivationContext(options.db, id);
        return { result, context };
      })();
      const result = committed.result;
      if (result.ok) {
        const selection = activationSelectionSummary(committed.context, {
          selectionRevision: committed.context?.selectionRevision ?? 0,
          profileRevision: result.revision,
        });
        return reply.send({
          ok: true,
          repoId: id,
          revision: result.revision,
          // Authoritative save-only outcome: whether the saved team is active
          // for new jobs and the current source/revision context.
          active: committed.context?.active ?? false,
          selection,
          selectionRevision: selection.revision,
        });
      }
      switch (result.reason) {
        case "not-found":
          return reply.code(404).send({ error: "repository-not-found" });
        case "not-opencode":
          return reply.code(404).send({ error: "not-opencode" });
        case "validation":
          return reply.code(400).send({
            error: "validation",
            currentRevision: result.currentRevision,
            issues: result.issues,
          });
        case "conflict":
          return reply
            .code(409)
            .send({ error: "conflict", currentRevision: result.currentRevision });
      }
      return reply.code(500).send({ error: "save-failed" });
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** One field-scoped 400 for a malformed route body, matching the editor route. */
function invalidRequest(reply: FastifyReply, path: string, message: string): FastifyReply {
  return reply.code(400).send({ error: "invalid-request", issues: [{ path, message }] });
}
/**
 * The saved managed-profile revision to report to the picker, whether the team
 * is active or dormant. The client needs it to CAS a deliberate managed
 * activation; null when no profile is saved. The `selection.source` still tells
 * the client whether the team is currently controlling runs.
 */
function savedProfileRevision(
  profile: { profile: unknown; revision: number } | undefined,
): number | null {
  return profile?.profile != null ? profile.revision : null;
}
/** One field-scoped activation-body issue. */
type ActivationFieldIssue = { path: string; message: string };
/** The strict request body, without the server-derived repository scope. */
type ActivationRequestBody =
  | {
      mode: "activate-saved";
      expectedProfileRevision: number;
      expectedSelectionRevision: number;
    }
  | {
      mode: "save-and-activate";
      expectedProfileRevision: number;
      expectedSelectionRevision: number;
      /** The reviewed whole profile candidate named `profile` on the wire. */
      profile: unknown;
    };
type ParsedActivationBody =
  { ok: true; request: ActivationRequestBody } | { ok: false; issues: ActivationFieldIssue[] };
/**
 * Strictly parse the discriminated activation body. `activate-saved` accepts
 * exactly the two baselines and no profile; `save-and-activate` additionally
 * requires an object `profile` candidate. Unknown fields and wrong types are
 * rejected so a client cannot smuggle an activation mode the operator did not
 * choose.
 */
function parseActivationBody(body: unknown): ParsedActivationBody {
  if (!isRecord(body))
    return { ok: false, issues: [{ path: "body", message: "body must be an object" }] };
  const mode = body.mode;
  if (mode !== "activate-saved" && mode !== "save-and-activate") {
    return {
      ok: false,
      issues: [{ path: "mode", message: 'mode must be "activate-saved" or "save-and-activate"' }],
    };
  }
  const issues: ActivationFieldIssue[] = [];
  const expectedProfileRevision = body.expectedProfileRevision;
  if (!Number.isInteger(expectedProfileRevision) || (expectedProfileRevision as number) < 0) {
    issues.push({
      path: "expectedProfileRevision",
      message: "expectedProfileRevision must be a non-negative integer",
    });
  }
  const expectedSelectionRevision = body.expectedSelectionRevision;
  if (!Number.isInteger(expectedSelectionRevision) || (expectedSelectionRevision as number) < 0) {
    issues.push({
      path: "expectedSelectionRevision",
      message: "expectedSelectionRevision must be a non-negative integer",
    });
  }
  const allowed = new Set([
    "mode",
    "expectedProfileRevision",
    "expectedSelectionRevision",
    "profile",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) issues.push({ path: key, message: `unknown field "${key}"` });
  }
  if (mode === "activate-saved" && "profile" in body) {
    issues.push({ path: "profile", message: "profile is not accepted for activate-saved" });
  }
  if (mode === "save-and-activate" && !isRecord(body.profile)) {
    issues.push({
      path: "profile",
      message: "profile must be an object for save-and-activate",
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  const base = {
    expectedProfileRevision: expectedProfileRevision as number,
    expectedSelectionRevision: expectedSelectionRevision as number,
  };
  return mode === "activate-saved"
    ? { ok: true, request: { ...base, mode } }
    : { ok: true, request: { ...base, mode, profile: body.profile } };
}
/** Map a store activation refusal to a scoped, actionable HTTP response. */
function sendActivationRefusal(
  reply: FastifyReply,
  repoId: number,
  result: Exclude<ActivateOpenCodeTeamResult, { ok: true }>,
): FastifyReply {
  const revisions = {
    currentRevision: result.reason === "not-found" ? 0 : result.currentSelectionRevision,
    currentProfileRevision: result.reason === "not-found" ? 0 : result.currentProfileRevision,
  };
  switch (result.reason) {
    case "not-found":
      return reply.code(404).send({ error: "repository-not-found" });
    case "not-opencode":
      return reply.code(404).send({ error: "not-opencode" });
    case "validation":
      return reply.code(400).send({
        error: "validation",
        currentRevision: result.currentSelectionRevision,
        currentProfileRevision: result.currentProfileRevision,
        issues: result.issues,
      });
    case "conflict":
      return reply.code(409).send({ error: "conflict", ...revisions });
    case "profile-conflict":
      return reply.code(409).send({ error: "profile-conflict", ...revisions });
    case "no-profile":
      return reply.code(409).send({ error: "no-profile", ...revisions });
    case "corrupt-profile":
      return reply.code(422).send({ error: "opencode-profile-corrupt", repoId, ...revisions });
  }
  return reply.code(500).send({ error: "activation-failed" });
}
/** Read the committed activation context without letting corruption throw. */
function safeReadActivationContext(
  db: Database.Database,
  repoId: number,
): ReturnType<typeof readOpenCodeActivationContext> {
  try {
    return readOpenCodeActivationContext(db, repoId);
  } catch {
    return undefined;
  }
}
/**
 * The safe selection summary returned by the editor read and the activation
 * route: source, retained native id, selection revision and controlling
 * managed-profile revision. Mirrors the console projection shape and never
 * carries instruction text.
 */
interface ActivationSelectionSummary {
  source: "default" | "native" | "managed";
  nativeAgentId: string | null;
  revision: number;
  profileRevision: number | null;
}
function activationSelectionSummary(
  context: ReturnType<typeof readOpenCodeActivationContext>,
  fallback: { selectionRevision: number; profileRevision: number },
): ActivationSelectionSummary {
  if (context === undefined) {
    return {
      source: "managed",
      nativeAgentId: null,
      revision: fallback.selectionRevision,
      profileRevision: fallback.profileRevision,
    };
  }
  return {
    source: context.selection.source,
    nativeAgentId: context.selection.source === "native" ? context.selection.agentId : null,
    revision: context.selectionRevision,
    profileRevision: context.hasProfile && !context.profileCorrupt ? context.profileRevision : null,
  };
}
/**
 * Read a stored OpenCode profile without letting a corrupt payload throw out of
 * a route. `undefined` means the repository/profile could not be read (or the
 * payload no longer parses); callers that must report corruption explicitly do
 * their own guarded read.
 */
function tryReadOpenCodeProfile(
  db: Database.Database,
  repoId: number,
): ReturnType<typeof readOpenCodeProfile> {
  try {
    return readOpenCodeProfile(db, repoId);
  } catch {
    return undefined;
  }
}
/**
 * Parse a `/repos/:id` path parameter safely: a non-numeric or out-of-range id
 * is reported as a scoped not-found rather than echoing a 500 for an internal
 * parse error.
 */
function repositoryIdParam(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}
