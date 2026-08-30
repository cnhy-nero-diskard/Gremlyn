import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import { setRepositoryModelProvider } from "../src/console/mutations.js";
import type { RepoConfig } from "../src/config/loader.js";

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
  const [resynced] = syncRepositories(store.db, [config({ sourcePath: "/src/widgets-moved" })]);
  assert.ok(resynced);
  assert.equal(resynced.provider, "cline");
  assert.equal(resynced.model, "moonshotai/kimi-k3");
  assert.equal(resynced.effort, "medium");
  // Non-operator-editable fields still follow the config file.
  assert.equal(resynced.sourcePath, "/src/widgets-moved");
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
