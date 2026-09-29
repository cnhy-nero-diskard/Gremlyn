/**
 * Tests for task 4.1: OpenCode-only repository projections and the readable
 * dashboard summary of primary, callable children, model inheritance/overrides,
 * and permission presets (`src/console/queries.ts`, `src/console/views/dashboard.ts`,
 * design D5, capability `opencode-agent-profiles`).
 *
 * Covers the task's verification points: the dashboard projection carries the
 * primary and each subagent with its callable state, model resolution data, and
 * tool preset while never projecting private instruction text; a Cline
 * repository renders no OpenCode controls even when a dormant profile is
 * stored; and an unconfigured OpenCode repository states its current default
 * behavior beside the direct `#repo-agents-<id>` Configure link.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { readDashboard, type OpenCodeProfileSummary } from "../src/console/queries.js";
import { repositoryCards } from "../src/console/views/dashboard.js";
import { bundledProviderCatalog } from "../src/agent/provider-catalog.js";
import type { AgentDefinition } from "../src/config/loader.js";
import type { RepositorySummary } from "../src/console/queries.js";

/** The instruction text that must never reach the dashboard projection or HTML. */
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

function openStore(): Store {
  return new Store({ dataDir: ".", file: ":memory:" });
}

function insertOpenCodeRepository(store: Store): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', 'opencode', 'opencode/claude-sonnet-5', '', 'high', 1)`,
      )
      .run("acme", "opencode-widgets").lastInsertRowid,
  );
}

function insertClineRepository(store: Store): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', 'cline', 'gpt-5.4', 'provider', 'high', 1)`,
      )
      .run("acme", "docs").lastInsertRowid,
  );
}

function profileInput(): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description: "Primary review agent",
      instructions: PRIVATE_INSTRUCTION,
      permissions: ["edit", "shell", "web", "skill"],
    },
    subagents: [
      {
        id: "reviewer",
        description: "Spec checker",
        instructions: PRIVATE_INSTRUCTION,
        enabled: true,
        model: "opencode/gpt-5.4",
        stepLimit: 120,
        permissions: ["edit", "shell"],
      },
      // No model override: the child inherits the repository's selected model.
      {
        id: "researcher",
        description: "Web research",
        enabled: false,
        permissions: [],
      },
    ],
  };
}

function repoSummary(
  repoId: number,
  overrides: Partial<RepositorySummary> = {},
): RepositorySummary {
  return {
    id: repoId,
    owner: "acme",
    name: "opencode-widgets",
    enabled: 1,
    agent: "opencode",
    model: "opencode/claude-sonnet-5",
    provider: "",
    effort: "high",
    ...overrides,
  };
}

function configuredSummary(revision = 2): OpenCodeProfileSummary {
  return {
    revision,
    primaryId: "primary",
    primaryDescription: "Primary review agent",
    primaryPermissions: ["edit", "shell", "web", "skill"],
    primaryStepLimit: null,
    subagents: [
      {
        id: "reviewer",
        enabled: true,
        description: "Spec checker",
        model: "opencode/gpt-5.4",
        permissions: ["edit", "shell"],
        stepLimit: 120,
      },
      {
        id: "researcher",
        enabled: false,
        description: "Web research",
        model: null,
        permissions: [],
        stepLimit: null,
      },
    ],
  };
}

test("the dashboard projection carries the primary, children, models, and permission presets without instruction text", () => {
  const store = openStore();
  const repoId = insertOpenCodeRepository(store);
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: profileInput(),
  });
  assert.equal(saved.ok, true);

  const model = readDashboard(store.db, []);
  const repo = model.repositories.find((entry) => entry.id === repoId);
  assert.ok(repo);
  const summary = repo.opencodeProfile;
  assert.equal(summary?.revision, 1);
  assert.equal(summary?.primaryId, "primary");
  assert.equal(summary?.primaryDescription, "Primary review agent");
  assert.deepEqual(summary?.primaryPermissions, ["edit", "shell", "web", "skill"]);
  assert.equal(summary?.primaryStepLimit, null);
  assert.equal(summary?.subagents.length, 2);

  const reviewer = summary?.subagents[0];
  assert.equal(reviewer?.id, "reviewer");
  assert.equal(reviewer?.enabled, true);
  assert.equal(reviewer?.description, "Spec checker");
  assert.equal(reviewer?.model, "opencode/gpt-5.4");
  assert.deepEqual(reviewer?.permissions, ["edit", "shell"]);
  assert.equal(reviewer?.stepLimit, 120);

  // The child without an override projects null so the view can say it inherits.
  const researcher = summary?.subagents[1];
  assert.equal(researcher?.id, "researcher");
  assert.equal(researcher?.enabled, false);
  assert.equal(researcher?.model, null);
  assert.deepEqual(researcher?.permissions, []);

  // Instructions are never projected into the ordinary dashboard surface.
  const serialized = JSON.stringify(model.repositories);
  assert.equal(JSON.stringify(summary).includes(PRIVATE_INSTRUCTION), false);
  assert.equal(JSON.stringify(summary).includes("instructions"), false);
  assert.equal(serialized.includes(PRIVATE_INSTRUCTION), false);
  store.close();
});

test("repositories without a saved profile project no OpenCode team summary", () => {
  const store = openStore();
  const opencodeRepoId = insertOpenCodeRepository(store);
  const clineRepoId = insertClineRepository(store);

  const model = readDashboard(store.db, []);
  const opencodeRepo = model.repositories.find((entry) => entry.id === opencodeRepoId);
  const clineRepo = model.repositories.find((entry) => entry.id === clineRepoId);
  assert.equal(opencodeRepo?.opencodeProfile, null);
  assert.equal(clineRepo?.opencodeProfile, null);
  assert.equal(JSON.stringify(model.repositories).includes("opencodeProfile"), true);
  store.close();
});

test("an OpenCode repository renders the readable agent team and its direct Configure link", () => {
  const html = repositoryCards(
    [repoSummary(7, { opencodeProfile: configuredSummary() })],
    bundledProviderCatalog(),
    AGENTS,
  );

  assert.match(html, /OpenCode agents/u);
  assert.match(html, /href="#repo-agents-7"/u);
  assert.match(html, /data-repo-agents-configure/u);
  assert.match(html, /Configure agents/u);
  assert.match(html, /primary <code>primary<\/code>/u);
  assert.match(html, /tools: edit workspace, run shell, browse web, load skills/u);
  assert.match(html, /<code>reviewer<\/code>/u);
  assert.match(html, /callable/u);
  assert.match(html, /model: opencode\/gpt-5\.4/u);
  assert.match(html, /tools: edit workspace, run shell/u);
  assert.match(html, /step limit 120/u);
  assert.match(html, /<code>researcher<\/code>/u);
  assert.match(html, /disabled/u);
  assert.match(html, /model: inherits opencode\/claude-sonnet-5/u);
  assert.match(html, /tools: read-only/u);
  assert.match(html, /revision 2/u);
  assert.match(html, /External-directory access and nested delegation are always denied/u);
  // The purpose text is shown; the private instructions are not.
  assert.match(html, /Spec checker/u);
  assert.equal(html.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(html.includes("instructions"), false);
});

test("an unconfigured OpenCode repository states its current default behavior", () => {
  const html = repositoryCards(
    [repoSummary(7, { opencodeProfile: null })],
    bundledProviderCatalog(),
    AGENTS,
  );

  assert.match(html, /OpenCode agents/u);
  assert.match(html, /href="#repo-agents-7"/u);
  assert.match(html, /default behavior/u);
  assert.match(html, /No dashboard-managed agent team/u);
  assert.match(html, /data-has-profile="0"/u);
  assert.equal(html.includes("instructions"), false);
});

test("a Cline repository renders no OpenCode controls, even with a dormant stored profile", () => {
  // A profile saved before an executor change may remain dormant; the console
  // must not surface OpenCode controls for a repository using another executor.
  const html = repositoryCards(
    [
      repoSummary(3, {
        name: "docs",
        agent: "cline",
        model: "gpt-5.4",
        provider: "provider",
        opencodeProfile: configuredSummary(),
      }),
    ],
    bundledProviderCatalog(),
    AGENTS,
  );

  assert.doesNotMatch(html, /OpenCode agents/u);
  assert.doesNotMatch(html, /Configure agents/u);
  assert.doesNotMatch(html, /repo-agents-/u);
  assert.doesNotMatch(html, /data-opencode-agents/u);
  assert.doesNotMatch(html, /callable/u);
  assert.doesNotMatch(html, /inherits/u);
});

test("the OpenCode controls follow the configured executor kind, not the agent alias", () => {
  const catalog = bundledProviderCatalog();
  // An alias whose kind is Cline must not offer OpenCode controls...
  const clineAlias = repositoryCards(
    [
      repoSummary(4, {
        agent: "code-review-agent",
        model: "gpt-5.4",
        provider: "provider",
        opencodeProfile: configuredSummary(),
      }),
    ],
    catalog,
    AGENTS,
  );
  assert.doesNotMatch(clineAlias, /OpenCode agents/u);
  assert.doesNotMatch(clineAlias, /repo-agents-/u);

  // ...while an alias whose kind is OpenCode still renders the section, even
  // though its repository row is named as the free-form agent label.
  const opencodeAlias = repositoryCards(
    [repoSummary(5, { agent: "review-agent", opencodeProfile: configuredSummary() })],
    catalog,
    AGENTS,
  );
  assert.match(opencodeAlias, /OpenCode agents/u);
  assert.match(opencodeAlias, /href="#repo-agents-5"/u);
  assert.match(opencodeAlias, /data-opencode-agents/u);
});
