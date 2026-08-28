import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  ConfigError,
  loadConfig,
  type AgentDefinition,
  type AppConfig,
  type RepoConfig,
} from "../config/loader.js";
import { ClineExecutor, EXPECTED_CLINE_VERSION } from "../agent/cline.js";
import { verifyCredentialSource } from "../agent/credentials.js";
import { probe as runAgentProbe } from "../agent/probe.js";
import { buildAgentEnvironment } from "../agent/environment.js";
import { OctokitGitHubClient } from "../github/octokit.js";
import { createRedactor } from "../log/redact.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../types.js";
import {
  appendRepository,
  loadDocument,
  placeholderEnvironment,
  removeRepositories,
  writeValidatedConfig,
} from "./document.js";
import { inferRepository } from "./infer.js";
import {
  allChecksPassed,
  checkEntry,
  failedChecks,
  realVerificationEnvironment,
  type CheckResult,
  type VerificationEnvironment,
} from "./verify.js";
import {
  closeInput,
  createReadlineInput,
  resolveCommandList,
  resolveInput,
  type InputSource,
} from "./input.js";

export interface FlowIO {
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  input?: InputSource | undefined;
  out?: ((line: string) => void) | undefined;
  err?: ((line: string) => void) | undefined;
  verificationEnvironment?: VerificationEnvironment | undefined;
  verifyCredentials?: typeof verifyCredentialSource | undefined;
  createGitHubClient?:
    ((token: string) => { getAuthenticatedLogin(): Promise<string> }) | undefined;
  checkAgentVersion?: ((definition: AgentDefinition) => Promise<void>) | undefined;
  runProbe?: (() => Promise<number>) | undefined;
  examplePath?: string | undefined;
}

export interface AddRepositoryOptions extends FlowIO {
  configPath: string;
  sourcePath: string;
  yes?: boolean | undefined;
  owner?: string | undefined;
  name?: string | undefined;
  workspaceRoot?: string | undefined;
  agent?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  allowedModels?: string[] | undefined;
  validationCommands?: string[][] | undefined;
  enabled?: boolean | undefined;
  agentInstructions?: string | undefined;
}

export interface SetupOptions extends FlowIO {
  configPath: string;
  yes?: boolean | undefined;
  repoPath?: string | undefined;
  probe?: boolean | undefined;
  addRepository?:
    Omit<AddRepositoryOptions, "configPath" | "sourcePath" | keyof FlowIO> | undefined;
}

interface RuntimeFlowIO extends Omit<FlowIO, "env" | "out" | "err" | "verificationEnvironment"> {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  verificationEnvironment: VerificationEnvironment;
}

export interface FlowResult {
  exitCode: number;
  configPath: string;
  createdConfig?: boolean;
  checks?: CheckResult[];
}

export interface PrerequisiteResult {
  id: string;
  met: boolean;
  observed: string;
  remedy: string;
}

export interface SetupReport {
  prerequisites: PrerequisiteResult[];
  allMet: boolean;
  generatedConsoleToken?: string;
}

export class SetupFlowError extends Error {
  readonly exitCode = 1;
  readonly problems: string[];

  constructor(message: string, problems: string[] = [message]) {
    super(message);
    this.name = "SetupFlowError";
    this.problems = problems;
  }
}

const DEFAULT_CONFIG_NAME = "gremlyn.yaml";

/** Copy the shipped example only when the operator has no configuration yet. */
export function bootstrapConfig(
  configPath: string,
  examplePath = defaultExamplePath(),
): { created: boolean; path: string } {
  const target = resolve(configPath);
  if (existsSync(target)) return { created: false, path: target };
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(examplePath, target);
  return { created: true, path: target };
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GREMLYN_CONFIG ?? DEFAULT_CONFIG_NAME;
}

export function defaultExamplePath(): string {
  return fileURLToPath(new URL("../../config.example.yaml", import.meta.url));
}

/**
 * Register a checkout after resolving all proposals and running every shared
 * verification check. No file write occurs until all checks pass.
 */
export async function addRepository(options: AddRepositoryOptions): Promise<FlowResult> {
  const configPath = resolve(options.configPath);
  const io = makeIO(options, configPath);
  const config = readSetupConfig(configPath, io.env);
  const out = io.out;
  const sourcePath = resolve(options.sourcePath);
  const configuredRepositories = config.repositories.filter((entry) => !isExampleRepository(entry));
  const inference = await inferRepository(sourcePath, {
    existingEntries: configuredRepositories,
    agents: config.agents,
    ...(options.agent !== undefined ? { preferredAgent: options.agent } : {}),
  });

  const identity = inference.identity?.value;
  if (options.effort !== undefined && parseEffort(options.effort) === undefined) {
    throw new SetupFlowError(
      `invalid effort "${options.effort}"; choose one of ${REASONING_EFFORTS.join(", ")}`,
    );
  }
  if (!identity && options.owner === undefined && options.name === undefined) {
    throw new SetupFlowError(
      "owner and name cannot be derived: origin is missing or does not address a GitHub repository; supply --owner and --name, then fix origin before retrying",
    );
  }

  const owner = await resolveInput<string>("owner", {
    explicit: options.owner,
    proposed: identity?.owner,
    describe: (value) =>
      `owner proposed as ${value} (${inference.identity?.provenance ?? "explicit input"})`,
    yes: options.yes,
    input: io.input,
  });
  const name = await resolveInput<string>("name", {
    explicit: options.name,
    proposed: identity?.name,
    describe: (value) =>
      `name proposed as ${value} (${inference.identity?.provenance ?? "explicit input"})`,
    yes: options.yes,
    input: io.input,
  });
  const workspaceRoot = await resolveInput<string>("workspace-root", {
    explicit: options.workspaceRoot,
    proposed: inference.workspaceRoot.value || undefined,
    describe: (value) =>
      `workspace_root proposed as ${value} (${inference.workspaceRoot.provenance})`,
    yes: options.yes,
    input: io.input,
  });

  const settings = inference.settings?.value;
  const agent = await resolveInput<string>("agent", {
    explicit: options.agent,
    proposed: settings?.agent,
    describe: (value) =>
      `agent proposed as ${value} (${inference.settings?.provenance ?? "configured agent"})`,
    yes: options.yes,
    input: io.input,
  });
  const provider = await resolveInput<string>("provider", {
    explicit: options.provider,
    proposed: nonEmpty(settings?.provider),
    describe: (value) =>
      `provider proposed as ${value} (${inference.settings?.provenance ?? "existing entry"})`,
    yes: options.yes,
    input: io.input,
  });
  const model = await resolveInput<string>("model", {
    explicit: options.model,
    proposed: nonEmpty(settings?.model),
    describe: (value) =>
      `model proposed as ${value} (${inference.settings?.provenance ?? "existing entry"})`,
    yes: options.yes,
    input: io.input,
  });
  const effort = await resolveInput<ReasoningEffort>("effort", {
    explicit: parseEffort(options.effort),
    proposed: settings?.effort,
    describe: (value) =>
      `effort proposed as ${value} (${inference.settings?.provenance ?? "agent ceiling"})`,
    yes: options.yes,
    input: io.input,
    parse: parseEffort,
  });
  const validationCommands = await resolveCommandList(
    "validation-commands",
    inference.validationCommands.map((candidate) => candidate.command),
    { explicit: options.validationCommands, yes: options.yes, input: io.input },
  );
  const allowedModels = options.allowedModels ?? [];
  const entry: RepoConfig = {
    owner,
    name,
    sourcePath,
    workspaceRoot,
    agent,
    provider,
    model,
    effort,
    enabled: options.enabled ?? true,
    validationCommands,
    allowedModels,
    ...(options.agentInstructions !== undefined
      ? { agentInstructions: options.agentInstructions }
      : {}),
  };

  out(`Checking proposed repository ${owner}/${name}...`);
  const checks = await checkEntry(
    entry,
    configuredRepositories,
    config.agents,
    io.verificationEnvironment,
  );
  renderChecks(checks, out);
  if (!allChecksPassed(checks)) {
    throw new SetupFlowError(
      `registration aborted for ${owner}/${name}; configuration was not changed`,
      failedChecks(checks).map((result) => `${result.message}. Remedy: ${result.remedy}`),
    );
  }

  const document = loadDocument(configPath);
  removeRepositories(document, isExampleRepositoryRecord);
  appendRepository(document, toYamlRepository(entry));
  const writeResult = writeValidatedConfig(configPath, document, io.env);
  if (!writeResult.ok) {
    throw new SetupFlowError(
      `registration aborted; generated configuration was rejected and the original file was not changed`,
      writeResult.problems,
    );
  }
  out(`Registered ${owner}/${name} in ${configPath}.`);
  return { exitCode: 0, configPath, checks };
}

/** Verify every configured entry and continue reporting after any failure. */
export async function verifyConfig(options: FlowIO & { configPath: string }): Promise<FlowResult> {
  const configPath = resolve(options.configPath);
  const io = makeIO(options, configPath);
  const config = readSetupConfig(configPath, io.env);
  const configuredRepositories = config.repositories.filter((entry) => !isExampleRepository(entry));
  let failed = false;
  const allResults: CheckResult[] = [];
  for (const [index, entry] of configuredRepositories.entries()) {
    io.out(`Repository ${entry.owner}/${entry.name}`);
    const checks = await checkEntry(
      entry,
      configuredRepositories,
      config.agents,
      io.verificationEnvironment,
      { entryIndex: index },
    );
    allResults.push(...checks);
    renderChecks(checks, io.out);
    if (!allChecksPassed(checks)) failed = true;
  }
  io.out(failed ? "Configuration verification failed." : "Configuration verification passed.");
  return { exitCode: failed ? 1 : 0, configPath, checks: allResults };
}

/** Run host onboarding and optionally hand off to the same registration flow. */
export async function setup(options: SetupOptions): Promise<FlowResult> {
  const configPath = resolve(options.configPath);
  const bootstrapped = bootstrapConfig(configPath, options.examplePath ?? defaultExamplePath());
  const io = makeIO(options, configPath);
  io.out(
    bootstrapped.created
      ? `Created configuration file ${configPath} from the shipped example.`
      : `Using existing configuration file ${configPath} as-is.`,
  );

  const report = await checkPrerequisites(configPath, io, options);
  for (const prerequisite of report.prerequisites) {
    io.out(`${prerequisite.met ? "PASS" : "FAIL"} ${prerequisite.id}: ${prerequisite.observed}`);
    if (!prerequisite.met) io.out(`  Remedy: ${prerequisite.remedy}`);
  }
  if (report.generatedConsoleToken !== undefined) {
    const tokenEnv = readTokenEnv(configPath).console;
    io.out(`Generated a console token for ${tokenEnv}; it was not persisted.`);
    io.out(`PowerShell export: $env:${tokenEnv} = '${report.generatedConsoleToken}'`);
  }
  if (!report.allMet) {
    io.out("Setup is incomplete; resolve every unmet prerequisite and run setup again.");
    return { exitCode: 1, configPath };
  }

  const loaded = readSetupConfig(configPath, io.env);
  if (loaded.repositories.length > 0 && !loaded.repositories.every(isExampleRepository)) {
    io.out(
      `Setup is complete; ${loaded.repositories.length} repository entr${loaded.repositories.length === 1 ? "y is" : "ies are"} configured.`,
    );
    return { exitCode: 0, configPath };
  }

  if (options.probe === true) {
    const probeRunner =
      io.runProbe ?? (() => runAgentProbe(buildProbeArguments(loaded, options.addRepository)));
    const probeCode = await probeRunner();
    if (probeCode !== 0) {
      io.out("FAIL agent-probe: the optional agent probe did not complete");
      io.out(
        "  Remedy: authenticate the agent and rerun the probe, or rerun setup without --probe.",
      );
      return { exitCode: 1, configPath };
    }
    io.out("PASS agent-probe: the agent probe completed");
  }

  const repoPath = options.repoPath;
  if (!repoPath) {
    if (options.yes === true) {
      throw new SetupFlowError(
        "missing repository path; supply --repo <path> to register the first repository",
      );
    }
    const input = io.input ?? createReadlineInput();
    try {
      const accepted = await resolveInput("repo", {
        describe: () => "Enter the local checkout path",
        yes: false,
        input,
        parse: (value) => (value.length > 0 ? value : undefined),
      });
      return addRepository({
        ...options.addRepository,
        configPath,
        sourcePath: accepted,
        yes: options.yes,
        env: io.env,
        input,
        out: io.out,
        err: io.err,
        verificationEnvironment: io.verificationEnvironment,
        verifyCredentials: io.verifyCredentials,
        createGitHubClient: io.createGitHubClient,
        checkAgentVersion: io.checkAgentVersion,
        examplePath: io.examplePath,
      });
    } finally {
      if (!options.input) closeInput(input);
    }
  }
  return addRepository({
    ...options.addRepository,
    configPath,
    sourcePath: repoPath,
    yes: options.yes,
    env: io.env,
    input: io.input,
    out: io.out,
    err: io.err,
    verificationEnvironment: io.verificationEnvironment,
    verifyCredentials: io.verifyCredentials,
    createGitHubClient: io.createGitHubClient,
    checkAgentVersion: io.checkAgentVersion,
    examplePath: io.examplePath,
  });
}

/** Check the same startup prerequisites without modifying the configuration. */
export async function checkPrerequisites(
  configPath: string,
  io: RequiredPick<FlowIO, "out">,
  options: Pick<SetupOptions, "probe"> = {},
): Promise<SetupReport> {
  const env = io.env ?? process.env;
  const prerequisites: PrerequisiteResult[] = [];
  let raw: Record<string, unknown> | undefined;
  let config: AppConfig | undefined;
  try {
    const text = readFileSync(configPath, "utf8");
    raw = asRecord(parseDocument(text).toJS());
    config = loadConfig(configPath, placeholderEnvironment(text, env));
    prerequisites.push({
      id: "configuration-file",
      met: true,
      observed: configPath,
      remedy: "Create the file from config.example.yaml and fix its YAML/configuration errors.",
    });
  } catch (error) {
    const message = describeError(error);
    prerequisites.push({
      id: "configuration-file",
      met: false,
      observed: message,
      remedy: "Fix the configuration YAML and every loader problem, then rerun setup.",
    });
  }

  const tokenEnv = nonEmpty(asRecord(raw?.github)?.token_env) ?? "GREMLYN_GITHUB_TOKEN";
  const login = nonEmpty(asRecord(raw?.github)?.orchestrator_login);
  const githubToken = env[tokenEnv];
  prerequisites.push({
    id: "github-token",
    met: Boolean(githubToken),
    observed: githubToken
      ? `environment variable ${tokenEnv} is set`
      : `environment variable ${tokenEnv} is not set`,
    remedy: githubToken
      ? "Keep the GitHub token in the environment only."
      : `Export ${tokenEnv} in this process without putting the token in gremlyn.yaml.`,
  });
  if (!githubToken) {
    // Identity cannot be checked without a token; the token prerequisite above
    // carries the actionable failure while preserving the existing report shape.
  } else if (!login) {
    prerequisites.push({
      id: "github-identity",
      met: false,
      observed: `github.orchestrator_login is missing; token is present in ${tokenEnv}`,
      remedy: "Set github.orchestrator_login to the dedicated account login.",
    });
  } else {
    try {
      const client = (io.createGitHubClient ?? ((token: string) => new OctokitGitHubClient(token)))(
        githubToken,
      );
      const authenticatedLogin = await client.getAuthenticatedLogin();
      const matches = authenticatedLogin.toLowerCase() === login.toLowerCase();
      prerequisites.push({
        id: "github-identity",
        met: matches,
        observed: matches
          ? `token authenticates as ${authenticatedLogin}`
          : `token authenticates as ${authenticatedLogin}, expected ${login}`,
        remedy: matches
          ? "Keep the dedicated token and configured login together."
          : `Use a token for ${login}, or set github.orchestrator_login to ${authenticatedLogin}.`,
      });
    } catch (error) {
      prerequisites.push({
        id: "github-identity",
        met: false,
        observed: `could not authenticate with ${tokenEnv}: ${describeError(error)}`,
        remedy: `Check ${tokenEnv} and its GitHub permissions, then rerun setup.`,
      });
    }
  }

  const gitConfig = asRecord(raw?.git);
  const authorName = nonEmpty(gitConfig?.author_name);
  const authorEmail = nonEmpty(gitConfig?.author_email);
  prerequisites.push({
    id: "commit-author",
    met: authorName !== undefined && authorEmail !== undefined,
    observed:
      authorName !== undefined && authorEmail !== undefined
        ? `${authorName} <${authorEmail}>`
        : "git.author_name and/or git.author_email is missing",
    remedy: "Set git.author_name and git.author_email to the intended verified commit identity.",
  });

  const consoleTokenEnv = nonEmpty(asRecord(raw?.console)?.token_env) ?? "GREMLYN_CONSOLE_TOKEN";
  const consoleToken = env[consoleTokenEnv];
  let generatedConsoleToken: string | undefined;
  if (!consoleToken) generatedConsoleToken = randomBytes(32).toString("base64url");
  prerequisites.push({
    id: "console-token",
    met: Boolean(consoleToken),
    observed: consoleToken
      ? `environment variable ${consoleTokenEnv} is set`
      : `environment variable ${consoleTokenEnv} is not set`,
    remedy: consoleToken
      ? "Keep the console token in the environment only."
      : `Export ${consoleTokenEnv}; setup can generate a value, but never writes it to disk.`,
  });

  const agents = config?.agents ?? {};
  const verifyCredentials = io.verifyCredentials ?? verifyCredentialSource;
  if (Object.keys(agents).length === 0) {
    prerequisites.push({
      id: "agent-credentials",
      met: false,
      observed: "no configured agents",
      remedy: "Configure an agent with its read-only credential_source and authenticate it.",
    });
    prerequisites.push({
      id: "agent-version",
      met: false,
      observed: "no configured agents",
      remedy: "Configure the supported Cline agent and install the expected version.",
    });
  } else {
    for (const definition of Object.values(agents)) {
      try {
        verifyCredentials(definition.id, definition.credentialSource);
        prerequisites.push({
          id: `agent-credentials:${definition.id}`,
          met: true,
          observed: `${definition.credentialSource} contains the agent credential seed files`,
          remedy: `Authenticate ${definition.id} and keep its credential source readable.`,
        });
      } catch (error) {
        prerequisites.push({
          id: `agent-credentials:${definition.id}`,
          met: false,
          observed: describeError(error),
          remedy: `Authenticate ${definition.id} and ensure its credential_source contains the expected files.`,
        });
      }
      try {
        const checkVersion =
          io.checkAgentVersion ??
          (async (agent: AgentDefinition) => {
            await new ClineExecutor(agent.binary).checkVersion(
              EXPECTED_CLINE_VERSION,
              buildAgentEnvironment(env),
            );
          });
        await checkVersion(definition);
        prerequisites.push({
          id: `agent-version:${definition.id}`,
          met: true,
          observed: `${definition.binary} is ${EXPECTED_CLINE_VERSION}`,
          remedy: `Install Cline ${EXPECTED_CLINE_VERSION} and keep it on PATH.`,
        });
      } catch (error) {
        prerequisites.push({
          id: `agent-version:${definition.id}`,
          met: false,
          observed: describeError(error),
          remedy: `Install Cline ${EXPECTED_CLINE_VERSION}, then rerun setup.`,
        });
      }
    }
  }

  // `options` is intentionally accepted so callers can share the prerequisite
  // phase with the optional probe decision without changing its report shape.
  void options;
  return {
    prerequisites,
    allMet: prerequisites.every((prerequisite) => prerequisite.met),
    ...(generatedConsoleToken !== undefined ? { generatedConsoleToken } : {}),
  };
}

function readSetupConfig(path: string, env: NodeJS.ProcessEnv): AppConfig {
  const text = readFileSync(path, "utf8");
  try {
    return loadConfig(path, placeholderEnvironment(text, env));
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new SetupFlowError(
        `configuration cannot be used: ${error.problems.join("; ")}`,
        error.problems,
      );
    }
    throw error;
  }
}

function makeIO(options: FlowIO, configPath?: string): RuntimeFlowIO {
  const env = options.env ?? process.env;
  const baseOut = options.out ?? ((line) => process.stdout.write(`${line}\n`));
  const baseErr = options.err ?? ((line) => process.stderr.write(`${line}\n`));
  const redact = createRedactor([
    ...environmentSecrets(env),
    ...configuredTokenValues(configPath, env),
  ]);
  return {
    ...options,
    env,
    cwd: options.cwd ?? process.cwd(),
    verificationEnvironment: options.verificationEnvironment ?? realVerificationEnvironment,
    out: (line) => baseOut(redact(line)),
    err: (line) => baseErr(redact(line)),
  };
}

function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        value !== undefined && /(token|secret|password|credential|api[_-]?key)/iu.test(name),
    )
    .map(([, value]) => value!);
}

function configuredTokenValues(path: string | undefined, env: NodeJS.ProcessEnv): string[] {
  if (path === undefined) return [];
  try {
    const names = readTokenEnv(path);
    return [env[names.github], env[names.console]].filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
  } catch {
    return [];
  }
}

function renderChecks(checks: readonly CheckResult[], out: (line: string) => void): void {
  for (const result of checks) {
    out(`${result.passed ? "PASS" : "FAIL"} ${result.id}: ${result.message}`);
    if (!result.passed) out(`  Remedy: ${result.remedy}`);
  }
}

function buildProbeArguments(
  config: AppConfig,
  repositoryOptions: SetupOptions["addRepository"] | undefined,
): string[] {
  const configuredRepository = config.repositories.find((entry) => !isExampleRepository(entry));
  const agentId =
    repositoryOptions?.agent ?? configuredRepository?.agent ?? Object.keys(config.agents)[0];
  const agent = agentId === undefined ? undefined : config.agents[agentId];
  if (!agent) return [];

  const provider = repositoryOptions?.provider ?? configuredRepository?.provider;
  const model = repositoryOptions?.model ?? configuredRepository?.model;
  const effort = repositoryOptions?.effort ?? configuredRepository?.effort;
  const args = ["--binary", agent.binary, "--seed-source", agent.credentialSource];
  if (provider !== undefined) args.push("--provider", provider);
  if (model !== undefined) args.push("--model", model);
  if (effort !== undefined) args.push("--effort", effort);
  return args;
}

function toYamlRepository(entry: RepoConfig): Record<string, unknown> {
  return {
    owner: entry.owner,
    name: entry.name,
    source_path: entry.sourcePath,
    workspace_root: entry.workspaceRoot,
    agent: entry.agent,
    provider: entry.provider,
    model: entry.model,
    effort: entry.effort,
    enabled: entry.enabled,
    allowed_models: [...entry.allowedModels],
    validation_commands: entry.validationCommands.map((command) => [...command]),
    ...(entry.agentInstructions !== undefined
      ? { agent_instructions: entry.agentInstructions }
      : {}),
  };
}

function parseEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTokenEnv(path: string): { github: string; console: string } {
  const raw = asRecord(parseDocument(readFileSync(path, "utf8")).toJS());
  return {
    github: nonEmpty(asRecord(raw?.github)?.token_env) ?? "GREMLYN_GITHUB_TOKEN",
    console: nonEmpty(asRecord(raw?.console)?.token_env) ?? "GREMLYN_CONSOLE_TOKEN",
  };
}

function isExampleRepository(entry: RepoConfig): boolean {
  return isExampleRepositoryRecord({
    owner: entry.owner,
    name: entry.name,
    source_path: entry.sourcePath,
  });
}

function isExampleRepositoryRecord(entry: Record<string, unknown>): boolean {
  const sourcePath = typeof entry.source_path === "string" ? entry.source_path : "";
  return (
    entry.owner === "your-github-login" &&
    entry.name === "your-repo" &&
    (sourcePath.includes("your-repo") || sourcePath.includes("your\\\\repo"))
  );
}

type RequiredPick<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> };

/** Exported for CLI callers that want the same raw path default as setup. */
export const DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_NAME;
