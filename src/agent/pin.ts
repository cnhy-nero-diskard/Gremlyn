/**
 * Agent pin sync — keeps the pinned agent-CLI releases Gremlyn refuses to
 * start without (`EXPECTED_CLINE_VERSION`, `EXPECTED_OPENCODE_VERSION`)
 * tracking the releases actually installed, so a self-updating CLI does not
 * strand startup.
 *
 * The pins exist because each executor encodes an inferred argv surface: a
 * drifting CLI is refused at startup rather than failing mid-job (design D10,
 * D-opencode). Bumping a pin is fine; bumping it *blindly* is what the gate
 * was protecting against. So this tool never bumps on a version number alone
 * — it re-probes the surface its executor documents, and only then rewrites:
 *
 *   installed == pin                  -> nothing to do
 *   installed != pin, surface intact  -> rewrite the pin and its documented mentions
 *   installed != pin, surface drifted -> refuse, naming the flag that moved
 *
 * That carries `npm start` across the routine patch releases OpenCode ships
 * several times a week (the common case, where nothing Gremlyn passes has
 * changed) while still stopping at the release that actually moves a flag.
 *
 * The surface checks are deliberately the same commands `opencode.ts` names in
 * its own bump note — `run --help`, `debug paths`, `export --help` — so this
 * automates the review that comment asks for instead of substituting for it.
 * It is not a replacement for `npm run probe:agent`, which exercises a real
 * authenticated invocation; a bump made here is still worth a probe before it
 * is trusted for a long run.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { extractVersion } from "./cline.js";
import { buildAgentEnvironment } from "./environment.js";
import { defaultRunner, type ProcessRunner } from "./launcher.js";
import { EXECUTOR_EXPECTED_VERSIONS } from "./registry.js";

/** Repository root, so the tool rewrites sources rather than build output. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * A flag as it appears in `--help` text, matched on its own rather than as a
 * substring: `--auto` must not be satisfied by Cline's `--auto-approve`, and
 * `-m` must not be satisfied by the word "model".
 */
function flag(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s,=]|$)`, "mu");
}

/** One `--help`-style invocation whose output must still show a known surface. */
interface SurfaceCheck {
  /** How the check is named in output — the argv, near enough to retype. */
  readonly label: string;
  readonly args: readonly string[];
  /** Every pattern that must match; a miss is reported by its own name. */
  readonly requires: readonly { readonly what: string; readonly pattern: RegExp }[];
}

/** A literal mention of the pin in prose, replaced verbatim rather than by regex. */
interface DocPin {
  /** Repository-relative file. */
  readonly file: string;
  /** Text containing `{version}`; every occurrence of the rendered old form is replaced. */
  readonly template: string;
}

interface PinnedAgent {
  readonly kind: string;
  /** Binary as it is invoked — the same default the executor uses. */
  readonly binary: string;
  /** The npm package that installs it, for the pin-back remedy. */
  readonly packageName: string;
  /** Repository-relative file holding the pin constant. */
  readonly sourceFile: string;
  readonly constantName: string;
  readonly surface: readonly SurfaceCheck[];
  readonly docPins: readonly DocPin[];
}

function req(what: string, pattern: RegExp): { what: string; pattern: RegExp } {
  return { what, pattern };
}

/**
 * The surface each executor actually depends on, per kind. Every entry
 * corresponds to an argument the executor's `run` builds, or to state its
 * `additionalEnvironment` relocates; nothing is listed for completeness.
 */
const PINNED_AGENTS: readonly PinnedAgent[] = [
  {
    kind: "opencode",
    binary: "opencode",
    packageName: "opencode-ai",
    sourceFile: "src/agent/opencode.ts",
    constantName: "EXPECTED_OPENCODE_VERSION",
    surface: [
      {
        label: "run --help",
        args: ["run", "--help"],
        requires: [
          req("--dir (workspace)", flag("--dir")),
          req("-m (provider/model)", flag("-m")),
          req("--format (structured stream)", flag("--format")),
          req('--format choice "json"', /\bjson\b/u),
          req("--auto (permission auto-approve)", flag("--auto")),
          req("--thinking", flag("--thinking")),
          req("--variant (reasoning effort)", flag("--variant")),
        ],
      },
      {
        label: "debug paths",
        args: ["debug", "paths"],
        requires: [
          req("data path (auth.json, opencode.db)", /^data\s/mu),
          req("state path (locks/)", /^state\s/mu),
        ],
      },
      {
        label: "export --help",
        args: ["export", "--help"],
        requires: [req("sessionID positional (transcript export)", /sessionID/u)],
      },
    ],
    docPins: [
      { file: "README.md", template: "pinned to **{version}**" },
      { file: "README.md", template: "OpenCode {version}" },
      { file: "README.md", template: "opencode-ai@{version}" },
    ],
  },
  {
    kind: "cline",
    binary: "cline",
    packageName: "@cline/cli",
    sourceFile: "src/agent/cline.ts",
    constantName: "EXPECTED_CLINE_VERSION",
    surface: [
      {
        label: "--help",
        args: ["--help"],
        requires: [
          req("-c (working directory)", flag("-c")),
          req("-m (model)", flag("-m")),
          req("-P (provider)", flag("-P")),
          req("--json (structured stream)", flag("--json")),
          req("--thinking (reasoning effort)", flag("--thinking")),
          req("-t (timeout seconds)", flag("-t")),
          req("--data-dir (isolated state)", flag("--data-dir")),
          req("--auto-approve", flag("--auto-approve")),
          req("--retries", flag("--retries")),
        ],
      },
    ],
    docPins: [
      { file: "README.md", template: "Cline CLI {version}" },
      { file: "README.md", template: "Cline {version}" },
      { file: "README.md", template: "@cline/cli@{version}" },
    ],
  },
];

export type PinOutcome =
  | { readonly kind: string; readonly status: "in-sync"; readonly version: string }
  | {
      readonly kind: string;
      readonly status: "bumped";
      readonly from: string;
      readonly to: string;
      readonly files: readonly string[];
      readonly staleMentions: readonly string[];
    }
  | {
      readonly kind: string;
      readonly status: "drifted";
      readonly from: string;
      readonly to: string;
      readonly missing: readonly { readonly check: string; readonly what: string }[];
    }
  | { readonly kind: string; readonly status: "unavailable"; readonly reason: string };

export interface PinSyncOptions {
  /** Only these kinds; every registered kind when omitted or empty. */
  readonly kinds?: readonly string[];
  /** Report without writing — the `--check` shape. */
  readonly dryRun?: boolean;
  readonly runner?: ProcessRunner;
  readonly root?: string;
  readonly today?: string;
  /** Per-line reporter; defaults to stdout. */
  readonly out?: (line: string) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The newline a file already uses. Every rewrite here is a substring swap that
 * preserves line endings by construction, except the inserted provenance line
 * — which would otherwise leave a lone LF in a CRLF checkout.
 */
function newlineOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/** The pin as the source file spells it, which is the value this tool rewrites. */
function readPin(root: string, agent: PinnedAgent): { source: string; version: string } {
  const source = readFileSync(resolve(root, agent.sourceFile), "utf8");
  const match = source.match(new RegExp(`${agent.constantName}\\s*=\\s*"([^"]+)"`, "u"));
  const parsed = match?.[1];
  if (parsed === undefined) {
    throw new Error(`could not find ${agent.constantName} in ${agent.sourceFile}`);
  }
  // Cross-check against the exported value: a regex that matched some other
  // literal would otherwise rewrite something that is not the pin at all.
  // Only for the real tree — a test or fixture root holds its own constants,
  // and comparing those against this process's imports proves nothing.
  const exported = root === REPO_ROOT ? EXECUTOR_EXPECTED_VERSIONS[agent.kind] : undefined;
  if (exported !== undefined && exported !== parsed) {
    throw new Error(`${agent.constantName} parsed as ${parsed} but the module exports ${exported}`);
  }
  return { source, version: parsed };
}

/** Every remaining mention of the superseded version, for human review. */
function staleMentions(root: string, files: readonly string[], version: string): string[] {
  const found: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(resolve(root, file), "utf8");
    } catch {
      continue;
    }
    text.split(/\r?\n/u).forEach((line, index) => {
      if (line.includes(version)) found.push(`${file}:${String(index + 1)}`);
    });
  }
  return found;
}

/**
 * Rewrite the pin constant, the provenance line this tool owns, and the
 * documented mentions. Returns the files actually changed.
 */
function applyBump(input: {
  root: string;
  agent: PinnedAgent;
  source: string;
  from: string;
  to: string;
  today: string;
  checks: readonly string[];
}): string[] {
  const { root, agent, source, from, to, today, checks } = input;
  const changed: string[] = [];

  let next = source.replace(
    new RegExp(`(${agent.constantName}\\s*=\\s*")[^"]+(")`, "u"),
    `$1${to}$2`,
  );
  // A provenance line this tool owns end to end, so repeated auto-bumps leave
  // a readable trail instead of silently ageing the hand-written note above
  // it. It goes inside the constant's existing doc comment rather than in a
  // second block of its own, which reads as two unrelated comments.
  const body = `@pin-sync ${from} -> ${to} on ${today}; surface verified via ${checks.join(", ")}.`;
  const existing = /^[ \t]*\*[ \t]*@pin-sync .*$/mu;
  // The doc comment immediately preceding the declaration: a comment body
  // cannot contain `*/`, so the alternation stops at the first close and
  // backtracking walks forward to the block that actually abuts the constant.
  const precedingDoc = new RegExp(
    `(/\\*\\*(?:[^*]|\\*(?!/))*)(\\*/\\s*export const ${agent.constantName}\\s*=)`,
    "u",
  );
  const eol = newlineOf(source);
  if (existing.test(next)) {
    next = next.replace(existing, ` * ${body}`);
  } else if (precedingDoc.test(next)) {
    next = next.replace(precedingDoc, `$1* ${body}${eol} $2`);
  } else {
    next = next.replace(
      new RegExp(`(export const ${agent.constantName}\\s*=)`, "u"),
      `/**${eol} * ${body}${eol} */${eol}$1`,
    );
  }
  if (next !== source) {
    writeFileSync(resolve(root, agent.sourceFile), next, "utf8");
    changed.push(agent.sourceFile);
  }

  for (const pin of agent.docPins) {
    const path = resolve(root, pin.file);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const before = pin.template.replace("{version}", from);
    if (!text.includes(before)) continue;
    writeFileSync(path, text.replaceAll(before, pin.template.replace("{version}", to)), "utf8");
    if (!changed.includes(pin.file)) changed.push(pin.file);
  }

  return changed;
}

/**
 * Report OpenCode-hosted model ids the bundled picker no longer matches. A
 * roster change never blocks a run — the executor passes `-m` through verbatim
 * — but README ties re-pasting `opencode models` to a pin bump, so an
 * auto-bump that said nothing would quietly leave the console's picker stale.
 */
async function reportRosterDrift(input: {
  root: string;
  binary: string;
  runner: ProcessRunner;
  env: Record<string, string>;
  out: (line: string) => void;
}): Promise<void> {
  let catalog: string;
  try {
    catalog = readFileSync(resolve(input.root, "src/agent/provider-catalog.ts"), "utf8");
  } catch {
    return;
  }
  const result = await input.runner(input.binary, ["models"], { env: input.env });
  if (result.exitCode !== 0) return;
  const live = new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^opencode(-go)?\//u.test(line)),
  );
  const bundled = new Set(
    [...catalog.matchAll(/"(opencode(?:-go)?\/[^"]+)"/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
  const added = [...live].filter((id) => !bundled.has(id)).sort();
  const removed = [...bundled].filter((id) => !live.has(id)).sort();
  if (added.length === 0 && removed.length === 0) {
    input.out("  models       roster unchanged — the bundled picker still matches");
    return;
  }
  input.out(
    `  models       roster moved: ${String(added.length)} new, ${String(removed.length)} gone`,
  );
  if (added.length > 0) input.out(`               + ${added.join(", ")}`);
  if (removed.length > 0) input.out(`               - ${removed.join(", ")}`);
  input.out("               paste `opencode models` into OPENCODE_ZEN_MODEL_IDS /");
  input.out("               OPENCODE_GO_MODEL_IDS in src/agent/provider-catalog.ts to");
  input.out("               offer these in the console picker (runs are unaffected)");
}

/** Sync every requested pin, reporting as it goes. Writes nothing when `dryRun`. */
export async function syncAgentPins(options: PinSyncOptions = {}): Promise<PinOutcome[]> {
  const runner = options.runner ?? defaultRunner;
  const root = options.root ?? REPO_ROOT;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const env = buildAgentEnvironment();
  const wanted = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : undefined;
  const agents = PINNED_AGENTS.filter((agent) => !wanted || wanted.has(agent.kind));
  const outcomes: PinOutcome[] = [];

  for (const agent of agents) {
    out("");
    out(agent.kind);
    out("-".repeat(agent.kind.length));

    let pinned: { source: string; version: string };
    try {
      pinned = readPin(root, agent);
    } catch (error) {
      out(`  pin          UNREADABLE — ${describe(error)}`);
      outcomes.push({ kind: agent.kind, status: "unavailable", reason: describe(error) });
      continue;
    }
    out(`  pinned       ${pinned.version} (${agent.sourceFile})`);

    let installed: string | undefined;
    try {
      const version = await runner(agent.binary, ["--version"], { env });
      if (version.exitCode !== 0) {
        const reason = `${agent.binary} --version exited ${String(version.exitCode)}: ${version.stderr.trim() || "(no stderr)"}`;
        out(`  installed    UNAVAILABLE — ${reason}`);
        outcomes.push({ kind: agent.kind, status: "unavailable", reason });
        continue;
      }
      installed = extractVersion(version.stdout);
    } catch (error) {
      const reason = `cannot execute ${agent.binary} --version: ${describe(error)}`;
      out(`  installed    UNAVAILABLE — ${reason}`);
      outcomes.push({ kind: agent.kind, status: "unavailable", reason });
      continue;
    }
    if (installed === undefined) {
      const reason = `${agent.binary} --version printed no x.y.z version`;
      out(`  installed    UNAVAILABLE — ${reason}`);
      outcomes.push({ kind: agent.kind, status: "unavailable", reason });
      continue;
    }
    out(`  installed    ${installed}`);

    if (installed === pinned.version) {
      out("  result       in sync — startup will accept this CLI");
      outcomes.push({ kind: agent.kind, status: "in-sync", version: installed });
      continue;
    }

    const missing: { check: string; what: string }[] = [];
    for (const check of agent.surface) {
      let haystack: string;
      try {
        const result = await runner(agent.binary, check.args, { env });
        haystack = `${result.stdout}\n${result.stderr}`;
      } catch (error) {
        missing.push({ check: check.label, what: `could not run: ${describe(error)}` });
        out(`  surface      ${agent.binary} ${check.label} — COULD NOT RUN`);
        continue;
      }
      const absent = check.requires.filter((entry) => !entry.pattern.test(haystack));
      for (const entry of absent) missing.push({ check: check.label, what: entry.what });
      const total = check.requires.length;
      out(
        absent.length === 0
          ? `  surface      ${agent.binary} ${check.label} — ok (${String(total)} ${total === 1 ? "check" : "checks"})`
          : `  surface      ${agent.binary} ${check.label} — ${String(absent.length)} of ${String(total)} MISSING`,
      );
      for (const entry of absent) out(`               missing: ${entry.what}`);
    }

    if (missing.length > 0) {
      out(`  result       REFUSED — ${installed} moved a surface Gremlyn depends on`);
      out(`               the pin stays at ${pinned.version}; reinstall it to keep running:`);
      out(`                 npm install -g ${agent.packageName}@${pinned.version}`);
      out("               then re-probe before pinning forward:");
      out(
        `                 npm run probe:agent -- --kind ${agent.kind} --provider <id> --model <id>`,
      );
      outcomes.push({
        kind: agent.kind,
        status: "drifted",
        from: pinned.version,
        to: installed,
        missing,
      });
      continue;
    }

    if (agent.kind === "opencode") {
      await reportRosterDrift({ root, binary: agent.binary, runner, env, out });
    }

    if (options.dryRun === true) {
      out(`  result       would bump ${pinned.version} -> ${installed} (surface intact)`);
      outcomes.push({
        kind: agent.kind,
        status: "bumped",
        from: pinned.version,
        to: installed,
        files: [],
        staleMentions: [],
      });
      continue;
    }

    const files = applyBump({
      root,
      agent,
      source: pinned.source,
      from: pinned.version,
      to: installed,
      today,
      checks: agent.surface.map((check) => `${agent.binary} ${check.label}`),
    });
    const stale = staleMentions(
      root,
      [
        "README.md",
        "src/agent/provider-catalog.ts",
        ...new Set(PINNED_AGENTS.map((entry) => entry.sourceFile)),
      ],
      pinned.version,
    );
    out(`  result       bumped ${pinned.version} -> ${installed} (surface intact)`);
    out(`  wrote        ${files.length > 0 ? files.join(", ") : "(nothing — already current)"}`);
    if (stale.length > 0) {
      out(`  review       ${pinned.version} still named at ${stale.join(", ")}`);
      out("               (prose and provenance notes are left to a human)");
    }
    outcomes.push({
      kind: agent.kind,
      status: "bumped",
      from: pinned.version,
      to: installed,
      files,
      staleMentions: stale,
    });
  }

  return outcomes;
}

export async function pinSyncCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      kind: { type: "string", multiple: true },
      check: { type: "boolean" },
      auto: { type: "boolean" },
    },
    allowPositionals: false,
  });

  // `--auto` is the `prestart` shape: it self-heals the routine case, stays
  // quiet about a CLI that is simply not installed, and never fails the start
  // itself. A surface that really drifted is left to the orchestrator's own
  // `checkVersion`, so the operator sees the one canonical refusal instead of
  // a second one from a helper that happened to run first.
  const auto = values.auto === true;
  const check = values.check === true;
  const lines: string[] = [];
  const outcomes = await syncAgentPins({
    ...(values.kind ? { kinds: values.kind } : {}),
    ...(check ? { dryRun: true } : {}),
    out: (line) => lines.push(line),
  });

  const bumped = outcomes.filter((outcome) => outcome.status === "bumped");
  const drifted = outcomes.filter((outcome) => outcome.status === "drifted");
  const unavailable = outcomes.filter((outcome) => outcome.status === "unavailable");

  // In auto mode a fully in-sync run is the common case and should say
  // nothing; anything else prints the whole report.
  if (!auto || bumped.length > 0 || drifted.length > 0) {
    for (const line of lines) process.stdout.write(`${line}\n`);
    process.stdout.write("\n");
  }

  for (const outcome of bumped) {
    if (outcome.status !== "bumped") continue;
    process.stdout.write(
      check
        ? `${outcome.kind}: pin ${outcome.from} is behind the installed ${outcome.to} (surface intact) — run \`npm run pin:sync\`\n`
        : `${outcome.kind}: pin bumped ${outcome.from} -> ${outcome.to}; commit ${outcome.files.join(", ")}\n`,
    );
  }
  for (const outcome of drifted) {
    if (outcome.status !== "drifted") continue;
    process.stdout.write(
      `${outcome.kind}: ${outcome.to} changed the CLI surface — pin left at ${outcome.from}\n`,
    );
  }

  if (auto) return 0;
  if (drifted.length > 0) return 1;
  if (check && bumped.length > 0) return 1;
  if (outcomes.length > 0 && unavailable.length === outcomes.length) return 1;
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  pinSyncCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${describe(error)}\n`);
      process.exitCode = 1;
    });
}
