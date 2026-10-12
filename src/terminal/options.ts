/**
 * Terminal operator experience — presentation configuration and resolution.
 *
 * Owns the optional terminal configuration surface and CLI flags introduced by
 * the terminal-operator-experience change (tasks 1.1/1.2). Human presentation
 * owns stderr, because that is where the existing structured JSON logs already
 * write; resolution therefore tests the *presentation* stream itself (stderr
 * in the daemon) rather than assuming stdout proves anything.
 *
 * Precedence is: command-line flags > configuration file block > defaults.
 * Summary of the resolution rules (design D1):
 *
 * - `auto`    → terminal only when the presentation stream is a usable TTY,
 *               CI/no-interaction are absent, and basic cursor handling is
 *               supported; otherwise the non-TTY default is `json` (no cursor
 *               or color controls emitted).
 * - `terminal`→ same usability gate as `auto`, but an explicit request cannot
 *               override a known unsafe/non-interactive stream: it degrades to
 *               `plain` without cursor codes and explains once (a `reason`).
 * - `plain`   → explicit append-only readable output, never interactive.
 * - `json`    → explicit machine-readable output, never interactive.
 *
 * Audio stays off unless explicitly enabled, independent of presentation mode.
 */

import { parseArgs } from "node:util";

export type PresentationMode = "auto" | "terminal" | "plain" | "json";

export const PRESENTATION_MODES: readonly PresentationMode[] = [
  "auto",
  "terminal",
  "plain",
  "json",
];

/** Resolved terminal presentation and sound controls (defaults applied). */
export interface TerminalOptions {
  presentation: PresentationMode;
  noColor: boolean;
  noInteraction: boolean;
  sound: boolean;
  mute: boolean;
}

export const DEFAULT_TERMINAL_OPTIONS: Readonly<TerminalOptions> = {
  presentation: "auto",
  noColor: false,
  noInteraction: false,
  sound: false,
  mute: false,
};

export const TERMINAL_OPTIONS_USAGE = `Presentation options:
  --presentation auto|terminal|plain|json   Presentation mode (default: auto).
  --no-color                                Disable ANSI color (honors NO_COLOR).
  --no-interaction                          Disable interactive terminal behavior.
  --sound                                   Enable audible completion cues (default: off).
  --mute                                    Mute audible completion cues.
  [config-path]                             Optional configuration file; falls back to
                                            GREMLYN_CONFIG, then gremlyn.yaml.`;

/** Raised when the launch arguments are unusable; carries concise usage. */
export class TerminalArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalArgumentsError";
  }
}

const OPTION_DEFINITIONS = {
  presentation: { type: "string" },
  "no-color": { type: "boolean" },
  "no-interaction": { type: "boolean" },
  sound: { type: "boolean" },
  mute: { type: "boolean" },
} as const;

interface ParsedValues {
  presentation?: string;
  "no-color"?: boolean;
  "no-interaction"?: boolean;
  sound?: boolean;
  mute?: boolean;
}

/**
 * Parse the daemon launch arguments ahead of bootstrap.
 *
 * Preserves the existing positional configuration-path contract: the first
 * positional argument is the configuration file, with `GREMLYN_CONFIG` as the
 * fallback (matching `main`'s current `argv[0] ?? env.GREMLYN_CONFIG`). Unknown
 * flags and invalid option values fail safely with concise usage rather than
 * surfacing as a file-read error. Extra positionals are ignored, matching the
 * pre-existing launch behavior that only read `argv[0]`.
 */
export function parseTerminalArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { configPath: string | undefined; overrides: Partial<TerminalOptions> } {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTION_DEFINITIONS,
      allowPositionals: true,
      strict: true,
    }) as unknown as { values: Record<string, unknown>; positionals: string[] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TerminalArgumentsError(`${detail}\n\n${TERMINAL_OPTIONS_USAGE}`);
  }

  const values = parsed.values as ParsedValues;
  const overrides: Partial<TerminalOptions> = {};
  if (values.presentation !== undefined) {
    const mode = values.presentation as PresentationMode;
    if (!PRESENTATION_MODES.includes(mode)) {
      throw new TerminalArgumentsError(
        `--presentation must be one of ${PRESENTATION_MODES.join("|")}, got "${values.presentation}".\n\n${TERMINAL_OPTIONS_USAGE}`,
      );
    }
    overrides.presentation = mode;
  }
  if (values["no-color"] === true) overrides.noColor = true;
  if (values["no-interaction"] === true) overrides.noInteraction = true;
  if (values.sound === true) overrides.sound = true;
  if (values.mute === true) overrides.mute = true;

  return {
    configPath: parsed.positionals[0] ?? env.GREMLYN_CONFIG,
    overrides,
  };
}

/**
 * Merge resolved configuration with command-line overrides over the defaults.
 * Command-line overrides win over the configuration block, which wins over
 * defaults. `false` values are honored (never collapsed by a default).
 */
export function resolveTerminalOptions(
  config: Partial<TerminalOptions> | undefined,
  overrides: Partial<TerminalOptions>,
): TerminalOptions {
  return {
    presentation:
      overrides.presentation ?? config?.presentation ?? DEFAULT_TERMINAL_OPTIONS.presentation,
    noColor: overrides.noColor ?? config?.noColor ?? DEFAULT_TERMINAL_OPTIONS.noColor,
    noInteraction:
      overrides.noInteraction ?? config?.noInteraction ?? DEFAULT_TERMINAL_OPTIONS.noInteraction,
    sound: overrides.sound ?? config?.sound ?? DEFAULT_TERMINAL_OPTIONS.sound,
    mute: overrides.mute ?? config?.mute ?? DEFAULT_TERMINAL_OPTIONS.mute,
  };
}

/** Outcome of resolving the presentation mode against the real stream. */
export interface PresentationResolution {
  mode: "terminal" | "plain" | "json";
  color: boolean;
  interactive: boolean;
  /** Why an explicit terminal request was degraded; omitted on normal paths. */
  reason?: string;
}

/** Common CI markers. `CI` is special-cased so an explicit "false"/"0" is not CI. */
const CI_ENVIRONMENT_VARIABLES = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "TRAVIS",
  "CIRCLECI",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "APPVEYOR",
  "BITRISE_IO",
  "GO_JOB_NAME",
] as const;

function detectCi(env: NodeJS.ProcessEnv): boolean {
  for (const name of CI_ENVIRONMENT_VARIABLES) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (name === "CI") {
      const normalized = value.toLowerCase();
      if (normalized === "false" || normalized === "0") continue;
    }
    return true;
  }
  return false;
}

function colorRequested(options: TerminalOptions, env: NodeJS.ProcessEnv): boolean {
  if (options.noColor) return false;
  // no-color.org: NO_COLOR suppresses color when present and not an empty
  // string (regardless of its value).
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  return true;
}

/**
 * Whether the basic cursor/line handling this surface needs is available.
 *
 * Windows CMD and PowerShell frequently leave `TERM` unset yet still support
 * the small anchored cursor updates used here, so an absent `TERM` is allowed
 * on win32. A `dumb` TERM (any platform) cannot address the cursor and is
 * excluded. Other platforms are expected to declare a `TERM`.
 */
function supportsBasicCursorHandling(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const term = env.TERM;
  if (term === "dumb") return false;
  if (platform === "win32") return true;
  return typeof term === "string" && term.length > 0;
}

/**
 * Resolve the presentation mode against the actual presentation stream.
 *
 * `stream` is the stream that owns human presentation (stderr in the daemon).
 * The returned object never mixes interactive cursor/color writing into a
 * mode the operator did not explicitly enable: non-interactive outcomes carry
 * `color: false` and `interactive: false` so no control codes are emitted.
 */
export function resolvePresentation(
  options: TerminalOptions,
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PresentationResolution {
  const requested = options.presentation;

  // An explicit non-interactive mode is honored unconditionally.
  if (requested === "json") {
    return { mode: "json", color: false, interactive: false };
  }
  if (requested === "plain") {
    return { mode: "plain", color: false, interactive: false };
  }

  const isTty = stream.isTTY === true;
  const ci = detectCi(env);
  const cursorSupported = supportsBasicCursorHandling(env, platform);
  const usable = isTty && !options.noInteraction && !ci && cursorSupported;

  if (requested === "terminal") {
    if (usable) {
      return {
        mode: "terminal",
        color: colorRequested(options, env),
        interactive: true,
      };
    }
    // Explicit terminal cannot override a known unsafe/non-interactive stream:
    // degrade to plain (never json, which changes data semantics) and explain.
    return {
      mode: "plain",
      color: false,
      interactive: false,
      reason: whyNotUsable({ isTty, noInteraction: options.noInteraction, ci, cursorSupported }),
    };
  }

  // `auto` (including the default): preserve JSON as the non-TTY default.
  if (usable) {
    return {
      mode: "terminal",
      color: colorRequested(options, env),
      interactive: true,
    };
  }
  return { mode: "json", color: false, interactive: false };
}

function whyNotUsable(input: {
  isTty: boolean;
  noInteraction: boolean;
  ci: boolean;
  cursorSupported: boolean;
}): string {
  if (!input.isTty) return "presentation stream is not a TTY";
  if (input.ci) return "CI environment detected";
  if (input.noInteraction) return "interaction disabled (--no-interaction)";
  if (!input.cursorSupported) return "terminal cursor handling is unsupported";
  return "presentation stream is not interactive";
}
