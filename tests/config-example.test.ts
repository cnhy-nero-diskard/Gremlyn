import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.js";

test("config.example.yaml parses successfully with no real credentials", () => {
  const example = join(import.meta.dirname, "..", "config.example.yaml");
  const config = loadConfig(example, {
    GREMLYN_GITHUB_TOKEN: "placeholder",
    GREMLYN_CONSOLE_TOKEN: "placeholder",
  } as NodeJS.ProcessEnv);
  assert.equal(config.orchestratorLogin, "gremlyn-bot");
  assert.deepEqual(config.commitAuthor, {
    name: "Your Name",
    email: "your-github-verified-email@example.com",
  });
  assert.equal(config.repositories.length, 2);
  assert.equal(config.repositories[0]!.effort, "xhigh");
  const opencodeRepo = config.repositories.find((r) => r.agent === "opencode")!;
  assert.ok(opencodeRepo, "expected an OpenCode repository entry");
  assert.equal(opencodeRepo.provider, "");
  assert.equal(opencodeRepo.effort, "high");
  assert.equal(config.agents.opencode?.kind, "opencode");
  assert.deepEqual(config.agents.opencode?.credentialFiles, ["auth.json"]);
  assert.equal(config.consoleTimezone, undefined);
  assert.deepEqual(config.workspaceReclamation, {
    enabled: false,
    minimumAgeSec: 604800,
  });
  assert.deepEqual(config.artifactRetention, {
    enabled: false,
    maximumAgeSec: 2592000,
    maximumTotalBytes: 1073741824,
  });
});
