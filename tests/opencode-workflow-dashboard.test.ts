/**
 * Dashboard tests for tasks 3.1-3.5 of `make-agent-activation-explicit`:
 * the prominent repository Agent workflow summary (what new jobs use, saved-team
 * state, historical launch evidence), the truthful child-availability labels,
 * the review/submit paths for save-only vs save-and-activate, the saved-team
 * activation action, and the reconciliation that preserves operation intent and
 * both baselines across live updates and conflicts.
 *
 * View rendering is exercised through `src/console/views/dashboard.ts` with
 * literal repository rows (the workflow projection is supplied as the query
 * layer populates it); client behavior runs the actual editor / activation
 * blocks from `src/console/assets.ts` in a lightweight vm harness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { clientScript } from "../src/console/assets.js";
import { repositoryCards, dashboardRegions } from "../src/console/views/dashboard.js";
import { bundledProviderCatalog } from "../src/agent/provider-catalog.js";
import type {
  RepositoryLastLaunchSummary,
  RepositorySummary,
  RepositoryWorkflowSummary,
} from "../src/console/queries.js";
import type { AgentDefinition } from "../src/config/loader.js";

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
  "review-agent": {
    id: "review-agent",
    kind: "opencode",
    binary: "opencode",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    credentialSource: "/tmp/opencode-data",
    credentialFiles: ["auth.json"],
  },
  "code-review-agent": {
    id: "code-review-agent",
    kind: "cline",
    binary: "cline",
    efforts: ["none", "low", "medium", "high", "xhigh"],
    credentialSource: "/tmp/cline-data",
    credentialFiles: ["secrets.json"],
  },
};

/** A saved team matching the projection's `RepositoryTeamSummary` shape. */
const SAVED_TEAM = {
  revision: 2,
  primaryId: "primary",
  primaryDescription: "Primary review agent",
  subagentCount: 2,
  enabledSubagentCount: 1,
  active: false,
};

const PROFILE = {
  revision: 2,
  primaryId: "primary",
  primaryDescription: "Primary review agent",
  primaryPermissions: ["edit", "shell"] as const,
  primaryStepLimit: null as number | null,
  subagents: [
    {
      id: "reviewer",
      enabled: true,
      description: "Spec checker",
      model: "opencode/gpt-5.4",
      permissions: ["edit", "shell"] as const,
      stepLimit: 120 as number | null,
    },
    {
      id: "researcher",
      enabled: false,
      description: "Web research",
      model: null,
      permissions: [] as const,
      stepLimit: null as number | null,
    },
  ],
};

const NO_LAUNCH: RepositoryLastLaunchSummary | null = null;

/** The per-repository workflow projection consumed by the workflow summary. */
function workflow(overrides: Partial<RepositoryWorkflowSummary> = {}): RepositoryWorkflowSummary {
  const base: RepositoryWorkflowSummary = {
    executorKind: "opencode",
    applicable: true,
    state: "no-team",
    source: "default",
    selectionRevision: 0,
    nativeAgentId: null,
    team: null,
    teamCorrupt: false,
    teamUnavailable: false,
    lastLaunch: NO_LAUNCH,
  };
  return { ...base, ...overrides };
}

function repoSummary(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: 7,
    owner: "acme",
    name: "opencode-widgets",
    enabled: 1,
    source_path: "source",
    workspace_root: "workspaces",
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "",
    effort: "high",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 3.1 / 3.2 Server-rendered workflow summary and roster labels
// ---------------------------------------------------------------------------

test("default with no saved team reads as ordinary, names the default policy, and never predicts build", () => {
  const html = repositoryCards(
    [repoSummary({ opencodeProfile: null, opencodeSelection: null, agentWorkflow: workflow() })],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /Agent workflow/u);
  assert.match(html, /No saved team/u);
  assert.match(html, /New jobs use: OpenCode default/u);
  assert.match(html, /Most recent launch:.*No recorded launch/u);
  assert.match(html, />Configure team</u);
  assert.match(html, /Change agent/u);
  assert.doesNotMatch(html, /Activate this team/u);
  assert.doesNotMatch(html, />Edit team</u, "a missing team is configured, not edited");
  // The default source must never be projected as a predicted primary; the
  // word "build" may exist in unrelated model catalogs but never in the
  // workflow's new-jobs or launch statements.
  assert.doesNotMatch(html, /New jobs use: OpenCode default[\s\S]{0,80}build/u);
  assert.doesNotMatch(html, /No recorded launch[\s\S]{0,80}build/u);
});

test("an inactive saved team under default source is a prominent amber notice with activation", () => {
  const html = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        opencodeSelection: {
          source: "default",
          revision: 0,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
        agentWorkflow: workflow({
          state: "inactive-team",
          source: "default",
          selectionRevision: 0,
          team: { ...SAVED_TEAM, active: false },
        }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /Saved team: INACTIVE/u);
  assert.match(html, /saved but is not selected/u);
  assert.match(html, /is-inactive/u);
  assert.match(html, /data-visual-state="warning"/u);
  assert.match(html, /New jobs use: OpenCode default/u);
  assert.match(
    html,
    /Selecting managed uses the saved team; switching away retains its definition/u,
  );
  // The direct activation action carries both baselines the operator reviewed.
  assert.match(html, /data-opencode-activate/u);
  assert.match(html, /data-selection-revision="0"/u);
  assert.match(html, /data-profile-revision="2"/u);
  assert.match(html, /data-activation-url="\/repos\/7\/opencode-team-activation"/u);
  assert.match(html, />Edit team</u);
  assert.match(html, />Change agent</u);
});

test("an inactive saved team under a retained native source names the native selection", () => {
  const html = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        opencodeSelection: {
          source: "native",
          revision: 3,
          explicit: true,
          nativeAgentId: "native-reviewer",
          profileRevision: 2,
        },
        agentWorkflow: workflow({
          state: "inactive-team",
          source: "native",
          selectionRevision: 3,
          nativeAgentId: "native-reviewer",
          team: { ...SAVED_TEAM, active: false },
        }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /New jobs use: Existing OpenCode agent <code>native-reviewer<\/code>/u);
  assert.match(html, /Saved team: INACTIVE/u);
  assert.match(html, /Activate this team/u);
});

test("an active managed team reads ACTIVE FOR NEW JOBS with an edit action", () => {
  const html = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        opencodeSelection: {
          source: "managed",
          revision: 2,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
        agentWorkflow: workflow({
          state: "active-managed",
          source: "managed",
          selectionRevision: 2,
          team: { ...SAVED_TEAM, active: true },
        }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /Team: ACTIVE FOR NEW JOBS/u);
  // The prominent active summary names the selected primary and revision
  // without relying on the subordinate roster.
  assert.match(
    html,
    /New jobs use: the Gremlyn-managed team \(primary <code>primary<\/code>\) at revision 2/u,
  );
  const workflowHtml = (html.match(
    /<section class="repo-opencode-workflow[\s\S]*?<\/section>/u,
  ) ?? [""])[0];
  assert.match(
    workflowHtml,
    /primary <code>primary<\/code>/u,
    "the primary id appears in the active workflow summary",
  );
  assert.match(
    workflowHtml,
    /at revision 2/u,
    "the activation-relevant revision appears in the active summary",
  );
  assert.match(html, />Edit active team</u);
  assert.doesNotMatch(html, /Activate this team/u);
  assert.match(html, /Existing jobs and retries keep the selection recorded/u);
});

test("managed selection with a missing or corrupt team shows an unavailable repair state", () => {
  for (const teamCorrupt of [false, true]) {
    const html = repositoryCards(
      [
        repoSummary({
          opencodeProfile: null,
          opencodeSelection: {
            source: "managed",
            revision: 4,
            explicit: true,
            nativeAgentId: null,
            profileRevision: null,
          },
          agentWorkflow: workflow({
            state: "unavailable-managed",
            source: "managed",
            selectionRevision: 4,
            teamCorrupt,
            teamUnavailable: true,
          }),
        }),
      ],
      bundledProviderCatalog(),
      AGENTS,
    );
    assert.match(html, /Selected team unavailable/u);
    assert.match(html, /cannot safely use it/u);
    assert.match(html, />Repair team</u);
    assert.doesNotMatch(html, /Activate this team/u);
    assert.doesNotMatch(html, /ACTIVE FOR NEW JOBS/u);
  }
});

test("the historical line shows the caused actual primary and links its job", () => {
  const launch: RepositoryLastLaunchSummary = {
    jobId: 221,
    jobHref: "/jobs/221",
    attemptId: 9,
    invocationOrdinal: 1,
    launchedAt: "2026-09-01T10:00:00.000Z",
    requestedSource: "default",
    requestedNativeAgentId: null,
    requestedProfileRevision: null,
    actualPrimaryAgent: "build",
    actualModel: "opencode/claude-sonnet-5",
    status: "settled",
  };
  const html = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        agentWorkflow: workflow({
          state: "inactive-team",
          team: { ...SAVED_TEAM, active: false },
          lastLaunch: launch,
        }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /Most recent launch: <a href="\/jobs\/221">Job #221<\/a>/u);
  // The requested default policy and the observed actual primary stay separate;
  // default resolving to build is ordinary, not a mismatch.
  assert.match(html, /New jobs use: OpenCode default/u);
  assert.match(html, /ran as <code>build<\/code>/u);
});

test("an unknown latest identity stays not observed and never borrows an older primary", () => {
  const html = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        agentWorkflow: workflow({
          state: "inactive-team",
          team: { ...SAVED_TEAM, active: false },
          lastLaunch: {
            jobId: 300,
            jobHref: "/jobs/300",
            attemptId: 2,
            invocationOrdinal: 1,
            launchedAt: "2026-09-02T10:00:00.000Z",
            requestedSource: "native",
            requestedNativeAgentId: "native-primary",
            requestedProfileRevision: null,
            actualPrimaryAgent: null,
            actualModel: null,
            status: "settled",
          },
        }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /ran as <span class="muted">Not observed<\/span>/u);
  assert.equal(
    html.includes("native-primary</code>"),
    false,
    "requested identity must not masquerade as actual",
  );
});

test("repositories keep their own launch histories and redact escaped identity", () => {
  const repos = [
    repoSummary({
      id: 1,
      name: "one",
      opencodeProfile: PROFILE,
      agentWorkflow: workflow({
        state: "inactive-team",
        team: { ...SAVED_TEAM, active: false },
        lastLaunch: {
          jobId: 1,
          jobHref: "/jobs/1",
          attemptId: 1,
          invocationOrdinal: 1,
          launchedAt: "2026-09-01T00:00:00.000Z",
          requestedSource: "default",
          requestedNativeAgentId: null,
          requestedProfileRevision: null,
          actualPrimaryAgent: "agent-one",
          actualModel: null,
          status: "settled",
        },
      }),
    }),
    repoSummary({
      id: 2,
      name: "two",
      opencodeProfile: PROFILE,
      agentWorkflow: workflow({
        state: "inactive-team",
        team: { ...SAVED_TEAM, active: false },
        lastLaunch: {
          jobId: 2,
          jobHref: "/jobs/2",
          attemptId: 3,
          invocationOrdinal: 1,
          launchedAt: "2026-09-01T00:00:00.000Z",
          requestedSource: "managed",
          requestedNativeAgentId: null,
          requestedProfileRevision: 2,
          actualPrimaryAgent: "agent-two",
          actualModel: null,
          status: "settled",
        },
      }),
    }),
  ];
  const html = repositoryCards(repos, bundledProviderCatalog(), AGENTS);
  assert.match(html, /Job #1/u);
  assert.match(html, /Job #2/u);
  assert.match(html, /agent-one/u);
  assert.match(html, /agent-two/u);
  assert.equal(
    html.includes("agent-one</code>agent-two"),
    false,
    "histories must not bleed across repositories",
  );
});

test("enabled children are labeled by saved-team context, never as executed", () => {
  const inactive = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        opencodeSelection: {
          source: "default",
          revision: 0,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
        agentWorkflow: workflow({ state: "inactive-team", team: { ...SAVED_TEAM, active: false } }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(inactive, /Enabled in saved team/u);
  assert.equal(inactive.includes("Available to orchestrator"), false);
  assert.match(inactive, /Disabled/u);
  assert.match(inactive, /Only enabled children are callable by the primary/u);
  assert.match(inactive, /the primary decides when to delegate/u);
  assert.match(inactive, /never evidence that a child ran/u);
  assert.match(
    inactive,
    /A default or native runner can still delegate through its own configuration/u,
  );

  const active = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        opencodeSelection: {
          source: "managed",
          revision: 1,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
        agentWorkflow: workflow({
          state: "active-managed",
          source: "managed",
          selectionRevision: 1,
          team: { ...SAVED_TEAM, active: true },
        }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(active, /Available to orchestrator/u);
  assert.equal(active.includes("Enabled in saved team"), false);
  assert.match(active, /Disabled/u);
  assert.doesNotMatch(
    active,
    /data-delegation/u,
    "availability must never be rendered as observed delegation",
  );
});

test("a corrupt dormant team offers no activation because the saved bytes cannot run", () => {
  const html = repositoryCards(
    [
      repoSummary({
        // The query fails closed to no projected team summary for corrupt bytes;
        // the retained selection revision is exposed but activation is unsafe.
        opencodeProfile: null,
        opencodeSelection: {
          source: "default",
          revision: 0,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
        agentWorkflow: workflow({ state: "inactive-team", teamCorrupt: true }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /Saved team: INACTIVE/u);
  assert.doesNotMatch(html, /data-opencode-activate/u, "a corrupt saved team cannot be activated");
  assert.match(html, />Edit team</u, "repair stays available through the editor");
});

test("an active team with zero enabled children discloses the state explicitly", () => {
  const emptyProfile = {
    revision: 2,
    primaryId: "primary",
    primaryDescription: "Primary review agent",
    primaryPermissions: [] as const,
    primaryStepLimit: null as number | null,
    subagents: [] as ReadonlyArray<{
      id: string;
      enabled: boolean;
      description: string;
      model: string | null;
      permissions: readonly string[];
      stepLimit: number | null;
    }>,
  };
  const html = repositoryCards(
    [
      repoSummary({
        opencodeProfile: emptyProfile,
        opencodeSelection: {
          source: "managed",
          revision: 1,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
        agentWorkflow: workflow({
          state: "active-managed",
          source: "managed",
          selectionRevision: 1,
          team: {
            revision: 2,
            primaryId: "primary",
            primaryDescription: "Primary review agent",
            subagentCount: 0,
            enabledSubagentCount: 0,
            active: true,
          },
        }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(html, /data-no-enabled-children/u);
  assert.match(html, /No enabled children/u);
});

test("Non-OpenCode executors render no workflow summary even with a dormant profile", () => {
  for (const agent of ["cline", "code-review-agent"]) {
    const html = repositoryCards(
      [
        repoSummary({
          agent,
          opencodeProfile: PROFILE,
          agentWorkflow: workflow({
            executorKind: agent === "cline" ? "cline" : "cline",
            applicable: false,
            state: "unsupported-executor",
            team: null,
          }),
        }),
      ],
      bundledProviderCatalog(),
      AGENTS,
    );
    assert.doesNotMatch(html, /data-opencode-workflow/u);
    assert.doesNotMatch(html, /Agent workflow/u);
  }
  const alias = repositoryCards(
    [
      repoSummary({
        agent: "review-agent",
        opencodeProfile: PROFILE,
        agentWorkflow: workflow({ state: "inactive-team", team: { ...SAVED_TEAM, active: false } }),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(
    alias,
    /data-opencode-workflow/u,
    "an alias resolving to OpenCode renders the workflow",
  );
});

test("the workflow summary falls back to the authoritative projections when agentWorkflow is absent", () => {
  // View-layer literals predate the query field; the same state must still render.
  const managed = repositoryCards(
    [
      repoSummary({
        opencodeProfile: PROFILE,
        opencodeSelection: {
          source: "managed",
          revision: 1,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(managed, /Team: ACTIVE FOR NEW JOBS/u);

  const unavailable = repositoryCards(
    [
      repoSummary({
        opencodeProfile: null,
        opencodeSelection: {
          source: "managed",
          revision: 1,
          explicit: true,
          nativeAgentId: null,
          profileRevision: null,
        },
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(unavailable, /Selected team unavailable/u);

  const none = repositoryCards(
    [repoSummary({ opencodeProfile: null, opencodeSelection: null })],
    bundledProviderCatalog(),
    AGENTS,
  );
  assert.match(none, /No saved team/u);
});

test("the workflow summary stays visible in the dashboard region without opening details", () => {
  const model = {
    repositories: [
      repoSummary({
        opencodeProfile: PROFILE,
        opencodeSelection: {
          source: "default",
          revision: 0,
          explicit: true,
          nativeAgentId: null,
          profileRevision: 2,
        },
        agentWorkflow: workflow({ state: "inactive-team", team: { ...SAVED_TEAM, active: false } }),
      }),
    ],
    running: [],
    queued: [],
    recent: [],
    jobs: [],
    health: {
      status: "ok",
      stale: false,
      queueDepth: 0,
      inFlight: 0,
      concurrency: 1,
      lastPolledAt: null,
      pollIntervalSec: 60,
    },
  };
  const regions = dashboardRegions(model, bundledProviderCatalog(), AGENTS);
  assert.match(regions.repositories, /Agent workflow/u);
  assert.match(regions.repositories, /Saved team: INACTIVE/u);
  assert.match(regions.repositories, /Activate this team/u);
});

// ---------------------------------------------------------------------------
// 3.3 / 3.4 Client editor save-only vs save-and-activate review and submit
// ---------------------------------------------------------------------------

interface AgentDraft {
  primary: Record<string, unknown>;
  subagents: Array<Record<string, unknown>>;
}

interface AgentEditorSurface {
  draftFromProfile: (profile: unknown) => AgentDraft;
  draftToCandidate: (draft: AgentDraft) => Record<string, unknown>;
  editorHtml: (repoId: number, state: Record<string, unknown>) => string;
  editors: Map<number, Record<string, unknown>>;
  mount: (container: unknown, repoId: number) => Promise<void>;
  save: (repoId: number, operation?: string) => Promise<void>;
  reloadBaselines: (repoId: number) => Promise<void>;
  cancel: (repoId: number) => void;
  capture: () => Array<Record<string, unknown>>;
  restore: (root: unknown, saved: Array<Record<string, unknown>>) => void;
}

function editorScript(): string {
  const start = clientScript.indexOf("// BEGIN_OPENCODE_AGENT_EDITOR");
  const end = clientScript.lastIndexOf("// END_OPENCODE_AGENT_EDITOR");
  assert.ok(start >= 0 && end > start, "editor block is present in the client script");
  return clientScript.slice(start, end);
}

function fakeContainer(
  initialHtml = "",
  repoId = 7,
): {
  innerHTML: string;
  dataset: Record<string, string>;
  querySelector: (selector: string) => unknown;
  closest: () => unknown;
  setAttribute: () => void;
  getAttribute: () => null;
  focus: () => void;
} {
  const container = {
    innerHTML: initialHtml,
    dataset: { repoId: String(repoId) },
    closest: () => null,
    setAttribute: () => undefined,
    getAttribute: () => null,
    focus: () => undefined,
    querySelector: () => null,
  };
  container.querySelector = (selector: string) => {
    if (selector === "[data-agent-editor]") {
      return container.innerHTML.includes("data-agent-editor") ? { focus: () => undefined } : null;
    }
    return null;
  };
  return container;
}

function runAgentEditor(
  fetchImpl: (url: string, options?: unknown) => Promise<unknown>,
  options: { querySelector?: (selector: string) => unknown } = {},
): {
  agent: AgentEditorSurface;
} {
  const listeners: Record<string, Array<unknown>> = { click: [], input: [], change: [] };
  const document = {
    listeners,
    addEventListener: (name: string, callback: unknown) => {
      if (listeners[name]) listeners[name].push(callback);
    },
    querySelector: options.querySelector ?? (() => null),
    querySelectorAll: () => [],
  };
  const window = { gremlynConsole: {}, location: { assign: () => undefined } };
  runInNewContext(editorScript(), {
    document,
    window,
    fetch: fetchImpl,
    registerSurface: () => undefined,
    console,
  });
  const agent = window.gremlynConsole.agentEditor as AgentEditorSurface;
  assert.ok(agent, "editor helpers are exposed on window.gremlynConsole.agentEditor");
  return { agent };
}

function profileWithReviewer(): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description: "Primary review agent",
      instructions: "private",
      permissions: ["edit", "shell"],
    },
    subagents: [
      {
        id: "reviewer",
        description: "Spec checker",
        instructions: "private",
        enabled: true,
        model: "opencode/gpt-5.4",
        stepLimit: 120,
        permissions: ["edit", "shell"],
      },
    ],
  };
}

function editorState(
  agent: AgentEditorSurface,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode: "review",
    revision: 2,
    draft: agent.draftFromProfile(profileWithReviewer()),
    errors: [],
    notice: null,
    busy: false,
    activeSaved: false,
    operation: "save",
    needReload: false,
    baseSelectionRevision: 5,
    selectionRevision: 5,
    container: fakeContainer(),
    repoModel: "opencode/gpt-5.4",
    ...overrides,
  };
}

test("the review names the chosen operation and its future-job consequence before submit", () => {
  const { agent } = runAgentEditor(async () => {
    throw new Error("no fetch expected");
  });
  const state = editorState(agent);
  state.container = fakeContainer();
  const review = agent.editorHtml(7, state);
  assert.match(review, /data-agent-action="save"/u);
  assert.match(review, /data-agent-action="save-and-activate"/u);
  assert.match(
    review,
    /Save team persists the reviewed profile without changing what new jobs use/u,
  );
  assert.match(
    review,
    /Save and activate commits this same profile and makes it control new managed jobs/u,
  );

  const activeState = editorState(agent, { activeSaved: true });
  const activeReview = agent.editorHtml(7, activeState);
  assert.match(activeReview, /data-agent-action="save"/u);
  assert.doesNotMatch(
    activeReview,
    /data-agent-action="save-and-activate"/u,
    "active teams only offer save",
  );
  assert.match(activeReview, /Saving updates the active team this repository already uses/u);
});

test("save-only still posts the reviewed candidate to the profile route and preserves selection", async () => {
  let posted: { url: string; body: string } | undefined;
  const { agent } = runAgentEditor(async (url, options) => {
    posted = { url, body: (options as { body: string }).body };
    return { ok: true, status: 200, json: async () => ({ ok: true, revision: 3 }) };
  });
  const container = fakeContainer();
  const state = editorState(agent, { container, revision: 2 });
  agent.editors.set(7, state as never);
  await agent.save(7, "save");

  assert.equal(posted?.url, "/repos/7/opencode-profile");
  const body = JSON.parse(posted?.body ?? "{}") as {
    expectedRevision: number;
    candidate: Record<string, unknown>;
  };
  assert.equal(body.expectedRevision, 2);
  assert.equal(body.candidate.version, 1);
  assert.equal("mode" in body, false);
  // Save-only feedback distinguishes inactive from active outcomes.
  assert.match(container.innerHTML, /Agent team saved as revision 3/u);
  assert.match(container.innerHTML, /It remains inactive/u);
});

test("save-and-activate submits the reviewed candidate with both baselines in one operation", async () => {
  let posted: { url: string; body: string } | undefined;
  const { agent } = runAgentEditor(async (url, options) => {
    posted = { url, body: (options as { body: string }).body };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        repoId: 7,
        operation: "save-and-activate",
        changed: true,
        active: true,
        selection: { source: "managed" },
        selectionRevision: 6,
        profileRevision: 3,
        primaryId: "primary",
        subagentIds: ["reviewer"],
      }),
    };
  });
  const container = fakeContainer();
  const state = editorState(agent, { container, revision: 2, baseSelectionRevision: 5 });
  agent.editors.set(7, state as never);
  await agent.save(7, "save-and-activate");

  assert.equal(posted?.url, "/repos/7/opencode-team-activation");
  const body = JSON.parse(posted?.body ?? "{}") as {
    mode: string;
    expectedProfileRevision: number;
    expectedSelectionRevision: number;
    profile: Record<string, unknown>;
  };
  assert.equal(body.mode, "save-and-activate");
  assert.equal(body.expectedProfileRevision, 2);
  assert.equal(body.expectedSelectionRevision, 5);
  assert.equal(body.profile.version, 1);
  assert.match(container.innerHTML, /Team active for new jobs/u);
  assert.match(container.innerHTML, /Existing jobs and retries keep their recorded selection/u);
  assert.equal(agent.editors.has(7), false, "a landed operation closes the draft");
});

test("a save-and-activate conflict keeps the draft, the intent, and both baselines", async () => {
  const { agent } = runAgentEditor(async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: "profile-conflict",
      currentProfileRevision: 4,
      currentSelectionRevision: 6,
    }),
  }));
  const container = fakeContainer();
  const state = editorState(agent, { container, revision: 2, baseSelectionRevision: 5 });
  agent.editors.set(7, state as never);
  await agent.save(7, "save-and-activate");

  const after = agent.editors.get(7) as
    | {
        notice: string;
        operation: string;
        revision: number;
        baseSelectionRevision: number;
        needReload: boolean;
        draft: AgentDraft;
      }
    | undefined;
  assert.ok(after, "the draft must survive the conflict");
  assert.equal(after.operation, "save-and-activate");
  assert.equal(after.revision, 2, "the frozen profile baseline is preserved");
  assert.equal(after.baseSelectionRevision, 5, "the frozen selection baseline is preserved");
  assert.equal(after.needReload, true, "a conflict must require a deliberate reload/review");
  assert.match(after.notice, /its operation intent and your reviewed baselines were kept/u);
  // The recovery control appears in the review and never auto-retries.
  const review = agent.editorHtml(7, after);
  assert.match(review, /data-agent-action="reload-baselines"/u);
  assert.match(
    container.innerHTML,
    /data-agent-action="reload-baselines"(?! disabled)/u,
    "the settled conflict must enable recovery in the actual rendered DOM, without waiting for SSE",
  );
  assert.match(container.innerHTML, /data-agent-notice/u);
});

test("a conflict disables submits until reload and refuses a premature submit without any fetch", async () => {
  let fetches = 0;
  const { agent } = runAgentEditor(async () => {
    fetches += 1;
    return {
      ok: false,
      status: 409,
      json: async () => ({
        error: "profile-conflict",
        currentProfileRevision: 4,
        currentSelectionRevision: 6,
      }),
    };
  });
  const container = fakeContainer();
  const state = editorState(agent, {
    container,
    revision: 2,
    baseSelectionRevision: 5,
    operation: "save-and-activate",
  });
  agent.editors.set(7, state as never);
  await agent.save(7, "save-and-activate");
  assert.equal(fetches, 1);

  // While the conflict is unresolved both submit paths render disabled, and a
  // save call must not fire: recovery requires the explicit reload-to-review.
  const after = agent.editors.get(7) as Record<string, unknown>;
  const review = agent.editorHtml(7, after);
  assert.match(review, /data-agent-action="save" disabled/u);
  assert.match(review, /data-agent-action="save-and-activate" disabled/u);
  assert.match(review, /data-agent-action="reload-baselines"/u);
  await agent.save(7, "save-and-activate");
  await agent.save(7, "save");
  assert.equal(fetches, 1, "no submission may fire while the conflict is unresolved");
  const kept = agent.editors.get(7) as {
    revision: number;
    baseSelectionRevision: number;
    operation: string;
    needReload: boolean;
  };
  assert.equal(kept.revision, 2, "frozen profile baseline preserved until reload");
  assert.equal(kept.baseSelectionRevision, 5, "frozen selection baseline preserved until reload");
  assert.equal(kept.operation, "save-and-activate", "operation intent preserved");
  assert.equal(kept.needReload, true, "the conflict gate is not silently cleared");
});

test("reload baselines advances only the CAS baselines and keeps the draft, intent, and focus scope", async () => {
  let fetched = 0;
  const { agent } = runAgentEditor(async (url) => {
    fetched += 1;
    assert.equal(url, "/repos/7/opencode-profile");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        revision: 9,
        selection: { source: "managed" },
        selectionRevision: 8,
        selectionExplicit: true,
        active: true,
        profile: {
          version: 1,
          primary: { id: "newer-primary", description: "Newer stored team", permissions: ["edit"] },
          subagents: [],
        },
        defaultProfile: null,
      }),
    };
  });
  const container = fakeContainer();
  const state = editorState(agent, {
    container,
    mode: "review",
    revision: 2,
    baseSelectionRevision: 5,
    needReload: true,
  });
  state.draft.primary.description = "My unsaved edit must survive the reload";
  agent.editors.set(7, state as never);
  await agent.reloadBaselines(7);

  assert.equal(fetched, 1);
  const after = agent.editors.get(7) as
    | {
        revision: number;
        baseSelectionRevision: number;
        selectionRevision: number;
        activeSaved: boolean;
        needReload: boolean;
        operation: string;
        notice: string;
        draft: AgentDraft;
      }
    | undefined;
  assert.ok(after, "reload keeps the editor open");
  assert.equal(after.revision, 9, "the profile baseline advances to the newer stored revision");
  assert.equal(
    after.baseSelectionRevision,
    8,
    "the selection baseline advances with the coherent GET",
  );
  assert.equal(after.selectionRevision, 8);
  assert.equal(after.activeSaved, true);
  assert.equal(after.needReload, false, "a deliberate reload clears the conflict gate");
  assert.equal(after.operation, "save", "operation intent is preserved");
  assert.equal(
    after.draft.primary.description,
    "My unsaved edit must survive the reload",
    "the draft is never replaced",
  );
  assert.match(after.notice, /Baselines reloaded from the stored team/u);
  assert.match(after.notice, /profile revision 9/u);
});

test("save-only feedback trusts the backend's active boolean, never cached mount state", async () => {
  // Scenario the parent flagged: the source switched away while the operator
  // edited, so the cached mount-time active state is stale. The save response
  // captures the authoritative result in the same transaction.
  const activePayload: boolean | undefined = false;
  const { agent } = runAgentEditor(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, revision: 4, active: activePayload }),
  }));
  const container = fakeContainer();
  const state = editorState(agent, { container, revision: 3, activeSaved: true });
  agent.editors.set(7, state as never);
  await agent.save(7, "save");
  assert.match(
    container.innerHTML,
    /It remains inactive/u,
    "a false backend active must not claim active from cache",
  );

  const second = runAgentEditor(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, revision: 5, active: true }),
  }));
  const containerB = fakeContainer();
  // Cached state says inactive, but the transaction captured an active result.
  const stateB = editorState(second.agent, {
    container: containerB,
    revision: 4,
    activeSaved: false,
  });
  second.agent.editors.set(7, stateB as never);
  await second.agent.save(7, "save");
  assert.match(
    containerB.innerHTML,
    /Active team updated for new jobs/u,
    "the authoritative payload active wins",
  );
});

test("a combined success reflects the committed active state even if a switch interleaves", async () => {
  const { agent } = runAgentEditor(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      repoId: 7,
      operation: "save-and-activate",
      changed: true,
      active: false,
      selection: { source: "default" },
      profileRevision: 3,
      selectionRevision: 7,
    }),
  }));
  const container = fakeContainer();
  const state = editorState(agent, {
    container,
    revision: 2,
    baseSelectionRevision: 5,
    activeSaved: false,
  });
  agent.editors.set(7, state as never);
  await agent.save(7, "save-and-activate");
  assert.match(container.innerHTML, /not currently selected for new jobs/u);
  assert.doesNotMatch(container.innerHTML, /Team active for new jobs/u);
});

test("a save-and-activate refresh failure after commit is reported as a refresh problem", async () => {
  let posted: { url: string; body: string } | undefined;
  const { agent } = runAgentEditor(async (url, options) => {
    posted = { url, body: (options as { body: string }).body };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        repoId: 7,
        operation: "save-and-activate",
        changed: true,
        active: true,
        selectionRevision: 6,
        profileRevision: 3,
        refreshError: "notification-failed",
      }),
    };
  });
  const container = fakeContainer();
  const state = editorState(agent, { container, revision: 2, baseSelectionRevision: 5 });
  agent.editors.set(7, state as never);
  await agent.save(7, "save-and-activate");
  assert.equal(posted?.url, "/repos/7/opencode-team-activation");
  assert.match(
    container.innerHTML,
    /The change is committed, but the live settings refresh failed/u,
  );
  assert.doesNotMatch(container.innerHTML, /rolled back/u);
});

test("a started starter template stays unsaved until an explicit operation succeeds", async () => {
  let posted = 0;
  const { agent } = runAgentEditor(async (_url, _options) => {
    posted += 1;
    return {
      ok: false,
      status: 409,
      json: async () => ({ error: "conflict", currentRevision: 9 }),
    };
  });
  const container = fakeContainer("");
  const state = editorState(agent, { container, revision: 0, baseSelectionRevision: 0 });
  agent.editors.set(7, state as never);
  await agent.save(7, "save");
  assert.equal(posted, 1);
  assert.equal(agent.editors.has(7), true, "a refused save keeps the unsaved starter draft");
});

// ---------------------------------------------------------------------------
// 3.4 / 3.5 Saved-team activation action and reconciliation
// ---------------------------------------------------------------------------

interface ActivationSurface {
  for: (
    node: unknown,
  ) => { container: ActivationContainer; state: ActivationRunState; repoId: number } | null;
  apply: (container: ActivationContainer, state: ActivationRunState) => Promise<void>;
  reloadBaselines: (container: ActivationContainer, state: ActivationRunState) => Promise<void>;
  markActive: (container: ActivationContainer, override?: Record<string, unknown>) => void;
  markInactive: (container: ActivationContainer, override?: Record<string, unknown>) => void;
  syncWorkflow: (container: unknown, state: Record<string, unknown>) => void;
  errorMessage: (payload: unknown) => string;
  state: Map<number, ActivationRunState>;
}

interface ActivationRunState {
  busy: boolean;
  conflict?: boolean;
  intent?: string;
  frozen?: { expectedProfileRevision: number; expectedSelectionRevision: number } | null;
}

/** Compare a vm-realm frozen-baseline object without prototype-sensitive deepEqual. */
function assertFrozenSnapshot(
  frozen: unknown,
  profileRevision: number,
  selectionRevision: number,
): void {
  const value = frozen as
    { expectedProfileRevision?: number; expectedSelectionRevision?: number } | null | undefined;
  assert.equal(value?.expectedProfileRevision, profileRevision);
  assert.equal(value?.expectedSelectionRevision, selectionRevision);
}

interface ActivationContainer {
  dataset: Record<string, string>;
  classList: { add: (name: string) => void; remove: (name: string) => void };
  querySelector: (selector: string) => unknown;
}

/** Slices the selection + activation client region (shares its helpers). */
function clientActivationScript(): string {
  const start = clientScript.indexOf("// BEGIN_OPENCODE_SELECTION");
  const end = clientScript.indexOf("// END_OPENCODE_ACTIVATION");
  assert.ok(start >= 0 && end > start, "activation block is present in the client script");
  return clientScript.slice(start, end);
}

interface ActivationHarness {
  activation: ActivationSurface;
  selection: {
    stateFrom: (container: unknown) => Record<string, unknown>;
    apply: (container: unknown, state: Record<string, unknown>) => Promise<void>;
    applyDisabled: (state: Record<string, unknown>) => boolean;
    reloadBaselines: (container: unknown, state: Record<string, unknown>) => Promise<void>;
    cancel: (container: unknown, state: Record<string, unknown>) => void;
    editors: Map<number, Record<string, unknown>>;
  };
  messages: Array<{ message: string; error: boolean }>;
  surfaces: Map<
    string,
    { capture: () => unknown; restore: (root: unknown, saved: unknown) => void }
  >;
}

function runActivation(
  fetchImpl: (url: string, options?: unknown) => Promise<unknown> = async () => {
    throw new Error("unexpected fetch in this client test");
  },
): ActivationHarness {
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
  const messages: Array<{ message: string; error: boolean }> = [];
  const actionMessage = (_source: unknown, message: string, error: boolean) => {
    messages.push({ message, error });
  };
  const surfaces = new Map<
    string,
    { capture: () => unknown; restore: (root: unknown, saved: unknown) => void }
  >();
  runInNewContext(clientActivationScript(), {
    document,
    window,
    fetch: fetchImpl,
    registerSurface: (
      name: string,
      hook: { capture: () => unknown; restore: (root: unknown, saved: unknown) => void },
    ) => {
      surfaces.set(name, hook);
    },
    actionMessage,
    console,
  });
  const activation = window.gremlynConsole.opencodeActivation as ActivationSurface;
  assert.ok(
    activation,
    "activation helpers are exposed on window.gremlynConsole.opencodeActivation",
  );
  const selection = window.gremlynConsole.opencodeSelection as ActivationHarness["selection"];
  assert.ok(selection, "selection helpers are exposed in the activation harness");
  return { activation, selection, messages, surfaces };
}

function fakeWorkflow(dataset: Record<string, string>): ActivationContainer {
  return {
    dataset,
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => undefined,
    },
    querySelector: () => null,
  };
}

interface FocusableNode {
  hidden?: boolean;
  disabled?: boolean;
  focus: () => void;
}

interface PositionedWorkflow extends ActivationContainer {
  dataset: Record<string, string>;
  focused: string[];
}

/** A workflow node that records which stable action received focus. */
function fakePositionedWorkflow(focused: string[], reloadVisible = false): PositionedWorkflow {
  const stub = (label: string, extra: Partial<FocusableNode> = {}): FocusableNode => ({
    ...extra,
    focus: () => focused.push(label),
  });
  return {
    dataset: {
      repoId: "7",
      teamState: "inactive-team",
      source: "default",
      selectionRevision: "0",
      profileRevision: "2",
      activationUrl: "/repos/7/opencode-team-activation",
    },
    focused,
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => undefined,
    },
    closest: () => null,
    querySelector: (selector) => {
      if (selector === "[data-opencode-reload-baselines]")
        return stub("reload", { hidden: !reloadVisible });
      if (selector === "[data-repo-agents-configure]") return stub("configure");
      if (selector === "[data-opencode-change-agent]") return stub("change");
      if (selector === "[data-opencode-activate]") return stub("activate");
      return null;
    },
  };
}

interface ActivationFocusHarness {
  activation: ActivationSurface;
  activationFocusTarget: string[];
}

function runActivationWithFocus(
  focused: string[],
  fetchImpl: (url: string, options?: unknown) => Promise<unknown> = async () => {
    throw new Error("unexpected fetch in this client test");
  },
): ActivationFocusHarness {
  const harness = runActivation(fetchImpl);
  // The shipped activation focus helper follows `activationFocusStable` by
  // querying the mounted workflow for the reload/edit/change/activate buttons;
  // the fake above records each .focus() call in the shared array.
  return { activation: harness.activation, activationFocusTarget: focused };
}

test("Activate this team posts the reviewed saved revision with both baselines and no candidate", async () => {
  let posted: { url: string; body: string } | undefined;
  const { activation, messages } = runActivation(async (url, options) => {
    posted = { url, body: (options as { body: string }).body };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        repoId: 7,
        operation: "activate-saved",
        changed: true,
        alreadyActive: false,
        active: true,
        selection: { source: "managed" },
        selectionRevision: 1,
        profileRevision: 2,
        primaryId: "primary",
        subagentIds: ["reviewer"],
      }),
    };
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow };
  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  button.closest = () => workflow;
  const found = activation.for(button);
  assert.ok(found);
  await activation.apply(found.container, found.state);

  assert.equal(posted?.url, "/repos/7/opencode-team-activation");
  const body = JSON.parse(posted?.body ?? "{}");
  assert.deepEqual(body, {
    mode: "activate-saved",
    expectedProfileRevision: 2,
    expectedSelectionRevision: 0,
  });
  assert.equal(
    "candidate" in body,
    false,
    "activation of the saved revision never sends a candidate",
  );
  assert.equal("profile" in body, false);
  assert.equal(
    workflow.dataset.teamState,
    "active-managed",
    "committed activation marks the summary active",
  );
  assert.equal(
    messages.some((m) => /Team active for new jobs/.test(m.message)),
    true,
  );
});

test("a stale activation baseline conflicts without changing the summary or the audit intent", async () => {
  let posted = 0;
  const { activation, messages } = runActivation(async (url) => {
    if (url === "/repos/7/opencode-profile") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          revision: 9,
          profileRevision: 9,
          selectionRevision: 4,
          selection: { source: "default" },
          profile: { version: 1, primary: { id: "primary" }, subagents: [] },
          active: false,
        }),
      };
    }
    posted += 1;
    return {
      ok: false,
      status: 409,
      json: async () => ({
        error: "profile-conflict",
        currentProfileRevision: 9,
        currentSelectionRevision: 4,
      }),
    };
  });
  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow, disabled: false };
  const found = activation.for(button);
  assert.ok(found);
  await activation.apply(found.container, found.state);
  assert.equal(posted, 1);
  assert.equal(workflow.dataset.teamState, "inactive-team", "a conflict changes nothing");
  assert.equal(found.state.intent, "activate-saved", "operation intent is persisted");
  assertFrozenSnapshot(found.state.frozen, 2, 0);
  assert.equal(found.state.conflict, true, "the conflict gate blocks an unreviewed retry");
  await activation.apply(found.container, found.state);
  assert.equal(posted, 1, "an unreviewed conflict must not fire another request");
  assertFrozenSnapshot(found.state.frozen, 2, 0);
  await activation.reloadBaselines(found.container, found.state);
  assert.equal(found.state.conflict, false, "deliberate reload re-opens review");
  assert.equal(
    workflow.dataset.selectionRevision,
    "4",
    "the reloaded selection baseline is the authoritative stored revision",
  );
  assert.equal(
    workflow.dataset.profileRevision,
    "9",
    "the reloaded profile baseline is the authoritative stored revision",
  );
  assertFrozenSnapshot(found.state.frozen, 9, 4);
  await activation.apply(found.container, found.state);
  assert.equal(posted, 2, "after reload the operator may deliberately re-activate");
  assert.equal(
    messages.some((m) => /changed in another session/.test(m.message) && m.error),
    true,
    "the conflict names the stale baseline as a scoped refusal",
  );
});

test("activation reload fetches coherent revisions and retains the conflict when the read fails", async () => {
  const requests: string[] = [];
  let fail = true;
  const { activation, messages } = runActivation(async (url) => {
    requests.push(url);
    if (url === "/repos/7/opencode-profile") {
      if (fail) {
        return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          revision: 6,
          profileRevision: 6,
          selectionRevision: 3,
          profile: { version: 1, primary: { id: "primary" }, subagents: [] },
        }),
      };
    }
    return {
      ok: false,
      status: 409,
      json: async () => ({
        error: "profile-conflict",
        currentProfileRevision: 6,
        currentSelectionRevision: 3,
      }),
    };
  });
  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow, disabled: false };
  const found = activation.for(button);
  assert.ok(found);
  await activation.apply(found.container, found.state);
  assert.equal(found.state.conflict, true);

  await activation.reloadBaselines(found.container, found.state);
  assert.equal(
    requests.at(-1),
    "/repos/7/opencode-profile",
    "reload reads the existing coherent profile GET rather than trusting the DOM",
  );
  assert.equal(found.state.conflict, true, "a failed read must not clear the conflict");
  assert.equal(
    workflow.dataset.selectionRevision,
    "0",
    "a failed read leaves the frozen baselines untouched",
  );
  assert.equal(
    messages.some((m) => /could not be reloaded/.test(m.message) && m.error),
    true,
    "a failed reload is reported as a scoped refusal",
  );

  fail = false;
  await activation.reloadBaselines(found.container, found.state);
  assert.equal(found.state.conflict, false);
  assert.equal(workflow.dataset.selectionRevision, "3");
  assert.equal(workflow.dataset.profileRevision, "6");
});

test("activation reload names the authoritative stored primary and current source", async () => {
  const { activation, messages } = runActivation(async (url) => {
    assert.equal(url, "/repos/7/opencode-profile");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        revision: 6,
        profileRevision: 6,
        selectionRevision: 3,
        selection: { source: "native", nativeAgentId: "native-reviewer" },
        profile: { version: 1, primary: { id: "stored-primary" }, subagents: [] },
        active: false,
      }),
    };
  });
  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow, disabled: false };
  const found = activation.for(button);
  assert.ok(found);
  await activation.reloadBaselines(found.container, found.state);

  const notice = messages.find((m) => /Baselines reloaded/.test(m.message));
  assert.ok(notice, "a successful reload issues an outcome notice");
  assert.match(
    notice.message,
    /stored-primary/u,
    "the notice names the newly stored team's primary, not just the revisions",
  );
  assert.match(
    notice.message,
    /Existing OpenCode agent native-reviewer/u,
    "the notice names the current source for new jobs",
  );
  assert.doesNotMatch(
    notice.message,
    /<code>/u,
    "a plain-text outcome must not leak markup tokens",
  );
  assert.equal(found.state.conflict, false);
});

test("activation reload refuses to enable activation when the authoritative profile is absent", async () => {
  const { activation, messages } = runActivation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      revision: 0,
      profileRevision: 0,
      selectionRevision: 2,
      selection: { source: "default" },
      profile: null,
      active: false,
    }),
  }));
  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow, disabled: false };
  const found = activation.for(button);
  assert.ok(found);
  await activation.reloadBaselines(found.container, found.state);

  assert.equal(
    found.state.conflict,
    true,
    "a missing profile must not become an activatable saved team",
  );
  assert.equal(
    workflow.dataset.profileRevision,
    "2",
    "the stale profile baseline is not advanced without a readable team",
  );
  assert.equal(
    messages.some((m) => /No readable saved team/.test(m.message) && m.error),
    true,
  );
  assert.equal(
    messages.some((m) => /Baselines reloaded/.test(m.message)),
    false,
    "no success notice is issued without a readable team",
  );
});

test("client workflow re-render updates the visual state token with the team state", () => {
  const { activation } = runActivation();
  const statusNode = {
    dataset: {} as Record<string, string>,
    querySelector: () => ({ innerHTML: "" }),
  };
  const workflow: ActivationContainer = {
    dataset: {
      repoId: "7",
      teamState: "active-managed",
      source: "managed",
      selectionRevision: "2",
      profileRevision: "2",
      activationUrl: "/repos/7/opencode-team-activation",
    },
    classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
    querySelector: (selector) => {
      if (selector === ".workflow-status") return statusNode;
      if (selector === "[data-workflow-heading]") return { textContent: "" };
      if (selector === ".workflow-notice") return { textContent: "" };
      if (selector === ".workflow-actions") return { innerHTML: "" };
      return null;
    },
  };

  activation.markInactive(workflow, {
    source: "default",
    selectionRevision: 3,
    profileRevision: 2,
  });
  assert.equal(workflow.dataset.teamState, "inactive-team");
  assert.equal(
    statusNode.dataset.visualState,
    "warning",
    "an inactive saved team carries the warning token",
  );

  activation.markActive(workflow, {
    selectionRevision: 4,
    profileRevision: 2,
    primaryId: "primary",
  });
  assert.equal(workflow.dataset.teamState, "active-managed");
  assert.equal(
    statusNode.dataset.visualState,
    "success",
    "an active team carries the success token",
  );
});

test("activation success reflects an interleaved source switch instead of assuming active", async () => {
  let posted: { url: string; body: string } | undefined;
  const { activation, messages } = runActivation(async (url, options) => {
    posted = { url, body: (options as { body: string }).body };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        repoId: 7,
        operation: "activate-saved",
        changed: true,
        active: false,
        selection: { source: "default" },
        selectionRevision: 3,
        profileRevision: 2,
        primaryId: "primary",
      }),
    };
  });
  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow };
  const found = activation.for(button);
  assert.ok(found);
  await activation.apply(found.container, found.state);

  assert.match(posted?.body ?? "", /"mode":"activate-saved"/u);
  assert.equal(
    workflow.dataset.teamState,
    "inactive-team",
    "an interleaved switch away must not be marked active",
  );
  assert.equal(
    workflow.dataset.source,
    "default",
    "the authoritative returned source is reflected",
  );
  assert.equal(workflow.dataset.selectionRevision, "3");
  assert.equal(workflow.dataset.profileRevision, "2");
  assert.equal(
    messages.some((m) => /not currently selected for new jobs/.test(m.message)),
    true,
    "scoped feedback names the committed-but-switched outcome",
  );
});

test("an in-flight activation uses the frozen baselines and lands on the mounted node", async () => {
  let resolveApply: ((value: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    resolveApply = resolve;
  });
  const posted: Array<{ url: string; body: string }> = [];
  const { activation, surfaces } = runActivation(async (url, options) => {
    posted.push({ url, body: (options as { body: string }).body });
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        repoId: 7,
        operation: "activate-saved",
        changed: true,
        active: true,
        selection: { source: "managed" },
        selectionRevision: 1,
        profileRevision: 2,
        primaryId: "primary",
      }),
    };
  });
  const surface = surfaces.get("opencode-activation");
  assert.ok(surface, "the activation surface registers with the reconciler");

  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow };
  const found = activation.for(button);
  assert.ok(found);
  const applyPromise = activation.apply(found.container, found.state);

  // SSE swaps the fragment while the request is in flight: restore re-arms
  // busy, keeps the frozen baselines, and points the surface at the mounted
  // node. The response must land there, not on the detached container.
  const freshWorkflow = fakeWorkflow({
    repoId: "7",
    teamState: "inactive-team",
    selectionRevision: "5",
    profileRevision: "9",
    activationUrl: "/repos/7/opencode-team-activation",
  });
  const root = {
    querySelector: (selector: string) =>
      selector.includes('data-repo-id="7"') ? freshWorkflow : null,
  };
  surface.restore(root, surface.capture());
  const inFlight = activation.state.get(7);
  assert.equal(inFlight?.busy, true, "busy survives the swap");
  assertFrozenSnapshot(inFlight?.frozen, 2, 0);

  resolveApply?.(null);
  await applyPromise;
  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0].body) as {
    expectedProfileRevision: number;
    expectedSelectionRevision: number;
  };
  assert.equal(body.expectedProfileRevision, 2, "the request used the frozen profile baseline");
  assert.equal(body.expectedSelectionRevision, 0, "the request used the frozen selection baseline");
  assert.equal(
    freshWorkflow.dataset.teamState,
    "active-managed",
    "the commit lands on the authoritative mounted node",
  );
});

test("activation never submits or discards an in-progress profile draft", async () => {
  const { agent } = runAgentEditor(async () => {
    throw new Error("editor must not fetch");
  });
  const { activation } = runActivation(async (url) => {
    assert.equal(url, "/repos/7/opencode-team-activation");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        repoId: 7,
        changed: true,
        active: true,
        selectionRevision: 1,
        profileRevision: 2,
      }),
    };
  });
  const container = fakeContainer();
  const state = editorState(agent, { container, mode: "editing" });
  state.draft.primary.description = "Unsaved description must survive activation";
  agent.editors.set(7, state as never);

  const workflow = fakeWorkflow({
    repoId: "7",
    activationUrl: "/repos/7/opencode-team-activation",
    selectionRevision: "0",
    profileRevision: "2",
    teamState: "inactive-team",
  });
  const button = { dataset: { repoId: "7" }, closest: () => workflow };
  const found = activation.for(button);
  assert.ok(found);
  await activation.apply(found.container, found.state);

  // The activation targeted the saved revision; the open editor draft is intact.
  const draft = agent.editors.get(7) as { draft: AgentDraft } | undefined;
  assert.ok(draft, "the unsaved draft stays open");
  assert.equal(draft.draft.primary.description, "Unsaved description must survive activation");
});

test("a stale source apply keeps the draft until the operator deliberately reloads baselines", async () => {
  const posted: Array<{ url: string; body: string }> = [];
  const { selection } = runActivation(async (url, options) => {
    const body = JSON.parse((options as { body: string }).body ?? "{}") as Record<string, unknown>;
    posted.push({ url, body: (options as { body: string }).body });
    if (url === "/repos/7/opencode-agents") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          agents: [],
          selection: { source: "default" },
          revision: 3,
          profileRevision: 4,
        }),
      };
    }
    if (body.expectedRevision === 3) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          selection: { source: "managed" },
          revision: 4,
          profileRevision: 4,
        }),
      };
    }
    return {
      ok: false,
      status: 409,
      json: async () => ({ error: "conflict", currentRevision: 3 }),
    };
  });
  const dataset: Record<string, string> = {
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "4",
    discoveryUrl: "/repos/7/opencode-agents",
    updateUrl: "/repos/7/opencode-selection",
  };
  const container = { dataset, querySelector: () => null, closest: () => null };
  const state = selection.stateFrom(container) as SelectionDraftState;
  state.source = "managed";

  await selection.apply(container, state);
  assert.equal(state.conflict, true, "a stale apply conflicts without changing state");
  assert.equal(state.source, "managed", "the draft survives the conflict");
  assert.equal(
    selection.applyDisabled(state),
    true,
    "Apply stays disabled while the conflict is unreviewed",
  );
  const postsBeforeGuard = posted.length;
  await selection.apply(container, state);
  assert.equal(posted.length, postsBeforeGuard, "a guarded apply must not fire a stale submission");

  await selection.reloadBaselines(container, state);
  assert.equal(state.conflict, false, "deliberate reload clears the conflict gate");
  assert.equal(state.baseRevision, 3, "baselines advance only after an explicit reload");
  assert.equal(state.baseProfileRevision, 4);
  assert.equal(state.source, "managed", "the draft is preserved across the reload");
  assert.equal(
    selection.applyDisabled(state),
    false,
    "Apply re-enables after the deliberate reload",
  );

  await selection.apply(container, state);
  const second = posted.find(
    (entry) =>
      entry.url === "/repos/7/opencode-selection" &&
      (JSON.parse(entry.body) as { expectedRevision?: number }).expectedRevision === 3,
  );
  assert.ok(second, "reapplying after reload submits against the current baselines");
  assert.equal(state.savedSource, "managed");
});

interface SelectionDraftState extends Record<string, unknown> {
  conflict: boolean;
  source: string;
  baseRevision: number;
  baseProfileRevision: number | null;
  savedSource: string;
  savedRevision: number;
  savedProfileRevision: number | null;
}

test("a committed source switch away immediately marks the retained team inactive", async () => {
  const { activation } = runActivation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      selection: { source: "default" },
      revision: 3,
      profileRevision: 2,
    }),
  }));
  const workflow = fakeWorkflow({
    repoId: "7",
    teamState: "active-managed",
    source: "managed",
    selectionRevision: "2",
    profileRevision: "2",
  });
  const card = {
    querySelector: (selector: string) =>
      selector === "[data-opencode-workflow]" ? workflow : null,
  };
  const container = {
    dataset: { repoId: "7", updateUrl: "/repos/7/opencode-selection" },
    closest: (selector: string) => (selector.startsWith("[data-live-key") ? card : null),
    querySelector: () => null,
  };
  const state = {
    savedSource: "default",
    savedNativeId: "",
    savedRevision: 3,
    savedProfileRevision: 2,
  };
  activation.syncWorkflow(container, state);
  assert.equal(workflow.dataset.teamState, "inactive-team");
  assert.equal(workflow.dataset.source, "default");
  assert.equal(workflow.dataset.selectionRevision, "3");
});

test("roster badges follow activation and switching away immediately without SSE", () => {
  const { activation } = runActivation();
  const workflow = fakeWorkflow({ repoId: "7", profileRevision: "2", teamState: "inactive-team" });
  const agents = { dataset: { active: "0" } };
  const enabled = { dataset: { availability: "saved" }, textContent: "Enabled in saved team" };
  const disabled = { dataset: { availability: "disabled" }, textContent: "Disabled" };
  const card = {
    querySelector: (selector: string) =>
      selector === "[data-opencode-workflow]" ? workflow : agents,
    querySelectorAll: () => [enabled, disabled],
  };
  Object.assign(workflow, { closest: () => card });
  const container = { closest: () => card, querySelector: () => null, dataset: { repoId: "7" } };
  for (const source of ["managed", "default", "managed", "native"]) {
    activation.syncWorkflow(container, {
      savedSource: source,
      savedRevision: 3,
      savedProfileRevision: 2,
    });
    const active = source === "managed";
    assert.equal(agents.dataset.active, active ? "1" : "0");
    assert.equal(enabled.dataset.availability, active ? "available" : "saved");
    assert.equal(
      enabled.textContent,
      active ? "Available to orchestrator" : "Enabled in saved team",
    );
    assert.equal(disabled.dataset.availability, "disabled");
    assert.equal(disabled.textContent, "Disabled");
  }
});

test("a committed switch to managed marks the retained team active", () => {
  const { activation } = runActivation();
  const workflow = fakeWorkflow({
    repoId: "7",
    teamState: "inactive-team",
    source: "default",
    selectionRevision: "0",
    profileRevision: "2",
  });
  const card = {
    querySelector: (selector: string) =>
      selector === "[data-opencode-workflow]" ? workflow : null,
  };
  const container = {
    dataset: { repoId: "7" },
    closest: (selector: string) => (selector.startsWith("[data-live-key") ? card : null),
    querySelector: () => null,
  };
  activation.syncWorkflow(container, {
    savedSource: "managed",
    savedRevision: 4,
    savedProfileRevision: 2,
  });
  assert.equal(workflow.dataset.teamState, "active-managed");
});

test("reconciliation preserves intent, frozen baselines, conflict, and busy activation state", () => {
  const { activation, surfaces } = runActivation();
  const surface = surfaces.get("opencode-activation");
  assert.ok(surface, "the activation surface registers with the shared reconciler");

  // A busy activation with frozen baselines and an unresolved conflict survives
  // a live region swap: capture persists the intent/pair, restore re-arms the
  // flag on the matching fresh container, and other workflows stay untouched.
  activation.state.set(7, {
    busy: true,
    conflict: true,
    intent: "activate-saved",
    frozen: { expectedProfileRevision: 2, expectedSelectionRevision: 0 },
  });
  const captured = surface.capture() as Array<{
    repoId: number;
    busy: boolean;
    conflict: boolean;
    intent: string;
    frozen: { expectedProfileRevision: number; expectedSelectionRevision: number };
  }>;
  assert.equal(captured.length, 1);
  assert.equal(captured[0].repoId, 7);
  assert.equal(captured[0].busy, true);
  assert.equal(captured[0].conflict, true);
  assert.equal(captured[0].intent, "activate-saved");
  assertFrozenSnapshot(captured[0].frozen, 2, 0);

  const freshWorkflow = fakeWorkflow({
    repoId: "7",
    teamState: "inactive-team",
    selectionRevision: "0",
    profileRevision: "2",
  });
  const otherWorkflow = fakeWorkflow({
    repoId: "8",
    teamState: "inactive-team",
    selectionRevision: "0",
    profileRevision: "1",
  });
  const root = {
    querySelector: (selector: string) =>
      selector.includes('data-repo-id="7"')
        ? freshWorkflow
        : selector.includes('data-repo-id="8"')
          ? otherWorkflow
          : null,
  };
  surface.restore(root, captured);
  const restored = activation.state.get(7);
  assert.equal(restored?.busy, true, "busy survives the swap");
  assert.equal(restored?.conflict, true, "the unreviewed conflict survives the swap");
  assert.equal(restored?.intent, "activate-saved", "operation intent survives the swap");
  assertFrozenSnapshot(restored?.frozen, 2, 0);
  assert.equal(activation.state.has(8), false, "other repositories stay untouched");
});

test("editor capture/restore preserves the frozen selection baseline across a live swap", () => {
  const { agent } = runAgentEditor(async () => {
    throw new Error("no fetch expected");
  });
  const container = fakeContainer("<div>old summary</div>", 7);
  const state = editorState(agent, {
    container,
    operation: "save-and-activate",
    revision: 2,
    baseSelectionRevision: 5,
    selectionRevision: 5,
    activeSaved: false,
  });
  agent.editors.set(7, state as never);
  const captured = agent.capture();
  const fresh = fakeContainer("<div>fresh summary</div>", 7);
  agent.restore({ querySelector: () => fresh }, captured);
  const restored = agent.editors.get(7) as
    | { operation: string; revision: number; baseSelectionRevision: number; activeSaved: boolean }
    | undefined;
  assert.ok(restored);
  assert.equal(restored.operation, "save-and-activate", "operation intent survives the swap");
  assert.equal(restored.revision, 2, "profile baseline stays frozen");
  assert.equal(restored.baseSelectionRevision, 5, "selection baseline stays frozen");
  assert.equal(restored.activeSaved, false);
});

test("editor mount trusts an authoritative active=false payload over a stale active workflow DOM", async () => {
  const requests: string[] = [];
  const container = fakeContainer("", 7);
  const workflow = {
    dataset: { teamState: "active-managed", selectionRevision: "3" },
    querySelector: () => null,
  };
  const card = {
    querySelector: (selector: string) =>
      selector === "[data-opencode-workflow]" ? workflow : null,
  };
  container.closest = (selector: string) => (selector.startsWith("[data-live-key") ? card : null);
  const { agent } = runAgentEditor(
    async (url) => {
      requests.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          revision: 2,
          profileRevision: 2,
          selectionRevision: 7,
          active: false,
          profile: profileWithReviewer(),
          defaultProfile: null,
        }),
      };
    },
    { querySelector: (selector) => (selector.includes("data-opencode-agents") ? container : null) },
  );
  await agent.mount(container, 7);
  assert.deepEqual(requests, ["/repos/7/opencode-profile"]);
  const state = agent.editors.get(7) as { activeSaved: boolean } | undefined;
  assert.ok(state);
  assert.equal(
    state.activeSaved,
    false,
    "an explicit authoritative false must not be overridden by a stale active DOM",
  );

  // Only a response without the field may fall back to the rendered workflow.
  const fallbackContainer = fakeContainer("", 7);
  const fallbackWorkflow = {
    dataset: { teamState: "active-managed", selectionRevision: "3" },
    querySelector: () => null,
  };
  const fallbackCard = {
    querySelector: (selector: string) =>
      selector === "[data-opencode-workflow]" ? fallbackWorkflow : null,
  };
  fallbackContainer.closest = (selector: string) =>
    selector.startsWith("[data-live-key") ? fallbackCard : null;
  const fallbackHarness = runAgentEditor(
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        revision: 2,
        profile: profileWithReviewer(),
        defaultProfile: null,
      }),
    }),
    {
      querySelector: (selector) =>
        selector.includes("data-opencode-agents") ? fallbackContainer : null,
    },
  );
  await fallbackHarness.agent.mount(fallbackContainer, 7);
  const fallbackState = fallbackHarness.agent.editors.get(7) as
    { activeSaved: boolean } | undefined;
  assert.ok(fallbackState);
  assert.equal(
    fallbackState.activeSaved,
    true,
    "the DOM fallback still applies only when the payload field is absent",
  );
});

// ---------------------------------------------------------------------------
// 3.5 partial-root and deferred-operation regressions through the real client
// surfaces: an unrelated partial SSE region (health/job lanes) opens the editor
// surface restore with no repository cards, and the in-flight save/reload/apply
// closures must keep mutating the same mounted state instead of a detached copy.
// ---------------------------------------------------------------------------

interface RealSurfaceEnv {
  agent: AgentEditorSurface;
  selection: {
    editors: Map<number, Record<string, unknown>>;
    stateFrom: (container: unknown) => SelectionDraftState;
    capture: () => Array<Record<string, unknown>>;
    restore: (root: unknown, saved: Array<Record<string, unknown>>) => void;
  };
  activation: ActivationSurface;
  remember: (root: unknown) => { surfaces: Record<string, unknown> };
  restore: (root: unknown, state: { surfaces: Record<string, unknown> }) => void;
}

/** Runs the shipped base reconcile block plus the editor, selection and
 *  activation blocks in ONE vm context so surfaces register into the real
 *  surfaceHooks and `remember`/`restore` drive the shipped surface restores. */
function loadRealSurfaces(
  fetchImpl: (url: string, options?: unknown) => Promise<unknown> = async () => {
    throw new Error("unexpected fetch in this client test");
  },
): RealSurfaceEnv {
  const baseStart = clientScript.indexOf("  const logState = (root) => {");
  const baseEnd = clientScript.indexOf("  const redirectToSignIn");
  assert.ok(baseStart >= 0 && baseEnd > baseStart, "base reconcile block is present");
  const editorEnd = clientScript.lastIndexOf("// END_OPENCODE_AGENT_EDITOR");
  const selectionStart = clientScript.indexOf("// BEGIN_OPENCODE_SELECTION");
  const selectionEnd = clientScript.indexOf("// END_OPENCODE_SELECTION");
  const activationStart = clientScript.indexOf("// BEGIN_OPENCODE_ACTIVATION");
  const activationEnd = clientScript.indexOf("// END_OPENCODE_ACTIVATION");
  assert.ok(editorEnd > 0 && selectionStart > 0 && selectionEnd > selectionStart);
  assert.ok(activationStart > 0 && activationEnd > activationStart);
  const script =
    clientScript.slice(baseStart, baseEnd) +
    "\n" +
    clientScript.slice(clientScript.indexOf("// BEGIN_OPENCODE_AGENT_EDITOR"), editorEnd) +
    "\n" +
    clientScript.slice(selectionStart, selectionEnd) +
    "\n" +
    clientScript.slice(activationStart, activationEnd) +
    "\nwindow.gremlynConsole.__reconcile = { remember, restore, surfaceHooks };";
  const listeners: Record<string, Array<unknown>> = {
    click: [],
    input: [],
    change: [],
    focusout: [],
  };
  const document = {
    activeElement: null as unknown,
    addEventListener: (name: string, callback: unknown) => {
      if (listeners[name]) listeners[name].push(callback);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    gremlynConsole: {} as Record<string, unknown>,
    location: { assign: () => undefined },
  };
  runInNewContext(script, {
    document,
    window,
    fetch: fetchImpl,
    console,
  });
  const reconcile = window.gremlynConsole.__reconcile as
    | {
        remember: (root: unknown) => { surfaces: Record<string, unknown> };
        restore: (root: unknown, state: { surfaces: Record<string, unknown> }) => void;
        surfaceHooks: Map<
          string,
          { capture: () => unknown; restore: (root: unknown, saved: unknown) => void }
        >;
      }
    | undefined;
  assert.ok(reconcile, "remember/restore are exported for the real surface path");
  assert.ok(
    reconcile.surfaceHooks.has("opencode-editors") &&
      reconcile.surfaceHooks.has("opencode-selection") &&
      reconcile.surfaceHooks.has("opencode-activation"),
    "all three surfaces register into the shared surfaceHooks",
  );
  const agent = window.gremlynConsole.agentEditor as AgentEditorSurface;
  const selection = window.gremlynConsole.opencodeSelection as RealSurfaceEnv["selection"];
  const activation = window.gremlynConsole.opencodeActivation as ActivationSurface;
  assert.ok(agent && selection && activation, "all three surfaces register in the shared context");
  return {
    agent,
    selection,
    activation,
    remember: reconcile.remember,
    restore: reconcile.restore,
  };
}

function surfaceRoot(presentRepoIds: number[]): {
  querySelector: (selector: string) => unknown;
  querySelectorAll: () => [];
} {
  return {
    querySelectorAll: () => [],
    querySelector: (selector) => {
      const agents = selector.match(/data-repo-id="(\d+)"/);
      if (agents && presentRepoIds.includes(Number(agents[1])))
        return fakeContainer("", Number(agents[1]));
      // An authoritative repositories root lists repository cards; a partial
      // health/job-lanes region does not.
      if (selector.startsWith('[data-live-key^="repository-"]')) return { dataset: {} };
      return null;
    },
  };
}

test("an unrelated partial region never discards editor drafts through the real surface restore", () => {
  const { agent, remember, restore } = loadRealSurfaces();
  for (const repoId of [3, 7]) {
    const state = editorState(agent, { container: fakeContainer("<summary>", repoId) });
    agent.editors.set(repoId, state as never);
  }
  // A health/job-lanes fragment reconciles into a root with no repository
  // cards; the surface restore must not treat that as proof the repos vanished.
  const partialRoot = { querySelector: () => null, querySelectorAll: () => [] };
  const captured = remember(partialRoot);
  restore(partialRoot, captured);
  assert.equal(agent.editors.has(3), true, "repo 3's focused draft survives a partial region");
  assert.equal(agent.editors.has(7), true, "repo 7's draft survives a partial region");
});

test("only an authoritative repositories root removes a genuinely vanished repo's draft", () => {
  const { agent, remember, restore } = loadRealSurfaces();
  const state7 = editorState(agent, { container: fakeContainer("<summary>", 7) });
  const state3 = editorState(agent, {
    container: fakeContainer("<summary>", 3),
    operation: "save-and-activate",
  });
  agent.editors.set(7, state7 as never);
  agent.editors.set(3, state3 as never);
  const captured = remember(surfaceRoot([3, 7]));
  restore(surfaceRoot([3, 7]), captured);
  assert.equal(agent.editors.get(7), state7, "repo 7 keeps the same state object");
  assert.equal(agent.editors.get(3), state3, "repo 3 keeps the same state object");

  // The full repositories fragment now omits repo 3 entirely (removed). Only
  // repo 3's draft is released; repo 7's survives on its still-listed surface.
  const removed = remember(surfaceRoot([7]));
  restore(surfaceRoot([7]), removed);
  assert.equal(agent.editors.has(3), false, "the vanished repo's draft is released");
  assert.equal(agent.editors.get(7), state7, "the retained repo's draft is preserved");
});

test("a deferred save keeps object identity and lands its note on the mounted container", async () => {
  let resolveSave: ((value: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    resolveSave = resolve;
  });
  const { agent } = runAgentEditor(async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ ok: true, revision: 3, active: false }) };
  });
  const container = fakeContainer("<summary>", 7);
  const state = editorState(agent, { container, revision: 2 });
  agent.editors.set(7, state as never);
  const saving = agent.save(7, "save");
  assert.equal(state.busy, true, "the save is in flight");

  // An SSE fragment lands while the save is pending: restore must update the
  // SAME state object (identity preserved) and point it at the mounted node.
  const captured = agent.capture();
  const fresh = fakeContainer("<fresh summary>", 7);
  agent.restore({ querySelector: () => fresh }, captured);
  assert.equal(agent.editors.get(7), state, "state object identity survives the swap");
  assert.equal(state.container, fresh, "the pending closure sees the mounted container");

  resolveSave?.(null);
  await saving;
  assert.equal(agent.editors.has(7), false, "a landed save closes the draft");
  assert.equal(state.busy, false, "busy clears on the same object");
  assert.match(fresh.innerHTML, /Agent team saved as revision 3/u);
  assert.doesNotMatch(
    container.innerHTML,
    /Agent team saved/u,
    "the detached pre-swap node stays untouched",
  );
});

test("a deferred baseline reload keeps identity and renders onto the mounted node", async () => {
  let resolveReload: ((value: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    resolveReload = resolve;
  });
  const { agent } = runAgentEditor(async () => {
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        revision: 9,
        selection: { source: "managed" },
        selectionRevision: 8,
        selectionExplicit: true,
        active: true,
        profile: {
          version: 1,
          primary: { id: "newer-primary", permissions: ["edit"] },
          subagents: [],
        },
        defaultProfile: null,
      }),
    };
  });
  const container = fakeContainer("<summary>", 7);
  const state = editorState(agent, {
    container,
    revision: 2,
    baseSelectionRevision: 5,
    needReload: true,
  });
  state.draft.primary.description = "draft survives the deferred reload";
  agent.editors.set(7, state as never);
  const reloading = agent.reloadBaselines(7);

  const captured = agent.capture();
  const fresh = fakeContainer("<fresh summary>", 7);
  agent.restore({ querySelector: () => fresh }, captured);
  assert.equal(agent.editors.get(7), state, "reload closure keeps the same object");
  assert.equal(state.container, fresh, "reload closure targets the mounted node");

  resolveReload?.(null);
  await reloading;
  assert.equal(state.busy, false, "busy clears after the deferred reload");
  assert.equal(state.revision, 9, "CAS baselines advance from the reload response");
  assert.equal(state.baseSelectionRevision, 8);
  assert.equal(state.needReload, false, "the unresolved-conflict gate clears");
  assert.equal(
    (state.draft as AgentDraft).primary.description,
    "draft survives the deferred reload",
    "the draft is never replaced",
  );
  assert.match(fresh.innerHTML, /Baselines reloaded from the stored team/u);
  assert.match(fresh.innerHTML, /profile revision 9/u);
  assert.doesNotMatch(
    container.innerHTML,
    /reload-baselines/u,
    "the detached node is not re-rendered",
  );
});

test("a deferred source apply keeps identity, clears busy, and lands feedback on the mounted container", async () => {
  let resolveApply: ((value: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    resolveApply = resolve;
  });
  const { selection } = loadRealSurfaces(async (url, _options) => {
    assert.equal(url, "/repos/7/opencode-selection");
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        selection: { source: "managed" },
        revision: 4,
        profileRevision: 4,
      }),
    };
  });
  const dataset: Record<string, string> = {
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "3",
    discoveryUrl: "/repos/7/opencode-agents",
    updateUrl: "/repos/7/opencode-selection",
  };
  const container = { dataset, querySelector: () => null };
  const state = selection.stateFrom(container) as SelectionDraftState;
  state.source = "managed";
  state.baseProfileRevision = 3;
  selection.editors.set(7, state as never);
  const applying = selection.apply(container, state);
  assert.equal(state.busy, true, "the apply is in flight");

  const captured = selection.capture();
  const freshDataset: Record<string, string> = {
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "3",
    discoveryUrl: "/repos/7/opencode-agents",
    updateUrl: "/repos/7/opencode-selection",
  };
  const fresh = { dataset: freshDataset, querySelector: () => null };
  const saved = captured as Array<Record<string, unknown>>;
  selection.restore({ querySelector: () => fresh }, saved);
  assert.equal(selection.editors.get(7), state, "the apply closure keeps its state object");
  assert.equal(state.container, fresh, "the pending closure targets the mounted container");

  resolveApply?.(null);
  await applying;
  assert.equal(state.busy, false, "busy clears on the same object after the deferred apply");
  assert.equal(state.savedSource, "managed", "the committed source is authoritative");
  assert.equal(state.baseRevision, 4, "the apply advances the CAS base from its own response");
  assert.equal(state.feedback, "Primary source saved. New jobs will use it.");
});

test("restore never advances selection CAS bases during busy, conflict, or an unreviewed draft", () => {
  const { selection } = loadRealSurfaces();
  const seed = (overrides: Record<string, unknown>) => {
    const dataset: Record<string, string> = {
      repoId: "7",
      savedSource: "default",
      savedNativeId: "",
      selectionRevision: "0",
      profileRevision: "3",
    };
    const container = { dataset, querySelector: () => null };
    const fresh = {
      dataset: { ...dataset, selectionRevision: "9", profileRevision: "9" },
      querySelector: () => null,
    };
    const state = selection.stateFrom(container) as SelectionDraftState;
    Object.assign(state, overrides);
    selection.editors.set(7, state as never);
    selection.restore({ querySelector: () => fresh }, selection.capture() as never);
    return selection.editors.get(7) as SelectionDraftState;
  };
  // A busy apply must keep the frozen base even when the committed snapshot
  // makes the draft look clean.
  const busy = seed({ busy: true, source: "default" });
  assert.equal(busy.baseRevision, 0, "busy preserves the CAS base");
  assert.equal(busy.baseProfileRevision, 3, "busy preserves the frozen profile base");
  // An unresolved conflict must keep the drafts' baselines until a reload.
  const conflict = seed({ busy: false, conflict: true, source: "default" });
  assert.equal(conflict.baseRevision, 0, "conflict preserves the CAS base");
  assert.equal(conflict.baseProfileRevision, 3, "conflict preserves the profile base");
  // A device with a dirty draft is never rebased silently.
  const dirty = seed({ busy: false, conflict: false, source: "managed" });
  assert.equal(dirty.baseRevision, 0, "a dirty draft keeps its frozen base");
  assert.equal(dirty.baseProfileRevision, 3);
  // Only an idle, clean, reviewed state advances — the existing clean-reconcile
  // behavior is retained.
  const clean = seed({ busy: false, conflict: false, source: "default" });
  assert.equal(clean.baseRevision, 9, "a clean idle snapshot advances its CAS base");
  assert.equal(clean.baseProfileRevision, 9);
});

test("selection reload uses persisted baselines when native discovery fails or is pending", async () => {
  const responses = [
    {
      ok: false,
      status: 503,
      body: {
        ok: false,
        status: "unavailable",
        error: "discovery-unavailable",
        selection: { source: "default" },
        revision: 3,
        profileRevision: 4,
      },
    },
    {
      ok: true,
      status: 200,
      body: {
        ok: false,
        status: "pending",
        reason: "native agent discovery is still settling",
        selection: { source: "default" },
        revision: 5,
        profileRevision: 6,
      },
    },
  ];
  let index = 0;
  const { selection } = runActivation(async (url) => {
    assert.equal(url, "/repos/7/opencode-agents");
    const entry = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { ok: entry.ok, status: entry.status, json: async () => entry.body };
  });
  const dataset: Record<string, string> = {
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "1",
    discoveryUrl: "/repos/7/opencode-agents",
    updateUrl: "/repos/7/opencode-selection",
  };
  const container = { dataset, querySelector: () => null, closest: () => null };
  const state = selection.stateFrom(container) as SelectionDraftState;
  state.source = "managed";
  state.conflict = true;
  state.baseRevision = 0;
  state.baseProfileRevision = 1;

  await selection.reloadBaselines(container, state);
  assert.equal(state.conflict, false, "a discovery failure still yields the persisted baseline");
  assert.equal(state.baseRevision, 3);
  assert.equal(state.baseProfileRevision, 4);
  assert.match(
    String(state.feedback),
    /discovery did not complete/u,
    "a failed discovery is disclosed rather than reported as a refresh",
  );
  assert.doesNotMatch(String(state.feedback), /Loaded \d+ eligible/u);

  await selection.reloadBaselines(container, state);
  assert.equal(state.baseRevision, 5, "a pending discovery also carries usable baselines");
  assert.equal(state.baseProfileRevision, 6);
  assert.match(String(state.feedback), /discovery did not complete/u);
});

test("selection reload retains the conflict when no persisted baseline is returned", async () => {
  const { selection } = runActivation(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "repository-not-found" }),
  }));
  const dataset: Record<string, string> = {
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "1",
    discoveryUrl: "/repos/7/opencode-agents",
    updateUrl: "/repos/7/opencode-selection",
  };
  const container = { dataset, querySelector: () => null, closest: () => null };
  const state = selection.stateFrom(container) as SelectionDraftState;
  state.conflict = true;
  state.baseRevision = 0;
  state.baseProfileRevision = 1;

  await selection.reloadBaselines(container, state);
  assert.equal(state.conflict, true, "a payload without a baseline cannot clear the conflict");
  assert.equal(state.baseRevision, 0, "the frozen CAS base is preserved");
  assert.equal(state.baseProfileRevision, 1, "the frozen profile base is preserved");
  assert.match(String(state.feedback), /could not be reloaded/u);
});

test("a deferred selection reload marks busy and lands on the mounted node without racing apply or cancel", async () => {
  let resolveReload: ((value: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    resolveReload = resolve;
  });
  const requests: string[] = [];
  const { selection } = runActivation(async (url) => {
    requests.push(url);
    assert.equal(url, "/repos/7/opencode-agents");
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        agents: [],
        selection: { source: "default" },
        revision: 9,
        profileRevision: 8,
      }),
    };
  });
  const dataset: Record<string, string> = {
    repoId: "7",
    savedSource: "default",
    savedNativeId: "",
    selectionRevision: "0",
    profileRevision: "1",
    discoveryUrl: "/repos/7/opencode-agents",
    updateUrl: "/repos/7/opencode-selection",
  };
  const container = { dataset, querySelector: () => null, closest: () => null };
  const state = selection.stateFrom(container) as SelectionDraftState;
  state.source = "managed";
  state.conflict = true;
  state.baseRevision = 0;
  state.baseProfileRevision = 1;
  selection.editors.set(7, state as never);

  const reloading = selection.reloadBaselines(container, state);
  assert.equal(state.busy, true, "the pending read marks the entry busy");
  assert.equal(
    selection.applyDisabled(state),
    true,
    "apply is blocked while the reload is in flight",
  );

  // Concurrent apply/cancel must not fetch or discard the in-flight draft.
  await selection.apply(container, state);
  selection.cancel(container, state);
  assert.equal(requests.length, 1, "no concurrent request is issued");
  assert.equal(state.source, "managed", "a concurrent cancel cannot discard the draft");

  // SSE re-points the same entry at the mounted node mid-flight; the outcome
  // must land there rather than on the detached pre-swap container.
  const feedback = {
    textContent: "",
    classList: { toggle: () => undefined },
    setAttribute: () => undefined,
  };
  const fresh = {
    dataset,
    closest: () => null,
    querySelector: (selector: string) =>
      selector === "[data-opencode-selection-feedback]" ? feedback : null,
  };
  state.container = fresh;

  resolveReload?.(null);
  await reloading;
  assert.equal(state.busy, false, "busy clears before the success render");
  assert.equal(state.conflict, false);
  assert.equal(state.baseRevision, 9);
  assert.equal(state.baseProfileRevision, 8);
  assert.match(
    feedback.textContent,
    /Baselines reloaded/u,
    "the outcome lands on the mounted node",
  );
});

test("cancel and keep-editing are guarded and disabled while a save is in flight", async () => {
  let resolveSave: ((value: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    resolveSave = resolve;
  });
  const { agent } = runAgentEditor(async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ ok: true, revision: 3, active: false }) };
  });
  const container = fakeContainer("<summary>", 7);
  const state = editorState(agent, { container, mode: "review", revision: 2 });
  state.draft.primary.description = "in-flight draft must not be discarded";
  agent.editors.set(7, state as never);
  const review = agent.editorHtml(7, { ...state, busy: true });
  assert.match(review, /data-agent-action="back" disabled/u);
  assert.match(review, /data-agent-action="cancel" disabled/u);
  const applyHtml = agent.editorHtml(7, { ...state, mode: "editing", busy: true });
  assert.match(applyHtml, /data-agent-action="cancel" disabled/u);
  assert.match(applyHtml, /data-agent-action="apply" disabled/u);

  const saving = agent.save(7, "save");
  // The click handlers are guarded client-side too: cancel/back while busy
  // never discard the in-flight draft.
  agent.cancel(7);
  const kept = agent.editors.get(7) as { busy: boolean; draft: AgentDraft } | undefined;
  assert.ok(kept, "cancel while busy keeps the draft open");
  assert.equal(kept.busy, true, "the in-flight save stays active");
  assert.equal(kept.draft.primary.description, "in-flight draft must not be discarded");
  resolveSave?.(null);
  await saving;
});

test("a settled activation moves focus to a stable workflow action instead of the body", async () => {
  let posted: { url: string; body: string } | undefined;
  const focused: string[] = [];
  const { activation } = runActivationWithFocus(focused, async (url, options) => {
    posted = { url, body: (options as { body: string }).body };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        repoId: 7,
        operation: "activate-saved",
        changed: true,
        active: true,
        selection: { source: "managed" },
        selectionRevision: 1,
        profileRevision: 2,
        primaryId: "primary",
        subagentIds: ["reviewer"],
      }),
    };
  });
  const workflow = fakePositionedWorkflow(focused);
  const button = { dataset: { repoId: "7" }, closest: () => workflow, disabled: false };
  const found = activation.for(button);
  assert.ok(found);
  await activation.apply(found.container, found.state);
  assert.equal(workflow.dataset.teamState, "active-managed");
  assert.equal(
    focused[0],
    "configure",
    "focus lands on Edit active team / configure, not the body",
  );
  void posted;
});

test("a conflict keeps focus on the Reload baselines review action", async () => {
  const focused: string[] = [];
  const { activation } = runActivationWithFocus(focused, async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: "profile-conflict",
      currentProfileRevision: 9,
      currentSelectionRevision: 4,
    }),
  }));
  const workflow = fakePositionedWorkflow(focused, true);
  const button = { dataset: { repoId: "7" }, closest: () => workflow, disabled: false };
  const found = activation.for(button);
  assert.ok(found);
  await activation.apply(found.container, found.state);
  assert.equal(found.state.conflict, true);
  assert.equal(focused[0], "reload", "the conflict keeps focus on the explicit review action");
});
