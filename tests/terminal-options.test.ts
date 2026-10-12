import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config/loader.js";
import {
  DEFAULT_TERMINAL_OPTIONS,
  parseTerminalArguments,
  resolvePresentation,
  resolveTerminalOptions,
  TerminalArgumentsError,
  type PresentationResolution,
  type TerminalOptions,
} from "../src/terminal/options.js";

const ENV = { GREMLYN_CONFIG: "/env/config.yaml" } as NodeJS.ProcessEnv;

const TTY_STREAM = { isTTY: true };
const REDIRECTED_STREAM = { isTTY: false };

/** A win32 CMD/PowerShell style environment: TERM is typically absent. */
const WIN_ENV = {} as NodeJS.ProcessEnv;

function resolve(
  options: Partial<TerminalOptions>,
  stream: { isTTY?: boolean } = REDIRECTED_STREAM,
  env: NodeJS.ProcessEnv = WIN_ENV,
  platform: NodeJS.Platform = "win32",
): PresentationResolution {
  return resolvePresentation(resolveTerminalOptions(undefined, options), stream, env, platform);
}

test("parseTerminalArguments preserves the positional config path", () => {
  assert.deepEqual(parseTerminalArguments([], ENV), {
    configPath: "/env/config.yaml",
    overrides: {},
  });
  assert.deepEqual(parseTerminalArguments(["gremlyn.yaml"], ENV), {
    configPath: "gremlyn.yaml",
    overrides: {},
  });
  // Positional path wins over the GREMLYN_CONFIG environment fallback.
  assert.deepEqual(
    parseTerminalArguments(["my-config.yaml", "--presentation", "plain", "--no-color"], ENV),
    {
      configPath: "my-config.yaml",
      overrides: { presentation: "plain", noColor: true },
    },
  );
});

test("parseTerminalArguments maps every presentation flag to overrides", () => {
  assert.deepEqual(
    parseTerminalArguments(
      ["--presentation", "terminal", "--no-color", "--no-interaction", "--sound", "--mute"],
      {},
    ),
    {
      configPath: undefined,
      overrides: {
        presentation: "terminal",
        noColor: true,
        noInteraction: true,
        sound: true,
        mute: true,
      },
    },
  );
  // Flags may appear before, between, or after the positional config path.
  assert.deepEqual(
    parseTerminalArguments(["--sound", "gremlyn.yaml", "--presentation", "json"], {}),
    {
      configPath: "gremlyn.yaml",
      overrides: { sound: true, presentation: "json" },
    },
  );
});

test("parseTerminalArguments treats an empty argv without env as fully defaulted", () => {
  assert.deepEqual(parseTerminalArguments([], {}), {
    configPath: undefined,
    overrides: {},
  });
});

test("parseTerminalArguments rejects unknown flags with concise usage", () => {
  assert.throws(
    () => parseTerminalArguments(["--presentation", "plain", "--not-a-flag"], {}),
    (error: unknown) =>
      error instanceof TerminalArgumentsError &&
      /--not-a-flag/u.test(error.message) &&
      /Presentation options:/u.test(error.message),
  );
});

test("parseTerminalArguments rejects an invalid --presentation value", () => {
  assert.throws(
    () => parseTerminalArguments(["--presentation", "fancy"], {}),
    (error: unknown) =>
      error instanceof TerminalArgumentsError &&
      /--presentation must be one of auto\|terminal\|plain\|json/u.test(error.message) &&
      /got "fancy"/u.test(error.message),
  );
});

test("resolveTerminalOptions applies defaults and lets overrides win", () => {
  assert.deepEqual(resolveTerminalOptions(undefined, {}), DEFAULT_TERMINAL_OPTIONS);
  assert.deepEqual(resolveTerminalOptions(undefined, { presentation: "json" }), {
    ...DEFAULT_TERMINAL_OPTIONS,
    presentation: "json",
  });
  assert.deepEqual(resolveTerminalOptions({ presentation: "plain", sound: true }, {}), {
    presentation: "plain",
    noColor: false,
    noInteraction: false,
    sound: true,
    mute: false,
  });
});

test("resolveTerminalOptions never collapses an explicit false", () => {
  assert.deepEqual(resolveTerminalOptions({ noColor: false, mute: false }, {}), {
    ...DEFAULT_TERMINAL_OPTIONS,
    noColor: false,
    mute: false,
  });
  // Command-line overrides beat the configuration block.
  assert.deepEqual(
    resolveTerminalOptions({ presentation: "terminal", noColor: true }, { presentation: "json" }),
    {
      ...DEFAULT_TERMINAL_OPTIONS,
      presentation: "json",
      noColor: true,
    },
  );
});

test("auto mode picks terminal on a supported interactive Windows terminal", () => {
  const result = resolve({}, TTY_STREAM, WIN_ENV, "win32");
  assert.deepEqual(result, { mode: "terminal", color: true, interactive: true });
});

test("auto mode falls back to json for redirected stderr", () => {
  assert.deepEqual(resolve({}, REDIRECTED_STREAM, WIN_ENV, "win32"), {
    mode: "json",
    color: false,
    interactive: false,
  });
  assert.deepEqual(resolve({}, {}, WIN_ENV, "win32"), {
    mode: "json",
    color: false,
    interactive: false,
  });
});

test("auto mode excludes CI and no-interaction environments", () => {
  const ciResult = resolve({}, TTY_STREAM, { ...WIN_ENV, CI: "true" }, "win32");
  assert.deepEqual(ciResult, { mode: "json", color: false, interactive: false });
  const ghActions = resolve({}, TTY_STREAM, { ...WIN_ENV, GITHUB_ACTIONS: "1" }, "win32");
  assert.equal(ghActions.mode, "json");
  const noInteraction = resolve({ noInteraction: true }, TTY_STREAM, WIN_ENV, "win32");
  assert.deepEqual(noInteraction, { mode: "json", color: false, interactive: false });
  // CI=false explicitly is not CI.
  const notCi = resolve({}, TTY_STREAM, { ...WIN_ENV, CI: "false" }, "win32");
  assert.equal(notCi.mode, "terminal");
});

test("auto mode excludes a TERM=dumb terminal on any platform", () => {
  const dumbWin = resolve({}, TTY_STREAM, { ...WIN_ENV, TERM: "dumb" }, "win32");
  assert.deepEqual(dumbWin, { mode: "json", color: false, interactive: false });
  const dumbLinux = resolve({}, TTY_STREAM, { TERM: "dumb" }, "linux");
  assert.equal(dumbLinux.mode, "json");
});

test("auto mode requires a declared TERM outside Windows", () => {
  const withoutTerm = resolve({}, TTY_STREAM, {}, "linux");
  assert.equal(withoutTerm.mode, "json");
  const withTerm = resolve({}, TTY_STREAM, { TERM: "xterm-256color" }, "linux");
  assert.deepEqual(withTerm, { mode: "terminal", color: true, interactive: true });
});

test("explicit json and plain are honored unconditionally without controls", () => {
  assert.deepEqual(resolve({ presentation: "json" }, TTY_STREAM, WIN_ENV, "win32"), {
    mode: "json",
    color: false,
    interactive: false,
  });
  assert.deepEqual(resolve({ presentation: "plain" }, TTY_STREAM, WIN_ENV, "win32"), {
    mode: "plain",
    color: false,
    interactive: false,
  });
  assert.deepEqual(
    resolve({ presentation: "json", sound: true }, REDIRECTED_STREAM, WIN_ENV, "win32"),
    { mode: "json", color: false, interactive: false },
  );
});

test("explicit terminal is honored on a usable stream and degrades safely otherwise", () => {
  assert.deepEqual(resolve({ presentation: "terminal" }, TTY_STREAM, WIN_ENV, "win32"), {
    mode: "terminal",
    color: true,
    interactive: true,
  });
  // Redirected stream: degrade to plain, never emit cursor codes.
  const redirected = resolve({ presentation: "terminal" }, REDIRECTED_STREAM, WIN_ENV, "win32");
  assert.deepEqual(redirected, {
    mode: "plain",
    color: false,
    interactive: false,
    reason: "presentation stream is not a TTY",
  });
  // CI cannot be overridden by an explicit terminal request.
  const ci = resolve({ presentation: "terminal" }, TTY_STREAM, { ...WIN_ENV, CI: "true" }, "win32");
  assert.equal(ci.mode, "plain");
  assert.equal(ci.reason, "CI environment detected");
  // --no-interaction behaves the same way.
  const noInteraction = resolve(
    { presentation: "terminal", noInteraction: true },
    TTY_STREAM,
    WIN_ENV,
    "win32",
  );
  assert.equal(noInteraction.mode, "plain");
  assert.equal(noInteraction.reason, "interaction disabled (--no-interaction)");
  // A dumb terminal cannot be forced.
  const dumb = resolve({ presentation: "terminal" }, TTY_STREAM, { TERM: "dumb" }, "win32");
  assert.equal(dumb.mode, "plain");
  assert.equal(dumb.reason, "terminal cursor handling is unsupported");
});

test("color follows --no-color and NO_COLOR but never disables interactivity", () => {
  const flag = resolve({ noColor: true }, TTY_STREAM, WIN_ENV, "win32");
  assert.deepEqual(flag, { mode: "terminal", color: false, interactive: true });
  const envNoColor = resolve({}, TTY_STREAM, { ...WIN_ENV, NO_COLOR: "1" }, "win32");
  assert.deepEqual(envNoColor, { mode: "terminal", color: false, interactive: true });
  // An empty NO_COLOR does not disable color (no-color.org).
  const emptyNoColor = resolve({}, TTY_STREAM, { ...WIN_ENV, NO_COLOR: "" }, "win32");
  assert.equal(emptyNoColor.color, true);
  // Redirected output never carries color even without any no-color flag.
  const redirected = resolve({}, REDIRECTED_STREAM, WIN_ENV, "win32");
  assert.equal(redirected.mode, "json");
  assert.equal(redirected.color, false);
});

// --- loader integration: the optional terminal block ---

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

const VALID_ENV = {
  GREMLYN_GITHUB_TOKEN: "ghp_test_token",
  GREMLYN_CONSOLE_TOKEN: "console_test_token",
} as NodeJS.ProcessEnv;

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-terminal-config-"));
  const path = join(dir, "gremlyn.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

test("loader leaves AppConfig.terminal absent when the block is omitted", () => {
  const config = loadConfig(writeConfig(VALID_CONFIG), VALID_ENV);
  assert.equal(config.terminal, undefined);
});

test("loader resolves the terminal block with defaults applied", () => {
  const config = loadConfig(
    writeConfig(`${VALID_CONFIG}\nterminal:\n  presentation: plain\n  sound: true\n`),
    VALID_ENV,
  );
  assert.deepEqual(config.terminal, {
    presentation: "plain",
    noColor: false,
    noInteraction: false,
    sound: true,
    mute: false,
  });
});

test("loader accepts a fully specified terminal block", () => {
  const config = loadConfig(
    writeConfig(
      `${VALID_CONFIG}\nterminal:\n  presentation: terminal\n  no_color: true\n  no_interaction: true\n  sound: true\n  mute: true\n`,
    ),
    VALID_ENV,
  );
  assert.deepEqual(config.terminal, {
    presentation: "terminal",
    noColor: true,
    noInteraction: true,
    sound: true,
    mute: true,
  });
});

test("loader rejects an invalid terminal.presentation value", () => {
  assert.throws(
    () => loadConfig(writeConfig(`${VALID_CONFIG}\nterminal:\n  presentation: fancy\n`), VALID_ENV),
    (error: unknown) =>
      error instanceof ConfigError &&
      /terminal\.presentation must be one of auto\|terminal\|plain\|json/u.test(error.message),
  );
});

test("loader rejects non-boolean terminal sound/mute/color fields", () => {
  for (const field of ["no_color", "no_interaction", "sound", "mute"]) {
    assert.throws(
      () => loadConfig(writeConfig(`${VALID_CONFIG}\nterminal:\n  ${field}: yes\n`), VALID_ENV),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.problems.some((problem) => problem.includes(`terminal.${field} must be a boolean`)),
    );
  }
});

test("loader rejects scalar, null and list terminal blocks", () => {
  for (const value of ["true", "null", "[plain]", '"plain"']) {
    assert.throws(
      () => loadConfig(writeConfig(`${VALID_CONFIG}\nterminal: ${value}\n`), VALID_ENV),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.problems.includes("terminal must be a configuration object"),
    );
  }
});
