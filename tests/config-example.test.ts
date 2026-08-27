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
  assert.equal(config.repositories.length, 1);
  assert.equal(config.repositories[0]!.effort, "xhigh");
});
