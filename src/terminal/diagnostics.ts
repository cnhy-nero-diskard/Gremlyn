import { ConfigError } from "../config/loader.js";
import { createRedactor } from "../log/redact.js";
import { PRESENTATION_MODES, type TerminalOptions } from "./options.js";

/** Select only safe presentation intent when strict argument parsing itself fails. */
export function diagnosticOverrides(argv: readonly string[]): Partial<TerminalOptions> {
  const options: Partial<TerminalOptions> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value =
      arg === "--presentation"
        ? argv[index + 1]
        : arg.startsWith("--presentation=")
          ? arg.slice(15)
          : undefined;
    const mode = PRESENTATION_MODES.find((candidate) => candidate === value);
    if (mode) options.presentation = mode;
    if (arg === "--no-color") options.noColor = true;
    if (arg === "--no-interaction") options.noInteraction = true;
  }
  return options;
}

export type StartupStage =
  | "arguments"
  | "configuration"
  | "ownership"
  | "store"
  | "credentials"
  | "github"
  | "version"
  | "recovery"
  | "startup";

const ADVICE: Record<StartupStage, [string, string]> = {
  arguments: [
    "Invalid launch options",
    "Use [config-path] --presentation auto|terminal|plain|json [--no-color] [--no-interaction] [--sound] [--mute].",
  ],
  configuration: [
    "Configuration could not be loaded or validated",
    "Check the config path, required settings and token environment variable names; run npm run verify:config.",
  ],
  ownership: [
    "Data directory ownership could not be acquired",
    "Stop the other daemon using this data directory; do not delete a live ownership lock.",
  ],
  store: [
    "The operational store could not be opened",
    "Check data-directory permissions and available disk space.",
  ],
  credentials: [
    "Agent credentials are unavailable",
    "Authenticate the configured agent and check its credential_source directory.",
  ],
  github: [
    "GitHub authentication or identity preflight failed",
    "Check the GitHub token permissions, network access and configured orchestrator_login.",
  ],
  version: [
    "Agent version preflight failed",
    "Install the pinned agent version and check the configured binary; keep npm prestart pin safety enabled.",
  ],
  recovery: [
    "Startup recovery could not finish",
    "Inspect persisted logs and retained attempts before retrying; do not remove quarantined workspaces.",
  ],
  startup: [
    "Daemon startup failed",
    "Inspect persisted logs, console port availability and repository configuration, then retry.",
  ],
};

/** No arbitrary error payload (YAML excerpts, subprocess output, or env dumps) escapes. */
export function startupDiagnostic(
  error: unknown,
  stage: StartupStage,
): { cause: string; nextAction: string } {
  const [cause, nextAction] = ADVICE[stage];
  const detail =
    error instanceof ConfigError ? ` (${error.problems.length} configuration problem(s))` : "";
  return { cause: cause + detail, nextAction };
}

export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    /(?:TOKEN|PASSWORD|SECRET|API_KEY)/i.test(name) && value ? [value] : [],
  );
}

export function formatStartupDiagnostic(
  error: unknown,
  stage: StartupStage,
  secrets: readonly string[],
): { event: string; nextAction: string } {
  const diagnostic = startupDiagnostic(error, stage);
  const redact = createRedactor(secrets);
  return { event: redact(diagnostic.cause), nextAction: redact(diagnostic.nextAction) };
}
