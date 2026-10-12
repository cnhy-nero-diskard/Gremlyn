import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import Database from "better-sqlite3";
import { ConfigError } from "../src/config/loader.js";
import { DataDirectoryLock, dataDirectoryLockPath } from "../src/orchestrator/instance-lock.js";
import { formatStartupDiagnostic, type StartupStage } from "../src/terminal/diagnostics.js";

const FIXTURE_SECRET = "fixture-only-startup-token";

function fixture(): { root: string; dataDir: string; config: string; credentials: string } {
  const temp = join(tmpdir(), "opencode");
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "gremlyn-terminal-startup-"));
  const dataDir = join(root, "data");
  const credentials = join(root, "credentials");
  mkdirSync(credentials);
  const config = join(root, "config.yaml");
  writeFileSync(
    config,
    stringify({
      data_dir: dataDir,
      github: { orchestrator_login: "fixture-bot" },
      git: { author_name: "Fixture", author_email: "fixture@example.test" },
      allowed_authors: ["fixture-human"],
      agents: { cline: { credential_source: credentials, credential_files: [] } },
      repositories: [],
    }),
  );
  return { root, dataDir, config, credentials };
}

function run(args: string[], env: NodeJS.ProcessEnv = {}, script?: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(script ? ["--input-type=module", "--eval", script] : ["src/index.ts", ...args]),
    ],
    {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        GREMLYN_GITHUB_TOKEN: FIXTURE_SECRET,
        GREMLYN_CONSOLE_TOKEN: "fixture-console-token",
        GREMLYN_DATA_DIR: "",
        GREMLYN_CONFIG: "",
        ...env,
      },
    },
  );
}

test("startup diagnostic categories never expose arbitrary exception or YAML payloads", () => {
  for (const stage of [
    "arguments",
    "configuration",
    "ownership",
    "store",
    "credentials",
    "github",
    "version",
    "recovery",
    "startup",
  ] as StartupStage[]) {
    const result = formatStartupDiagnostic(
      new Error(`${FIXTURE_SECRET}\u0007 raw confidential payload`),
      stage,
      [FIXTURE_SECRET],
    );
    assert.ok(result.event.length < 200);
    assert.ok(result.nextAction.length > 20);
    assert.ok(!JSON.stringify(result).includes(FIXTURE_SECRET));
    assert.ok(!JSON.stringify(result).includes("confidential payload"));
  }
  assert.match(
    formatStartupDiagnostic(new ConfigError(["yaml raw secret excerpt"]), "configuration", [])
      .event,
    /1 configuration problem/,
  );
});

test("real entrypoint rejects unknown flags and broken config with safe nonzero selected output", () => {
  for (const [args, expected] of [
    [["--unknown"], "Invalid launch options"],
    [["missing-fixture-file.yaml", "--presentation", "json"], "Configuration could not"],
    [["missing-fixture-file.yaml", "--presentation", "plain"], "Configuration could not"],
    [["missing-fixture-file.yaml", "--presentation", "terminal"], "Configuration could not"],
  ] as [string[], string][]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(expected));
    assert.ok(!result.stderr.includes("\u001b"));
    assert.ok(!result.stderr.includes(FIXTURE_SECRET));
    if (args.includes("json")) {
      const record = JSON.parse(result.stderr.trim());
      assert.equal(record.level, "error");
      assert.ok(record.nextAction);
    }
  }
});

test("credential startup failure releases store and lock without network or audio", () => {
  const f = fixture();
  try {
    rmSync(f.credentials, { recursive: true });
    const result = run([f.config, "--presentation", "plain"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Agent credentials are unavailable/);
    assert.equal(existsSync(dataDirectoryLockPath(f.dataDir)), false);
    const db = new Database(join(f.dataDir, "gremlyn.db"), { readonly: true, fileMustExist: true });
    db.close();
    const lock = DataDirectoryLock.acquire(f.dataDir);
    lock.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("ownership startup failure retains another daemon claim and reports next action", () => {
  const f = fixture();
  const lock = DataDirectoryLock.acquire(f.dataDir);
  try {
    const result = run([f.config, "--presentation", "json"]);
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(result.stderr.trim());
    assert.match(record.event, /ownership/);
    assert.match(record.nextAction, /other daemon/);
    assert.equal(existsSync(dataDirectoryLockPath(f.dataDir)), true);
    assert.equal(existsSync(join(f.dataDir, "gremlyn.db")), false);
  } finally {
    lock.release();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("GitHub and version preflight failure preserve nonzero outcome and dispose ownership", () => {
  for (const stage of ["github", "version"] as const) {
    const f = fixture();
    try {
      const script = `
        import { main } from ${JSON.stringify(pathToFileURL(resolve("src/index.ts")).href)};
        import { OctokitGitHubClient } from ${JSON.stringify(pathToFileURL(resolve("src/github/octokit.ts")).href)};
        import { EXECUTOR_FACTORIES } from ${JSON.stringify(pathToFileURL(resolve("src/agent/registry.ts")).href)};
        OctokitGitHubClient.prototype.getAuthenticatedLogin = async () => {
          if (${JSON.stringify(stage)} === "github") throw new Error(${JSON.stringify(FIXTURE_SECRET + " raw remote payload")});
          return "fixture-bot";
        };
        EXECUTOR_FACTORIES.cline = () => ({ id: "cline", checkVersion: async () => { throw new Error(${JSON.stringify(FIXTURE_SECRET + " raw version payload")}); } });
        try { await main(${JSON.stringify([f.config, "--presentation", "plain"])}); }
        catch { process.exitCode = 1; }
      `;
      const result = run([], {}, script);
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        stage === "github" ? /GitHub authentication/ : /version preflight/,
      );
      assert.ok(!result.stderr.includes(FIXTURE_SECRET));
      assert.ok(!result.stderr.includes("raw remote payload"));
      assert.ok(!result.stderr.includes("raw version payload"));
      assert.equal(existsSync(dataDirectoryLockPath(f.dataDir)), false);
      const lock = DataDirectoryLock.acquire(f.dataDir);
      lock.release();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("ownership recovery uses injectable diagnostic owner rather than direct JSON", () => {
  const f = fixture();
  try {
    mkdirSync(f.dataDir);
    writeFileSync(dataDirectoryLockPath(f.dataDir), "invalid abandoned fixture claim");
    const messages: string[] = [];
    const lock = DataDirectoryLock.acquire(f.dataDir, (event) => {
      messages.push(event);
    });
    assert.deepEqual(messages, ["reclaiming abandoned Gremlyn data directory claim"]);
    lock.release();
    assert.equal(existsSync(dataDirectoryLockPath(f.dataDir)), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
