/**
 * Tests for tasks 5.1-5.4: the authenticated native-agent discovery and
 * revisioned primary-source update routes, the repository/job projections of
 * configured-versus-captured-versus-effective identity, the keyed "Run with
 * agent" editor, and its draft-preservation across live updates
 * (`src/console/server.ts`, `src/console/queries.ts`, `src/console/views/dashboard.ts`,
 * `src/console/views/job.ts`, `src/console/assets.ts`).
 *
 * Covers the task verification points: unauthorized/cross-repository/stale/
 * unavailable/failed discovery with safe errors; default/native/managed route
 * updates with one audit action and one runtime notification; Cline exclusion;
 * captured-versus-effective job identity including explicit unknown; no raw
 * instructions in HTML, API or audit output; and client reconciliation that
 * preserves a keyed draft and rejects a stale apply.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildConsoleServer, type ConsoleOptions } from "../src/console/server.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import { readDashboard, readJobDetail, type RepositorySummary } from "../src/console/queries.js";
import { repositoryCards } from "../src/console/views/dashboard.js";
import { jobRegions } from "../src/console/views/job.js";
import { clientScript } from "../src/console/assets.js";
import { bundledProviderCatalog } from "../src/agent/provider-catalog.js";
import { resolveOpenCodeWorker } from "../src/agent/opencode-worker.js";
import { defaultRunner } from "../src/agent/launcher.js";
import type {
  DiscoverNativeAgentsInput,
  NativeDiscoveryOutcome,
} from "../src/agent/native-discovery.js";
import type { NativeAgentChoice } from "../src/agent/agent-inventory.js";
import type { AgentDefinition } from "../src/config/loader.js";
import type { OpenCodeWorkerResolverInput } from "../src/console/server.js";

const TOKEN = "console-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SECRET = "super-secret-token";
const PRIVATE_INSTRUCTION = "replace the widget renderer and never mention the vault key";

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
};

const CHOICE: NativeAgentChoice = {
  id: "native-reviewer",
  name: "Native Reviewer",
  description: "Reviews specs",
  mode: "primary",
  hidden: false,
  eligible: true,
  origin: "project",
};

interface Fixture {
  store: Store;
  options: ConsoleOptions;
  opencodeRepoId: number;
  secondRepoId: number;
  clineRepoId: number;
  workerInputs: OpenCodeWorkerResolverInput[];
  discoveryInputs: DiscoverNativeAgentsInput[];
  settingsChanges: number;
}

function openStore(
  discover?: (input: DiscoverNativeAgentsInput) => Promise<NativeDiscoveryOutcome>,
): Fixture {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const insert = (owner: string, name: string, agent: string, sourcePath: string): number =>
    Number(
      store.db
        .prepare(
          `INSERT INTO repositories
             (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          owner,
          name,
          sourcePath,
          "workspaces",
          agent,
          agent === "opencode" ? "opencode/gpt-5.4" : "gpt-5.4",
          agent === "opencode" ? "" : "provider",
          "high",
        ).lastInsertRowid,
    );
  const opencodeRepoId = insert("acme", "opencode-widgets", "opencode", "source-a");
  const secondRepoId = insert("acme", "opencode-docs", "opencode", "source-b");
  const clineRepoId = insert("acme", "docs", "cline", "source-cline");
  const workerInputs: OpenCodeWorkerResolverInput[] = [];
  const discoveryInputs: DiscoverNativeAgentsInput[] = [];
  const fixture: Fixture = {
    store,
    opencodeRepoId,
    secondRepoId,
    clineRepoId,
    workerInputs,
    discoveryInputs,
    settingsChanges: 0,
    options: {
      db: store.db,
      token: TOKEN,
      secrets: [SECRET],
      operatorActions: new OperatorActionStore(store.db),
      agents: AGENTS,
      opencodeWorker: (input) => {
        workerInputs.push(input);
        return resolveOpenCodeWorker({
          executorId: input.executorId,
          binary: input.binary,
          cwd: input.cwd,
          env: {},
          runner: defaultRunner,
        });
      },
      nativeDiscovery: {
        discover:
          discover ??
          (async (input) => {
            discoveryInputs.push(input);
            return {
              status: "ready",
              agents: [CHOICE],
              recordCount: 2,
              polls: 1,
              fromCache: false,
            };
          }),
      },
      actions: {
        repositorySettingsChanged: () => {
          fixture.settingsChanges += 1;
        },
      },
    },
  };
  return fixture;
}

// ---------------------------------------------------------------------------
// 5.1 Discovery and source-update routes
// ---------------------------------------------------------------------------

test("the discovery route requires authentication and refuses unknown or non-OpenCode repositories", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  const unauthorized = await app.inject({
    method: "GET",
    url: `/repos/${fixture.opencodeRepoId}/opencode-agents`,
  });
  assert.equal(unauthorized.statusCode, 401);

  const missing = await app.inject({
    method: "GET",
    url: "/repos/999999999/opencode-agents",
    headers: AUTH,
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "repository-not-found" });

  const cline = await app.inject({
    method: "GET",
    url: `/repos/${fixture.clineRepoId}/opencode-agents`,
    headers: AUTH,
  });
  assert.equal(cline.statusCode, 404);
  assert.deepEqual(cline.json(), { error: "not-opencode" });

  await app.close();
  fixture.store.close();
});

test("discovery derives the repository path on the server and returns only safe choice metadata", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  const response = await app.inject({
    method: "GET",
    url: `/repos/${fixture.opencodeRepoId}/opencode-agents?refresh=1`,
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json() as {
    ok: boolean;
    status: string;
    agents: NativeAgentChoice[];
    selection: { source: string };
    revision: number;
    profileRevision: number | null;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "ready");
  assert.deepEqual(payload.agents, [CHOICE]);
  assert.equal(payload.selection.source, "default");
  // The path used came from the repository row, not a browser-supplied value.
  assert.equal(fixture.workerInputs[0]?.cwd, "source-a");
  assert.equal(fixture.workerInputs[0]?.executorId, "opencode");
  assert.equal(fixture.discoveryInputs[0]?.refresh, true);
  assert.equal(fixture.discoveryInputs[0]?.repositoryId, String(fixture.opencodeRepoId));

  // Only the safe projection fields are exposed; never a permission, model,
  // prompt or credential-shaped field.
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["permissions", "instructions", "system", "credential", "auth"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  await app.close();
  fixture.store.close();
});

test("discovery is scoped per repository and never reuses another repository context", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  await app.inject({
    method: "GET",
    url: `/repos/${fixture.opencodeRepoId}/opencode-agents`,
    headers: AUTH,
  });
  await app.inject({
    method: "GET",
    url: `/repos/${fixture.secondRepoId}/opencode-agents`,
    headers: AUTH,
  });
  assert.deepEqual(
    fixture.workerInputs.map((input) => [input.repoId, input.cwd]),
    [
      [fixture.opencodeRepoId, "source-a"],
      [fixture.secondRepoId, "source-b"],
    ],
  );
  await app.close();
  fixture.store.close();
});

test("discovery reports unavailable, failed (redacted), and pending sources without fabricating an inventory", async () => {
  const unavailable = openStore();
  unavailable.options.opencodeWorker = undefined;
  const unavailableApp = buildConsoleServer(unavailable.options);
  const unavailableResponse = await unavailableApp.inject({
    method: "GET",
    url: `/repos/${unavailable.opencodeRepoId}/opencode-agents`,
    headers: AUTH,
  });
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal((unavailableResponse.json() as { error: string }).error, "discovery-unavailable");
  await unavailableApp.close();
  unavailable.store.close();

  const failed = openStore(async () => ({
    status: "failed",
    reason: `inventory transport failed with ${SECRET}`,
    polls: 2,
  }));
  const failedApp = buildConsoleServer(failed.options);
  const failedResponse = await failedApp.inject({
    method: "GET",
    url: `/repos/${failed.opencodeRepoId}/opencode-agents`,
    headers: AUTH,
  });
  assert.equal(failedResponse.statusCode, 502);
  const failedBody = failedResponse.json() as { error: string; reason: string };
  assert.equal(failedBody.error, "discovery-failed");
  assert.equal(failedBody.reason.includes(SECRET), false);
  await failedApp.close();
  failed.store.close();

  const pending = openStore(async () => ({ status: "pending", polls: 3, recordCount: 0 }));
  const pendingApp = buildConsoleServer(pending.options);
  const pendingResponse = await pendingApp.inject({
    method: "GET",
    url: `/repos/${pending.opencodeRepoId}/opencode-agents`,
    headers: AUTH,
  });
  assert.equal(pendingResponse.statusCode, 200);
  const pendingBody = pendingResponse.json() as { ok: boolean; status: string; agents?: unknown };
  assert.equal(pendingBody.status, "pending");
  assert.equal(pendingBody.ok, false);
  assert.equal("agents" in pendingBody, false);
  await pendingApp.close();
  pending.store.close();
});

test("a native primary is saved with one audit action and one runtime notification", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  const saved = await app.inject({
    method: "POST",
    url: `/repos/${fixture.opencodeRepoId}/opencode-selection`,
    headers: AUTH,
    payload: { expectedRevision: 0, selection: { source: "native", agentId: "native-reviewer" } },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), {
    ok: true,
    repoId: fixture.opencodeRepoId,
    revision: 1,
    selection: { source: "native", agentId: "native-reviewer" },
    profileRevision: null,
  });
  assert.equal(fixture.settingsChanges, 1);
  const row = fixture.store.db
    .prepare(
      "SELECT source, native_agent_id, revision FROM opencode_primary_selections WHERE repo_id = ?",
    )
    .get(fixture.opencodeRepoId);
  assert.deepEqual(row, { source: "native", native_agent_id: "native-reviewer", revision: 1 });
  const actions = new OperatorActionStore(fixture.store.db).list();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.action, "opencode-primary-source");
  assert.equal(actions[0]?.target, `repository:${fixture.opencodeRepoId}`);
  // The audit records the safe source/id, never an instruction body.
  assert.match(String(actions[0]?.detail), /native-reviewer/u);
  assert.equal(String(actions[0]?.detail).includes(PRIVATE_INSTRUCTION), false);
  await app.close();
  fixture.store.close();
});

test("strict bodies, stale revisions, and cross-repository isolation are enforced", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  const body = (payload: unknown) => ({
    method: "POST" as const,
    url: `/repos/${fixture.opencodeRepoId}/opencode-selection`,
    headers: { ...AUTH, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

  assert.equal((await app.inject(body("not-an-object"))).statusCode, 400);
  assert.equal(
    (await app.inject(body({ expectedRevision: -1, selection: { source: "default" } }))).statusCode,
    400,
  );
  assert.equal(
    (await app.inject(body({ expectedRevision: 0, selection: "nope" }))).statusCode,
    400,
  );
  const unknownField = await app.inject(
    body({ expectedRevision: 0, selection: { source: "default", extra: true } }),
  );
  assert.equal(unknownField.statusCode, 400);
  assert.equal((unknownField.json() as { error: string }).error, "validation");

  const first = await app.inject(body({ expectedRevision: 0, selection: { source: "default" } }));
  assert.equal(first.statusCode, 200);
  const stale = await app.inject(
    body({ expectedRevision: 0, selection: { source: "native", agentId: "native-reviewer" } }),
  );
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { error: "conflict", currentRevision: 1 });

  // Updating the first repository never touched the second.
  assert.equal(
    fixture.store.db
      .prepare("SELECT revision FROM opencode_primary_selections WHERE repo_id = ?")
      .get(fixture.secondRepoId),
    undefined,
  );
  await app.close();
  fixture.store.close();
});

test("managed activation requires a saved profile and a matching profile revision", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  const update = (payload: unknown) => ({
    method: "POST" as const,
    url: `/repos/${fixture.opencodeRepoId}/opencode-selection`,
    headers: AUTH,
    payload,
  });

  const noProfile = await app.inject(
    update({ expectedRevision: 0, selection: { source: "managed" } }),
  );
  assert.equal(noProfile.statusCode, 409);
  assert.equal((noProfile.json() as { error: string }).error, "no-profile");

  const saved = saveOpenCodeAgentProfile(fixture.store.db, {
    repoId: fixture.opencodeRepoId,
    expectedRevision: 0,
    candidate: {
      version: 1,
      primary: { id: "primary", description: "Primary", permissions: ["edit"] },
      subagents: [],
    },
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error("profile save failed");

  const required = await app.inject(
    update({ expectedRevision: 0, selection: { source: "managed" } }),
  );
  assert.equal(required.statusCode, 400);
  assert.equal((required.json() as { error: string }).error, "profile-revision-required");

  const conflicted = await app.inject(
    update({ expectedRevision: 0, selection: { source: "managed" }, expectedProfileRevision: 99 }),
  );
  assert.equal(conflicted.statusCode, 409);
  assert.equal((conflicted.json() as { error: string }).error, "profile-conflict");

  const activated = await app.inject(
    update({
      expectedRevision: 0,
      selection: { source: "managed" },
      expectedProfileRevision: saved.revision,
    }),
  );
  assert.equal(activated.statusCode, 200);
  assert.deepEqual((activated.json() as { selection: unknown }).selection, { source: "managed" });
  await app.close();
  fixture.store.close();
});

test("a dormant managed profile's revision is exposed and can be explicitly activated", async () => {
  const fixture = openStore();
  const saved = saveOpenCodeAgentProfile(fixture.store.db, {
    repoId: fixture.opencodeRepoId,
    expectedRevision: 0,
    candidate: {
      version: 1,
      primary: { id: "primary", description: "Primary", permissions: ["edit"] },
      subagents: [],
    },
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error("profile save failed");
  // Saving a profile never activates it: the source is still default.
  const app = buildConsoleServer(fixture.options);
  const discovery = await app.inject({
    method: "GET",
    url: `/repos/${fixture.opencodeRepoId}/opencode-agents`,
    headers: AUTH,
  });
  const discoveryBody = discovery.json() as {
    selection: { source: string };
    profileRevision: number | null;
  };
  assert.equal(discoveryBody.selection.source, "default");
  assert.equal(discoveryBody.profileRevision, saved.revision);

  const dashboard = readDashboard(fixture.store.db, []);
  const repo = dashboard.repositories.find((entry) => entry.id === fixture.opencodeRepoId);
  assert.equal(repo?.opencodeSelection?.source, "default");
  assert.equal(repo?.opencodeSelection?.profileRevision, saved.revision);

  const activated = await app.inject({
    method: "POST",
    url: `/repos/${fixture.opencodeRepoId}/opencode-selection`,
    headers: AUTH,
    payload: {
      expectedRevision: 0,
      selection: { source: "managed" },
      expectedProfileRevision: saved.revision,
    },
  });
  assert.equal(activated.statusCode, 200);
  assert.deepEqual((activated.json() as { selection: unknown }).selection, { source: "managed" });
  await app.close();
  fixture.store.close();
});

test("an OpenCode source mutation against a Cline repository is rejected", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  const response = await app.inject({
    method: "POST",
    url: `/repos/${fixture.clineRepoId}/opencode-selection`,
    headers: AUTH,
    payload: { expectedRevision: 0, selection: { source: "default" } },
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "not-opencode" });
  await app.close();
  fixture.store.close();
});

// ---------------------------------------------------------------------------
// 5.2 Projections
// ---------------------------------------------------------------------------

test("repository summaries distinguish executor from the configured primary source", () => {
  const fixture = openStore();
  const profile = saveOpenCodeAgentProfile(fixture.store.db, {
    repoId: fixture.opencodeRepoId,
    expectedRevision: 0,
    candidate: {
      version: 1,
      primary: {
        id: "primary",
        description: "Primary",
        instructions: PRIVATE_INSTRUCTION,
        permissions: ["edit"],
      },
      subagents: [],
    },
  });
  assert.equal(profile.ok, true);
  if (!profile.ok) throw new Error("profile save failed");
  assert.equal(
    saveOpenCodeSelection(fixture.store.db, {
      repoId: fixture.opencodeRepoId,
      expectedRevision: 0,
      candidate: { source: "managed" },
      expectedProfileRevision: profile.revision,
    }).ok,
    true,
  );
  const native = saveOpenCodeSelection(fixture.store.db, {
    repoId: fixture.secondRepoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "native-reviewer" },
  });
  assert.equal(native.ok, true);

  const model = readDashboard(fixture.store.db, []);
  const managedRepo = model.repositories.find((entry) => entry.id === fixture.opencodeRepoId);
  const nativeRepo = model.repositories.find((entry) => entry.id === fixture.secondRepoId);
  const clineRepo = model.repositories.find((entry) => entry.id === fixture.clineRepoId);
  assert.equal(managedRepo?.opencodeSelection?.source, "managed");
  assert.equal(managedRepo?.opencodeSelection?.profileRevision, profile.revision);
  assert.equal(nativeRepo?.opencodeSelection?.source, "native");
  assert.equal(nativeRepo?.opencodeSelection?.nativeAgentId, "native-reviewer");
  // A repository with no durable selection row reads as an untracked default.
  assert.equal(clineRepo?.opencodeSelection?.source, "default");
  assert.equal(clineRepo?.opencodeSelection?.explicit, false);
  assert.equal(JSON.stringify(model.repositories).includes(PRIVATE_INSTRUCTION), false);
  fixture.store.close();
});

test("job detail shows captured source and the actual per-invocation identity including unknown", () => {
  const fixture = openStore();
  const saved = saveOpenCodeSelection(fixture.store.db, {
    repoId: fixture.opencodeRepoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "native-reviewer" },
  });
  assert.equal(saved.ok, true);
  const created = new JobStore(fixture.store.db).createJob({
    repoId: fixture.opencodeRepoId,
    prNumber: 42,
    commentId: 1001,
    command: "RESOLVE",
    threadId: "1001",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("job not created");
  const attemptId = Number(
    fixture.store.db
      .prepare(
        `INSERT INTO attempts (job_id, attempt_number, agent, model, provider, effort)
         VALUES (?, 1, 'opencode', 'opencode/gpt-5.4', '', 'high')`,
      )
      .run(created.jobId).lastInsertRowid,
  );
  fixture.store.db
    .prepare(
      `INSERT INTO opencode_invocations
         (attempt_id, invocation_ordinal, status, ownership_state, requested_source,
          requested_native_agent_id, parent_session_id, actual_primary_agent, actual_model)
       VALUES (?, 1, 'settled', 'settled', 'native', 'native-reviewer', 'ses_parent', NULL, NULL)`,
    )
    .run(attemptId);

  const model = readJobDetail(fixture.store.db, created.jobId, []);
  assert.ok(model);
  assert.equal(model.job.opencodeSelection?.source, "native");
  assert.equal(model.job.opencodeSelection?.nativeAgentId, "native-reviewer");
  assert.equal(model.attempts[0]?.invocations[0]?.requestedNativeAgentId, "native-reviewer");
  // The runtime did not expose a primary, so it stays explicitly unknown.
  assert.equal(model.attempts[0]?.invocations[0]?.actualPrimaryAgent, null);
  const html = jobRegions(model)["job-detail-region"];
  assert.match(html, /OpenCode primary source/u);
  assert.match(html, /native agent <code>native-reviewer<\/code>/u);
  assert.match(html, /data-invocation-actual-unknown/u);
  assert.match(html, /ses_parent/u);
  assert.equal(html.includes(PRIVATE_INSTRUCTION), false);
  fixture.store.close();
});

test("a legacy OpenCode job resolves managed from its captured profile and a non-OpenCode job projects nothing", () => {
  const fixture = openStore();
  const created = new JobStore(fixture.store.db).createJob({
    repoId: fixture.clineRepoId,
    prNumber: 7,
    commentId: 70,
    command: "RESOLVE",
    threadId: "70",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("job not created");
  const model = readJobDetail(fixture.store.db, created.jobId, []);
  assert.equal(model?.job.opencodeSelection, null);
  assert.doesNotMatch(jobRegions(model!)["job-detail-region"], /OpenCode primary source/u);
  fixture.store.close();
});

test("a legacy job resolves managed from its captured profile, and an unknown source projects nothing", () => {
  const fixture = openStore();
  const created = new JobStore(fixture.store.db).createJob({
    repoId: fixture.opencodeRepoId,
    prNumber: 8,
    commentId: 80,
    command: "RESOLVE",
    threadId: "80",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("job not created");
  const profileJson = JSON.stringify({
    version: 1,
    primary: { id: "legacy-primary", description: "Legacy", permissions: ["edit"] },
    subagents: [],
  });
  // Legacy shape: no recorded source, but a captured managed profile.
  fixture.store.db
    .prepare(
      "UPDATE jobs SET opencode_source = NULL, opencode_native_agent_id = NULL, opencode_selection_revision = NULL, opencode_profile_json = ?, opencode_profile_revision = 2 WHERE id = ?",
    )
    .run(profileJson, created.jobId);
  const legacy = readJobDetail(fixture.store.db, created.jobId, []);
  assert.equal(legacy?.job.opencodeSelection?.source, "managed");
  assert.equal(legacy?.job.opencodeSelection?.profileRevision, 2);
  assert.equal(legacy?.job.opencodeProfile?.primaryId, "legacy-primary");

  // A corrupt/unknown recorded source is not guessed; it projects nothing.
  fixture.store.db
    .prepare("UPDATE jobs SET opencode_source = 'weird' WHERE id = ?")
    .run(created.jobId);
  const unknown = readJobDetail(fixture.store.db, created.jobId, []);
  assert.equal(unknown?.job.opencodeSelection, null);
  fixture.store.close();
});

// ---------------------------------------------------------------------------
// 5.3 Views
// ---------------------------------------------------------------------------

function repoSummary(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: 7,
    owner: "acme",
    name: "opencode-widgets",
    enabled: 1,
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "",
    effort: "high",
    opencodeSelection: {
      source: "native",
      revision: 3,
      explicit: true,
      nativeAgentId: "gone-agent",
      profileRevision: null,
    },
    ...overrides,
  };
}

test("the Run with agent control renders default/native/unavailable/managed states and excludes Cline", () => {
  const nativeCard = repositoryCards([repoSummary()], bundledProviderCatalog(), AGENTS);
  assert.match(nativeCard, /data-opencode-selection/u);
  assert.match(nativeCard, /data-opencode-source-select/u);
  assert.match(nativeCard, /data-saved-source="native"/u);
  assert.match(nativeCard, /data-selection-revision="3"/u);
  // The saved native id is displayed even when discovery has not offered it.
  assert.match(nativeCard, /<option value="gone-agent" selected[^>]*>gone-agent \(saved\)/u);
  assert.match(nativeCard, /primary Existing OpenCode agent/u);
  assert.match(nativeCard, /data-opencode-source-action="apply"/u);
  assert.match(nativeCard, /data-opencode-source-action="cancel"/u);
  assert.match(nativeCard, /data-opencode-source-action="refresh"/u);
  assert.match(nativeCard, /data-opencode-native-description/u);

  const defaultCard = repositoryCards(
    [
      repoSummary({
        opencodeSelection: {
          source: "default",
          revision: 0,
          explicit: true,
          nativeAgentId: null,
          profileRevision: null,
        },
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(defaultCard, /<option value="default" selected>OpenCode default<\/option>/u);

  const managedCard = repositoryCards(
    [
      repoSummary({
        opencodeSelection: {
          source: "managed",
          revision: 2,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 5,
        },
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(managedCard, /data-saved-source="managed"/u);
  assert.match(managedCard, /managed team revision 5/u);
  assert.match(managedCard, /data-repo-agents-configure/u);
  assert.match(managedCard, /Edit managed team/u);

  const clineCard = repositoryCards(
    [repoSummary({ agent: "cline", model: "gpt-5.4", provider: "provider" })],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.doesNotMatch(clineCard, /data-opencode-selection/u);
  assert.doesNotMatch(clineCard, /Run with agent/u);
});

// ---------------------------------------------------------------------------
// 5.3/5.4 Client reconciliation
// ---------------------------------------------------------------------------

function selectionScript(): string {
  const start = clientScript.indexOf("// BEGIN_OPENCODE_SELECTION");
  const end = clientScript.lastIndexOf("// END_OPENCODE_SELECTION");
  assert.ok(start >= 0 && end > start, "selection block is present in the client script");
  return clientScript.slice(start, end);
}

interface SelectionState {
  repoId: number;
  savedSource: string;
  savedNativeId: string;
  savedRevision: number;
  savedProfileRevision: number | null;
  baseRevision: number;
  baseProfileRevision: number | null;
  source: string;
  nativeId: string;
  agents: NativeAgentChoice[] | null;
  unavailable: boolean;
  feedback: string;
  feedbackError: boolean;
  busy: boolean;
  keepApplyFocusable: boolean;
}

interface SelectionSurface {
  editors: Map<number, SelectionState>;
  stateFrom: (container: unknown) => SelectionState;
  isDirty: (state: SelectionState) => boolean;
  candidate: (state: SelectionState) => Record<string, unknown>;
  applyDisabled: (state: SelectionState) => boolean;
  ingestAgents: (state: SelectionState, agents: NativeAgentChoice[]) => SelectionState;
  nativeOptionsHtml: (state: SelectionState) => string;
  nativeDescription: (state: SelectionState) => string;
  savedSentence: (state: SelectionState) => string;
  apply: (container: unknown, state: SelectionState) => Promise<void>;
  discover: (container: unknown, state: SelectionState) => Promise<void>;
  capture: () => Array<SelectionState>;
  restore: (root: unknown, saved: Array<SelectionState>) => void;
}

function fakeSelectionContainer(dataset: Record<string, string>): {
  dataset: Record<string, string>;
  querySelector: () => null;
} {
  return { dataset, querySelector: () => null };
}

function runSelection(
  fetchImpl: (url: string, options?: unknown) => Promise<unknown> = async () => {
    throw new Error("unexpected fetch in this client test");
  },
): {
  surface: SelectionSurface;
  registered: string[];
  listeners: Record<string, Array<unknown>>;
  document: { activeElement: unknown };
} {
  const listeners: Record<string, Array<unknown>> = { click: [], change: [], focusout: [] };
  const document = {
    activeElement: null as unknown,
    addEventListener: (name: string, callback: unknown) => {
      if (listeners[name]) listeners[name].push(callback);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = { gremlynConsole: {}, location: { assign: () => undefined } };
  const registered: string[] = [];
  runInNewContext(selectionScript(), {
    document,
    window,
    fetch: fetchImpl,
    registerSurface: (name: string) => {
      registered.push(name);
    },
    console,
  });
  const surface = window.gremlynConsole.opencodeSelection as SelectionSurface;
  assert.ok(surface, "selection helpers are exposed on window.gremlynConsole.opencodeSelection");
  return { surface, registered, listeners, document };
}

test("the selection draft survives a live update while rejecting a stale apply", () => {
  const { surface, registered } = runSelection();
  assert.deepEqual(registered, ["opencode-selection"]);
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "3",
    profileRevision: "",
  });
  const state = surface.stateFrom(container);
  assert.equal(state.savedSource, "default");
  assert.equal(state.baseRevision, 3);

  // The operator explores a native choice (a draft) without applying it.
  state.source = "native";
  state.nativeId = "native-reviewer";
  surface.ingestAgents(state, [CHOICE]);
  assert.equal(surface.isDirty(state), true);
  assert.equal(surface.applyDisabled(state), false);
  const candidate = surface.candidate(state);
  assert.equal(candidate.expectedRevision, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.selection)), {
    source: "native",
    agentId: "native-reviewer",
  });
  surface.editors.set(7, state);

  // A live update swaps the region and bumps the saved revision to 9.
  const captured = surface.capture();
  const fresh = fakeSelectionContainer({
    repoId: "7",
    savedSource: "managed",
    savedNativeId: "",
    selectionRevision: "9",
    profileRevision: "5",
  });
  const root = { querySelector: () => fresh };
  surface.restore(root, captured);
  const restored = surface.editors.get(7);
  assert.ok(restored);
  // The draft is intact, the authoritative saved values are adopted, and the
  // apply still targets the revision the draft began from — so it conflicts
  // rather than silently overwriting the newer server state.
  assert.equal(restored.source, "native");
  assert.equal(restored.nativeId, "native-reviewer");
  assert.equal(restored.savedSource, "managed");
  assert.equal(restored.savedRevision, 9);
  assert.equal(restored.baseRevision, 3);
  assert.equal(surface.isDirty(restored), true);
});

test("a partial live fragment without repository cards does not discard selection drafts", () => {
  const { surface } = runSelection();
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "3",
    profileRevision: "4",
  });
  const state = surface.stateFrom(container);
  state.source = "managed";
  state.baseProfileRevision = 4;
  state.keepApplyFocusable = true;
  surface.editors.set(7, state);

  // Health/queue SSE fragments update the top-level dashboard independently
  // and do not contain the repository selection editor.
  surface.restore({ querySelector: () => null }, surface.capture());

  const retained = surface.editors.get(7);
  assert.ok(retained);
  assert.equal(retained.source, "managed");
  assert.equal(retained.baseProfileRevision, 4);
  assert.equal(retained.keepApplyFocusable, true);
});

test("a saved native id that disappears from discovery stays selected and explained", () => {
  const { surface } = runSelection();
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "native",
    savedNativeId: "gone-agent",
    selectionRevision: "2",
    profileRevision: "",
  });
  const state = surface.stateFrom(container);
  assert.equal(state.nativeId, "gone-agent");
  surface.ingestAgents(state, [CHOICE]);
  assert.equal(state.unavailable, true);
  const options = surface.nativeOptionsHtml(state);
  assert.match(options, /value="gone-agent"[^>]*selected[^>]*>gone-agent \(unavailable\)/u);
  assert.match(options, /value="native-reviewer"/u);
  assert.match(surface.savedSentence(state), /not in the latest discovery/u);
  // The saved choice is unchanged, so there is nothing to apply.
  assert.equal(surface.isDirty(state), false);
  assert.equal(surface.applyDisabled(state), true);
  // The offered agent's safe description and evidenced origin are exposed.
  state.nativeId = "native-reviewer";
  assert.match(surface.nativeDescription(state), /Reviews specs/u);
  assert.match(surface.nativeDescription(state), /Origin: project/u);
});

test("a native draft without a chosen id cannot be applied", () => {
  const { surface } = runSelection();
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "",
  });
  const state = surface.stateFrom(container);
  state.source = "native";
  state.nativeId = "";
  state.agents = [CHOICE];
  assert.equal(surface.applyDisabled(state), true);
  // A managed draft carries the frozen controlling profile revision for CAS.
  state.source = "managed";
  state.savedProfileRevision = 4;
  state.baseProfileRevision = 4;
  const managedCandidate = surface.candidate(state);
  assert.equal(managedCandidate.expectedRevision, 0);
  assert.equal(managedCandidate.expectedProfileRevision, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(managedCandidate.selection)), {
    source: "managed",
  });
});

test("discovery never auto-selects the first eligible agent while the draft is empty", () => {
  // Regression: after choosing the native source, discovery populated the
  // select and the browser showed the first agent, but the draft stayed empty
  // (the unchanged value fires no change event), so Apply stayed disabled even
  // though an agent appeared chosen.
  const { surface } = runSelection();
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "",
  });
  const state = surface.stateFrom(container);
  state.source = "native";
  surface.ingestAgents(state, [CHOICE]);

  const options = surface.nativeOptionsHtml(state);
  assert.match(options, /<option value="" selected>Select an existing agent…<\/option>/u);
  assert.match(options, /value="native-reviewer"/u);
  assert.doesNotMatch(options, /value="native-reviewer" selected/u);
  assert.equal(surface.applyDisabled(state), true);

  // A deliberate keyboard choice records the draft and enables Apply.
  state.nativeId = "native-reviewer";
  assert.equal(surface.applyDisabled(state), false);
  const candidate = surface.candidate(state);
  assert.equal(candidate.expectedRevision, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.selection)), {
    source: "native",
    agentId: "native-reviewer",
  });
});

test("choosing the first eligible agent in the native select records the draft", () => {
  const { surface, listeners } = runSelection();
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "",
  });
  const state = surface.stateFrom(container);
  state.source = "native";
  surface.ingestAgents(state, [CHOICE]);
  surface.editors.set(7, state);

  const nativeSelect = {
    value: "native-reviewer",
    dataset: {},
    closest: (selector: string) =>
      selector === '[data-opencode-source-action="apply"]'
        ? applyButton
        : selector === "[data-opencode-selection]"
          ? container
          : null,
  };
  const changeHandler = listeners.change[0] as (event: unknown) => void;
  changeHandler({
    target: {
      closest: (selector: string) =>
        selector === "[data-opencode-native-select]" ? nativeSelect : null,
    },
  });

  const updated = surface.editors.get(7);
  assert.ok(updated);
  assert.equal(updated.nativeId, "native-reviewer");
  assert.equal(surface.applyDisabled(updated), false);
});

test("successful keyboard Apply restores focus after the busy state and keeps it focusable", async () => {
  const { surface, document, listeners } = runSelection(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      revision: 1,
      selection: { source: "native", agentId: "native-reviewer" },
      profileRevision: null,
    }),
  }));
  let focusCount = 0;
  const applyButton = {
    disabled: false,
    attributes: new Map<string, string>(),
    focus: () => {
      focusCount += 1;
      document.activeElement = applyButton;
    },
    closest: (selector: string) =>
      selector === '[data-opencode-source-action="apply"]'
        ? applyButton
        : selector === "[data-opencode-selection]"
          ? container
          : null,
    setAttribute: (name: string, value: string) => applyButton.attributes.set(name, value),
    removeAttribute: (name: string) => applyButton.attributes.delete(name),
  };
  const container = {
    dataset: {
      repoId: "7",
      savedSource: "default",
      savedNativeId: "",
      selectionRevision: "0",
      profileRevision: "",
      updateUrl: "/repos/7/opencode-selection",
    },
    querySelector: (selector: string) =>
      selector === '[data-opencode-source-action="apply"]' ? applyButton : null,
  };
  const state = surface.stateFrom(container);
  state.source = "native";
  state.nativeId = "native-reviewer";
  surface.editors.set(7, state);
  document.activeElement = applyButton;

  await surface.apply(container, state);

  assert.equal(state.savedSource, "native");
  assert.equal(state.busy, false);
  assert.equal(applyButton.disabled, false);
  assert.equal(applyButton.attributes.get("aria-disabled"), "true");
  assert.equal(document.activeElement, applyButton);
  assert.equal(focusCount, 1);
  assert.equal(surface.capture()[0]?.keepApplyFocusable, true);
  const focusoutHandler = listeners.focusout[0] as (event: { target: unknown }) => void;
  focusoutHandler({ target: applyButton });
  assert.equal(state.keepApplyFocusable, false);
  assert.equal(applyButton.disabled, true);
});

// ---------------------------------------------------------------------------
// Read-only hardening findings
// ---------------------------------------------------------------------------

function corruptProfile(fixture: Fixture, repoId: number): void {
  const saved = saveOpenCodeAgentProfile(fixture.store.db, {
    repoId,
    expectedRevision: 0,
    candidate: {
      version: 1,
      primary: { id: "primary", description: "Primary", permissions: ["edit"] },
      subagents: [],
    },
  });
  assert.equal(saved.ok, true);
  fixture.store.db
    .prepare("UPDATE opencode_agent_profiles SET profile_json = ? WHERE repo_id = ?")
    .run("{ this is not a valid profile", repoId);
}

test("a corrupt stored profile never takes down the dashboard projection", () => {
  const fixture = openStore();
  corruptProfile(fixture, fixture.opencodeRepoId);
  const model = readDashboard(fixture.store.db, []);
  const repo = model.repositories.find((entry) => entry.id === fixture.opencodeRepoId);
  assert.ok(repo);
  assert.equal(repo.opencodeProfile, null);
  // The source/id projection stays available even though the team cannot parse.
  assert.equal(repo.opencodeSelection?.source, "default");
  fixture.store.close();
});

test("a corrupt dormant profile yields scoped errors but never blocks a selection save", async () => {
  const fixture = openStore();
  corruptProfile(fixture, fixture.opencodeRepoId);
  const app = buildConsoleServer(fixture.options);

  const dashboard = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(dashboard.statusCode, 200);
  assert.match(dashboard.body, /data-opencode-selection/u);

  const discovery = await app.inject({
    method: "GET",
    url: `/repos/${fixture.opencodeRepoId}/opencode-agents`,
    headers: AUTH,
  });
  assert.equal(discovery.statusCode, 200);
  assert.equal((discovery.json() as { profileRevision: number | null }).profileRevision, null);

  const selection = await app.inject({
    method: "POST",
    url: `/repos/${fixture.opencodeRepoId}/opencode-selection`,
    headers: AUTH,
    payload: { expectedRevision: 0, selection: { source: "default" } },
  });
  assert.equal(selection.statusCode, 200);
  assert.equal((selection.json() as { profileRevision: number | null }).profileRevision, null);
  assert.deepEqual(
    fixture.store.db
      .prepare("SELECT revision FROM opencode_primary_selections WHERE repo_id = ?")
      .get(fixture.opencodeRepoId),
    { revision: 1 },
  );

  const editor = await app.inject({
    method: "GET",
    url: `/repos/${fixture.opencodeRepoId}/opencode-profile`,
    headers: AUTH,
  });
  assert.equal(editor.statusCode, 422);
  assert.deepEqual(editor.json(), {
    error: "opencode-profile-corrupt",
    repoId: fixture.opencodeRepoId,
  });
  await app.close();
  fixture.store.close();
});

test("invalid repository ids are scoped not-found instead of an echoed 500", async () => {
  const fixture = openStore();
  const app = buildConsoleServer(fixture.options);
  const requests = [
    { method: "GET" as const, url: "/repos/not-a-number/opencode-agents" },
    {
      method: "POST" as const,
      url: "/repos/not-a-number/opencode-selection",
      payload: { expectedRevision: 0, selection: { source: "default" } },
    },
    { method: "GET" as const, url: "/repos/not-a-number/opencode-profile" },
    {
      method: "POST" as const,
      url: "/repos/not-a-number/opencode-profile",
      payload: { expectedRevision: 0, candidate: {} },
    },
    { method: "POST" as const, url: "/repos/0/model", payload: { model: "x" } },
    { method: "POST" as const, url: "/repos/abc/toggle" },
  ];
  for (const request of requests) {
    const response = await app.inject({ headers: AUTH, ...request });
    assert.equal(response.statusCode, 404, request.url);
    assert.deepEqual(response.json(), { error: "repository-not-found" }, request.url);
    assert.equal(response.body.includes("invalid positive integer"), false, request.url);
  }
  await app.close();
  fixture.store.close();
});

test("a live profile update does not rebind a managed draft's activation", () => {
  const { surface } = runSelection();
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "4",
  });
  const state = surface.stateFrom(container);
  state.source = "managed";
  assert.equal(state.baseProfileRevision, 4);
  surface.editors.set(7, state);

  const captured = surface.capture();
  const fresh = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "7",
  });
  surface.restore({ querySelector: () => fresh }, captured);
  const restored = surface.editors.get(7);
  assert.ok(restored);
  assert.equal(restored.savedProfileRevision, 7);
  // The frozen base keeps the CMS attempt bound to the team the operator saw.
  assert.equal(restored.baseProfileRevision, 4);
  assert.equal(surface.candidate(restored).expectedProfileRevision, 4);
});

test("a clean reconcile advances the frozen profile revision", () => {
  const { surface } = runSelection();
  const container = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "4",
  });
  surface.editors.set(7, surface.stateFrom(container));
  const captured = surface.capture();
  const fresh = fakeSelectionContainer({
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "7",
  });
  surface.restore({ querySelector: () => fresh }, captured);
  const restored = surface.editors.get(7);
  assert.ok(restored);
  assert.equal(restored.baseProfileRevision, 7);
});

test("a session-expiry redirect clears the busy and discovering flags", async () => {
  const { surface } = runSelection(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: "session-expired" }),
  }));
  const container = {
    dataset: {
      repoId: "7",
      savedSource: "default",
      savedNativeId: "",
      selectionRevision: "0",
      profileRevision: "4",
      discoveryUrl: "/repos/7/opencode-agents",
      updateUrl: "/repos/7/opencode-selection",
    },
    querySelector: () => null,
  };
  const state = surface.stateFrom(container);
  state.source = "managed";
  await surface.apply(container, state);
  assert.equal(state.busy, false);
  await surface.discover(container, state);
  assert.equal(state.discovering, false);
});

test("legacy OpenCode default jobs project default while Cline jobs stay null", () => {
  const fixture = openStore();
  const store = new JobStore(fixture.store.db);
  const job = (repoId: number, prNumber: number) =>
    store.createJob({
      repoId,
      prNumber,
      commentId: prNumber * 10,
      command: "RESOLVE",
      threadId: String(prNumber * 10),
      authorLogin: "owner",
      observedAt: "2026-09-01T00:00:00Z",
    });
  const openCode = job(fixture.opencodeRepoId, 20);
  assert.equal(openCode.kind, "created");
  if (openCode.kind !== "created") throw new Error("job not created");
  const cline = job(fixture.clineRepoId, 21);
  assert.equal(cline.kind, "created");
  if (cline.kind !== "created") throw new Error("job not created");
  // Simulate legacy rows: no recorded source/profile, only the historical attempt.
  fixture.store.db
    .prepare(
      "UPDATE jobs SET opencode_source = NULL, opencode_native_agent_id = NULL, opencode_selection_revision = NULL, opencode_profile_json = NULL WHERE id IN (?, ?)",
    )
    .run(openCode.jobId, cline.jobId);
  fixture.store.db
    .prepare(
      `INSERT INTO attempts (job_id, attempt_number, agent, model, provider, effort)
       VALUES (?, 1, 'opencode', 'opencode/gpt-5.4', '', 'high'), (?, 1, 'cline', 'gpt-5.4', 'provider', 'high')`,
    )
    .run(openCode.jobId, cline.jobId);

  assert.equal(
    readJobDetail(fixture.store.db, openCode.jobId, [])?.job.opencodeSelection?.source,
    "default",
  );
  // The recorded attempt wins over the repository's current (mutated) agent.
  fixture.store.db
    .prepare("UPDATE repositories SET agent = 'cline' WHERE id = ?")
    .run(fixture.opencodeRepoId);
  assert.equal(
    readJobDetail(fixture.store.db, openCode.jobId, [])?.job.opencodeSelection?.source,
    "default",
  );
  assert.equal(readJobDetail(fixture.store.db, cline.jobId, [])?.job.opencodeSelection, null);
  fixture.store.close();
});

test("legacy job resolution follows the configured executor kind, not the alias id", () => {
  const fixture = openStore();
  const aliasRepoId = Number(
    fixture.store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', 'alias-repo', 'source-alias', 'workspaces', 'review-agent', 'opencode/gpt-5.4', '', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  const created = new JobStore(fixture.store.db).createJob({
    repoId: aliasRepoId,
    prNumber: 22,
    commentId: 220,
    command: "RESOLVE",
    threadId: "220",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("job not created");
  fixture.store.db
    .prepare(
      "UPDATE jobs SET opencode_source = NULL, opencode_native_agent_id = NULL, opencode_selection_revision = NULL, opencode_profile_json = NULL WHERE id = ?",
    )
    .run(created.jobId);
  fixture.store.db
    .prepare(
      `INSERT INTO attempts (job_id, attempt_number, agent, model, provider, effort)
       VALUES (?, 1, 'review-agent', 'opencode/gpt-5.4', '', 'high')`,
    )
    .run(created.jobId);

  const resolve = (agentId: string | undefined): string | undefined =>
    agentId === "review-agent" ? "opencode" : agentId;
  assert.equal(
    readJobDetail(fixture.store.db, created.jobId, [], ".gremlyn", resolve)?.job.opencodeSelection
      ?.source,
    "default",
  );
  // Without the configured definition, the raw alias must not be assumed OpenCode.
  assert.equal(readJobDetail(fixture.store.db, created.jobId, [])?.job.opencodeSelection, null);
  fixture.store.close();
});
