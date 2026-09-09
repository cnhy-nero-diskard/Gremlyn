/**
 * Tests for the agent pin sync (`src/agent/pin.ts`), the tool that lets a
 * self-updating agent CLI keep working without hand-editing a pin.
 *
 * The property that matters is not "the pin follows the CLI" — that alone
 * would delete the gate the pin exists to be. It is "the pin follows the CLI
 * only while the surface the executor builds argv against is still there".
 * Both halves are asserted here against a fixture tree, with `--help` output
 * captured from the real CLIs so a passing surface check is not a tautology.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../src/agent/launcher.js";
import { syncAgentPins } from "../src/agent/pin.js";

/** Captured verbatim from `opencode run --help` on 1.18.30 (abridged to the flags Gremlyn passes). */
const OPENCODE_RUN_HELP = [
  "opencode run [message..]",
  "",
  "Options:",
  "  -h, --help         show help                                     [boolean]",
  "  -m, --model        model to use in the format of provider/model   [string]",
  "      --format       format: default (formatted) or json (raw JSON events)",
  '                             [string] [choices: "default", "json"] [default: "default"]',
  "      --dir          directory to run in                            [string]",
  "      --variant      model variant (provider-specific reasoning effort)      ",
  "      --thinking     show thinking blocks                          [boolean]",
  "      --auto         auto-approve permissions that are not explicitly denied",
].join("\n");

/** Captured verbatim from `opencode debug paths` on 1.18.30. */
const OPENCODE_DEBUG_PATHS = [
  "home       C:\\Users\\someone",
  "data       C:\\Users\\someone\\.local\\share\\opencode",
  "cache      C:\\Users\\someone\\.cache\\opencode",
  "config     C:\\Users\\someone\\.config\\opencode",
  "state      C:\\Users\\someone\\.local\\state\\opencode",
].join("\n");

/** Captured verbatim from `opencode export --help` on 1.18.30. */
const OPENCODE_EXPORT_HELP = [
  "opencode export [sessionID]",
  "",
  "Positionals:",
  "  sessionID  session id to export                                   [string]",
].join("\n");

/** Captured verbatim from `cline --help` on 3.0.61 (abridged the same way). */
const CLINE_HELP = [
  "Usage: cline [options] [command] [prompt]",
  "",
  "Options:",
  "  --json                        Output messages as JSON instead of styled text",
  "  --auto-approve <boolean>      Set tool auto-approval for all tools",
  "  -c, --cwd <path>              Working directory",
  "  --thinking <level>            Set reasoning effort",
  "  -P, --provider <id>           Provider id",
  "  -m, --model <model-id>        Model to use for the session",
  "  --retries [value]             Number of maximum consecutive mistakes",
  "  -t, --timeout <seconds>       Optional timeout in seconds",
  "  --data-dir <path>             Use isolated local state at this directory path",
].join("\n");

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, isCanceled: false };
}

/**
 * A fixture tree carrying only what the tool reads and rewrites, so a test
 * never edits the real sources it is exercising.
 */
function fixture(input: { opencodePin: string; clinePin: string; opencodeDoc?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "gremlyn-pin-"));
  mkdirSync(join(root, "src", "agent"), { recursive: true });
  writeFileSync(
    join(root, "src", "agent", "opencode.ts"),
    [
      "/**",
      " * The single OpenCode release this executor was probed against.",
      input.opencodeDoc ?? "",
      " */",
      `export const EXPECTED_OPENCODE_VERSION = "${input.opencodePin}";`,
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "src", "agent", "cline.ts"),
    `export const EXPECTED_CLINE_VERSION = "${input.clinePin}";\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "README.md"),
    [
      `Gremlyn can also run OpenCode (pinned to **${input.opencodePin}**), registered`,
      "alongside Cline.",
      `A historical note: ${input.opencodePin} also brought Zen glm-5.3.`,
      `- install the pinned release (Cline ${input.clinePin}, OpenCode ${input.opencodePin});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

/** Answers every probe the tool makes as an intact, newer OpenCode would. */
const intactRunner =
  (versions: Record<string, string>, overrides: Record<string, string> = {}): ProcessRunner =>
  (binary, args) => {
    const key = args.join(" ");
    if (key === "--version") return Promise.resolve(ok(versions[binary] ?? "0.0.0"));
    if (key in overrides) return Promise.resolve(ok(overrides[key]!));
    if (binary === "opencode") {
      if (key === "run --help") return Promise.resolve(ok(OPENCODE_RUN_HELP));
      if (key === "debug paths") return Promise.resolve(ok(OPENCODE_DEBUG_PATHS));
      if (key === "export --help") return Promise.resolve(ok(OPENCODE_EXPORT_HELP));
      if (key === "models") return Promise.resolve(ok("opencode/big-pickle\nopencode-go/qwen3.8"));
    }
    if (binary === "cline" && key === "--help") return Promise.resolve(ok(CLINE_HELP));
    throw new Error(`unexpected probe: ${binary} ${key}`);
  };

const silent = () => {
  /* the report is asserted through the returned outcomes, not stdout */
};

test("a CLI already at its pin is left completely alone", async () => {
  const root = fixture({ opencodePin: "1.18.30", clinePin: "3.0.61" });
  const before = readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8");
  const outcomes = await syncAgentPins({
    root,
    out: silent,
    runner: intactRunner({ opencode: "1.18.30", cline: "3.0.61" }),
  });

  assert.deepEqual(
    outcomes.map((outcome) => [outcome.kind, outcome.status]),
    [
      ["opencode", "in-sync"],
      ["cline", "in-sync"],
    ],
  );
  assert.equal(readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8"), before);
});

test("a newer CLI with the probed surface intact bumps the pin and its documented mentions", async () => {
  const root = fixture({ opencodePin: "1.18.29", clinePin: "3.0.61" });
  const outcomes = await syncAgentPins({
    root,
    out: silent,
    today: "2026-09-09",
    runner: intactRunner({ opencode: "1.18.30", cline: "3.0.61" }),
  });

  const opencode = outcomes.find((outcome) => outcome.kind === "opencode");
  assert.equal(opencode?.status, "bumped");
  assert.deepEqual(opencode?.status === "bumped" ? [opencode.from, opencode.to] : [], [
    "1.18.29",
    "1.18.30",
  ]);

  const source = readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8");
  assert.match(source, /EXPECTED_OPENCODE_VERSION = "1\.18\.30"/u);
  assert.doesNotMatch(source, /EXPECTED_OPENCODE_VERSION = "1\.18\.29"/u);
  // The provenance line records what was verified, inside the existing block.
  assert.match(source, /^ \* @pin-sync 1\.18\.29 -> 1\.18\.30 on 2026-09-09; surface verified/mu);
  assert.equal(source.split("/**").length - 1, 1, "no second doc comment was opened");

  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /pinned to \*\*1\.18\.30\*\*/u);
  assert.match(readme, /OpenCode 1\.18\.30/u);
  // Prose about which release introduced something is a historical claim, not
  // a pin: rewriting it would make the README say something untrue.
  assert.match(readme, /A historical note: 1\.18\.29 also brought Zen/u);
  assert.match(readme, /Cline 3\.0\.61/u, "the in-sync agent's own mention is untouched");
});

test("a second bump replaces the provenance line instead of stacking another", async () => {
  const root = fixture({
    opencodePin: "1.18.30",
    clinePin: "3.0.61",
    opencodeDoc: " * @pin-sync 1.18.29 -> 1.18.30 on 2026-09-09; surface verified via x.",
  });
  await syncAgentPins({
    root,
    out: silent,
    today: "2026-09-16",
    runner: intactRunner({ opencode: "1.18.31", cline: "3.0.61" }),
  });

  const source = readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8");
  assert.equal(source.match(/@pin-sync/gu)?.length, 1);
  assert.match(source, /@pin-sync 1\.18\.30 -> 1\.18\.31 on 2026-09-16/u);
  assert.match(source, /EXPECTED_OPENCODE_VERSION = "1\.18\.31"/u);
});

test("a newer CLI that moved a flag is refused, and the pin is left where it was", async () => {
  const root = fixture({ opencodePin: "1.18.29", clinePin: "3.0.61" });
  const before = readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8");
  const outcomes = await syncAgentPins({
    root,
    out: silent,
    // A release that renamed --variant to --effort and dropped --dir: exactly
    // the case the version gate exists to catch before a job starts.
    runner: intactRunner(
      { opencode: "2.0.0", cline: "3.0.61" },
      {
        "run --help": OPENCODE_RUN_HELP.replace("--variant", "--effort").replace(
          "      --dir          directory to run in                            [string]\n",
          "",
        ),
      },
    ),
  });

  const opencode = outcomes.find((outcome) => outcome.kind === "opencode");
  assert.equal(opencode?.status, "drifted");
  const missing = opencode?.status === "drifted" ? opencode.missing.map((entry) => entry.what) : [];
  assert.deepEqual(missing, ["--dir (workspace)", "--variant (reasoning effort)"]);
  assert.equal(
    readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8"),
    before,
    "a refused bump writes nothing",
  );
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /pinned to \*\*1\.18\.29\*\*/u);
});

test("--auto's surface check is not satisfied by a lookalike flag", async () => {
  const root = fixture({ opencodePin: "1.18.29", clinePin: "3.0.61" });
  const outcomes = await syncAgentPins({
    root,
    out: silent,
    runner: intactRunner(
      { opencode: "1.18.31", cline: "3.0.61" },
      // `--auto` replaced by `--auto-approve` is a real surface change, and a
      // substring check would have called it intact.
      { "run --help": OPENCODE_RUN_HELP.replace("--auto  ", "--auto-approve  ") },
    ),
  });

  const opencode = outcomes.find((outcome) => outcome.kind === "opencode");
  assert.equal(opencode?.status, "drifted");
  assert.deepEqual(
    opencode?.status === "drifted" ? opencode.missing.map((entry) => entry.what) : [],
    ["--auto (permission auto-approve)"],
  );
});

test("--check reports the bump it would make without touching a file", async () => {
  const root = fixture({ opencodePin: "1.18.29", clinePin: "3.0.61" });
  const before = readFileSync(join(root, "README.md"), "utf8");
  const outcomes = await syncAgentPins({
    root,
    out: silent,
    dryRun: true,
    runner: intactRunner({ opencode: "1.18.30", cline: "3.0.61" }),
  });

  const opencode = outcomes.find((outcome) => outcome.kind === "opencode");
  assert.equal(opencode?.status, "bumped");
  assert.deepEqual(opencode?.status === "bumped" ? opencode.files : ["unexpected"], []);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), before);
});

test("a bump in a CRLF checkout does not leave a lone LF behind", async () => {
  const root = mkdtempSync(join(tmpdir(), "gremlyn-pin-crlf-"));
  mkdirSync(join(root, "src", "agent"), { recursive: true });
  writeFileSync(
    join(root, "src", "agent", "opencode.ts"),
    [
      "/**",
      " * Probed surface.",
      " */",
      'export const EXPECTED_OPENCODE_VERSION = "1.18.29";',
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeFileSync(join(root, "README.md"), "pinned to **1.18.29**\r\n", "utf8");
  await syncAgentPins({
    root,
    out: silent,
    kinds: ["opencode"],
    runner: intactRunner({ opencode: "1.18.30" }),
  });

  const source = readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8");
  assert.match(source, /@pin-sync 1\.18\.29 -> 1\.18\.30/u);
  assert.equal(source.match(/(?<!\r)\n/gu), null, "every inserted line kept the file's CRLF");
});

test("a CLI that is not installed is reported, not treated as drift", async () => {
  const root = fixture({ opencodePin: "1.18.29", clinePin: "3.0.61" });
  const outcomes = await syncAgentPins({
    root,
    out: silent,
    kinds: ["cline"],
    runner: () => Promise.reject(new Error("spawn cline ENOENT")),
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, "unavailable");
  assert.match(
    outcomes[0]?.status === "unavailable" ? outcomes[0].reason : "",
    /cannot execute cline --version/u,
  );
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /Cline 3\.0\.61/u);
});

test("a version the CLI reports but cannot be parsed never becomes the pin", async () => {
  const root = fixture({ opencodePin: "1.18.29", clinePin: "3.0.61" });
  const outcomes = await syncAgentPins({
    root,
    out: silent,
    kinds: ["opencode"],
    runner: () => Promise.resolve(ok("dev build (unversioned)")),
  });

  assert.equal(outcomes[0]?.status, "unavailable");
  assert.match(readFileSync(join(root, "src", "agent", "opencode.ts"), "utf8"), /"1\.18\.29"/u);
});
