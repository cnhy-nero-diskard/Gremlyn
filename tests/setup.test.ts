import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type RepoConfig } from "../src/config/loader.js";
import {
  appendRepository,
  emitDocument,
  loadDocument,
  writeValidatedConfig,
} from "../src/setup/document.js";
import {
  inferIdentityFromOrigin,
  inferValidationCommands,
  inheritRepositorySettings,
  parseOriginUrl,
  proposeWorkspaceRoot,
} from "../src/setup/infer.js";
import {
  InputResolutionError,
  nonInteractiveInput,
  resolveCommandList,
  resolveInput,
} from "../src/setup/input.js";
import {
  addRepository,
  bootstrapConfig,
  checkPrerequisites,
  setup,
  verifyConfig,
} from "../src/setup/flows.js";
import {
  allChecksPassed,
  checkEntry,
  isPathInside,
  realVerificationEnvironment,
} from "../src/setup/verify.js";
import { HELP } from "../src/setup/cli.js";
import { FakeExecutor } from "../src/agent/fake.js";
import { EXECUTOR_FACTORIES } from "../src/agent/registry.js";
import { createTempRepo } from "./helpers/gitrepo.js";
import { git } from "../src/workspace/gitops.js";

const ENV = {
  GREMLYN_GITHUB_TOKEN: "github-placeholder",
  GREMLYN_CONSOLE_TOKEN: "console-placeholder",
} as NodeJS.ProcessEnv;

const AGENT = {
  id: "cline",
  binary: "cline",
  efforts: ["none", "low", "medium", "high", "xhigh"] as const,
  credentialSource: "/tmp/gremlyn-test-cline-data",
};

function tempRoot(prefix = "gremlyn-setup-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function validConfig(repositories = "[]"): string {
  return `data_dir: .gremlyn-test
log_level: info
poll_interval_seconds: 5
concurrency: 1
github:
  token_env: GREMLYN_GITHUB_TOKEN
  orchestrator_login: gremlyn-bot
git:
  author_name: Test Author
  author_email: test@example.com
console:
  host: 127.0.0.1
  port: 4780
  token_env: GREMLYN_CONSOLE_TOKEN
agent_defaults:
  timeout_seconds: 30
  retries: 1
allowed_authors: [human]
agents:
  cline:
    binary: cline
    efforts: [none, low, medium, high, xhigh]
    credential_source: /tmp/gremlyn-test-cline-data
repositories: ${repositories}
`;
}

function writeConfig(root: string, contents = validConfig()): string {
  const path = join(root, "gremlyn.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

/** A valid config whose only agent is an OpenCode one (max-tier ceiling, no provider). */
function validConfigWithOpencodeAgent(): string {
  return `data_dir: .gremlyn-test
log_level: info
poll_interval_seconds: 5
concurrency: 1
github:
  token_env: GREMLYN_GITHUB_TOKEN
  orchestrator_login: gremlyn-bot
git:
  author_name: Test Author
  author_email: test@example.com
console:
  host: 127.0.0.1
  port: 4780
  token_env: GREMLYN_CONSOLE_TOKEN
agent_defaults:
  timeout_seconds: 30
  retries: 1
allowed_authors: [human]
agents:
  opencode:
    kind: opencode
    binary: opencode
    efforts: [none, low, medium, high, xhigh, max]
    credential_source: /tmp/gremlyn-test-opencode-data
repositories: []
`;
}

/** A valid config with one Cline and one OpenCode agent for prerequisite reporting. */
function validConfigWithBothAgents(): string {
  return validConfigWithOpencodeAgent().replace(
    "agents:\n",
    `agents:
  cline:
    binary: cline
    efforts: [none, low, medium, high, xhigh]
    credential_source: /tmp/gremlyn-test-cline-data
`,
  );
}

function repositoryEntry(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    owner: "owner",
    name: "repo",
    sourcePath: "/source/repo",
    workspaceRoot: "/workspace/repo",
    agent: "cline",
    provider: "test-provider",
    model: "test-provider/model",
    effort: "xhigh",
    enabled: true,
    validationCommands: [],
    allowedModels: ["test-provider/model"],
    ...overrides,
  };
}

function fakeVerificationEnvironment(
  origin = "git@github.com:owner/repo.git",
  overrides: Partial<{
    pathExists: (path: string) => boolean;
    isGitWorkTree: (path: string) => Promise<boolean>;
    originUrl: (path: string) => Promise<string | undefined>;
  }> = {},
) {
  return {
    pathExists: overrides.pathExists ?? (() => true),
    isGitWorkTree: overrides.isGitWorkTree ?? (async () => true),
    originUrl: overrides.originUrl ?? (async () => origin),
  };
}

function outputCollector(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line) };
}

test("CLI help names every setup subcommand and supported flag", () => {
  for (const text of [
    "setup",
    "add-repo",
    "verify",
    "--help",
    "--yes",
    "--config",
    "--repo",
    "--probe",
    "--owner",
    "--name",
    "--workspace-root",
    "--agent",
    "--provider",
    "--model",
    "--effort",
    "--allowed-model",
    "--validation-command",
    "--no-validation",
    "--agent-instructions",
    "--enabled",
    "--disabled",
    "--example",
  ]) {
    assert.ok(HELP.includes(text), `help is missing ${text}`);
  }
});

test("document API preserves comments and key order while appending a repository", () => {
  const root = tempRoot();
  try {
    const path = join(root, "gremlyn.yaml");
    const source = `# file header\ndata_dir: .gremlyn\n\n# The operator's repository list\nrepositories:\n  # first entry comment\n  - owner: first\n    name: repo\n    source_path: /source/first\n    workspace_root: /workspace/first\n`;
    writeFileSync(path, source, "utf8");
    const document = loadDocument(path);
    appendRepository(document, {
      owner: "second",
      name: "repo",
      source_path: "/source/second",
      workspace_root: "/workspace/second",
      agent: "cline",
      provider: "provider",
      model: "provider/model",
      effort: "xhigh",
      enabled: true,
      allowed_models: ["provider/model"],
      validation_commands: [],
    });
    const emitted = emitDocument(document);
    assert.match(emitted, /# file header/u);
    assert.match(emitted, /# The operator's repository list/u);
    assert.match(emitted, /# first entry comment/u);
    assert.ok(emitted.indexOf("data_dir") < emitted.indexOf("repositories"));
    assert.ok(emitted.indexOf("owner: second") > emitted.indexOf("owner: first"));
    assert.ok(
      emitted.indexOf("owner: second") <
        emitted.indexOf("name: repo", emitted.indexOf("owner: second") + 1),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config.example.yaml is byte-stable through a no-op document round trip", () => {
  const path = join(import.meta.dirname, "..", "config.example.yaml");
  const source = readFileSync(path, "utf8");
  const document = loadDocument(path);
  assert.equal(emitDocument(document), source);
});

// The example file's line endings depend on the checkout, so byte stability for
// a CRLF operator file — the common Windows case — is asserted independently.
test("a document keeps the line endings it was loaded with through load, append, and emit", () => {
  const root = tempRoot();
  try {
    const lf = join(root, "lf.yaml");
    const lfSource = validConfig();
    writeFileSync(lf, lfSource, "utf8");
    assert.equal(emitDocument(loadDocument(lf)), lfSource);

    const crlf = join(root, "crlf.yaml");
    const crlfSource = lfSource.replace(/\n/gu, "\r\n");
    writeFileSync(crlf, crlfSource, "utf8");
    assert.equal(emitDocument(loadDocument(crlf)), crlfSource);

    const document = loadDocument(crlf);
    appendRepository(document, { owner: "octo", name: "repo" });
    const emitted = emitDocument(document);
    assert.match(emitted, /owner: octo/u);
    assert.ok(!/(?<!\r)\n/u.test(emitted), "an appended CRLF document must keep every CRLF");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validated config write returns loader problems and leaves the original byte-for-byte unchanged", () => {
  const root = tempRoot();
  try {
    const path = writeConfig(root);
    const before = readFileSync(path, "utf8");
    const document = loadDocument(path);
    document.set("data_dir", "");
    const result = writeValidatedConfig(path, document, ENV);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.problems.some((problem) => problem.includes("data_dir")));
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("origin inference accepts GitHub SSH, HTTPS, and ssh:// forms and trims .git", () => {
  assert.deepEqual(parseOriginUrl("git@github.com:octo/repo.git"), {
    owner: "octo",
    name: "repo",
  });
  assert.deepEqual(parseOriginUrl("https://github.com/octo/repo.git"), {
    owner: "octo",
    name: "repo",
  });
  assert.deepEqual(parseOriginUrl("ssh://git@github.com/octo/repo.git"), {
    owner: "octo",
    name: "repo",
  });
  assert.equal(parseOriginUrl("https://gitlab.com/octo/repo.git"), undefined);
});

test("origin inference does not guess a missing or unusable origin", async () => {
  const root = tempRoot();
  try {
    assert.equal(await inferIdentityFromOrigin(root), undefined);
    assert.equal(parseOriginUrl("repo-directory"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace proposal is a safe sibling outside the source and other sources", () => {
  const proposal = proposeWorkspaceRoot("/tmp/project/repo", ["/tmp/project/repo-workspaces"]);
  assert.ok(proposal);
  assert.ok(!isPathInside(proposal.value, "/tmp/project/repo"));
  assert.ok(!isPathInside(proposal.value, "/tmp/project/repo-workspaces"));
  assert.match(proposal.provenance, /sibling/u);
  assert.equal(isPathInside("C:\\Code\\Gremlyn-workspaces", "c:\\code\\Gremlyn"), false);
});

test("workspace proposal compares Windows paths case-insensitively but proposes the real case", () => {
  const proposal = proposeWorkspaceRoot(
    "C:\\Users\\Dev\\AppData\\Local\\Temp\\Gremlyn-Repo\\Source",
  );
  assert.ok(proposal);
  assert.equal(
    proposal.value,
    "C:\\Users\\Dev\\AppData\\Local\\Temp\\Gremlyn-Repo\\Source-workspaces",
  );

  // A conflict differing only in case must still be detected and walked past.
  const avoided = proposeWorkspaceRoot("C:\\Code\\Repo", ["c:\\code\\Repo-workspaces"]);
  assert.ok(avoided);
  assert.notEqual(avoided.value.toLowerCase(), "c:\\code\\repo-workspaces");
});

test("validation candidates come only from recognized package scripts", () => {
  const root = tempRoot();
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node test.js",
          build: "tsc",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          dev: "vite",
        },
      }),
      "utf8",
    );
    assert.deepEqual(
      inferValidationCommands(root).map((candidate) => candidate.command),
      [
        ["npm", "test"],
        ["npm", "run", "build"],
        ["npm", "run", "typecheck"],
        ["npm", "run", "lint"],
      ],
    );
    assert.ok(inferValidationCommands(root).every((candidate) => candidate.provenance));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }), "utf8");
    assert.deepEqual(inferValidationCommands(root), []);
    rmSync(join(root, "package.json"));
    assert.deepEqual(inferValidationCommands(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository settings inherit from an entry or the configured agent ceiling", () => {
  const existing = repositoryEntry({ effort: "high" });
  const inherited = inheritRepositorySettings(existing, { cline: AGENT });
  assert.deepEqual(inherited?.value, {
    agent: "cline",
    provider: "test-provider",
    model: "test-provider/model",
    effort: "high",
  });
  assert.match(inherited?.provenance ?? "", /existing/u);
  const fallback = inheritRepositorySettings(undefined, { cline: AGENT });
  assert.deepEqual(fallback?.value, {
    agent: "cline",
    provider: "",
    model: "",
    effort: "xhigh",
  });
  assert.match(fallback?.provenance ?? "", /ceiling/u);
});

test("verification returns data for every registration check", async () => {
  const base = repositoryEntry();
  const agents = { cline: AGENT };
  const cases: Array<{
    id: string;
    entry?: RepoConfig;
    existing?: RepoConfig[];
    environment?: ReturnType<typeof fakeVerificationEnvironment>;
  }> = [
    {
      id: "source-path-exists",
      environment: fakeVerificationEnvironment(undefined, { pathExists: () => false }),
    },
    {
      id: "source-is-git-work-tree",
      environment: fakeVerificationEnvironment(undefined, { isGitWorkTree: async () => false }),
    },
    {
      id: "origin-matches-owner-name",
      environment: fakeVerificationEnvironment("git@github.com:other/repo.git"),
    },
    {
      id: "workspace-outside-source",
      entry: { ...base, workspaceRoot: "/source/repo/nested" },
    },
    {
      id: "workspace-outside-other-sources",
      entry: { ...base, workspaceRoot: "/other/source/workspaces" },
      existing: [repositoryEntry({ owner: "other", name: "source", sourcePath: "/other/source" })],
    },
    {
      id: "workspace-root-available",
      entry: { ...base, workspaceRoot: "/workspace/existing" },
      existing: [
        repositoryEntry({ owner: "other", name: "existing", workspaceRoot: "/workspace/existing" }),
      ],
    },
    {
      id: "repository-not-duplicate",
      existing: [repositoryEntry()],
    },
    {
      id: "agent-known",
      entry: { ...base, agent: "missing" },
    },
  ];
  for (const scenario of cases) {
    const results = await checkEntry(
      scenario.entry ?? base,
      scenario.existing ?? [],
      agents,
      scenario.environment ?? fakeVerificationEnvironment(),
    );
    const result = results.find((candidate) => candidate.id === scenario.id);
    assert.ok(result, `missing result for ${scenario.id}`);
    assert.equal(result.passed, false, `expected ${scenario.id} to fail`);
    assert.equal(result.pass, false);
    assert.notEqual(result.observed, undefined);
    assert.ok(result.remedy.length > 0);
    assert.ok(result.message.length > 0);
  }
});

test("real verification environment passes a temporary git repository", async () => {
  const repo = await createTempRepo();
  try {
    await git(["remote", "set-url", "origin", "git@github.com:owner/temp.git"], {
      cwd: repo.sourcePath,
    });
    const results = await checkEntry(
      repositoryEntry({
        owner: "owner",
        name: "temp",
        sourcePath: repo.sourcePath,
        workspaceRoot: repo.workspaceRoot,
      }),
      [],
      { cline: AGENT },
      realVerificationEnvironment,
    );
    assert.equal(allChecksPassed(results), true);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("input resolution accepts explicit values and --yes proposals, but fails without a TTY", async () => {
  const input = nonInteractiveInput();
  assert.equal(
    await resolveInput("model", {
      explicit: "provider/model",
      describe: (value) => value,
      input,
    }),
    "provider/model",
  );
  assert.equal(
    await resolveInput("workspace-root", {
      proposed: "/tmp/workspaces",
      describe: (value) => `workspace ${value}`,
      yes: true,
      input,
    }),
    "/tmp/workspaces",
  );
  assert.deepEqual(
    await resolveCommandList("validation-commands", [["npm", "test"]], {
      explicit: [],
      input,
    }),
    [],
  );
  await assert.rejects(
    resolveInput("provider", {
      proposed: "provider/default",
      describe: (value) => `provider ${value}`,
      input,
    }),
    (error: unknown) =>
      error instanceof InputResolutionError &&
      error.field === "provider" &&
      /--provider|--yes/u.test(error.message),
  );
});

test("add-repo writes a fully explicit, loadable entry after verification", async () => {
  const root = tempRoot();
  const repo = await createTempRepo();
  try {
    await git(["remote", "set-url", "origin", "https://github.com/owner/registered.git"], {
      cwd: repo.sourcePath,
    });
    const configPath = writeConfig(root);
    const output = outputCollector();
    const result = await addRepository({
      configPath,
      sourcePath: repo.sourcePath,
      yes: true,
      provider: "test-provider",
      model: "test-provider/model",
      allowedModels: ["test-provider/model"],
      validationCommands: [],
      env: ENV,
      out: output.out,
      input: nonInteractiveInput(),
      verificationEnvironment: realVerificationEnvironment,
    });
    assert.equal(result.exitCode, 0);
    const config = loadConfig(configPath, ENV);
    const entry = config.repositories[0]!;
    assert.deepEqual(
      {
        owner: entry.owner,
        name: entry.name,
        sourcePath: entry.sourcePath,
        workspaceRoot: entry.workspaceRoot,
        agent: entry.agent,
        provider: entry.provider,
        model: entry.model,
        effort: entry.effort,
        enabled: entry.enabled,
        allowedModels: entry.allowedModels,
        validationCommands: entry.validationCommands,
      },
      {
        owner: "owner",
        name: "registered",
        sourcePath: repo.sourcePath,
        workspaceRoot: repo.workspaceRoot.replace(/workspaces$/u, "source-workspaces"),
        agent: "cline",
        provider: "test-provider",
        model: "test-provider/model",
        effort: "xhigh",
        enabled: true,
        allowedModels: ["test-provider/model"],
        validationCommands: [],
      },
    );
    assert.ok(output.lines.some((line) => line.includes("Registered owner/registered")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("an OpenCode agent registers provider-less under --yes and inherits its own effort ceiling", async () => {
  const root = tempRoot();
  const repo = await createTempRepo();
  try {
    await git(["remote", "set-url", "origin", "git@github.com:owner/opencoded.git"], {
      cwd: repo.sourcePath,
    });
    const configPath = writeConfig(root, validConfigWithOpencodeAgent());
    const result = await addRepository({
      configPath,
      sourcePath: repo.sourcePath,
      yes: true,
      model: "opencode/claude-sonnet-5",
      allowedModels: ["opencode/claude-sonnet-5"],
      validationCommands: [],
      env: ENV,
      out: () => undefined,
      input: nonInteractiveInput(),
      verificationEnvironment: realVerificationEnvironment,
    });
    assert.equal(result.exitCode, 0);
    const config = loadConfig(configPath, ENV);
    const entry = config.repositories[0]!;
    // No provider proposal exists for OpenCode and none is required: the
    // executor folds the provider into the model id.
    assert.equal(entry.agent, "opencode");
    assert.equal(entry.provider, "");
    assert.equal(entry.model, "opencode/claude-sonnet-5");
    // The effort proposal is the OpenCode agent's ceiling, not Cline's.
    assert.equal(entry.effort, "max");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("setup prerequisites validate declared credential files and dispatch version checks by kind", async () => {
  const root = tempRoot();
  const configPath = writeConfig(root, validConfigWithBothAgents());
  const credentialFilesById = new Map<string, readonly string[] | undefined>();
  const versionChecked: string[] = [];
  // Swap every real factory for a recording fake so the dispatch through the
  // registry is observable without spawning either CLI.
  const originalFactories = new Map(
    ["cline", "opencode"].map((kind) => [kind, EXECUTOR_FACTORIES[kind]]),
  );
  for (const kind of ["cline", "opencode"]) {
    EXECUTOR_FACTORIES[kind] = (binary) => {
      versionChecked.push(binary);
      return new FakeExecutor({ outcome: "success" });
    };
  }
  try {
    const report = await checkPrerequisites(configPath, {
      env: ENV,
      out: () => undefined,
      createGitHubClient: () => ({ getAuthenticatedLogin: async () => "gremlyn-bot" }),
      verifyCredentials: (id, _source, files) => {
        credentialFilesById.set(id, files);
      },
    });
    // Each agent's declared credential file set is validated, not Cline's.
    assert.deepEqual(credentialFilesById.get("cline"), ["secrets.json", "settings/providers.json"]);
    assert.deepEqual(credentialFilesById.get("opencode"), ["auth.json"]);
    // The version check ran the executor each kind declares, not Cline for both.
    assert.deepEqual(versionChecked, ["cline", "opencode"]);
    const clineVersion = report.prerequisites.find((item) => item.id === "agent-version:cline");
    assert.equal(clineVersion?.met, true);
    assert.match(clineVersion?.observed ?? "", /cline is 3\.0\.61/u);
    const opencodeVersion = report.prerequisites.find(
      (item) => item.id === "agent-version:opencode",
    );
    assert.equal(opencodeVersion?.met, true);
    assert.match(opencodeVersion?.observed ?? "", /opencode is 1\.18\.27/u);
  } finally {
    for (const [kind, factory] of originalFactories) {
      if (factory) EXECUTOR_FACTORIES[kind] = factory;
      else delete EXECUTOR_FACTORIES[kind];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unregistered agent kind fails the version prerequisite instead of probing Cline", async () => {
  const root = tempRoot();
  const configPath = writeConfig(
    root,
    validConfigWithOpencodeAgent().replace("kind: opencode", "kind: mystery"),
  );
  try {
    const report = await checkPrerequisites(configPath, {
      env: ENV,
      out: () => undefined,
      createGitHubClient: () => ({ getAuthenticatedLogin: async () => "gremlyn-bot" }),
      verifyCredentials: () => undefined,
    });
    const version = report.prerequisites.find((item) => item.id === "agent-version:opencode");
    assert.equal(version?.met, false);
    assert.match(version?.observed ?? "", /no executor is registered for kind "mystery"/u);
    assert.equal(report.allMet, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first registration removes only the shipped example repository", async () => {
  const root = tempRoot();
  const repo = await createTempRepo();
  try {
    await git(["remote", "set-url", "origin", "git@github.com:owner/first.git"], {
      cwd: repo.sourcePath,
    });
    const configPath = writeConfig(
      root,
      readFileSync(join(import.meta.dirname, "..", "config.example.yaml"), "utf8"),
    );
    await addRepository({
      configPath,
      sourcePath: repo.sourcePath,
      yes: true,
      provider: "test-provider",
      model: "test-provider/model",
      allowedModels: ["test-provider/model"],
      validationCommands: [],
      env: ENV,
      out: () => undefined,
      input: nonInteractiveInput(),
      verificationEnvironment: realVerificationEnvironment,
    });
    const config = loadConfig(configPath, ENV);
    assert.equal(config.repositories.length, 1);
    assert.deepEqual(
      { owner: config.repositories[0]!.owner, name: config.repositories[0]!.name },
      { owner: "owner", name: "first" },
    );
    const written = readFileSync(configPath, "utf8");
    assert.doesNotMatch(written, /owner: your-github-login\n\s+name: your-repo/u);
    assert.match(written, /- your-github-login/u);
    assert.match(written, /# Gremlyn configuration example\./u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a failed registration check leaves the configuration unchanged", async () => {
  const root = tempRoot();
  const repo = await createTempRepo();
  try {
    await git(["remote", "set-url", "origin", "git@github.com:owner/failed.git"], {
      cwd: repo.sourcePath,
    });
    const configPath = writeConfig(root);
    const before = readFileSync(configPath, "utf8");
    await assert.rejects(
      addRepository({
        configPath,
        sourcePath: repo.sourcePath,
        yes: true,
        provider: "test-provider",
        model: "test-provider/model",
        allowedModels: ["test-provider/model"],
        validationCommands: [],
        workspaceRoot: join(repo.sourcePath, "inside"),
        env: ENV,
        input: nonInteractiveInput(),
        verificationEnvironment: realVerificationEnvironment,
      }),
      /registration aborted/u,
    );
    assert.equal(readFileSync(configPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("registering a second repository preserves the first entry and comments", async () => {
  const root = tempRoot();
  const first = await createTempRepo();
  const second = await createTempRepo();
  try {
    await git(["remote", "set-url", "origin", "git@github.com:owner/first.git"], {
      cwd: first.sourcePath,
    });
    await git(["remote", "set-url", "origin", "git@github.com:owner/second.git"], {
      cwd: second.sourcePath,
    });
    const configPath = writeConfig(
      root,
      `${validConfig().replace("repositories: []", "# keep this registration note\nrepositories: []")}\n`,
    );
    const common = {
      configPath,
      yes: true,
      provider: "test-provider",
      model: "test-provider/model",
      allowedModels: ["test-provider/model"],
      validationCommands: [],
      env: ENV,
      input: nonInteractiveInput(),
      verificationEnvironment: realVerificationEnvironment,
    };
    await addRepository({ ...common, sourcePath: first.sourcePath });
    const afterFirst = readFileSync(configPath, "utf8");
    await addRepository({ ...common, sourcePath: second.sourcePath });
    const afterSecond = readFileSync(configPath, "utf8");
    assert.match(afterSecond, /# keep this registration note/u);
    assert.match(afterSecond, /name: first\n/u);
    assert.match(afterSecond, /name: second\n/u);
    assert.ok(
      afterSecond.includes(
        afterFirst.slice(
          afterFirst.indexOf("owner: first"),
          afterFirst.indexOf("owner: first") + 100,
        ),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("bootstrap creates the example when absent and leaves an existing file authoritative", () => {
  const root = tempRoot();
  try {
    const missing = join(root, "missing.yaml");
    const first = bootstrapConfig(missing, join(import.meta.dirname, "..", "config.example.yaml"));
    assert.equal(first.created, true);
    assert.equal(
      readFileSync(missing, "utf8"),
      readFileSync(join(import.meta.dirname, "..", "config.example.yaml"), "utf8"),
    );
    const existing = join(root, "existing.yaml");
    writeFileSync(existing, "# operator file\ndata_dir: custom\n", "utf8");
    const before = readFileSync(existing, "utf8");
    assert.equal(bootstrapConfig(existing, missing).created, false);
    assert.equal(readFileSync(existing, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prerequisite reporting names missing tokens, login mismatches, and credential remedies", async () => {
  const root = tempRoot();
  try {
    const configPath = writeConfig(root);
    const missing = await checkPrerequisites(configPath, {
      env: {} as NodeJS.ProcessEnv,
      out: () => undefined,
      verifyCredentials: () => {
        throw new Error("credential source missing: /tmp/credentials");
      },
      checkAgentVersion: async () => undefined,
    });
    const missingToken = missing.prerequisites.find((item) => item.id === "github-token");
    assert.ok(
      missingToken && !missingToken.met && missingToken.observed.includes("GREMLYN_GITHUB_TOKEN"),
    );
    const missingCredential = missing.prerequisites.find(
      (item) => item.id === "agent-credentials:cline",
    );
    assert.ok(
      missingCredential &&
        !missingCredential.met &&
        /credential source|Authenticate/u.test(missingCredential.remedy),
    );
    assert.equal(missing.allMet, false);

    const mismatch = await checkPrerequisites(configPath, {
      env: { ...ENV, GREMLYN_CONSOLE_TOKEN: "console" },
      out: () => undefined,
      createGitHubClient: () => ({ getAuthenticatedLogin: async () => "different-login" }),
      verifyCredentials: () => undefined,
      checkAgentVersion: async () => undefined,
    });
    const identity = mismatch.prerequisites.find((item) => item.id === "github-identity");
    assert.ok(
      identity &&
        !identity.met &&
        identity.observed.includes("different-login") &&
        identity.observed.includes("gremlyn-bot"),
    );
    assert.equal(mismatch.allMet, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup redacts configured token values from prerequisite output", async () => {
  const root = tempRoot();
  try {
    const configPath = writeConfig(
      root,
      validConfig()
        .replace("token_env: GREMLYN_GITHUB_TOKEN", "token_env: CUSTOM_GITHUB_VALUE")
        .replace("token_env: GREMLYN_CONSOLE_TOKEN", "token_env: CUSTOM_CONSOLE_VALUE"),
    );
    const githubToken = "github-secret-value";
    const consoleToken = "console-secret-value";
    const output = outputCollector();
    const result = await setup({
      configPath,
      env: {
        CUSTOM_GITHUB_VALUE: githubToken,
        CUSTOM_CONSOLE_VALUE: consoleToken,
      } as NodeJS.ProcessEnv,
      out: output.out,
      input: nonInteractiveInput(),
      createGitHubClient: () => ({ getAuthenticatedLogin: async () => "gremlyn-bot" }),
      verifyCredentials: () => {
        throw new Error(`credential source failed with ${githubToken}`);
      },
      checkAgentVersion: async () => undefined,
    });
    assert.equal(result.exitCode, 1);
    const text = output.lines.join("\n");
    assert.equal(text.includes(githubToken), false);
    assert.equal(text.includes(consoleToken), false);
    assert.match(text, /\[redacted\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated console tokens are returned for export and never written to configuration", async () => {
  const root = tempRoot();
  try {
    const configPath = writeConfig(root);
    const report = await checkPrerequisites(configPath, {
      env: { GREMLYN_GITHUB_TOKEN: "github" } as NodeJS.ProcessEnv,
      out: () => undefined,
      createGitHubClient: () => ({ getAuthenticatedLogin: async () => "gremlyn-bot" }),
      verifyCredentials: () => undefined,
      checkAgentVersion: async () => undefined,
    });
    assert.ok(report.generatedConsoleToken);
    assert.equal(readFileSync(configPath, "utf8").includes(report.generatedConsoleToken!), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup hands off to registration without probing unless --probe is requested", async () => {
  const root = tempRoot();
  const repo = await createTempRepo();
  try {
    await git(["remote", "set-url", "origin", "git@github.com:owner/setup.git"], {
      cwd: repo.sourcePath,
    });
    const configPath = writeConfig(root);
    let probed = false;
    const output = outputCollector();
    const result = await setup({
      configPath,
      repoPath: repo.sourcePath,
      yes: true,
      addRepository: {
        provider: "test-provider",
        model: "test-provider/model",
        allowedModels: ["test-provider/model"],
        validationCommands: [],
      },
      env: ENV,
      out: output.out,
      input: nonInteractiveInput(),
      createGitHubClient: () => ({ getAuthenticatedLogin: async () => "gremlyn-bot" }),
      verifyCredentials: () => undefined,
      checkAgentVersion: async () => undefined,
      runProbe: async () => {
        probed = true;
        return 1;
      },
      verificationEnvironment: realVerificationEnvironment,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(probed, false);
    assert.equal(loadConfig(configPath, ENV).repositories[0]?.name, "setup");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("verify reports every configured entry, fails on one bad source, and writes nothing", async () => {
  const root = tempRoot();
  try {
    const repositories = `
  - owner: owner
    name: bad
    source_path: ${join(root, "missing-source")}
    workspace_root: ${join(root, "bad-workspaces")}
    agent: cline
    provider: test-provider
    model: test-provider/model
    effort: xhigh
    enabled: true
    allowed_models: [test-provider/model]
    validation_commands: []
  - owner: owner
    name: good
    source_path: ${join(root, "good-source")}
    workspace_root: ${join(root, "good-workspaces")}
    agent: cline
    provider: test-provider
    model: test-provider/model
    effort: xhigh
    enabled: true
    allowed_models: [test-provider/model]
    validation_commands: []
`;
    const configPath = writeConfig(root, validConfig(repositories));
    const before = readFileSync(configPath, "utf8");
    const dataDir = join(root, ".gremlyn-data");
    const output = outputCollector();
    const result = await verifyConfig({
      configPath,
      env: ENV,
      out: output.out,
      verificationEnvironment: fakeVerificationEnvironment("git@github.com:owner/good.git", {
        pathExists: (path) => path.endsWith("good-source"),
        isGitWorkTree: async (path) => path.endsWith("good-source"),
        originUrl: async () => "git@github.com:owner/good.git",
      }),
    });
    assert.equal(result.exitCode, 1);
    assert.ok(output.lines.some((line) => line.includes("Repository owner/bad")));
    assert.ok(output.lines.some((line) => line.includes("Repository owner/good")));
    assert.ok(
      output.lines.some((line) => line.includes("source path") && line.includes("does not exist")),
    );
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(existsSync(dataDir), false);
    assert.equal(existsSync(join(root, "good-workspaces")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all configured entries can pass verification", async () => {
  const root = tempRoot();
  try {
    const repositories = `
  - owner: owner
    name: one
    source_path: ${join(root, "one-source")}
    workspace_root: ${join(root, "one-workspaces")}
    agent: cline
    provider: test-provider
    model: test-provider/model
    effort: xhigh
    enabled: true
    allowed_models: [test-provider/model]
    validation_commands: []
`;
    const configPath = writeConfig(root, validConfig(repositories));
    const result = await verifyConfig({
      configPath,
      env: ENV,
      out: () => undefined,
      verificationEnvironment: fakeVerificationEnvironment("git@github.com:owner/one.git"),
    });
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
