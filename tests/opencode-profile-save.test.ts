/**
 * Tests for task 2.3: the durable OpenCode profile read and atomic revision
 * compare-and-set save (`src/store/opencode-profiles.ts`, design D1/D2,
 * capability `opencode-agent-profiles`).
 *
 * Covers the task's verification points: stale writes conflict without
 * touching the stored profile or audit, non-OpenCode repositories reject
 * updates, an invalid candidate is rejected with field issues while the prior
 * profile stays active, a successful save records exactly one scoped operator
 * action whose detail carries ids/revision and never the instruction text, and
 * the stored profile survives a process restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import {
  OPENCODE_EXECUTOR_ID,
  openCodeProfileAuditDetail,
  readOpenCodeProfile,
  readOpenCodeProfileSummary,
  saveOpenCodeAgentProfile,
} from "../src/store/opencode-profiles.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { parseOpenCodeAgentProfile } from "../src/config/opencode-profile.js";

/** The instruction text that must never reach the audit or ordinary projections. */
const PRIVATE_INSTRUCTION = "replace the widget renderer and never mention the vault key";

function openStore(dir?: string): Store {
  return dir === undefined
    ? new Store({ dataDir: ".", file: ":memory:" })
    : new Store({ dataDir: dir, file: join(dir, "gremlyn.db") });
}

function insertRepository(
  db: Store["db"],
  overrides: { owner?: string; name?: string; agent?: string } = {},
): number {
  const owner = overrides.owner ?? "acme";
  const name = overrides.name ?? "web";
  const agent = overrides.agent ?? "opencode";
  return Number(
    db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', ?, 'opencode/gpt-5.4', 'opencode', 'xhigh', 1)`,
      )
      .run(owner, name, agent).lastInsertRowid,
  );
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
    subagents: [subagentInput("reviewer"), subagentInput("researcher", { enabled: false })],
    ...overrides,
  };
}

test("a compare-and-set save persists the profile, bumps the revision, and records one scoped audit action", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  const result = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: validProfileInput(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.revision, 1);
  assert.equal(result.profile.primary.id, "primary");
  assert.equal(result.profile.subagents.length, 2);

  // The durable read returns exactly what was saved, one revision on.
  const record = readOpenCodeProfile(store.db, repoId);
  assert.deepEqual(record, {
    repoId,
    revision: 1,
    profile: result.profile,
  });

  // Exactly one success action, scoped to the repository, with the new
  // revision labelled as the effect.
  const actions = new OperatorActionStore(store.db).list();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.action, "opencode-agent-profile");
  assert.equal(actions[0]?.target, `repository:${repoId}`);
  assert.equal(actions[0]?.effect, "v1");

  // Audit detail names ids and revision only: no instruction text, no
  // descriptions, no permissions, no models.
  const detail = JSON.parse(actions[0]?.detail ?? "{}") as Record<string, unknown>;
  assert.deepEqual(detail, {
    revision: 1,
    primaryId: "primary",
    subagentIds: ["reviewer", "researcher"],
  });
  const serializedAudit = JSON.stringify(actions);
  assert.equal(serializedAudit.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(serializedAudit.includes("instructions"), false);
  assert.equal(serializedAudit.includes("Permissions to"), false);

  store.close();
});

test("a stale expected revision conflicts without changing the profile or the audit", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  const first = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: validProfileInput(),
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.revision, 1);

  // A second writer edits from the stale baseline: rejected, no overwrite.
  const stale = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: validProfileInput({ primary: { ...primaryInput(), description: "Newer primary" } }),
  });
  assert.deepEqual(stale, { ok: false, reason: "conflict", currentRevision: 1 });

  const record = readOpenCodeProfile(store.db, repoId);
  assert.equal(record?.revision, 1);
  assert.equal(record?.profile?.primary.description, "Primary review agent");

  // No audit row accompanies a conflicted write.
  assert.equal(new OperatorActionStore(store.db).list().length, 1);

  // A save against the current baseline applies, revision 2.
  const fresh = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: validProfileInput({ primary: { ...primaryInput(), description: "Newer primary" } }),
  });
  assert.equal(fresh.ok, true);
  if (fresh.ok) {
    assert.equal(fresh.revision, 2);
    assert.equal(fresh.profile.primary.description, "Newer primary");
  }
  const actions = new OperatorActionStore(store.db).list();
  assert.equal(actions.length, 2);
  assert.deepEqual(JSON.parse(actions[0]?.detail ?? "{}"), {
    revision: 2,
    primaryId: "primary",
    subagentIds: ["reviewer", "researcher"],
  });

  store.close();
});

test("a non-OpenCode repository rejects the save with no profile and no audit row", () => {
  const store = openStore();
  const repoId = insertRepository(store.db, { name: "docs", agent: "cline" });

  const result = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: validProfileInput(),
  });
  assert.deepEqual(result, { ok: false, reason: "not-opencode", currentRevision: 0 });

  // No profile row was stored and the audit stayed quiet.
  const record = readOpenCodeProfile(store.db, repoId);
  assert.deepEqual(record, { repoId, revision: 0, profile: null });
  assert.equal(new OperatorActionStore(store.db).list().length, 0);

  store.close();
});

test("the OpenCode gate follows the configured executor kind, not just the agent id", () => {
  const store = openStore();
  // The agent id is a free operator label; its kind chooses the registered
  // executor. A kind that resolves to Cline refuses the save even though the
  // id is opencode-flavoured, and resolving the same repository to OpenCode
  // accepts it.
  const repoId = insertRepository(store.db, { name: "hybrid", agent: "code-review-agent" });

  const clineKind = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: validProfileInput(),
    executorKind: "cline",
  });
  assert.equal(clineKind.ok, false);
  assert.equal(clineKind.ok === false && clineKind.reason, "not-opencode");
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile, null);

  const opencodeKind = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: validProfileInput(),
    executorKind: OPENCODE_EXECUTOR_ID,
  });
  assert.equal(opencodeKind.ok, true);
  assert.equal(opencodeKind.ok && opencodeKind.revision, 1);
  assert.equal(new OperatorActionStore(store.db).list().length, 1);

  store.close();
});

test("an invalid candidate is rejected with field issues and the prior profile stays active", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const first = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: validProfileInput(),
  });
  assert.equal(first.ok, true);

  // Duplicate case-insensitive subagent ids and a non-positive step limit are
  // both rejected in one atomic pass.
  const invalid = validProfileInput({
    subagents: [
      subagentInput("reviewer", { stepLimit: 0 }),
      subagentInput("REVIEWER"),
      subagentInput("reviewer"),
    ],
  });
  const result = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: invalid,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "validation");
  assert.equal(result.currentRevision, 1);
  const paths = result.issues.map((issue) => issue.path);
  assert.ok(paths.includes("subagents[0].stepLimit"), `expected step-limit issue, got ${paths}`);
  assert.ok(paths.includes("subagents[2].id"), `expected duplicate-id issue, got ${paths}`);

  // The previously saved profile is byte-for-byte unchanged, revision intact.
  const record = readOpenCodeProfile(store.db, repoId);
  assert.equal(record?.revision, 1);
  assert.equal(record?.profile?.primary.description, "Primary review agent");
  assert.deepEqual(
    record?.profile?.subagents.map((agent) => agent.id),
    ["reviewer", "researcher"],
  );

  // A rejected save adds no audit row.
  assert.equal(new OperatorActionStore(store.db).list().length, 1);

  store.close();
});

test("a repository with no saved profile reads as revision zero with no synthesized profile", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  const record = readOpenCodeProfile(store.db, repoId);
  assert.deepEqual(record, { repoId, revision: 0, profile: null });
  const summary = readOpenCodeProfileSummary(store.db, repoId);
  assert.deepEqual(summary, {
    repoId,
    revision: 0,
    hasProfile: false,
    primaryId: null,
    subagentIds: [],
    subagentCount: 0,
  });

  store.close();
});

test("an invalid stored profile fails closed rather than launching the default agent", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  store.db
    .prepare(
      "INSERT INTO opencode_agent_profiles (repo_id, revision, profile_json) VALUES (?, 1, ?)",
    )
    .run(repoId, '{"version":99}');
  assert.throws(() => readOpenCodeProfile(store.db, repoId));
  assert.throws(() => readOpenCodeProfileSummary(store.db, repoId));
  store.close();
});

test("the privacy-safe summary identifies agents and revision without instruction text", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  assert.equal(
    saveOpenCodeAgentProfile(store.db, {
      repoId,
      expectedRevision: 0,
      candidate: validProfileInput(),
    }).ok,
    true,
  );

  const summary = readOpenCodeProfileSummary(store.db, repoId);
  assert.deepEqual(summary, {
    repoId,
    revision: 1,
    hasProfile: true,
    primaryId: "primary",
    subagentIds: ["reviewer", "researcher"],
    subagentCount: 2,
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(serialized.includes("instructions"), false);
  assert.equal(serialized.includes("Primary review agent"), false);

  store.close();
});

test("unknown repositories are reported as not-found and never written", () => {
  const store = openStore();
  const missingId = 999_999_999;

  const save = saveOpenCodeAgentProfile(store.db, {
    repoId: missingId,
    expectedRevision: 0,
    candidate: validProfileInput(),
  });
  assert.deepEqual(save, { ok: false, reason: "not-found" });
  assert.equal(readOpenCodeProfile(store.db, missingId), undefined);
  assert.equal(new OperatorActionStore(store.db).list().length, 0);

  store.close();
});

test("the saved profile is durable across a process restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-profile-save-"));
  let store = openStore(dir);
  const repoId = insertRepository(store.db, { agent: "opencode" });
  assert.equal(
    saveOpenCodeAgentProfile(store.db, {
      repoId,
      expectedRevision: 0,
      candidate: validProfileInput(),
    }).ok,
    true,
  );
  store.close();

  // Reopen the same data directory: the profile and revision survive.
  store = openStore(dir);
  const record = readOpenCodeProfile(store.db, repoId);
  assert.equal(record?.revision, 1);
  assert.equal(record?.profile?.primary.id, "primary");
  assert.equal(record?.profile?.subagents.length, 2);
  assert.deepEqual(
    new OperatorActionStore(store.db).list().map((action) => action.action),
    ["opencode-agent-profile"],
  );
  store.close();
});

test("the audit detail helper names ids and revision only", () => {
  const profile = parseValidProfile();
  const detail = openCodeProfileAuditDetail(profile, 3);
  assert.deepEqual(detail, {
    revision: 3,
    primaryId: "primary",
    subagentIds: ["reviewer", "researcher"],
  });
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes(PRIVATE_INSTRUCTION), false);
  assert.equal(serialized.includes("description"), false);
  assert.equal(serialized.includes("permissions"), false);
});

function parseValidProfile() {
  return parseOpenCodeAgentProfile(validProfileInput());
}
