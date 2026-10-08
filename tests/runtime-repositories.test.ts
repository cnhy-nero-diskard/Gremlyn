import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import {
  reportRepositoryProviderMismatches,
  syncRepositories,
} from "../src/runtime/repositories.js";
import { setRepositoryModelProvider } from "../src/console/mutations.js";
import type { RepoConfig } from "../src/config/loader.js";
import { readOpenCodeSelection, saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import { JobStore } from "../src/store/jobs.js";

function config(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    owner: "acme",
    name: "widgets",
    sourcePath: "/src/widgets",
    workspaceRoot: "/workspaces/widgets",
    agent: "fake",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    enabled: true,
    validationCommands: [],
    workspaceSeedFiles: [],
    allowedModels: [],
    ...overrides,
  };
}

test("syncRepositories keeps an operator's model/provider/effort choice across a restart", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-runtime-repos-"));
  const store = new Store({ dataDir, file: ":memory:" });

  const [initial] = syncRepositories(store.db, [config()]);
  assert.ok(initial);
  assert.equal(initial.model, "gpt-5.6-luna");

  // The operator picks a different provider/model via the console.
  const update = setRepositoryModelProvider(
    store.db,
    initial.id,
    "cline",
    "moonshotai/kimi-k3",
    "medium",
  );
  assert.equal(update.ok, true);

  // The process restarts; the config file on disk still says "luna".
  const [resynced] = syncRepositories(store.db, [
    config({
      sourcePath: "/src/widgets-moved",
      provider: "configured-provider",
      model: "configured-model",
    }),
  ]);
  assert.ok(resynced);
  assert.equal(resynced.provider, "cline");
  assert.equal(resynced.model, "moonshotai/kimi-k3");
  assert.equal(resynced.effort, "medium");
  // Non-operator-editable fields still follow the config file.
  assert.equal(resynced.sourcePath, "/src/widgets-moved");
});

test("startup mismatch reporting leaves the persisted provider and model untouched", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-runtime-provider-mismatch-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const [repository] = syncRepositories(store.db, [
    config({ agent: "cline", provider: "opencode", model: "opencode/gpt-5.4" }),
  ]);
  assert.ok(repository);
  const warnings: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const count = reportRepositoryProviderMismatches(
    [repository],
    {
      cline: {
        id: "cline",
        kind: "cline",
        binary: "cline",
        efforts: ["high"],
        credentialSource: "/tmp/cline",
        credentialFiles: [],
      },
    },
    { warn: (event, fields) => warnings.push({ event, fields }) },
  );
  assert.equal(count, 1);
  assert.equal(warnings[0]?.event, "repository provider mismatch");
  assert.equal(warnings[0]?.fields.provider, "opencode");
  assert.equal(repository.provider, "opencode");
  assert.equal(repository.model, "opencode/gpt-5.4");
});

test("syncRepositories seeds provider/model/effort from config for a brand-new repository", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-runtime-repos-"));
  const store = new Store({ dataDir, file: ":memory:" });

  const [repository] = syncRepositories(store.db, [config()]);
  assert.ok(repository);
  assert.equal(repository.provider, "openai-codex");
  assert.equal(repository.model, "gpt-5.6-luna");
  assert.equal(repository.effort, "xhigh");
});

test("repository synchronization seeds default and retains native intent across executor switches", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const [repository] = syncRepositories(store.db, [config({ agent: "opencode" })]);
    assert.ok(repository);
    assert.deepEqual(readOpenCodeSelection(store.db, repository.id), {
      repoId: repository.id,
      revision: 0,
      selection: { source: "default" },
      explicit: true,
    });
    assert.equal(
      saveOpenCodeSelection(store.db, {
        repoId: repository.id,
        expectedRevision: 0,
        candidate: { source: "native", agentId: "reviewer" },
      }).ok,
      true,
    );
    syncRepositories(store.db, [config({ agent: "cline" })]);
    syncRepositories(store.db, [config({ agent: "opencode" })]);
    assert.deepEqual(readOpenCodeSelection(store.db, repository.id)?.selection, {
      source: "native",
      agentId: "reviewer",
    });
    assert.equal(readOpenCodeSelection(store.db, repository.id)?.revision, 1);
  } finally {
    store.close();
  }
});

test("saving a profile after registration remains dormant across synchronization and job capture", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const [repository] = syncRepositories(store.db, [config({ agent: "opencode" })]);
    assert.ok(repository);
    const saved = saveOpenCodeAgentProfile(store.db, {
      repoId: repository.id,
      expectedRevision: 0,
      candidate: {
        version: 1,
        primary: { id: "reviewer", description: "Reviewer", permissions: [] },
        subagents: [],
      },
    });
    assert.equal(saved.ok, true);
    syncRepositories(store.db, [config({ agent: "opencode" })]);
    assert.deepEqual(readOpenCodeSelection(store.db, repository.id)?.selection, {
      source: "default",
    });
    const created = new JobStore(store.db).createJob({
      repoId: repository.id,
      prNumber: 1,
      commentId: 1,
      command: "RESOLVE",
      threadId: "1",
      authorLogin: "owner",
      observedAt: "2026-09-01T00:00:00Z",
    });
    assert.equal(created.kind, "created");
    if (created.kind !== "created") throw new Error("fixture capture failed");
    const capture = store.db
      .prepare("SELECT opencode_source, opencode_profile_json FROM jobs WHERE id = ?")
      .get(created.jobId);
    assert.deepEqual(capture, { opencode_source: "default", opencode_profile_json: null });
  } finally {
    store.close();
  }
});
