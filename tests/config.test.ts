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
  assert.equal(repo.adoptWorktree, false);
  // No effort configured: defaults to the agent's highest tier.
  assert.equal(repo.effort, "xhigh");
  assert.equal(config.agentTimeoutSec, undefined);
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

test("loads workspace reclamation settings and rejects invalid values", () => {
  const configured = loadConfig(
    writeConfig(
      `${VALID_CONFIG}\nworkspace_reclamation:\n  enabled: true\n  minimum_age_seconds: 3600\n`,
    ),
    VALID_ENV,
  );
  assert.deepEqual(configured.workspaceReclamation, { enabled: true, minimumAgeSec: 3600 });
  for (const value of ["1.5", "-1", '"one hour"']) {
    assert.throws(
      () =>
        loadConfig(
          writeConfig(`${VALID_CONFIG}\nworkspace_reclamation:\n  minimum_age_seconds: ${value}\n`),
          VALID_ENV,
        ),
      (error: unknown) =>
        error instanceof ConfigError &&
        /workspace_reclamation\.minimum_age_seconds must be a non-negative integer/u.test(
          error.message,
        ),
    );
  }
  assert.throws(
    () =>
      loadConfig(
        writeConfig(`${VALID_CONFIG}\nworkspace_reclamation:\n  enabled: yes\n`),
        VALID_ENV,
      ),
    (error: unknown) =>
      error instanceof ConfigError &&
      /workspace_reclamation\.enabled must be a boolean/u.test(error.message),
  );
});

test("loads artifact retention settings and rejects invalid values", () => {
  const configured = loadConfig(
    writeConfig(
      `${VALID_CONFIG}\nartifact_retention:\n  enabled: true\n  maximum_age_seconds: 86400\n  maximum_total_bytes: 4096\n`,
    ),
    VALID_ENV,
  );
  assert.deepEqual(configured.artifactRetention, {
    enabled: true,
    maximumAgeSec: 86400,
    maximumTotalBytes: 4096,
  });
  for (const value of ["1.5", "-1", '"one month"']) {
    assert.throws(
      () =>
        loadConfig(
          writeConfig(`${VALID_CONFIG}\nartifact_retention:\n  maximum_age_seconds: ${value}\n`),
          VALID_ENV,
        ),
      (error: unknown) =>
        error instanceof ConfigError &&
        /artifact_retention\.maximum_age_seconds must be a non-negative integer/u.test(
          error.message,
        ),
    );
  }
  for (const value of ["1.5", "-1", '"one gigabyte"']) {
    assert.throws(
      () =>
        loadConfig(
          writeConfig(`${VALID_CONFIG}\nartifact_retention:\n  maximum_total_bytes: ${value}\n`),
          VALID_ENV,
        ),
      (error: unknown) =>
        error instanceof ConfigError &&
        /artifact_retention\.maximum_total_bytes must be a non-negative safe integer/u.test(
          error.message,
        ),
    );
  }
  assert.throws(
    () =>
      loadConfig(writeConfig(`${VALID_CONFIG}\nartifact_retention:\n  enabled: yes\n`), VALID_ENV),
    (error: unknown) =>
      error instanceof ConfigError &&
      /artifact_retention\.enabled must be a boolean/u.test(error.message),
  );
});

test("loads an optional console timezone and rejects invalid zones", () => {
  const configured = loadConfig(
    writeConfig(`${VALID_CONFIG}\nconsole:\n  timezone: Asia/Taipei\n`),
    VALID_ENV,
  );
  assert.equal(configured.consoleTimezone, "Asia/Taipei");
  assert.throws(
    () =>
      loadConfig(writeConfig(`${VALID_CONFIG}\nconsole:\n  timezone: Not/A_Timezone\n`), VALID_ENV),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.problems.some((problem) => problem.includes("console.timezone")),
  );
});

test("accepts zero agent timeout as unlimited", () => {
  const config = loadConfig(
    writeConfig(`${VALID_CONFIG}\nagent_defaults:\n  timeout_seconds: 0\n`),
    VALID_ENV,
  );
  assert.equal(config.agentTimeoutSec, undefined);
});

test("rejects a fractional or negative agent timeout", () => {
  for (const value of ["1.5", "-1"]) {
    assert.throws(
      () =>
        loadConfig(
          writeConfig(`${VALID_CONFIG}\nagent_defaults:\n  timeout_seconds: ${value}\n`),
          VALID_ENV,
        ),
      (error: unknown) =>
        error instanceof ConfigError &&
        /timeout_seconds must be a non-negative integer/u.test(error.message),
    );
  }
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

test("rejects a Cline repository with an empty provider", () => {
  const config = VALID_CONFIG.replace("provider: test-provider", 'provider: ""');
  assert.throws(
    () => loadConfig(writeConfig(config), VALID_ENV),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) =>
          p.includes('repositories[0].provider is required for agent "cline"'),
        ),
      );
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

test("accepts a model without an allowed_models restriction", () => {
  const config = VALID_CONFIG.replace("model: test-provider/model-1", "model: test-provider/other");
  assert.equal(
    loadConfig(writeConfig(config), VALID_ENV).repositories[0]?.model,
    "test-provider/other",
  );
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

test("workspace_seed_files loads as a string list and defaults to empty", () => {
  const withSeeds = loadConfig(
    writeConfig(
      VALID_CONFIG.replace(
        "    validation_commands: []",
        "    validation_commands: []\n    workspace_seed_files: [local.properties, config/.env]",
      ),
    ),
    VALID_ENV,
  );
  assert.deepEqual(withSeeds.repositories[0]?.workspaceSeedFiles, [
    "local.properties",
    "config/.env",
  ]);

  const withoutSeeds = loadConfig(writeConfig(VALID_CONFIG), VALID_ENV);
  assert.deepEqual(withoutSeeds.repositories[0]?.workspaceSeedFiles, []);
});

test("workspace_seed_files rejects a non-list value", () => {
  assert.throws(
    () =>
      loadConfig(
        writeConfig(
          VALID_CONFIG.replace(
            "    validation_commands: []",
            "    validation_commands: []\n    workspace_seed_files: local.properties",
          ),
        ),
        VALID_ENV,
      ),
    (error: unknown) =>
      error instanceof ConfigError &&
      /workspace_seed_files must be a list of strings/u.test(error.message),
  );
});

test("adopt_worktree is opt-in and must be boolean", () => {
  const enabled = loadConfig(
    writeConfig(
      VALID_CONFIG.replace(
        "    validation_commands: []",
        "    validation_commands: []\n    adopt_worktree: true",
      ),
    ),
    VALID_ENV,
  );
  assert.equal(enabled.repositories[0]?.adoptWorktree, true);
  assert.throws(
    () =>
      loadConfig(
        writeConfig(
          VALID_CONFIG.replace(
            "    validation_commands: []",
            "    validation_commands: []\n    adopt_worktree: yes",
          ),
        ),
        VALID_ENV,
      ),
    (error: unknown) =>
      error instanceof ConfigError &&
      /repositories\[0\]\.adopt_worktree must be a boolean/u.test(error.message),
  );
});
