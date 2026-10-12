/**
 * Backend tests for tasks 2.1-2.4 of `make-agent-activation-explicit`: the
 * coordinated `activate-saved` / `save-and-activate` store transaction
 * (`src/store/opencode-activation.ts`), its authenticated route and coherent
 * editor read (`src/console/server.ts`), and the preservation of save-only,
 * source-switch and new-job capture semantics.
 *
 * Covers the task verification points: success, stale profile/source, invalid
 * candidate, corrupt/missing saved team, alias/executor change, idempotent
 * activation, injected write/audit failure with no partial persistence or
 * successful audit; unauthorized/unknown/cross-repository/malformed/non-OpenCode
 * refusals with scoped conflicts and authoritative results; at most one runtime
 * notification with committed-state reconciliation on failure; and complete
 * before/after captures for jobs created across an activation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { buildConsoleServer, type ConsoleOptions } from "../src/console/server.js";
import { saveOpenCodeAgentProfile, readOpenCodeProfile } from "../src/store/opencode-profiles.js";
import { readOpenCodeSelection, saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import {
  OPENCODE_TEAM_ACTIVATION_ACTION,
  activateOpenCodeTeam,
  openCodeActivationAuditDetail,
  readOpenCodeActivationContext,
} from "../src/store/opencode-activation.js";
import { auditView } from "../src/console/views/commands.js";
import type { OperatorActionModel } from "../src/console/queries.js";
import type { AgentDefinition } from "../src/config/loader.js";

const PRIVATE_INSTRUCTION = "rewrite the widget renderer and never reveal the vault key";
const TOKEN = "console-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const AGENTS: Record<string, AgentDefinition> = {
  cline: { id: "cline", kind: "cline", binary: "cline", efforts: ["high"] },
  opencode: { id: "opencode", kind: "opencode", binary: "opencode", efforts: ["high"] },
  // An alias whose configured kind is OpenCode: activation must resolve by kind,
  // not by the literal id.
  "review-agent": {
    id: "review-agent",
    kind: "opencode",
    binary: "opencode",
    efforts: ["high"],
  },
};

function openStore(dir?: string): Store {
  return dir === undefined
    ? new Store({ dataDir: ".", file: ":memory:" })
    : new Store({ dataDir: dir, file: join(dir, "gremlyn.db") });
}

function insertRepository(db: Store["db"], agent = "opencode", name = "web"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', ?, 'source', 'workspaces', ?, 'opencode/gpt-5.4', 'opencode', 'high', 1)`,
      )
      .run(name, agent).lastInsertRowid,
  );
}

function profileInput(description = "Primary review agent"): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description,
      instructions: PRIVATE_INSTRUCTION,
      permissions: ["edit"],
    },
    subagents: [
      { id: "reviewer", description: "Reviewer", enabled: true, permissions: [] },
      { id: "researcher", description: "Researcher", enabled: false, permissions: [] },
    ],
  };
}

function saveProfile(
  db: Store["db"],
  repoId: number,
  description = "Primary review agent",
): number {
  const result = saveOpenCodeAgentProfile(db, {
    repoId,
    expectedRevision: 0,
    candidate: profileInput(description),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(`profile save failed: ${result.reason}`);
  return result.revision;
}

function actionsFor(db: Store["db"]): OperatorActionModel[] {
  return new OperatorActionStore(db).list().map((row) => ({
    id: row.id,
    at: row.at,
    action: row.action,
    target: row.target,
    effect: row.effect,
    detail: row.detail,
  }));
}

// ---------------------------------------------------------------------------
// 2.1 Store transaction
// ---------------------------------------------------------------------------

test("save-and-activate validates, writes profile and managed source together, and audits once", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  const result = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    candidate: profileInput(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.operation, "save-and-activate");
  assert.equal(result.changed, true);
  assert.deepEqual(result.selection, { source: "managed" });
  assert.equal(result.selectionRevision, 1);
  assert.equal(result.profileRevision, 1);
  assert.equal(result.primaryId, "primary");
  assert.deepEqual(result.subagentIds, ["reviewer", "researcher"]);

  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "managed" });
  assert.equal(readOpenCodeSelection(store.db, repoId)?.revision, 1);
  assert.equal(readOpenCodeProfile(store.db, repoId)?.revision, 1);

  const actions = actionsFor(store.db);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.action, OPENCODE_TEAM_ACTIVATION_ACTION);
  assert.equal(actions[0]?.target, `repository:${repoId}`);
  assert.equal(actions[0]?.effect, "v1");
  const detail = JSON.parse(actions[0]?.detail ?? "{}") as Record<string, unknown>;
  assert.deepEqual(detail, {
    mode: "save-and-activate",
    before: { source: "default" },
    after: { source: "managed" },
    selectionRevision: 1,
    profileRevision: 1,
    primaryId: "primary",
    subagentIds: ["reviewer", "researcher"],
  });
  const serialized = JSON.stringify(actions);
  assert.equal(serialized.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(serialized.includes("instructions"), false);
  assert.equal(serialized.includes("description"), false);
  store.close();
});

test("activate-saved selects the reviewed saved profile without modifying its bytes or revision", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const revision = saveProfile(store.db, repoId, "Profile A");
  const before = readOpenCodeProfile(store.db, repoId);

  const result = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: revision,
    expectedSelectionRevision: 0,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  assert.equal(result.profileRevision, revision);
  assert.equal(result.selectionRevision, 1);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "managed" });
  // Bytes and revision are untouched by an activation-only operation.
  assert.deepEqual(readOpenCodeProfile(store.db, repoId), before);
  const detail = JSON.parse(actionsFor(store.db)[0]?.detail ?? "{}") as Record<string, unknown>;
  assert.equal(detail.mode, "activate-saved");
  store.close();
});

test("stale profile and stale selection baselines conflict without writing or auditing", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);

  const staleProfile = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
  });
  assert.deepEqual(staleProfile, {
    ok: false,
    reason: "profile-conflict",
    currentSelectionRevision: 0,
    currentProfileRevision: 1,
  });

  // A concurrent source switch invalidates the reviewed selection baseline.
  saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "reviewer" },
  });
  const staleSelection = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
  });
  assert.deepEqual(staleSelection, {
    ok: false,
    reason: "conflict",
    currentSelectionRevision: 1,
    currentProfileRevision: 1,
  });

  // No activation audit was recorded for either refusal.
  assert.equal(
    actionsFor(store.db).filter((a) => a.action === OPENCODE_TEAM_ACTIVATION_ACTION).length,
    0,
  );
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });
  store.close();
});

test("an invalid candidate and a missing or corrupt saved team are refused without partial writes", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  const invalid = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    candidate: { version: 1, primary: { id: "primary" }, subagents: [] },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok === false && invalid.reason, "validation");
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile, null);
  assert.equal(readOpenCodeSelection(store.db, repoId)?.explicit, false);

  // activate-saved with no saved definition at all.
  const missing = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
  });
  assert.deepEqual(missing, {
    ok: false,
    reason: "no-profile",
    currentSelectionRevision: 0,
    currentProfileRevision: 0,
  });

  // A stored payload that no longer parses prevents activation-only.
  saveProfile(store.db, repoId);
  store.db
    .prepare("UPDATE opencode_agent_profiles SET profile_json = ? WHERE repo_id = ?")
    .run("{ not a profile", repoId);
  const corrupt = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
  });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.ok === false && corrupt.reason, "corrupt-profile");
  assert.equal(readOpenCodeSelection(store.db, repoId)?.explicit, false);
  assert.equal(
    actionsFor(store.db).filter((a) => a.action === OPENCODE_TEAM_ACTIVATION_ACTION).length,
    0,
  );
  store.close();
});

test("executor aliases resolve by kind and a changed executor refuses activation", () => {
  const store = openStore();
  // An alias id whose configured kind is OpenCode is accepted when the caller
  // supplies the resolved kind.
  const aliasRepo = insertRepository(store.db, "review-agent", "alias");
  const activated = activateOpenCodeTeam(store.db, {
    repoId: aliasRepo,
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    candidate: profileInput(),
    executorKind: "opencode",
  });
  assert.equal(activated.ok, true);

  // A repository whose resolved kind is Cline is refused even if the id looks
  // OpenCode-flavoured.
  const clineRepo = insertRepository(store.db, "opencode", "cline-label");
  const refused = activateOpenCodeTeam(store.db, {
    repoId: clineRepo,
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    candidate: profileInput(),
    executorKind: "cline",
  });
  assert.deepEqual(refused, {
    ok: false,
    reason: "not-opencode",
    currentSelectionRevision: 0,
    currentProfileRevision: 0,
  });

  // With no caller-supplied kind, the row's own agent must resolve to OpenCode.
  const changed = insertRepository(store.db, "cline", "row-changed");
  const savedForRow = saveOpenCodeAgentProfile(store.db, {
    repoId: changed,
    expectedRevision: 0,
    candidate: profileInput(),
    executorKind: "opencode",
  });
  assert.equal(savedForRow.ok, true);
  const rowKind = activateOpenCodeTeam(store.db, {
    repoId: changed,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
  });
  assert.equal(rowKind.ok, false);
  assert.equal(rowKind.ok === false && rowKind.reason, "not-opencode");
  store.close();
});

test("repeated activation of an already-active matching team is an idempotent no-op", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  const first = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.changed, true);
  const auditCount = actionsFor(store.db).length;

  const second = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 1,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.changed, false);
  assert.equal(second.selectionRevision, 1);
  assert.equal(second.profileRevision, 1);
  // No revision bump and no duplicate successful audit.
  assert.equal(readOpenCodeSelection(store.db, repoId)?.revision, 1);
  assert.equal(actionsFor(store.db).length, auditCount);

  // A stale baseline still conflicts rather than reporting the no-op.
  const stale = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "conflict");
  store.close();
});

test("an injected profile-write failure rolls back the whole save-and-activate", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  store.db.exec(
    `CREATE TRIGGER fail_profile_write BEFORE INSERT ON opencode_agent_profiles
     BEGIN SELECT RAISE(ABORT, 'profile write unavailable'); END;`,
  );
  assert.throws(() =>
    activateOpenCodeTeam(store.db, {
      repoId,
      mode: "save-and-activate",
      expectedProfileRevision: 0,
      expectedSelectionRevision: 0,
      candidate: profileInput(),
    }),
  );
  // Neither resource moved and no successful activation was audited.
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile, null);
  assert.equal(readOpenCodeSelection(store.db, repoId)?.explicit, false);
  assert.equal(actionsFor(store.db).length, 0);
  store.close();
});

test("an injected audit failure rolls back both resources and never records a success", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  store.db.exec(
    `CREATE TRIGGER fail_activation_audit BEFORE INSERT ON operator_actions
     BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`,
  );
  assert.throws(() =>
    activateOpenCodeTeam(store.db, {
      repoId,
      mode: "save-and-activate",
      expectedProfileRevision: 0,
      expectedSelectionRevision: 0,
      candidate: profileInput(),
    }),
  );
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile, null);
  assert.equal(readOpenCodeSelection(store.db, repoId)?.explicit, false);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) AS count FROM operator_actions").get() as { count: number })
      .count,
    0,
  );

  // activate-saved rolls back the selection-only write the same way.
  store.db.exec("DROP TRIGGER fail_activation_audit");
  saveProfile(store.db, repoId);
  const auditBefore = Number(
    (store.db.prepare("SELECT COUNT(*) AS count FROM operator_actions").get() as { count: number })
      .count,
  );
  store.db.exec(
    `CREATE TRIGGER fail_activation_audit BEFORE INSERT ON operator_actions
     BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`,
  );
  assert.throws(() =>
    activateOpenCodeTeam(store.db, {
      repoId,
      mode: "activate-saved",
      expectedProfileRevision: 1,
      expectedSelectionRevision: 0,
    }),
  );
  assert.equal(readOpenCodeSelection(store.db, repoId)?.explicit, false);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) AS count FROM operator_actions").get() as { count: number })
      .count,
    auditBefore,
  );
  store.close();
});

test("the activation context reports a coherent, safe revision pair and active state", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  assert.deepEqual(readOpenCodeActivationContext(store.db, repoId), {
    repoId,
    selection: { source: "default" },
    selectionRevision: 0,
    selectionExplicit: false,
    profileRevision: 0,
    hasProfile: false,
    profileCorrupt: false,
    active: false,
    primaryId: null,
    subagentIds: [],
  });
  saveProfile(store.db, repoId);
  const dormant = readOpenCodeActivationContext(store.db, repoId);
  assert.equal(dormant?.hasProfile, true);
  assert.equal(dormant?.active, false);
  assert.equal(dormant?.profileRevision, 1);
  activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
  });
  const active = readOpenCodeActivationContext(store.db, repoId);
  assert.equal(active?.active, true);
  assert.equal(active?.selectionRevision, 1);
  assert.equal(active?.profileRevision, 1);
  assert.equal(active?.primaryId, "primary");
  assert.deepEqual(active?.subagentIds, ["reviewer", "researcher"]);
  assert.equal(readOpenCodeActivationContext(store.db, 999_999), undefined);
  store.close();
});

test("the audit detail helper names only safe identifiers", () => {
  const detail = openCodeActivationAuditDetail({
    mode: "save-and-activate",
    before: { source: "native", agentId: "reviewer" },
    after: { source: "managed" },
    selectionRevision: 4,
    profileRevision: 2,
    profile: {
      version: 1,
      primary: {
        id: "primary",
        description: "Private",
        instructions: PRIVATE_INSTRUCTION,
        permissions: ["edit"],
      },
      subagents: [],
    },
  });
  assert.deepEqual(detail, {
    mode: "save-and-activate",
    before: { source: "native", agentId: "reviewer" },
    after: { source: "managed" },
    selectionRevision: 4,
    profileRevision: 2,
    primaryId: "primary",
    subagentIds: [],
  });
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(serialized.includes("description"), false);
});

// ---------------------------------------------------------------------------
// 2.1b Follow-up review corrections (design D2 revision semantics, executor
// revalidation, in-transaction validation)
// ---------------------------------------------------------------------------

test("save-and-activate on an already-managed team saves the profile without bumping the selection revision", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  const first = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    candidate: profileInput("Initially activated"),
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.selectionRevision, 1);
  assert.equal(first.profileRevision, 1);

  // The source is already managed, so a combined save must bump only the
  // profile revision; the selection counter is untouched.
  const second = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 1,
    candidate: profileInput("Updated managed team"),
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.changed, true);
  assert.equal(second.selectionRevision, 1);
  assert.equal(second.profileRevision, 2);
  assert.equal(readOpenCodeSelection(store.db, repoId)?.revision, 1);
  assert.equal(readOpenCodeProfile(store.db, repoId)?.revision, 2);
  assert.equal(
    readOpenCodeProfile(store.db, repoId)?.profile?.primary.description,
    "Updated managed team",
  );

  // Still exactly one activation action per operation, and the combined
  // no-source-change action records managed -> managed with the frozen
  // selection revision.
  const activations = actionsFor(store.db).filter(
    (action) => action.action === OPENCODE_TEAM_ACTIVATION_ACTION,
  );
  assert.equal(activations.length, 2);
  const latest = JSON.parse(activations[0]?.detail ?? "{}") as Record<string, unknown>;
  assert.deepEqual(latest.before, { source: "managed" });
  assert.deepEqual(latest.after, { source: "managed" });
  assert.equal(latest.selectionRevision, 1);
  assert.equal(latest.profileRevision, 2);

  // A stale selection baseline is still checked and conflicts even when the
  // source is already managed.
  const stale = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 2,
    expectedSelectionRevision: 0,
    candidate: profileInput("Should not apply"),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "conflict");
  assert.equal(readOpenCodeProfile(store.db, repoId)?.revision, 2);
  store.close();
});

test("a cached opencode kind cannot override a repository whose executor row changed", () => {
  const store = openStore();
  // The caller cached an OpenCode kind for the alias it observed, but the row
  // now names a Cline executor. The stale kind must not be applied.
  const changedRow = insertRepository(store.db, "cline", "changed-executor");
  const savedForChanged = saveOpenCodeAgentProfile(store.db, {
    repoId: changedRow,
    expectedRevision: 0,
    candidate: profileInput(),
    executorKind: "opencode",
  });
  assert.equal(savedForChanged.ok, true);
  const staleKind = activateOpenCodeTeam(store.db, {
    repoId: changedRow,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
    executorKind: "opencode",
    executorAgentId: "review-agent",
  });
  assert.equal(staleKind.ok, false);
  assert.equal(staleKind.ok === false && staleKind.reason, "not-opencode");
  assert.equal(readOpenCodeSelection(store.db, changedRow)?.explicit, false);
  assert.equal(
    actionsFor(store.db).filter((action) => action.action === OPENCODE_TEAM_ACTIVATION_ACTION)
      .length,
    0,
  );

  // A resolver follows the transaction's current agent id: the alias is
  // accepted while it resolves to OpenCode, then refused once the row changes.
  const aliasRepo = insertRepository(store.db, "review-agent", "alias-follow");
  const savedAlias = saveOpenCodeAgentProfile(store.db, {
    repoId: aliasRepo,
    expectedRevision: 0,
    candidate: profileInput(),
    executorKind: "opencode",
  });
  assert.equal(savedAlias.ok, true);
  const resolver = (agentId: string): string => (agentId === "review-agent" ? "opencode" : agentId);
  const accepted = activateOpenCodeTeam(store.db, {
    repoId: aliasRepo,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
    resolveExecutorKind: resolver,
  });
  assert.equal(accepted.ok, true);
  store.db.prepare("UPDATE repositories SET agent = 'cline' WHERE id = ?").run(aliasRepo);
  const refusedAfterChange = activateOpenCodeTeam(store.db, {
    repoId: aliasRepo,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 1,
    resolveExecutorKind: resolver,
  });
  assert.equal(refusedAfterChange.ok, false);
  assert.equal(refusedAfterChange.ok === false && refusedAfterChange.reason, "not-opencode");
  // Only the accepted activation was audited.
  assert.equal(
    actionsFor(store.db).filter((action) => action.action === OPENCODE_TEAM_ACTIVATION_ACTION)
      .length,
    1,
  );
  store.close();
});

test("in-transaction candidate validation reports coherent revision context", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  // A saved profile bumps the profile revision to 1 while the selection stays
  // at 0; an invalid candidate must report exactly those stored counters.
  saveProfile(store.db, repoId, "Existing profile");

  const invalid = activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
    candidate: { version: 1, primary: { id: "primary" }, subagents: [] },
  });
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.equal(invalid.reason, "validation");
  assert.equal(invalid.currentSelectionRevision, 0);
  assert.equal(invalid.currentProfileRevision, 1);
  assert.ok(invalid.issues.length > 0);
  // Nothing changed and no activation was audited.
  assert.equal(
    readOpenCodeProfile(store.db, repoId)?.profile?.primary.description,
    "Existing profile",
  );
  assert.equal(
    actionsFor(store.db).filter((action) => action.action === OPENCODE_TEAM_ACTIVATION_ACTION)
      .length,
    0,
  );
  store.close();
});

// ---------------------------------------------------------------------------
// 2.2 / 2.3 Route
// ---------------------------------------------------------------------------

interface Fixture {
  store: Store;
  options: ConsoleOptions;
  repoId: number;
  otherRepoId: number;
  clineRepoId: number;
  settings: { count: number; fail: boolean };
}

function openConsole(): Fixture {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const insert = (name: string, agent: string): number =>
    Number(
      store.db
        .prepare(
          `INSERT INTO repositories
             (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
           VALUES ('acme', ?, 'source', 'workspaces', ?, 'opencode/gpt-5.4', 'opencode', 'high', 1)`,
        )
        .run(name, agent).lastInsertRowid,
    );
  const repoId = insert("widgets", "opencode");
  const otherRepoId = insert("docs", "opencode");
  const clineRepoId = insert("cline", "cline");
  const settings = { count: 0, fail: false };
  const options: ConsoleOptions = {
    db: store.db,
    token: TOKEN,
    secrets: [],
    operatorActions: new OperatorActionStore(store.db),
    agents: AGENTS,
    actions: {
      repositorySettingsChanged: () => {
        settings.count += 1;
        if (settings.fail) throw new Error("runtime refresh unavailable");
      },
    },
  };
  return { store, options, repoId, otherRepoId, clineRepoId, settings };
}

test("the activation route requires authentication and refuses unknown or non-OpenCode repositories", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  const unauthorized = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-team-activation`,
    payload: { mode: "activate-saved", expectedProfileRevision: 0, expectedSelectionRevision: 0 },
  });
  assert.equal(unauthorized.statusCode, 401);

  const missing = await app.inject({
    method: "POST",
    url: "/repos/999999999/opencode-team-activation",
    headers: AUTH,
    payload: { mode: "activate-saved", expectedProfileRevision: 0, expectedSelectionRevision: 0 },
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "repository-not-found" });

  const cline = await app.inject({
    method: "POST",
    url: `/repos/${fixture.clineRepoId}/opencode-team-activation`,
    headers: AUTH,
    payload: { mode: "activate-saved", expectedProfileRevision: 0, expectedSelectionRevision: 0 },
  });
  assert.equal(cline.statusCode, 404);
  assert.deepEqual(cline.json(), { error: "not-opencode" });
  assert.equal(fixture.settings.count, 0);
  await app.close();
  fixture.store.close();
});

test("the activation route strictly discriminates the body and rejects malformed or extra fields", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/repos/${fixture.repoId}/opencode-team-activation`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });

  assert.equal((await post("not-an-object")).statusCode, 400);
  assert.equal(
    (await post({ mode: "bogus", expectedProfileRevision: 0, expectedSelectionRevision: 0 }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await post({
        mode: "activate-saved",
        expectedProfileRevision: -1,
        expectedSelectionRevision: 0,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await post({
        mode: "activate-saved",
        expectedProfileRevision: 0,
        expectedSelectionRevision: 0,
        extra: true,
      })
    ).statusCode,
    400,
  );
  // `candidate` is no longer the wire name; it is an unknown field now.
  assert.equal(
    (
      await post({
        mode: "save-and-activate",
        expectedProfileRevision: 0,
        expectedSelectionRevision: 0,
        candidate: profileInput(),
      })
    ).statusCode,
    400,
  );
  const profileWithActivateSaved = await post({
    mode: "activate-saved",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    profile: profileInput(),
  });
  assert.equal(profileWithActivateSaved.statusCode, 400);
  assert.equal((profileWithActivateSaved.json() as { error: string }).error, "invalid-request");
  const missingProfile = await post({
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
  });
  assert.equal(missingProfile.statusCode, 400);
  assert.equal((missingProfile.json() as { error: string }).error, "invalid-request");
  await app.close();
  fixture.store.close();
});

test("save-and-activate commits authoritatively, notifies once, and is isolated per repository", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  const response = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-team-activation`,
    headers: AUTH,
    payload: {
      mode: "save-and-activate",
      expectedProfileRevision: 0,
      expectedSelectionRevision: 0,
      profile: profileInput(),
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    changed: boolean;
    alreadyActive: boolean;
    active: boolean;
    revision: number;
    profileRevision: number;
    selectionRevision: number;
    selection: {
      source: string;
      nativeAgentId: string | null;
      revision: number;
      profileRevision: number | null;
    };
    workflow: { operation: string; primaryId: string; subagentIds: string[] };
    primaryId: string;
    subagentIds: string[];
    notification: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.alreadyActive, false);
  assert.equal(body.active, true);
  assert.equal(body.revision, 1);
  assert.equal(body.profileRevision, 1);
  assert.equal(body.selectionRevision, 1);
  assert.deepEqual(body.selection, {
    source: "managed",
    nativeAgentId: null,
    revision: 1,
    profileRevision: 1,
  });
  assert.equal(body.workflow.operation, "save-and-activate");
  assert.equal(body.workflow.primaryId, "primary");
  assert.deepEqual(body.workflow.subagentIds, ["reviewer", "researcher"]);
  assert.equal(body.notification, "delivered");
  assert.equal(fixture.settings.count, 1);
  // The response carries no private instruction text.
  assert.equal(response.body.includes(PRIVATE_INSTRUCTION), false);

  // The other repository was never touched.
  assert.equal(readOpenCodeSelection(fixture.store.db, fixture.otherRepoId)?.explicit, false);
  assert.equal(readOpenCodeProfile(fixture.store.db, fixture.otherRepoId)?.profile, null);

  // The editor read exposes the committed, coherent selection baseline.
  const editor = await app.inject({
    method: "GET",
    url: `/repos/${fixture.repoId}/opencode-profile`,
    headers: AUTH,
  });
  const editorBody = editor.json() as {
    revision: number;
    profileRevision: number;
    selection: {
      source: string;
      nativeAgentId: string | null;
      revision: number;
      profileRevision: number | null;
    };
    selectionRevision: number;
    active: boolean;
  };
  assert.equal(editorBody.revision, 1);
  assert.equal(editorBody.profileRevision, 1);
  assert.deepEqual(editorBody.selection, {
    source: "managed",
    nativeAgentId: null,
    revision: 1,
    profileRevision: 1,
  });
  assert.equal(editorBody.selectionRevision, 1);
  assert.equal(editorBody.active, true);
  await app.close();
  fixture.store.close();
});

test("the route reports scoped conflicts and refusals without notifying", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  saveProfile(fixture.store.db, fixture.repoId);
  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/repos/${fixture.repoId}/opencode-team-activation`,
      headers: AUTH,
      payload,
    });

  const profileConflict = await post({
    mode: "activate-saved",
    expectedProfileRevision: 99,
    expectedSelectionRevision: 0,
  });
  assert.equal(profileConflict.statusCode, 409);
  assert.deepEqual(profileConflict.json(), {
    error: "profile-conflict",
    currentRevision: 0,
    currentProfileRevision: 1,
  });

  const selectionConflict = await post({
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 5,
  });
  assert.equal(selectionConflict.statusCode, 409);
  assert.deepEqual(selectionConflict.json(), {
    error: "conflict",
    currentRevision: 0,
    currentProfileRevision: 1,
  });

  const invalid = await post({
    mode: "save-and-activate",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
    profile: { version: 1, primary: { id: "primary" }, subagents: [] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal((invalid.json() as { error: string }).error, "validation");

  // A different repository with no saved definition refuses activate-saved.
  const noProfile = await app.inject({
    method: "POST",
    url: `/repos/${fixture.otherRepoId}/opencode-team-activation`,
    headers: AUTH,
    payload: { mode: "activate-saved", expectedProfileRevision: 0, expectedSelectionRevision: 0 },
  });
  assert.equal(noProfile.statusCode, 409);
  assert.equal((noProfile.json() as { error: string }).error, "no-profile");

  assert.equal(fixture.settings.count, 0);
  assert.equal(
    actionsFor(fixture.store.db).filter((a) => a.action === OPENCODE_TEAM_ACTIVATION_ACTION).length,
    0,
  );
  await app.close();
  fixture.store.close();
});

test("repeated activation is an idempotent no-op that issues no notification or audit", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  saveProfile(fixture.store.db, fixture.repoId);
  const first = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-team-activation`,
    headers: AUTH,
    payload: { mode: "activate-saved", expectedProfileRevision: 1, expectedSelectionRevision: 0 },
  });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as { changed: boolean }).changed, true);
  assert.equal(fixture.settings.count, 1);

  const second = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-team-activation`,
    headers: AUTH,
    payload: { mode: "activate-saved", expectedProfileRevision: 1, expectedSelectionRevision: 1 },
  });
  assert.equal(second.statusCode, 200);
  const body = second.json() as {
    changed: boolean;
    alreadyActive: boolean;
    notification: string;
    selectionRevision: number;
    profileRevision: number;
  };
  assert.equal(body.changed, false);
  assert.equal(body.alreadyActive, true);
  assert.equal(body.notification, "skipped");
  assert.equal(body.selectionRevision, 1);
  assert.equal(body.profileRevision, 1);
  assert.equal(fixture.settings.count, 1);
  assert.equal(
    actionsFor(fixture.store.db).filter((a) => a.action === OPENCODE_TEAM_ACTIVATION_ACTION).length,
    1,
  );
  await app.close();
  fixture.store.close();
});

test("a runtime refresh failure after commit is reported without rollback or blind resubmission", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  fixture.settings.fail = true;
  const response = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-team-activation`,
    headers: AUTH,
    payload: {
      mode: "save-and-activate",
      expectedProfileRevision: 0,
      expectedSelectionRevision: 0,
      profile: profileInput(),
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    changed: boolean;
    notification: string;
    refreshError?: string;
    selectionRevision: number;
    profileRevision: number;
    active: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.notification, "failed");
  assert.equal(body.refreshError, "notification-failed");
  // The committed state is authoritative and discoverable, and the write was
  // not rolled back.
  assert.equal(body.selectionRevision, 1);
  assert.equal(body.profileRevision, 1);
  assert.equal(body.active, true);
  assert.deepEqual(readOpenCodeSelection(fixture.store.db, fixture.repoId)?.selection, {
    source: "managed",
  });
  assert.equal(
    readOpenCodeProfile(fixture.store.db, fixture.repoId)?.profile?.primary.id,
    "primary",
  );
  assert.equal(fixture.settings.count, 1);
  await app.close();
  fixture.store.close();
});

test("an injected audit failure over HTTP is a scoped safe 500 with no write or notification", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  fixture.store.db.exec(
    `CREATE TRIGGER fail_activation_audit BEFORE INSERT ON operator_actions
     BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`,
  );
  const response = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-team-activation`,
    headers: AUTH,
    payload: {
      mode: "save-and-activate",
      expectedProfileRevision: 0,
      expectedSelectionRevision: 0,
      profile: profileInput(),
    },
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: "activation-failed", repoId: fixture.repoId });
  // The database error text never leaks, the transaction rolled back, no
  // runtime notification was issued and no audit row survived.
  assert.equal(response.body.includes("audit unavailable"), false);
  assert.equal(readOpenCodeProfile(fixture.store.db, fixture.repoId)?.profile, null);
  assert.equal(readOpenCodeSelection(fixture.store.db, fixture.repoId)?.explicit, false);
  assert.equal(fixture.settings.count, 0);
  assert.equal(
    (
      fixture.store.db.prepare("SELECT COUNT(*) AS count FROM operator_actions").get() as {
        count: number;
      }
    ).count,
    0,
  );
  await app.close();
  fixture.store.close();
});

test("the new activation action renders through the existing operator audit view", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  activateOpenCodeTeam(store.db, {
    repoId,
    mode: "activate-saved",
    expectedProfileRevision: 1,
    expectedSelectionRevision: 0,
  });
  const html = auditView(actionsFor(store.db));
  assert.match(html, new RegExp(OPENCODE_TEAM_ACTIVATION_ACTION));
  assert.match(html, /activate-saved/u);
  assert.equal(html.includes(PRIVATE_INSTRUCTION), false);
  store.close();
});

// ---------------------------------------------------------------------------
// 2.4 Preservation of save-only, source switching and capture semantics
// ---------------------------------------------------------------------------

test("a save-only profile write leaves the source unchanged and a switch retains profile bytes", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  const saved = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-profile`,
    headers: AUTH,
    payload: { expectedRevision: 0, candidate: profileInput("Saved, dormant") },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as {
    ok: boolean;
    revision: number;
    active: boolean;
    selection: {
      source: string;
      nativeAgentId: string | null;
      revision: number;
      profileRevision: number | null;
    };
    selectionRevision: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.revision, 1);
  // Save-only never activates, and the payload reports the committed default
  // source plus the new profile revision authoritatively.
  assert.equal(body.active, false);
  assert.deepEqual(body.selection, {
    source: "default",
    nativeAgentId: null,
    revision: 0,
    profileRevision: 1,
  });
  assert.equal(body.selectionRevision, 0);
  assert.deepEqual(readOpenCodeSelection(fixture.store.db, fixture.repoId)?.selection, {
    source: "default",
  });
  assert.equal(readOpenCodeSelection(fixture.store.db, fixture.repoId)?.explicit, false);

  // Switching to native retains the saved profile bytes untouched.
  saveOpenCodeSelection(fixture.store.db, {
    repoId: fixture.repoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "reviewer" },
  });
  assert.equal(
    readOpenCodeProfile(fixture.store.db, fixture.repoId)?.profile?.primary.description,
    "Saved, dormant",
  );
  assert.deepEqual(readOpenCodeSelection(fixture.store.db, fixture.repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });
  await app.close();
  fixture.store.close();
});

test("a concurrent source change before save yields an authoritative inactive save-only response", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  // The operator's editor cached the default source, but another writer already
  // switched the repository to a native primary. The save-only response must
  // reflect the committed source, never the cached value.
  saveOpenCodeSelection(fixture.store.db, {
    repoId: fixture.repoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "native-reviewer" },
  });
  const saved = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-profile`,
    headers: AUTH,
    payload: { expectedRevision: 0, candidate: profileInput("Saved against native") },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as {
    active: boolean;
    selection: {
      source: string;
      nativeAgentId: string | null;
      revision: number;
      profileRevision: number | null;
    };
    selectionRevision: number;
  };
  // Authoritative outcome: the save stored the profile, the team is inactive,
  // and the response names the repository's actual native primary.
  assert.equal(body.active, false);
  assert.deepEqual(body.selection, {
    source: "native",
    nativeAgentId: "native-reviewer",
    revision: 1,
    profileRevision: 1,
  });
  assert.equal(body.selectionRevision, 1);
  // The stored state agrees and the save-only change did not touch the source.
  assert.deepEqual(readOpenCodeSelection(fixture.store.db, fixture.repoId)?.selection, {
    source: "native",
    agentId: "native-reviewer",
  });
  await app.close();
  fixture.store.close();
});

test("a save-only response reports an already-active managed team accurately", async () => {
  const fixture = openConsole();
  const app = buildConsoleServer(fixture.options);
  const savedProfile = saveOpenCodeAgentProfile(fixture.store.db, {
    repoId: fixture.repoId,
    expectedRevision: 0,
    candidate: profileInput("Active team"),
  });
  assert.equal(savedProfile.ok, true);
  if (!savedProfile.ok) return;
  assert.equal(
    saveOpenCodeSelection(fixture.store.db, {
      repoId: fixture.repoId,
      expectedRevision: 0,
      candidate: { source: "managed" },
      expectedProfileRevision: savedProfile.revision,
    }).ok,
    true,
  );
  const saved = await app.inject({
    method: "POST",
    url: `/repos/${fixture.repoId}/opencode-profile`,
    headers: AUTH,
    payload: { expectedRevision: 1, candidate: profileInput("Active team updated") },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as {
    active: boolean;
    revision: number;
    selection: {
      source: string;
      nativeAgentId: string | null;
      revision: number;
      profileRevision: number | null;
    };
  };
  // The team remains active for new jobs and the payload names that result
  // with both revision counters at the save transaction's outcome.
  assert.equal(body.active, true);
  assert.equal(body.revision, 2);
  assert.deepEqual(body.selection, {
    source: "managed",
    nativeAgentId: null,
    revision: 1,
    profileRevision: 2,
  });
  assert.deepEqual(readOpenCodeSelection(fixture.store.db, fixture.repoId)?.selection, {
    source: "managed",
  });
  await app.close();
  fixture.store.close();
});

test("a job created across activation captures either the complete before or after workflow", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const jobs = new JobStore(store.db);
  const before = jobs.createJob({
    repoId,
    prNumber: 1,
    commentId: 10,
    command: "RESOLVE",
    threadId: "10",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(before.kind, "created");
  if (before.kind !== "created") throw new Error("job not created");

  activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    candidate: profileInput(),
  });
  const after = jobs.createJob({
    repoId,
    prNumber: 2,
    commentId: 20,
    command: "RESOLVE",
    threadId: "20",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(after.kind, "created");
  if (after.kind !== "created") throw new Error("job not created");

  const row = (jobId: number) =>
    store.db
      .prepare(
        `SELECT opencode_source, opencode_selection_revision, opencode_profile_json,
                opencode_profile_revision
         FROM jobs WHERE id = ?`,
      )
      .get(jobId) as {
      opencode_source: string | null;
      opencode_selection_revision: number | null;
      opencode_profile_json: string | null;
      opencode_profile_revision: number | null;
    };
  // The pre-activation job captured default with no materialized profile.
  assert.equal(row(before.jobId).opencode_source, "default");
  assert.equal(row(before.jobId).opencode_profile_json, null);
  // The post-activation job captured the committed managed profile as one unit.
  const afterRow = row(after.jobId);
  assert.equal(afterRow.opencode_source, "managed");
  assert.equal(afterRow.opencode_selection_revision, 1);
  assert.equal(afterRow.opencode_profile_revision, 1);
  assert.notEqual(afterRow.opencode_profile_json, null);
  store.close();
});

test("queued jobs and retries retain their capture across a restart and later activation", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-activation-capture-"));
  let store = openStore(dir);
  const repoId = insertRepository(store.db);
  const created = new JobStore(store.db).createJob({
    repoId,
    prNumber: 3,
    commentId: 30,
    command: "RESOLVE",
    threadId: "30",
    authorLogin: "owner",
    observedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("job not created");
  store.close();

  store = openStore(dir);
  activateOpenCodeTeam(store.db, {
    repoId,
    mode: "save-and-activate",
    expectedProfileRevision: 0,
    expectedSelectionRevision: 0,
    candidate: profileInput(),
  });
  // The repository now selects managed, but the queued job keeps its capture.
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "managed" });
  const captured = store.db
    .prepare("SELECT opencode_source, opencode_profile_json FROM jobs WHERE id = ?")
    .get(created.jobId) as { opencode_source: string | null; opencode_profile_json: string | null };
  assert.equal(captured.opencode_source, "default");
  assert.equal(captured.opencode_profile_json, null);
  store.close();
});
