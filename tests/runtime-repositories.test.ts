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
  const [resynced] = syncRepositories(
    store.db,
    [
      config({
        sourcePath: "/src/widgets-moved",
        provider: "configured-provider",
        model: "configured-model",
      }),
    ],
  );
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
  const [repository] = syncRepositories(
    store.db,
    [config({ agent: "cline", provider: "opencode", model: "opencode/gpt-5.4" })],
  );
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
