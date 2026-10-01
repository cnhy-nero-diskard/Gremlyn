/**
 * Tests for tasks 4.2-4.3: the repository-local OpenCode agent editor and the
 * authenticated compare-and-set save route plus live-update reconciliation
 * (`src/console/server.ts`, `src/console/views/dashboard.ts`,
 * `src/console/assets.ts`, design D5, capability `opencode-agent-profiles`).
 *
 * Covers the task's verification points at the route boundary and in the
 * client: the full profile — including private instruction text — is fetched
 * only when the editor opens and never appears in ordinary dashboard HTML or
 * live SSE fragments; the POST save applies a whole profile with HTTP 400 for
 * field issues and 409 for stale revisions; one successful save yields exactly
 * one audit action and one runtime (SSE) refresh; a stale edit or an SSE
 * update preserves the operator's unsaved draft; Apply -> review -> confirm ->
 * CAS cancel-discard flow keeps the draft independent of the provider/model
 * autosave.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { request as httpRequest } from "node:http";
import { buildConsoleServer, type ConsoleOptions } from "../src/console/server.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { defaultOpenCodeAgentProfile } from "../src/config/opencode-profile.js";
import { readOpenCodeProfile, saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { clientScript } from "../src/console/assets.js";
import type { AgentDefinition } from "../src/config/loader.js";

/** The instruction text that must never leave the authenticated editor route. */
const PRIVATE_INSTRUCTION = "replace the widget renderer and never mention the vault key";

const TOKEN = "console-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const AGENTS: Record<string, AgentDefinition> = {
  cline: {
    id: "cline",
    kind: "cline",
    binary: "cline",
    efforts: ["none", "low", "medium", "high", "xhigh"],
    credentialSource: "/tmp/cline-data",
    credentialFiles: ["secrets.json"],
  },
  opencode: {
    id: "opencode",
    kind: "opencode",
    binary: "opencode",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    credentialSource: "/tmp/opencode-data",
    credentialFiles: ["auth.json"],
  },
  // An agent id is a free operator label; its kind selects the executor.
  "code-review-agent": {
    id: "code-review-agent",
    kind: "cline",
    binary: "cline",
    efforts: ["none", "low", "medium", "high", "xhigh"],
    credentialSource: "/tmp/cline-data",
    credentialFiles: ["secrets.json"],
  },
  "review-agent": {
    id: "review-agent",
    kind: "opencode",
    binary: "opencode",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    credentialSource: "/tmp/opencode-data",
    credentialFiles: ["auth.json"],
  },
};

interface Fixture {
  store: Store;
  options: ConsoleOptions;
  opencodeRepoId: number;
  clineRepoId: number;
}

function openStore(): Fixture {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const opencodeRepoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', 'opencode', 'opencode/gpt-5.4', '', 'high', 1)`,
      )
      .run("acme", "opencode-widgets").lastInsertRowid,
  );
  const clineRepoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', 'cline', 'gpt-5.4', 'provider', 'high', 1)`,
      )
      .run("acme", "docs").lastInsertRowid,
  );
  return {
    store,
    options: {
      db: store.db,
      token: TOKEN,
      secrets: [],
      operatorActions: new OperatorActionStore(store.db),
      agents: AGENTS,
    },
    opencodeRepoId,
    clineRepoId,
  };
}

function primaryInput(): Record<string, unknown> {
  return {
    id: "primary",
    description: "Primary review agent",
    instructions: PRIVATE_INSTRUCTION,
    permissions: ["edit", "shell", "web", "skill"],
  };
}

function subagentInput(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    description: `Subagent ${id}`,
    enabled: true,
    permissions: [],
    ...overrides,
  };
}

function validProfileInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    primary: primaryInput(),
    subagents: [
      subagentInput("reviewer", {
        instructions: PRIVATE_INSTRUCTION,
        model: "opencode/gpt-5.4",
        stepLimit: 120,
        permissions: ["edit", "shell"],
      }),
      subagentInput("researcher", { enabled: false }),
    ],
    ...overrides,
  };
}

async function saveThroughRoute(
  app: ReturnType<typeof buildConsoleServer>,
  repoId: number,
  expectedRevision: number,
  candidate: unknown,
): Promise<import("light-my-request").Response> {
  return app.inject({
    method: "POST",
    url: `/repos/${repoId}/opencode-profile`,
    headers: AUTH,
    payload: { expectedRevision, candidate },
  });
}

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

test("the editor GET route returns the full authenticated profile while ordinary pages never project instructions", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId, clineRepoId } = fixture;
  assert.equal(
    saveOpenCodeAgentProfile(store.db, {
      repoId: opencodeRepoId,
      expectedRevision: 0,
      candidate: validProfileInput(),
      executorKind: "opencode",
    }).ok,
    true,
  );
  const app = buildConsoleServer(options);

  const unauthorized = await app.inject({
    method: "GET",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
  });
  assert.equal(unauthorized.statusCode, 401);

  const editor = await app.inject({
    method: "GET",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
  });
  assert.equal(editor.statusCode, 200);
  const payload = editor.json() as {
    ok: boolean;
    repoId: number;
    revision: number;
    profile: {
      primary: { instructions: string };
      subagents: Array<{ instructions: string }>;
    } | null;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.repoId, opencodeRepoId);
  assert.equal(payload.revision, 1);
  // The dedicated editor read carries the full document, instructions included.
  assert.equal(payload.profile?.primary.instructions, PRIVATE_INSTRUCTION);
  assert.equal(payload.profile?.subagents[0]?.instructions, PRIVATE_INSTRUCTION);

  const dashboard = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.body.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(dashboard.body.includes("instructions"), false);
  assert.match(dashboard.body, /data-repo-agents-configure/u);
  assert.match(
    dashboard.body,
    new RegExp(`data-repo-agents-url="/repos/${opencodeRepoId}/opencode-profile"`),
  );
  assert.match(dashboard.body, /revision 1/u);

  const sse = await app.inject({ method: "GET", url: "/stream?snapshot=1", headers: AUTH });
  assert.match(sse.body, /event: dashboard-update/);
  assert.equal(sse.body.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(sse.body.includes("instructions"), false);

  const missing = await app.inject({
    method: "GET",
    url: "/repos/999999999/opencode-profile",
    headers: AUTH,
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "repository-not-found" });

  const cline = await app.inject({
    method: "GET",
    url: `/repos/${clineRepoId}/opencode-profile`,
    headers: AUTH,
  });
  assert.equal(cline.statusCode, 404);
  assert.deepEqual(cline.json(), { error: "not-opencode" });

  await app.close();
  store.close();
});

test("an unconfigured OpenCode repository gets the shared default workflow at revision zero", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId } = fixture;
  const app = buildConsoleServer(options);
  const editor = await app.inject({
    method: "GET",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
  });
  assert.equal(editor.statusCode, 200);
  const payload = editor.json() as {
    ok: boolean;
    repoId: number;
    revision: number;
    profile: unknown;
    defaultProfile: { primary: { id: string }; subagents: Array<{ id: string }> };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.repoId, opencodeRepoId);
  assert.equal(payload.revision, 0);
  assert.equal(payload.profile, null);
  assert.equal(payload.defaultProfile.primary.id, "orchestrator");
  assert.deepEqual(
    payload.defaultProfile.subagents.map((agent) => agent.id),
    ["researcher", "implementer", "reviewer"],
  );
  assert.equal(readOpenCodeProfile(store.db, opencodeRepoId)?.profile, null);
  await app.close();
  store.close();
});

test("a compare-and-set save applies atomically, audits once, and updates the persisted summary", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId } = fixture;
  const app = buildConsoleServer(options);

  const saved = await saveThroughRoute(app, opencodeRepoId, 0, validProfileInput());
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as {
    ok: boolean;
    revision: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.revision, 1);
  assert.equal("profile" in body, false, "a save response need not repeat private instructions");
  const fullProfile = await app.inject({
    method: "GET",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
  });
  assert.equal(fullProfile.json().profile.primary.id, "primary");

  const actions = new OperatorActionStore(store.db).list();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.action, "opencode-agent-profile");
  assert.equal(actions[0]?.effect, "v1");
  assert.equal(actions[0]?.target, `repository:${opencodeRepoId}`);
  assert.equal(String(actions[0]?.detail).includes(PRIVATE_INSTRUCTION), false);

  const dashboard = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.match(dashboard.body, /revision 1/u);
  assert.equal(dashboard.body.includes(PRIVATE_INSTRUCTION), false);

  await app.close();
  store.close();
});

test("one applied profile yields one audit action and one runtime SSE refresh", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId } = fixture;
  const app = buildConsoleServer(options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");

  const refreshed = await new Promise<{ kind: string; fragments: Record<string, string> }>(
    (resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/stream",
        headers: AUTH,
      });
      let buffer = "";
      let initialSeen = false;
      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error("SSE did not deliver a change after the profile save"));
      }, 3_000);
      req.on("response", (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const events = buffer.split("\n\n").filter((event) => event.startsWith("event: "));
          if (!initialSeen && events.length >= 1) {
            initialSeen = true;
            void saveThroughRoute(app, opencodeRepoId, 0, validProfileInput());
          }
          if (events.length < 2) return;
          const line = events[1]!.split("\n").find((entry) => entry.startsWith("data: "));
          assert.ok(line);
          clearTimeout(timeout);
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
    },
  );

  assert.equal(refreshed.kind, "change");
  assert.match(refreshed.fragments.repositories ?? "", /revision 1/u);
  assert.equal(refreshed.fragments.repositories?.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(new OperatorActionStore(store.db).list().length, 1);

  await app.close();
  store.close();
});

test("a stale expected revision conflicts with 409 and changes nothing", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId } = fixture;
  const app = buildConsoleServer(options);
  const first = await saveThroughRoute(app, opencodeRepoId, 0, validProfileInput());
  assert.equal(first.statusCode, 200);

  const stale = await saveThroughRoute(app, opencodeRepoId, 0, {
    ...validProfileInput(),
    primary: { ...primaryInput(), description: "A newer write" },
  });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { error: "conflict", currentRevision: 1 });

  const record = readOpenCodeProfile(store.db, opencodeRepoId);
  assert.equal(record?.revision, 1);
  assert.equal(record?.profile?.primary.description, "Primary review agent");
  assert.equal(new OperatorActionStore(store.db).list().length, 1);

  await app.close();
  store.close();
});

test("an invalid candidate returns 400 with field issues and leaves the prior profile active", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId } = fixture;
  const app = buildConsoleServer(options);
  const first = await saveThroughRoute(app, opencodeRepoId, 0, validProfileInput());
  assert.equal(first.statusCode, 200);

  const invalid = validProfileInput({
    primary: { ...primaryInput(), stepLimit: 0 },
    subagents: [subagentInput("reviewer"), subagentInput("REVIEWER")],
  });
  const refused = await saveThroughRoute(app, opencodeRepoId, 1, invalid);
  assert.equal(refused.statusCode, 400);
  const refusedBody = refused.json() as {
    error: string;
    currentRevision: number;
    issues: Array<{ path: string; message: string }>;
  };
  assert.equal(refusedBody.error, "validation");
  assert.equal(refusedBody.currentRevision, 1);
  const paths = refusedBody.issues.map((issue) => issue.path);
  assert.ok(paths.includes("primary.stepLimit"), `expected step-limit issue, got ${paths}`);
  assert.ok(paths.includes("subagents[1].id"), `expected duplicate-id issue, got ${paths}`);

  const record = readOpenCodeProfile(store.db, opencodeRepoId);
  assert.equal(record?.revision, 1);
  assert.equal(record?.profile?.primary.description, "Primary review agent");
  assert.equal(new OperatorActionStore(store.db).list().length, 1);

  await app.close();
  store.close();
});

test("non-OpenCode repositories and unknown repositories reject the save route", async () => {
  const fixture = openStore();
  const { store, options, clineRepoId } = fixture;
  const app = buildConsoleServer(options);

  const cline = await saveThroughRoute(app, clineRepoId, 0, validProfileInput());
  assert.equal(cline.statusCode, 404);
  assert.deepEqual(cline.json(), { error: "not-opencode" });

  const missing = await saveThroughRoute(app, 999999999, 0, validProfileInput());
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "repository-not-found" });

  assert.equal(new OperatorActionStore(store.db).list().length, 0);
  await app.close();
  store.close();
});

test("the editor gate follows the configured executor kind, not the agent alias", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId } = fixture;
  const app = buildConsoleServer(options);

  // An alias whose kind resolves to Cline is refused.
  store.db
    .prepare("UPDATE repositories SET agent = 'code-review-agent' WHERE id = ?")
    .run(opencodeRepoId);
  const clineAlias = await app.inject({
    method: "GET",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
  });
  assert.equal(clineAlias.statusCode, 404);
  assert.deepEqual(clineAlias.json(), { error: "not-opencode" });

  // An alias whose kind resolves to OpenCode is accepted.
  store.db
    .prepare("UPDATE repositories SET agent = 'review-agent' WHERE id = ?")
    .run(opencodeRepoId);
  const opencodeAlias = await app.inject({
    method: "GET",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
  });
  assert.equal(opencodeAlias.statusCode, 200);
  const aliasPayload = opencodeAlias.json() as {
    ok: boolean;
    repoId: number;
    revision: number;
    profile: unknown;
    defaultProfile: { primary: { id: string } };
  };
  assert.equal(aliasPayload.ok, true);
  assert.equal(aliasPayload.repoId, opencodeRepoId);
  assert.equal(aliasPayload.revision, 0);
  assert.equal(aliasPayload.profile, null);
  assert.equal(aliasPayload.defaultProfile.primary.id, "orchestrator");

  await app.close();
  store.close();
});

test("malformed save requests are refused before any write", async () => {
  const fixture = openStore();
  const { store, options, opencodeRepoId } = fixture;
  const app = buildConsoleServer(options);

  const noRevision = await app.inject({
    method: "POST",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
    payload: { candidate: validProfileInput() },
  });
  assert.equal(noRevision.statusCode, 400);
  assert.equal((noRevision.json() as { error: string }).error, "invalid-request");

  const nonObjectCandidate = await app.inject({
    method: "POST",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
    payload: { expectedRevision: 0, candidate: "nope" },
  });
  assert.equal(nonObjectCandidate.statusCode, 400);
  assert.equal((nonObjectCandidate.json() as { error: string }).error, "invalid-request");

  const negativeRevision = await app.inject({
    method: "POST",
    url: `/repos/${opencodeRepoId}/opencode-profile`,
    headers: AUTH,
    payload: { expectedRevision: -1, candidate: validProfileInput() },
  });
  assert.equal(negativeRevision.statusCode, 400);
  assert.equal((negativeRevision.json() as { error: string }).error, "invalid-request");

  assert.equal(readOpenCodeProfile(store.db, opencodeRepoId)?.profile, null);
  assert.equal(new OperatorActionStore(store.db).list().length, 0);
  await app.close();
  store.close();
});

// ---------------------------------------------------------------------------
// Client tests (the framework-free editor block inside the console script)
// ---------------------------------------------------------------------------

function editorScript(): string {
  const start = clientScript.indexOf("// BEGIN_OPENCODE_AGENT_EDITOR");
  const end = clientScript.lastIndexOf("// END_OPENCODE_AGENT_EDITOR");
  assert.ok(start >= 0 && end > start, "editor block is present in the client script");
  return clientScript.slice(start, end);
}

interface AgentDraft {
  primary: Record<string, unknown>;
  subagents: Array<Record<string, unknown>>;
}

interface AgentEditorSurface {
  draftFromProfile: (profile: unknown) => AgentDraft;
  draftToCandidate: (draft: AgentDraft) => Record<string, unknown>;
  reviewRows: (draft: AgentDraft, primaryModel: string) => Array<Record<string, unknown>>;
  editorHtml: (repoId: number, state: Record<string, unknown>) => string;
  fieldLocation: (path: string) => { level: string; field: string };
  editors: Map<number, Record<string, unknown>>;
  mount: (container: unknown, repoId: number) => Promise<void>;
  render: (container: unknown, repoId: number) => void;
  save: (repoId: number) => Promise<void>;
  cancel: (repoId: number) => void;
  apply: (repoId: number) => void;
  addSubagent: (repoId: number) => void;
  removeSubagent: (repoId: number, index: number) => void;
  resetToDefault: (repoId: number) => void;
  handleInput: (repoId: number, path: string, value: string) => void;
  handleChange: (repoId: number, path: string, checked: boolean) => void;
  capture: () => Array<Record<string, unknown>>;
  restore: (root: unknown, saved: Array<Record<string, unknown>>) => void;
}

interface FakeContainer {
  innerHTML: string;
  dataset: Record<string, string>;
  querySelector: (selector: string) => unknown;
  closest: () => unknown;
  setAttribute: () => void;
  getAttribute: () => null;
  focus: () => void;
}

function fakeContainer(initialHtml = "", repoId = 7): FakeContainer {
  const container: FakeContainer = {
    innerHTML: initialHtml,
    dataset: { repoId: String(repoId) },
    querySelector: () => null,
    closest: () => null,
    setAttribute: () => undefined,
    getAttribute: () => null,
    focus: () => undefined,
  };
  // Reflect what was actually rendered so the editor's own guard — "did I
  // already replace the summary?" — behaves like the real DOM.
  container.querySelector = (selector) => {
    if (selector === "[data-agent-editor]") {
      return container.innerHTML.includes("data-agent-editor") ? { focus: () => undefined } : null;
    }
    return null;
  };
  return container;
}

interface AgentEditorEnvironment {
  document: {
    addEventListener: (name: string, callback: unknown) => void;
    listeners: Record<string, Array<unknown>>;
  };
  window: { gremlynConsole: Record<string, unknown> };
  registerSurface: (name: string, hook: unknown) => void;
  surface: unknown;
}

function runAgentEditor(fetchImpl: (url: string, options?: unknown) => Promise<unknown>): {
  agent: AgentEditorSurface;
  environment: AgentEditorEnvironment;
} {
  const listeners: Record<string, Array<unknown>> = { click: [], input: [], change: [] };
  const document = {
    listeners,
    addEventListener: (name: string, callback: unknown) => {
      if (listeners[name]) listeners[name].push(callback);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = { gremlynConsole: {}, location: { assign: () => undefined } };
  const environment: AgentEditorEnvironment = {
    document,
    window,
    registerSurface: (name, hook) => {
      if (name === "opencode-editors") environment.surface = hook;
    },
    surface: null,
  };
  runInNewContext(editorScript(), {
    document,
    window,
    fetch: fetchImpl,
    registerSurface: environment.registerSurface,
    console,
  });
  const agent = window.gremlynConsole.agentEditor as AgentEditorSurface;
  assert.ok(agent, "editor helpers are exposed on window.gremlynConsole.agentEditor");
  assert.ok(environment.surface, "the editor draft registers with the shared reconciler");
  return { agent, environment };
}

function profileWithChildren(): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description: "Primary review agent",
      instructions: PRIVATE_INSTRUCTION,
      permissions: ["edit", "shell"],
    },
    subagents: [
      {
        id: "reviewer",
        description: "Spec checker",
        enabled: true,
        model: "opencode/gpt-5.4",
        stepLimit: 120,
        permissions: ["shell"],
      },
      { id: "researcher", description: "Web research", enabled: false, permissions: [] },
    ],
  };
}

function rejectedFetch(): (url: string, options?: unknown) => Promise<never> {
  return async () => {
    throw new Error("unexpected fetch in this client test");
  };
}

test("the draft round-trips from a saved profile to a compare-and-set candidate", () => {
  const { agent } = runAgentEditor(rejectedFetch());
  const draft = agent.draftFromProfile(profileWithChildren());
  assert.equal(draft.primary.instructions, PRIVATE_INSTRUCTION);
  assert.equal(draft.primary.stepLimit, "");
  assert.equal(draft.subagents[0]?.stepLimit, "120");
  assert.equal(draft.subagents[1]?.model, "");

  const candidate = agent.draftToCandidate(draft);
  assert.equal(candidate.version, 1);
  assert.equal(candidate.primary.instructions, PRIVATE_INSTRUCTION);
  assert.equal(candidate.primary.stepLimit, undefined);
  assert.equal(candidate.subagents[0]?.stepLimit, 120);
  assert.equal(candidate.subagents[0]?.model, "opencode/gpt-5.4");
  assert.equal(candidate.subagents[1]?.model, undefined);
  assert.equal(candidate.subagents[1]?.enabled, false);
  // The candidate carries only the agent team — never provider/model/effort,
  // so saving the editor cannot disturb the separate repository pickers.
  assert.equal(candidate.provider, undefined);
  assert.equal(candidate.primary.model, undefined);
  assert.equal(candidate.primary.provider, undefined);

  const location = agent.fieldLocation("subagents[2].permissions[0]");
  assert.equal(location.level, "subagent");
  assert.equal(location.field, "permissions[0]");
});

test("the review names ids, models, callable state, and permission presets", () => {
  const { agent } = runAgentEditor(rejectedFetch());
  const draft = agent.draftFromProfile(profileWithChildren());
  const rows = agent.reviewRows(draft, "opencode/gpt-5.4");
  assert.equal(rows[0]?.id, "primary");
  assert.equal(rows[0]?.model, "opencode/gpt-5.4");
  assert.equal(rows[0]?.permissions, "edit workspace, run shell");
  assert.equal(rows[1]?.id, "reviewer");
  assert.equal(rows[1]?.status, "callable");
  assert.equal(rows[1]?.model, "opencode/gpt-5.4");
  assert.equal(rows[1]?.permissions, "run shell");
  assert.equal(rows[1]?.stepLimit, "120");
  assert.equal(rows[2]?.id, "researcher");
  assert.equal(rows[2]?.status, "disabled");
  assert.match(String(rows[2]?.model), /^inherits opencode\/gpt-5\.4$/u);
  assert.equal(rows[2]?.permissions, "read-only");
});

test("the editor renders labelled fields, and the review shows the team before the save", () => {
  const { agent } = runAgentEditor(rejectedFetch());
  const container = fakeContainer();
  const state = {
    mode: "editing",
    revision: 1,
    draft: agent.draftFromProfile(profileWithChildren()),
    errors: [],
    notice: null,
    busy: false,
    container,
    repoModel: "opencode/gpt-5.4",
  };
  const html = agent.editorHtml(7, state);
  assert.match(html, /<label for="agents-7-primary-id">Agent id<\/label>/u);
  assert.match(html, /data-agent-field="primary.instructions"/u);
  assert.match(html, /data-agent-field="subagents\[0\]\.model"/u);
  assert.match(html, /data-agent-model="subagents\[0\]\.model"/u);
  assert.match(html, /Inherit repository model/u);
  assert.match(html, /Custom model ID…/u);
  assert.match(html, /data-agent-checkbox="primary.permissions.shell"/u);
  assert.match(html, /data-agent-checkbox="subagents\[0\]\.enabled"/u);
  assert.match(html, /data-agent-action="add"/u);
  assert.match(html, /data-agent-action="apply"/u);
  assert.match(html, /data-agent-action="cancel"/u);
  assert.doesNotMatch(html, /data-agent-action="reset"/u);

  state.mode = "review";
  const review = agent.editorHtml(7, state);
  assert.match(review, /model: opencode\/gpt-5\.4/u);
  assert.match(review, /tools: run shell/u);
  assert.match(review, /data-agent-action="save"/u);
  assert.match(review, /data-agent-action="back"/u);
  assert.match(review, /<code>primary<\/code>/u);
  assert.match(review, /<code>reviewer<\/code>/u);
});

test("the child model dropdown uses catalog choices and keeps a custom-model escape hatch", () => {
  const { agent, environment } = runAgentEditor(rejectedFetch());
  const container = fakeContainer();
  const state = {
    mode: "editing",
    revision: 1,
    draft: agent.draftFromProfile(profileWithChildren()),
    defaultProfile: defaultOpenCodeAgentProfile(),
    modelProviders: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        models: [
          { id: "opencode/gpt-5.4", name: "GPT-5.4" },
          { id: "opencode/gpt-6-luna", name: "GPT-6 Luna" },
        ],
      },
    ],
    errors: [],
    notice: null,
    busy: false,
    container,
    repoModel: "opencode/gpt-5.4",
  };
  agent.editors.set(7, state as never);

  const html = agent.editorHtml(7, state);
  assert.match(html, /<optgroup label="OpenCode Zen">/u);
  assert.match(html, /<option value="opencode\/gpt-6-luna">GPT-6 Luna<\/option>/u);
  assert.match(html, /data-agent-custom-label="subagents\[0\]\.model" hidden/u);

  state.draft.subagents[0]!.model = "vendor/custom-model";
  const customHtml = agent.editorHtml(7, state);
  assert.match(customHtml, /<option value="__custom__" selected>Custom model ID…<\/option>/u);
  assert.match(
    customHtml,
    /data-agent-custom-label="subagents\[0\]\.model">Custom model ID<\/label>/u,
  );
  assert.match(
    customHtml,
    /value="vendor\/custom-model" placeholder="provider\/model\[#variant\]">/u,
  );

  // Selecting the custom option clears a prior catalog choice; text entry then
  // becomes the exact override, while selecting a catalog model stores its id.
  state.draft.subagents[0]!.model = "opencode/gpt-5.4";
  const editorElement = { dataset: { repoId: "7" } };
  const modelElement = {
    dataset: { agentModel: "subagents[0].model" },
    value: "__custom__",
    closest: (selector: string) => (selector === "[data-agent-editor]" ? editorElement : null),
  };
  const changeHandler = environment.document.listeners.change[0] as (event: unknown) => void;
  changeHandler({
    target: {
      closest: (selector: string) => (selector === "[data-agent-model]" ? modelElement : null),
    },
  });
  assert.equal(state.draft.subagents[0]?.model, "");
  const customModelInput = {
    dataset: { agentField: "subagents[0].model" },
    value: "vendor/custom-model",
    closest: (selector: string) => (selector === "[data-agent-editor]" ? editorElement : null),
  };
  const inputHandler = environment.document.listeners.input[0] as (event: unknown) => void;
  inputHandler({
    target: {
      closest: (selector: string) => (selector === "[data-agent-field]" ? customModelInput : null),
    },
  });
  assert.equal(state.draft.subagents[0]?.model, "vendor/custom-model");
  modelElement.value = "opencode/gpt-6-luna";
  changeHandler({
    target: {
      closest: (selector: string) => (selector === "[data-agent-model]" ? modelElement : null),
    },
  });
  assert.equal(state.draft.subagents[0]?.model, "opencode/gpt-6-luna");
});

test("the child model dropdown can reuse the repository picker catalog before live data loads", () => {
  const { agent } = runAgentEditor(rejectedFetch());
  const container = fakeContainer();
  const options = [
    {
      value: "opencode/gpt-5.4",
      dataset: { modelName: "GPT-5.4" },
      textContent: "GPT-5.4",
    },
  ];
  const modelSelect = {
    querySelectorAll: () => [{ label: "OpenCode Zen", querySelectorAll: () => options }],
  };
  const card = { querySelector: () => modelSelect };
  container.closest = () => card;
  const state = {
    mode: "editing",
    revision: 0,
    draft: agent.draftFromProfile(profileWithChildren()),
    defaultProfile: defaultOpenCodeAgentProfile(),
    modelProviders: [],
    errors: [],
    notice: null,
    busy: false,
    container,
    repoModel: "opencode/gpt-5.4",
  };

  const html = agent.editorHtml(7, state);
  assert.match(html, /<optgroup label="OpenCode Zen">/u);
  assert.match(html, /<option value="opencode\/gpt-5\.4" selected>GPT-5\.4<\/option>/u);
});

test("reset to default replaces only the current draft and leaves normal review/save in control", () => {
  const { agent } = runAgentEditor(rejectedFetch());
  const container = fakeContainer();
  const defaultProfile = defaultOpenCodeAgentProfile();
  const state = {
    mode: "editing",
    revision: 2,
    draft: agent.draftFromProfile(profileWithChildren()),
    defaultProfile,
    modelProviders: [],
    errors: [{ path: "primary.id", message: "fix this" }],
    notice: "old notice",
    busy: false,
    container,
    repoModel: "opencode/gpt-5.4",
  };
  agent.editors.set(7, state as never);
  agent.handleInput(7, "primary.description", "Unsaved custom edit");
  agent.resetToDefault(7);

  assert.equal(agent.editors.has(7), true);
  assert.equal(state.draft.primary.id, "orchestrator");
  assert.deepEqual(
    state.draft.subagents.map((child) => child.id),
    ["researcher", "implementer", "reviewer"],
  );
  assert.equal(state.draft.primary.description, defaultProfile.primary.description);
  assert.equal(state.errors.length, 0);
  assert.equal(state.notice, null);
  assert.equal(state.mode, "editing");
  assert.equal(state.revision, 2);
  assert.match(container.innerHTML, /data-agent-action="reset"/u);
  assert.match(container.innerHTML, /data-agent-action="apply"/u);
  assert.equal(container.innerHTML.includes("Unsaved custom edit"), false);
});

test("reset can be canceled before discarding an in-progress draft", () => {
  const { agent, environment } = runAgentEditor(rejectedFetch());
  Object.assign(environment.window, { confirm: () => false });
  const container = fakeContainer();
  const state = {
    mode: "editing",
    revision: 1,
    draft: agent.draftFromProfile(profileWithChildren()),
    defaultProfile: defaultOpenCodeAgentProfile(),
    modelProviders: [],
    errors: [],
    notice: null,
    busy: false,
    container,
    repoModel: "opencode/gpt-5.4",
  };
  agent.editors.set(7, state as never);
  agent.handleInput(7, "primary.description", "Keep this draft");

  agent.resetToDefault(7);

  assert.equal(state.draft.primary.description, "Keep this draft");
  assert.equal(state.revision, 1);
  assert.equal(container.innerHTML, "");
});

test("a validation refusal shows inline field errors and a focusable summary while the draft is retained", async () => {
  let postedUrl: string | undefined;
  const { agent } = runAgentEditor(async (url) => {
    postedUrl = url;
    return {
      ok: false,
      status: 400,
      json: async () => ({
        error: "validation",
        currentRevision: 1,
        issues: [{ path: "primary.id", message: "id is not a safe single path segment" }],
      }),
    };
  });
  const container = fakeContainer();
  const state = {
    mode: "review",
    revision: 1,
    draft: agent.draftFromProfile(profileWithChildren()),
    errors: [],
    notice: null,
    busy: false,
    container,
    repoModel: "",
  };
  agent.editors.set(7, state as never);
  agent.handleInput(7, "primary.description", "Typed while editing");
  await agent.save(7);

  assert.equal(postedUrl, "/repos/7/opencode-profile");
  const after = agent.editors.get(7) as {
    mode: string;
    errors: Array<{ path: string; message: string }>;
    draft: AgentDraft;
  };
  assert.equal(after.mode, "editing");
  assert.equal(after.errors.length, 1);
  assert.equal(after.draft.primary.description, "Typed while editing");
  assert.equal(agent.editors.has(7), true);
  assert.match(container.innerHTML, /data-agent-summary/u);
  assert.match(container.innerHTML, /tabindex="-1"/u);
  assert.match(container.innerHTML, /primary\.id/u);
  assert.match(container.innerHTML, /agents-7-primary-id-error/u);
  assert.match(container.innerHTML, />Typed while editing<\/textarea>/u);
});

test("a conflict keeps the draft and names the newer revision", async () => {
  const { agent } = runAgentEditor(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "conflict", currentRevision: 3 }),
  }));
  const container = fakeContainer();
  const state = {
    mode: "review",
    revision: 1,
    draft: agent.draftFromProfile(profileWithChildren()),
    errors: [],
    notice: null,
    busy: false,
    container,
    repoModel: "",
  };
  agent.editors.set(7, state as never);
  agent.handleInput(7, "primary.description", "Kept on conflict");
  await agent.save(7);

  const after = agent.editors.get(7) as {
    notice: string;
    errors: unknown[];
    draft: AgentDraft;
  };
  assert.equal(agent.editors.has(7), true);
  assert.match(after.notice, /revision 3/u);
  assert.equal(after.errors.length, 0);
  assert.equal(after.draft.primary.description, "Kept on conflict");
  assert.match(container.innerHTML, /data-agent-notice/u);
});

test("a successful save posts the reviewed CAS body, clears the draft, and confirms the revision", async () => {
  let posted: { url: string; body: string } | undefined;
  const { agent } = runAgentEditor(async (url, options) => {
    posted = { url, body: (options as { body: string }).body };
    return { ok: true, status: 200, json: async () => ({ ok: true, revision: 2, profile: {} }) };
  });
  const container = fakeContainer();
  const state = {
    mode: "review",
    revision: 1,
    draft: agent.draftFromProfile(profileWithChildren()),
    errors: [],
    notice: null,
    busy: false,
    container,
    repoModel: "",
  };
  agent.editors.set(7, state as never);
  await agent.save(7);

  assert.equal(posted?.url, "/repos/7/opencode-profile");
  const body = JSON.parse(posted?.body ?? "{}") as {
    expectedRevision: number;
    candidate: Record<string, unknown>;
  };
  assert.equal(body.expectedRevision, 1);
  assert.equal(body.candidate.version, 1);
  assert.equal(agent.editors.has(7), false);
  assert.equal(container.innerHTML.includes("Agent team saved as revision 2"), true);
});

test("an SSE update re-renders the persisted summary but preserves the in-progress draft", () => {
  const { agent, environment } = runAgentEditor(rejectedFetch());
  const containerA = fakeContainer("<a data-repo-agents-configure>Configure agents</a>", 7);
  const state = {
    mode: "editing",
    revision: 1,
    draft: agent.draftFromProfile(profileWithChildren()),
    errors: [],
    notice: null,
    busy: false,
    container: containerA,
    repoModel: "",
  };
  agent.editors.set(7, state as never);
  agent.handleInput(7, "primary.instructions", "TYPED instructions survive the swap");

  const surface = environment.surface as {
    capture: () => unknown;
    restore: (root: unknown, saved: unknown) => void;
  };
  const saved = surface.capture() as Array<Record<string, unknown>>;
  // The live update replaces the region with fresh server-rendered summaries.
  const containerB = fakeContainer("<div>fresh server summary</div>", 7);
  const root = {
    querySelector: (selector: string) =>
      selector.includes('data-repo-id="7"') ? containerB : null,
  };
  surface.restore(root, saved);

  const restored = agent.editors.get(7) as {
    draft: AgentDraft;
    summaryHtml: string;
  };
  assert.equal(agent.editors.has(7), true);
  assert.equal(restored.draft.primary.instructions, "TYPED instructions survive the swap");
  assert.equal(restored.summaryHtml, "<div>fresh server summary</div>");
  assert.match(containerB.innerHTML, /TYPED instructions survive the swap/u);
  assert.match(containerB.innerHTML, /data-agent-editor/u);
});

test("adding and removing subagents edits only the draft, and cancel discards it alone", () => {
  const { agent } = runAgentEditor(rejectedFetch());
  const container = fakeContainer("<a data-repo-agents-configure>Configure agents</a>", 7);
  const state = {
    mode: "editing",
    revision: 0,
    draft: agent.draftFromProfile(null),
    errors: [],
    notice: null,
    busy: false,
    container,
    summaryHtml: container.innerHTML,
    repoModel: "",
  };
  agent.editors.set(7, state as never);
  assert.equal(agent.editors.get(7)?.draft?.subagents?.length, 0);
  agent.addSubagent(7);
  assert.equal(agent.editors.get(7)?.draft?.subagents?.length, 1);
  agent.handleChange(7, "subagents[0].permissions.edit", true);
  const permissions = agent.editors.get(7)?.draft?.subagents?.[0]?.permissions;
  assert.ok(Array.isArray(permissions));
  assert.deepEqual([...(permissions as string[])], ["edit"]);
  agent.removeSubagent(7, 0);
  assert.equal(agent.editors.get(7)?.draft?.subagents?.length, 0);

  agent.cancel(7);
  assert.equal(agent.editors.has(7), false);
  assert.equal(container.innerHTML.includes("data-repo-agents-configure"), true);
});
