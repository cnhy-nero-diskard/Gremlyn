import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config/loader.js";

const VALID_ENV = {
  GREMLYN_GITHUB_TOKEN: "ghp_test_token",
  GREMLYN_CONSOLE_TOKEN: "console_test_token",
} as NodeJS.ProcessEnv;

const VALID_CONFIG = `
data_dir: .gremlyn-test
github:
  orchestrator_login: gremlyn-bot
git:
  author_name: Human Developer
  author_email: developer@example.com
allowed_authors: [someuser]
agents:
  cline:
    binary: cline
    efforts: [none, low, medium, high, xhigh]
    credential_source: C:/Users/test/.cline/data
repositories:
  - owner: someuser
    name: repo
    source_path: D:/code/repo
    workspace_root: D:/code/workspaces/repo
    agent: cline
    provider: test-provider
    model: test-provider/model-1
    allowed_models: [test-provider/model-1]
    validation_commands: []
`;

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-config-"));
  const path = join(dir, "gremlyn.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

test("loads a valid config", () => {
  const config = loadConfig(writeConfig(VALID_CONFIG), VALID_ENV);
  assert.equal(config.githubToken, "ghp_test_token");
  assert.equal(config.consoleToken, "console_test_token");
  assert.deepEqual(config.commitAuthor, {
    name: "Human Developer",
    email: "developer@example.com",
  });
  assert.equal(config.repositories.length, 1);
  const repo = config.repositories[0]!;
  assert.equal(repo.agent, "cline");
  // No effort configured: defaults to the agent's highest tier.
  assert.equal(repo.effort, "xhigh");
});

test("rejects a config with a missing GitHub token", () => {
  assert.throws(
    () => loadConfig(writeConfig(VALID_CONFIG), { GREMLYN_CONSOLE_TOKEN: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("GREMLYN_GITHUB_TOKEN")),
        "expected a problem naming the missing token env var",
      );
      return true;
    },
  );
});

test("rejects a repository naming an unknown agent", () => {
  const config = VALID_CONFIG.replace("agent: cline", "agent: nope");
  assert.throws(
    () => loadConfig(writeConfig(config), VALID_ENV),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes('unknown agent "nope"')),
        "expected a problem naming the unknown agent",
      );
      return true;
    },
  );
});

test("rejects a repository with an empty provider", () => {
  const config = VALID_CONFIG.replace("provider: test-provider", 'provider: ""');
  assert.throws(
    () => loadConfig(writeConfig(config), VALID_ENV),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.includes("repositories[0].provider is required"));
      return true;
    },
  );
});

test("rejects an effort above the agent's ceiling", () => {
  const config = VALID_CONFIG.replace(
    "efforts: [none, low, medium, high, xhigh]",
    "efforts: [none, low]",
  ).replace("model: test-provider/model-1", "model: test-provider/model-1\n    effort: xhigh");
  // xhigh is above the agent's declared ceiling.
  assert.throws(
    () => loadConfig(writeConfig(config), VALID_ENV),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes('effort "xhigh" is not supported')),
        "expected a problem naming the unsupported effort",
      );
      return true;
    },
  );
});

test("rejects the orchestrator identity inside allowed_authors", () => {
  const config = VALID_CONFIG.replace(
    "allowed_authors: [someuser]",
    "allowed_authors: [someuser, Gremlyn-Bot]",
  );
  assert.throws(() => loadConfig(writeConfig(config), VALID_ENV), ConfigError);
});

test("requires explicit git commit attribution", () => {
  const config = VALID_CONFIG.replace(
    "git:\n  author_name: Human Developer\n  author_email: developer@example.com\n",
    "",
  );
  assert.throws(
    () => loadConfig(writeConfig(config), VALID_ENV),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.includes("git.author_name is required"));
      assert.ok(err.problems.includes("git.author_email is required"));
      return true;
    },
  );
});

test("rejects a model outside allowed_models", () => {
  const config = VALID_CONFIG.replace("model: test-provider/model-1", "model: test-provider/other");
  assert.throws(() => loadConfig(writeConfig(config), VALID_ENV), ConfigError);
});

test("environment overlay overrides file values", () => {
  const config = loadConfig(writeConfig(VALID_CONFIG), {
    ...VALID_ENV,
    GREMLYN_POLL_INTERVAL_SECONDS: "5",
    GREMLYN_LOG_LEVEL: "debug",
  });
  assert.equal(config.pollIntervalSec, 5);
  assert.equal(config.logLevel, "debug");
});
