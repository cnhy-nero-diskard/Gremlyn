import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { CREDENTIAL_SEED_FILES, OPENCODE_CREDENTIAL_FILES } from "../agent/credentials.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../types.js";

/**
 * Config loader — file plus environment overlay, secrets sourced from
 * environment only (repository-registry spec: model/agent values are
 * validated, reasoning effort is configured and bounded).
 *
 * The configuration file never contains secret values. It names the
 * environment variables that hold them (`token_env` fields); the values are
 * read from the process environment at load time.
 */

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface AgentDefinition {
  id: string;
  /** Which registered executor runs this agent. Defaults to `id` when omitted. */
  kind: string;
  binary: string;
  /** Supported reasoning-effort tiers ordered ascending; the last is the ceiling. */
  efforts: ReasoningEffort[];
  /** Directory holding the operator-authenticated agent data (e.g. ~/.cline/data). Read-only. */
  credentialSource: string;
  /** Credential files to seed from credentialSource, defaulted per executor kind. */
  credentialFiles: string[];
}

/** Per-kind default credential set, since the files an agent needs differ by CLI. */
const DEFAULT_CREDENTIAL_FILES: Record<string, readonly string[]> = {
  cline: CREDENTIAL_SEED_FILES,
  opencode: OPENCODE_CREDENTIAL_FILES,
};

/** Kinds whose CLI takes a first-class provider argument distinct from the model id. */
export const KINDS_REQUIRING_PROVIDER = new Set(["cline"]);

export interface RepoConfig {
  owner: string;
  name: string;
  sourcePath: string;
  workspaceRoot: string;
  agent: string;
  provider: string;
  model: string;
  /** Resolved at load: the configured effort or the agent's highest tier. */
  effort: ReasoningEffort;
  enabled: boolean;
  validationCommands: string[][];
  /**
   * Repository-relative gitignored files copied from `sourcePath` into every
   * prepared workspace, for build inputs git deliberately does not carry.
   */
  workspaceSeedFiles: string[];
  agentInstructions?: string;
  allowedModels: string[];
}

export interface AppConfig {
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  pollIntervalSec: number;
  concurrency: number;
  githubToken: string;
  orchestratorLogin: string;
  commitAuthor: {
    name: string;
    email: string;
  };
  consoleHost: string;
  consolePort: number;
  consoleToken: string;
  /** Optional IANA timezone for server-rendered console wall-clock values. */
  consoleTimezone?: string;
  /** Initial per-repository agent timeout; undefined means no limit. */
  agentTimeoutSec?: number;
  agentRetries: number;
  allowedAuthors: string[];
  agents: Record<string, AgentDefinition>;
  repositories: RepoConfig[];
}

interface RawConfig {
  data_dir?: unknown;
  log_level?: unknown;
  poll_interval_seconds?: unknown;
  concurrency?: unknown;
  github?: {
    token_env?: unknown;
    orchestrator_login?: unknown;
  };
  git?: {
    author_name?: unknown;
    author_email?: unknown;
  };
  console?: {
    host?: unknown;
    port?: unknown;
    token_env?: unknown;
    timezone?: unknown;
  };
  agent_defaults?: {
    timeout_seconds?: unknown;
    retries?: unknown;
  };
  allowed_authors?: unknown;
  agents?: Record<
    string,
    {
      kind?: unknown;
      binary?: unknown;
      efforts?: unknown;
      credential_source?: unknown;
      credential_files?: unknown;
    }
  >;
  repositories?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

function asCommandList(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (!Array.isArray(entry)) return undefined;
    if (!entry.every((v) => typeof v === "string")) return undefined;
  }
  return value as string[][];
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

interface RawRepoEntry {
  owner?: unknown;
  name?: unknown;
  source_path?: unknown;
  workspace_root?: unknown;
  agent?: unknown;
  provider?: unknown;
  model?: unknown;
  effort?: unknown;
  enabled?: unknown;
  validation_commands?: unknown;
  workspace_seed_files?: unknown;
  agent_instructions?: unknown;
  allowed_models?: unknown;
}

function parseRepositories(
  rawRepos: unknown,
  agents: Record<string, AgentDefinition>,
  problems: string[],
): RepoConfig[] {
  const repositories: RepoConfig[] = [];
  if (!Array.isArray(rawRepos)) {
    problems.push("repositories must be a list");
    return repositories;
  }
  rawRepos.forEach((entry, index) => {
    const label = `repositories[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${label} must be an object`);
      return;
    }
    const r = entry as RawRepoEntry;
    const owner = asString(r.owner);
    const name = asString(r.name);
    const sourcePath = asString(r.source_path);
    const workspaceRoot = asString(r.workspace_root);
    const agent = asString(r.agent);
    const provider = asString(r.provider) ?? "";
    const model = asString(r.model);
    const enabled = asBoolean(r.enabled) ?? true;
    const validationCommands = asCommandList(r.validation_commands);
    const workspaceSeedFiles = asStringList(r.workspace_seed_files);
    const agentInstructions = asString(r.agent_instructions);
    const allowedModels = asStringList(r.allowed_models) ?? [];
    for (const [field, value] of [
      ["owner", owner],
      ["name", name],
      ["source_path", sourcePath],
      ["workspace_root", workspaceRoot],
      ["agent", agent],
      ["model", model],
    ] as const) {
      if (!value) problems.push(`${label}.${field} is required`);
    }
    if (r.validation_commands !== undefined && validationCommands === undefined) {
      problems.push(`${label}.validation_commands must be a list of argument arrays`);
    }
    if (r.workspace_seed_files !== undefined && workspaceSeedFiles === undefined) {
      problems.push(`${label}.workspace_seed_files must be a list of strings`);
    }
    // Agent must exist; effort must be within the agent's supported tiers.
    let effort: ReasoningEffort | undefined;
    const agentDef = agent ? agents[agent] : undefined;
    if (agent && !agentDef) {
      problems.push(`${label} names unknown agent "${agent}"`);
    } else if (agentDef) {
      const effortRaw = asString(r.effort);
      if (effortRaw === undefined) {
        effort = agentDef.efforts[agentDef.efforts.length - 1];
      } else if ((agentDef.efforts as string[]).includes(effortRaw)) {
        effort = effortRaw as ReasoningEffort;
      } else {
        problems.push(
          `${label}.effort "${effortRaw}" is not supported by agent "${agent}" ` +
            `(supports: ${agentDef.efforts.join(", ")})`,
        );
      }
      // Which settings are required depends on the named agent: a provider is
      // meaningful to Cline's `-P` argument but is folded into OpenCode's
      // model id, so an OpenCode entry must not be rejected for omitting it.
      if (KINDS_REQUIRING_PROVIDER.has(agentDef.kind) && !provider) {
        problems.push(
          `${label}.provider is required for agent "${agent}" (kind "${agentDef.kind}")`,
        );
      }
    }
    if (owner && name && sourcePath && workspaceRoot && agent && model && effort) {
      repositories.push({
        owner,
        name,
        sourcePath,
        workspaceRoot,
        agent,
        provider,
        model,
        effort,
        enabled,
        validationCommands: validationCommands ?? [],
        workspaceSeedFiles: workspaceSeedFiles ?? [],
        ...(agentInstructions !== undefined ? { agentInstructions } : {}),
        allowedModels,
      });
    }
  });
  return repositories;
}

/**
 * Load and validate configuration. Throws {@link ConfigError} listing every
 * problem found. Secrets arrive only through the process environment.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  let raw: RawConfig;
  try {
    raw = (parseYaml(readFileSync(path, "utf8")) ?? {}) as RawConfig;
  } catch (err) {
    throw new ConfigError([`cannot read or parse config file ${path}: ${String(err)}`]);
  }

  // Environment overlay: a small set of scalar settings may be overridden.
  const dataDir = asString(env.GREMLYN_DATA_DIR) ?? asString(raw.data_dir);
  if (!dataDir) problems.push("data_dir is required");
  const logLevelRaw = (
    asString(env.GREMLYN_LOG_LEVEL) ??
    asString(raw.log_level) ??
    "info"
  ).toLowerCase();
  const logLevel = (["debug", "info", "warn", "error"] as const).find((l) => l === logLevelRaw);
  if (!logLevel) {
    problems.push(`log_level must be one of debug|info|warn|error, got "${logLevelRaw}"`);
  }
  const pollIntervalSec =
    numberFromEnv(env.GREMLYN_POLL_INTERVAL_SECONDS) ?? asNumber(raw.poll_interval_seconds) ?? 60;
  const concurrency = numberFromEnv(env.GREMLYN_CONCURRENCY) ?? asNumber(raw.concurrency) ?? 2;
  if (concurrency < 1) problems.push("concurrency must be at least 1");

  // GitHub: the secret value comes from the environment only.
  const tokenEnv = asString(raw.github?.token_env) ?? "GREMLYN_GITHUB_TOKEN";
  const githubToken = asString(env[tokenEnv]);
  if (!githubToken) {
    problems.push(`github token missing: environment variable ${tokenEnv} is not set`);
  }
  const orchestratorLogin = asString(raw.github?.orchestrator_login);
  if (!orchestratorLogin) problems.push("github.orchestrator_login is required");

  // Git attribution is independent of the GitHub identity used to push.
  const commitAuthorName = asString(raw.git?.author_name);
  const commitAuthorEmail = asString(raw.git?.author_email);
  if (!commitAuthorName) problems.push("git.author_name is required");
  if (!commitAuthorEmail) problems.push("git.author_email is required");

  // Console.
  const consoleHost =
    asString(env.GREMLYN_CONSOLE_HOST) ?? asString(raw.console?.host) ?? "127.0.0.1";
  const consolePort =
    numberFromEnv(env.GREMLYN_CONSOLE_PORT) ?? asNumber(raw.console?.port) ?? 4780;
  const consoleTokenEnv = asString(raw.console?.token_env) ?? "GREMLYN_CONSOLE_TOKEN";
  const consoleToken = asString(env[consoleTokenEnv]);
  if (!consoleToken) {
    problems.push(`console token missing: environment variable ${consoleTokenEnv} is not set`);
  }
  const consoleTimezone = asString(raw.console?.timezone);
  if (raw.console?.timezone !== undefined && !consoleTimezone) {
    problems.push("console.timezone must be a non-empty IANA timezone");
  } else if (consoleTimezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: consoleTimezone }).format();
    } catch {
      problems.push(`console.timezone must be a valid IANA timezone (got "${consoleTimezone}")`);
    }
  }

  // Agent defaults.
  const configuredAgentTimeoutSec = asNumber(raw.agent_defaults?.timeout_seconds);
  const agentTimeoutSec = configuredAgentTimeoutSec === 0 ? undefined : configuredAgentTimeoutSec;
  const agentRetries = asNumber(raw.agent_defaults?.retries) ?? 2;
  // Cline rejects a retry budget below 1 with a warning and silently falls back
  // to its own default, so an out-of-range value here would not be the value
  // that runs. Verified against cline 3.0.60.
  if (!Number.isInteger(agentRetries) || agentRetries < 1) {
    problems.push(
      `agent_defaults.retries must be an integer >= 1 (got ${String(agentRetries)}); ` +
        "the agent CLI ignores anything lower and substitutes its own default",
    );
  }
  if (
    configuredAgentTimeoutSec !== undefined &&
    (!Number.isInteger(configuredAgentTimeoutSec) || configuredAgentTimeoutSec < 0)
  ) {
    problems.push(
      `agent_defaults.timeout_seconds must be a non-negative integer (got ${String(configuredAgentTimeoutSec)})`,
    );
  }

  // Author allowlist. The orchestrator identity must never self-authorize.
  const allowedAuthors = asStringList(raw.allowed_authors) ?? [];
  if (allowedAuthors.length === 0) problems.push("allowed_authors must not be empty");
  if (
    orchestratorLogin &&
    allowedAuthors.some((a) => a.toLowerCase() === orchestratorLogin.toLowerCase())
  ) {
    problems.push(
      `allowed_authors must not contain the orchestrator identity "${orchestratorLogin}"`,
    );
  }

  // Known agents. Each declares its binary and supported effort tiers.
  const agents: Record<string, AgentDefinition> = {};
  const rawAgents = raw.agents ?? {};
  if (typeof rawAgents !== "object" || rawAgents === null || Array.isArray(rawAgents)) {
    problems.push("agents must be a map of agent id to definition");
  } else {
    for (const [id, def] of Object.entries(rawAgents as Record<string, unknown>)) {
      const d = def as {
        kind?: unknown;
        binary?: unknown;
        efforts?: unknown;
        credential_source?: unknown;
        credential_files?: unknown;
      };
      // Id stays a free operator label; the kind selects the registered
      // executor and defaults to the id so an existing single-agent config
      // with no kind field keeps resolving to the executor it always used.
      const kind = asString(d?.kind) ?? id;
      const binary = asString(d?.binary) ?? id;
      const credentialSource = asString(d?.credential_source);
      if (!credentialSource) {
        problems.push(
          `agents.${id}.credential_source is required (conventional default: ~/.cline/data)`,
        );
      }
      const effortsRaw = asStringList(d?.efforts) ?? [...REASONING_EFFORTS];
      const efforts = effortsRaw.filter((e): e is ReasoningEffort =>
        (REASONING_EFFORTS as readonly string[]).includes(e),
      );
      if (efforts.length === 0 || effortsRaw.length !== efforts.length) {
        problems.push(`agents.${id}.efforts must list known effort tiers`);
        continue;
      }
      // Tiers must be declared in ascending order so the last is the ceiling.
      const ranks = efforts.map((e) => REASONING_EFFORTS.indexOf(e));
      const ascending = ranks.every((r, i) => i === 0 || r > (ranks[i - 1] ?? -1));
      if (!ascending) {
        problems.push(`agents.${id}.efforts must be ordered from lowest to highest`);
        continue;
      }
      const credentialFilesRaw = asStringList(d?.credential_files);
      if (d?.credential_files !== undefined && credentialFilesRaw === undefined) {
        problems.push(`agents.${id}.credential_files must be a list of strings`);
        continue;
      }
      const credentialFiles = credentialFilesRaw ?? DEFAULT_CREDENTIAL_FILES[kind] ?? [];
      if (!credentialSource) continue;
      agents[id] = { id, kind, binary, efforts, credentialSource, credentialFiles: [...credentialFiles] };
    }
  }

  // Repositories.
  const repositories = parseRepositories(raw.repositories, agents, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    dataDir: dataDir as string,
    logLevel: logLevel as AppConfig["logLevel"],
    pollIntervalSec,
    concurrency,
    githubToken: githubToken as string,
    orchestratorLogin: orchestratorLogin as string,
    commitAuthor: {
      name: commitAuthorName as string,
      email: commitAuthorEmail as string,
    },
    consoleHost,
    consolePort,
    consoleToken: consoleToken as string,
    ...(consoleTimezone === undefined ? {} : { consoleTimezone }),
    ...(agentTimeoutSec === undefined ? {} : { agentTimeoutSec }),
    agentRetries,
    allowedAuthors,
    agents,
    repositories,
  };
}
