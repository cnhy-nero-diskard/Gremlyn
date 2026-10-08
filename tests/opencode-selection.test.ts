/**
 * Tests for tasks 2.2/2.3: strict discriminated selection validation, the
 * revisioned compare-and-set source save, explicit managed activation, and
 * atomic active-profile clearing (`src/config/opencode-selection.ts`,
 * `src/store/opencode-selections.ts`, `src/store/opencode-profiles.ts`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import {
  NATIVE_AGENT_ID_MAX_LENGTH,
  OpenCodeSelectionValidationError,
  isValidNativeAgentId,
  openCodeSelectionDetail,
  parseOpenCodePrimarySelection,
} from "../src/config/opencode-selection.js";
import { readOpenCodeSelection, saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import {
  clearOpenCodeAgentProfile,
  readOpenCodeProfile,
  saveOpenCodeAgentProfile,
} from "../src/store/opencode-profiles.js";
import { OperatorActionStore } from "../src/store/actions.js";

const PRIVATE_INSTRUCTION = "rewrite the renderer and never reveal the vault key";

function openStore(): Store {
  return new Store({ dataDir: ".", file: ":memory:" });
}

function insertRepository(db: Store["db"], agent = "opencode", name = "web"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', ?, 'opencode/gpt-5.4', 'opencode', 'xhigh', 1)`,
      )
      .run("acme", name, agent).lastInsertRowid,
  );
}

function profileInput(description = "Primary review agent"): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description,
      instructions: PRIVATE_INSTRUCTION,
      permissions: ["edit", "shell", "web", "skill"],
    },
    subagents: [{ id: "reviewer", description: "Reviewer", enabled: true, permissions: [] }],
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

test("valid selections parse into the discriminated union", () => {
  assert.deepEqual(parseOpenCodePrimarySelection({ source: "default" }), { source: "default" });
  assert.deepEqual(parseOpenCodePrimarySelection({ source: "managed" }), { source: "managed" });
  assert.deepEqual(parseOpenCodePrimarySelection({ source: "native", agentId: "reviewer" }), {
    source: "native",
    agentId: "reviewer",
  });
  assert.deepEqual(openCodeSelectionDetail({ source: "native", agentId: "reviewer" }), {
    source: "native",
    agentId: "reviewer",
  });
  assert.deepEqual(openCodeSelectionDetail({ source: "managed" }), { source: "managed" });
});

test("malformed and conflicting selections are rejected with field issues", () => {
  const cases: Array<[unknown, string]> = [
    [null, "selection"],
    [[], "selection"],
    [{ source: "bogus" }, "source"],
    [{ source: "native" }, "agentId"],
    [{ source: "native", agentId: "   " }, "agentId"],
    [{ source: "native", agentId: "-flag" }, "agentId"],
    [{ source: "native", agentId: "has space" }, "agentId"],
    [{ source: "native", agentId: "back\\slash" }, "agentId"],
    [{ source: "native", agentId: "./segment" }, "agentId"],
    [{ source: "native", agentId: "a/../b" }, "agentId"],
    [{ source: "native", agentId: "a//b" }, "agentId"],
    [{ source: "native", agentId: "zero\u200Bwidth" }, "agentId"],
    [{ source: "native", agentId: "x".repeat(257) }, "agentId"],
    [{ source: "default", agentId: "unexpected" }, "agentId"],
    [{ source: "managed", agentId: "unexpected" }, "agentId"],
    [{ source: "native", agentId: "ok", extra: true }, "extra"],
  ];
  for (const [candidate, expectedPath] of cases) {
    assert.throws(
      () => parseOpenCodePrimarySelection(candidate),
      (error: unknown) => {
        assert.ok(error instanceof OpenCodeSelectionValidationError);
        assert.ok(
          error.issues.some((issue) => issue.path === expectedPath),
          `expected issue at ${expectedPath} for ${JSON.stringify(candidate)}, got ${error.issues
            .map((issue) => issue.path)
            .join(",")}`,
        );
        return true;
      },
    );
  }
  // The bounded validator is the shared inventory semantics: 256 is the
  // ceiling, and slash-separated generated/qualified ids are syntactically
  // valid (eligibility is a separate inventory check).
  assert.equal(isValidNativeAgentId("reviewer"), true);
  assert.equal(isValidNativeAgentId("x".repeat(256)), true);
  assert.equal(isValidNativeAgentId("x".repeat(257)), false);
  assert.equal(isValidNativeAgentId("attempt-1/primary"), true);
  assert.equal(isValidNativeAgentId(""), false);
  assert.equal(isValidNativeAgentId(42), false);
  assert.equal(NATIVE_AGENT_ID_MAX_LENGTH, 256);
});

test("a missing selection row reads as default and is not explicit", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId), {
    repoId,
    revision: 0,
    selection: { source: "default" },
    explicit: false,
  });
  assert.equal(readOpenCodeSelection(store.db, 999_999), undefined);
  store.close();
});

test("a source save is a compare-and-set that never touches other repository fields", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const before = store.db.prepare("SELECT * FROM repositories WHERE id = ?").get(repoId);

  const native = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "reviewer" },
  });
  assert.equal(native.ok, true);
  if (!native.ok) return;
  assert.equal(native.revision, 1);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });

  // Stale revision conflicts and changes nothing.
  const stale = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "default" },
  });
  assert.deepEqual(stale, { ok: false, reason: "conflict", currentRevision: 1 });
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });

  // The repository row is byte-for-byte unchanged.
  assert.deepEqual(store.db.prepare("SELECT * FROM repositories WHERE id = ?").get(repoId), before);

  // Audit names safe before/after ids only.
  const actions = new OperatorActionStore(store.db).list();
  assert.equal(actions[0]?.action, "opencode-primary-source");
  const detail = JSON.parse(actions[0]?.detail ?? "{}") as Record<string, unknown>;
  assert.deepEqual(detail, {
    before: { source: "default" },
    after: { source: "native", agentId: "reviewer" },
  });
  store.close();
});

test("invalid candidates and non-OpenCode executors are rejected without a write", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  const invalid = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "-bad" },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok === false && invalid.reason, "validation");
  assert.equal(readOpenCodeSelection(store.db, repoId)?.explicit, false);

  // A Cline repository refuses activation but the (absent) choice is preserved.
  const clineId = insertRepository(store.db, "cline", "docs");
  const refused = saveOpenCodeSelection(store.db, {
    repoId: clineId,
    expectedRevision: 0,
    candidate: { source: "default" },
  });
  assert.deepEqual(refused, { ok: false, reason: "not-opencode", currentRevision: 0 });
  assert.equal(new OperatorActionStore(store.db).list().length, 0);
  store.close();
});

test("configured executor aliases resolve by the caller-supplied kind", () => {
  const store = openStore();
  const repoId = insertRepository(store.db, "review-agent", "hybrid");
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId,
      expectedRevision: 0,
      executorKind: "cline",
      candidate: { source: "default" },
    }).ok,
    false,
  );
  const saved = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    executorKind: "opencode",
    candidate: { source: "native", agentId: "reviewer" },
  });
  assert.equal(saved.ok, true);

  // The caller-supplied resolved kind is authoritative over the stored agent id
  // (an alias maps a free label to a kind): a Cline-labelled row is accepted
  // when the caller resolves it to OpenCode, and an opencode-labelled row is
  // refused when the caller resolves it to Cline.
  const clineLabelled = insertRepository(store.db, "cline", "alias-opencode");
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId: clineLabelled,
      expectedRevision: 0,
      executorKind: "opencode",
      candidate: { source: "default" },
    }).ok,
    true,
  );
  const opencodeLabelled = insertRepository(store.db, "opencode", "alias-cline");
  assert.equal(
    saveOpenCodeSelection(store.db, {
      repoId: opencodeLabelled,
      expectedRevision: 0,
      executorKind: "cline",
      candidate: { source: "default" },
    }).ok,
    false,
  );
  store.close();
});

test("managed activation requires a saved profile and a matching profile revision", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);

  // No profile yet: managed activation is refused, selection unchanged.
  const noProfile = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "managed" },
    expectedProfileRevision: 0,
  });
  assert.deepEqual(noProfile, {
    ok: false,
    reason: "no-profile",
    currentRevision: 0,
    currentProfileRevision: 0,
  });

  const revision = saveProfile(store.db, repoId);
  assert.equal(revision, 1);

  // A missing expected profile revision is refused rather than assumed.
  const missing = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "managed" },
  });
  assert.deepEqual(missing, {
    ok: false,
    reason: "profile-revision-required",
    currentRevision: 0,
    currentProfileRevision: 1,
  });

  // A stale profile revision races and is refused.
  const stale = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "managed" },
    expectedProfileRevision: 0,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "profile-conflict");

  const activated = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "managed" },
    expectedProfileRevision: 1,
  });
  assert.equal(activated.ok, true);
  if (activated.ok) assert.equal(activated.revision, 1);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "managed" });
  store.close();
});

test("native/default switches preserve a dormant profile and dormant edits do not activate it", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, "Profile A");
  const activated = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "managed" },
    expectedProfileRevision: 1,
  });
  assert.equal(activated.ok, true);

  // Deliberately switch to native: profile retained, selection native.
  const native = saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: { source: "native", agentId: "reviewer" },
  });
  assert.equal(native.ok, true);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile?.primary.description, "Profile A");

  // Editing the now-dormant profile does not activate it.
  const edited = saveOpenCodeAgentProfile(store.db, {
    repoId,
    expectedRevision: 1,
    candidate: profileInput("Profile B"),
  });
  assert.equal(edited.ok, true);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile?.primary.description, "Profile B");
  store.close();
});

test("clearing an active profile atomically returns the source to default", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, "Profile A");
  saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "managed" },
    expectedProfileRevision: 1,
  });

  // A stale clear conflicts and changes nothing.
  const stale = clearOpenCodeAgentProfile(store.db, { repoId, expectedRevision: 0 });
  assert.deepEqual(stale, { ok: false, reason: "conflict", currentRevision: 1 });
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "managed" });

  const cleared = clearOpenCodeAgentProfile(store.db, { repoId, expectedRevision: 1 });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(cleared.revision, 2);
  assert.equal(cleared.selectionReset, true);
  assert.deepEqual(cleared.selection, { source: "default" });
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "default" });
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile, null);
  assert.equal(readOpenCodeProfile(store.db, repoId)?.revision, 2);

  // No profile remains to clear a second time.
  assert.deepEqual(clearOpenCodeAgentProfile(store.db, { repoId, expectedRevision: 2 }), {
    ok: false,
    reason: "no-profile",
    currentRevision: 2,
  });
  store.close();
});

test("clearing a dormant profile leaves the current non-managed source alone", () => {
  const store = openStore();
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId, "Profile A");
  saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "default" },
  });

  const cleared = clearOpenCodeAgentProfile(store.db, { repoId, expectedRevision: 1 });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(cleared.selectionReset, false);
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, { source: "default" });
  assert.equal(readOpenCodeSelection(store.db, repoId)?.revision, 1);
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile, null);
  store.close();
});

test("a non-OpenCode repository refuses profile clearing", () => {
  const store = openStore();
  const repoId = insertRepository(store.db, "cline", "docs");
  const result = clearOpenCodeAgentProfile(store.db, { repoId, expectedRevision: 0 });
  assert.deepEqual(result, { ok: false, reason: "not-opencode", currentRevision: 0 });
  store.close();
});

test("selection and profile state survive a process restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-selection-"));
  let store = new Store({ dataDir: dir, file: join(dir, "gremlyn.db") });
  const repoId = insertRepository(store.db);
  saveProfile(store.db, repoId);
  saveOpenCodeSelection(store.db, {
    repoId,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "reviewer" },
  });
  store.close();

  store = new Store({ dataDir: dir, file: join(dir, "gremlyn.db") });
  assert.deepEqual(readOpenCodeSelection(store.db, repoId)?.selection, {
    source: "native",
    agentId: "reviewer",
  });
  assert.equal(readOpenCodeSelection(store.db, repoId)?.revision, 1);
  assert.equal(readOpenCodeProfile(store.db, repoId)?.profile?.primary.id, "primary");
  store.close();
});
