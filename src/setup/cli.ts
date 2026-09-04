import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  addRepository,
  defaultConfigPath,
  reclaimConfiguredWorkspaces,
  setup,
  unlockDataDirectory,
  verifyConfig,
  type AddRepositoryOptions,
  type FlowIO,
  type SetupOptions,
} from "./flows.js";
import { createReadlineInput, nonInteractiveInput } from "./input.js";

const COMMANDS = ["setup", "add-repo", "verify", "unlock", "reclaim"] as const;
type Command = (typeof COMMANDS)[number];

interface CliValues {
  help?: boolean;
  yes?: boolean;
  config?: string;
  repo?: string;
  probe?: boolean;
  owner?: string;
  name?: string;
  "workspace-root"?: string;
  "adopt-worktree"?: boolean;
  agent?: string;
  provider?: string;
  model?: string;
  effort?: string;
  "allowed-model"?: string | string[];
  "validation-command"?: string | string[];
  "no-validation"?: boolean;
  "agent-instructions"?: string;
  enabled?: boolean;
  disabled?: boolean;
  example?: string;
  preview?: boolean;
  apply?: boolean;
}

const OPTION_DEFINITIONS = {
  help: { type: "boolean", short: "h" },
  yes: { type: "boolean", short: "y" },
  config: { type: "string", short: "c" },
  repo: { type: "string", short: "r" },
  probe: { type: "boolean" },
  owner: { type: "string" },
  name: { type: "string" },
  "workspace-root": { type: "string" },
  "adopt-worktree": { type: "boolean" },
  agent: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  "allowed-model": { type: "string", multiple: true },
  "validation-command": { type: "string", multiple: true },
  "no-validation": { type: "boolean" },
  "agent-instructions": { type: "string" },
  enabled: { type: "boolean" },
  disabled: { type: "boolean" },
  example: { type: "string" },
  preview: { type: "boolean" },
  apply: { type: "boolean" },
} as const;

export const HELP = `Gremlyn guided setup CLI

Usage:
  npm run setup -- [flags]
  npm run add-repo -- <path> [flags]
  npm run verify:config -- [flags]
  npm run setup -- unlock <data-dir> [flags]
  npm run setup -- reclaim [flags]

Subcommands:
  setup       Bootstrap gremlyn.yaml, report host prerequisites, and optionally register a repository.
  add-repo    Infer, verify, and append one explicit repository entry.
  verify      Verify every configured repository without writing anything.
  unlock      Release a data-directory claim without starting the orchestrator.
  reclaim     Preview deterministic workspace reclamation; use --apply after enabling it.

Flags:
  -h, --help                    Show this help.
  -y, --yes                     Accept derived proposals; confirm a live-owner unlock.
  -c, --config <path>           Configuration file (default: GREMLYN_CONFIG or gremlyn.yaml).
  -r, --repo <path>             Local checkout for setup's first repository registration.
      --probe                   Run the optional seeded agent probe during setup.
      --owner <owner>            Explicit GitHub owner.
      --name <name>              Explicit GitHub repository name.
      --workspace-root <path>    Explicit workspace root outside source repositories.
      --adopt-worktree            Allow clean foreign checkouts to be adopted.
      --agent <id>               Explicit configured agent id.
      --provider <id>            Explicit agent provider.
      --model <id>               Explicit model.
      --effort <tier>            Explicit reasoning tier.
      --allowed-model <id>       Allowed model; repeat for a non-empty allowed_models list.
      --validation-command <cmd> Validation argv; repeat, e.g. "npm test" or '["npm","test"]'.
      --no-validation             Confirm an empty validation_commands list.
      --agent-instructions <txt> Repository-specific instructions.
      --enabled                  Write enabled: true (the default).
      --disabled                 Write enabled: false.
      --example <path>           Setup bootstrap source instead of config.example.yaml.
      --preview                  Report reclamation decisions without removing anything (default).
      --apply                    Apply reclamation; requires workspace_reclamation.enabled: true.

Every value that can be prompted has an explicit flag. In a non-interactive shell,
pass --yes to accept derived values or supply the missing flags explicitly.
`;

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] as string | undefined;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "verify:config") return runWithCommand("verify", argv.slice(1));
  if (!COMMANDS.includes(command as Command)) {
    process.stderr.write(`Unknown setup command "${command}".\n\n${HELP}`);
    return 2;
  }
  return runWithCommand(command as Command, argv.slice(1));
}

async function runWithCommand(command: Command, args: readonly string[]): Promise<number> {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...args],
      options: OPTION_DEFINITIONS,
      allowPositionals: true,
      strict: true,
    }) as unknown as { values: Record<string, unknown>; positionals: string[] };
  } catch (error) {
    process.stderr.write(`${describe(error)}\n\n${HELP}`);
    return 2;
  }
  const values = parsed.values as CliValues;
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.enabled === true && values.disabled === true) {
    process.stderr.write("Use only one of --enabled or --disabled.\n");
    return 2;
  }
  if (values["no-validation"] === true && stringArray(values["validation-command"]).length > 0) {
    process.stderr.write("Use either --no-validation or --validation-command, not both.\n");
    return 2;
  }
  if (values.preview === true && values.apply === true) {
    process.stderr.write("Use only one of --preview or --apply.\n");
    return 2;
  }

  const input = interactive() ? createReadlineInput() : nonInteractiveInput();
  const io: FlowIO = { input };
  const configPath = values.config ?? defaultConfigPath();
  try {
    if (command === "setup") {
      const options: SetupOptions = {
        configPath,
        yes: values.yes,
        repoPath: values.repo,
        probe: values.probe,
        examplePath: values.example,
        addRepository: repositoryOptions(values),
        ...io,
      };
      return (await setup(options)).exitCode;
    }
    if (command === "add-repo") {
      const sourcePath = parsed.positionals[0];
      if (!sourcePath || parsed.positionals.length !== 1) {
        process.stderr.write("add-repo requires exactly one positional <path>.\n\n");
        process.stderr.write(HELP);
        return 2;
      }
      const options: AddRepositoryOptions = {
        configPath,
        sourcePath,
        yes: values.yes,
        ...repositoryOptions(values),
        ...io,
      };
      return (await addRepository(options)).exitCode;
    }
    if (command === "unlock") {
      if (!parsed.positionals[0] || parsed.positionals.length !== 1) {
        process.stderr.write("unlock requires exactly one positional <data-dir>.\n\n");
        process.stderr.write(HELP);
        return 2;
      }
      return (
        await unlockDataDirectory({
          dataDir: parsed.positionals[0],
          yes: values.yes,
          ...io,
        })
      ).exitCode;
    }
    if (command === "reclaim") {
      if (parsed.positionals.length > 0) {
        process.stderr.write("reclaim does not accept positional paths; use --config.\n");
        return 2;
      }
      return (
        await reclaimConfiguredWorkspaces({
          configPath,
          preview: values.apply !== true,
          ...io,
        })
      ).exitCode;
    }
    if (parsed.positionals.length > 0) {
      process.stderr.write("verify does not accept positional paths; use --config.\n");
      return 2;
    }
    return (await verifyConfig({ configPath, ...io })).exitCode;
  } catch (error) {
    const message = describe(error);
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    input.close?.();
  }
}

function repositoryOptions(
  values: CliValues,
): Omit<AddRepositoryOptions, "configPath" | "sourcePath" | keyof FlowIO> {
  const allowedModels = stringArray(values["allowed-model"]);
  const validationCommands = stringArray(values["validation-command"]).map(parseCommand);
  return {
    ...(values.owner !== undefined ? { owner: values.owner } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values["workspace-root"] !== undefined ? { workspaceRoot: values["workspace-root"] } : {}),
    ...(values["adopt-worktree"] === true ? { adoptWorktree: true } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
    ...(values.provider !== undefined ? { provider: values.provider } : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values.effort !== undefined ? { effort: values.effort } : {}),
    ...(allowedModels.length > 0 ? { allowedModels } : {}),
    ...(values["no-validation"] === true || validationCommands.length > 0
      ? { validationCommands: values["no-validation"] === true ? [] : validationCommands }
      : {}),
    ...(values["agent-instructions"] !== undefined
      ? { agentInstructions: values["agent-instructions"] }
      : {}),
    ...(values.enabled === true ? { enabled: true } : {}),
    ...(values.disabled === true ? { enabled: false } : {}),
  };
}

function stringArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseCommand(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
        return [...parsed];
      }
    } catch {
      // Fall through to a whitespace argv parse with a useful literal result.
    }
  }
  return trimmed.split(/\s+/u).filter((part) => part.length > 0);
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${describe(error)}\n`);
      process.exitCode = 1;
    });
}
