/**
 * Agent probe — a diagnostic that exercises a real agent CLI through its real
 * executor, with no config file, no SQLite store, and no GitHub token.
 *
 * It exists because the test suite injects a fake `ProcessRunner` everywhere, so
 * the suite proves Gremlyn *constructs* the documented argv but never that the
 * CLI *accepts* it. This closes that gap cheaply, ahead of the full acceptance
 * run. Generalized from a Cline-only tool (design D10) to probe either
 * registered executor by kind (design D-opencode).
 *
 * It answers three questions the inferred CLI contract leaves open:
 *   1. Is the installed CLI the version its executor was probed against?
 *   2. Does provider authentication survive a fresh per-attempt isolated state
 *      directory? (Isolation is per attempt; the operator's own `auth`
 *      persists it somewhere else. If those coincide, every attempt starts
 *      unauthenticated.)
 *   3. Does the structured stream actually carry a session id in the shape
 *      `extractSessionId` expects? A mismatch is silent: the console simply
 *      never gets an export handle.
 *
 * Nothing here writes to a workspace: each run gets a throwaway working
 * directory and a read-only prompt.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EXPECTED_CLINE_VERSION, extractSessionId, extractVersion } from "./cline.js";
import { CREDENTIAL_SEED_FILES, OPENCODE_CREDENTIAL_FILES, seedAgentCredentials } from "./credentials.js";
import { AGENT_ENV_ALLOWLIST, buildAgentEnvironment } from "./environment.js";
import { defaultRunner, type ProcessRunner } from "./launcher.js";
import { EXPECTED_OPENCODE_VERSION } from "./opencode.js";
import { EXECUTOR_FACTORIES } from "./registry.js";
import { REASONING_EFFORTS, type AgentResult, type ReasoningEffort } from "../types.js";
import { isAgentAuthenticationFailure } from "../orchestrator/failures.js";

/** Diagnostic-display expectation per kind; the authoritative check is `executor.checkVersion`. */
const EXPECTED_VERSION_BY_KIND: Record<string, string> = {
  cline: EXPECTED_CLINE_VERSION,
  opencode: EXPECTED_OPENCODE_VERSION,
};

/** Default credential set shown in probe output before a `--seed-files` override. */
const DEFAULT_SEED_FILES_BY_KIND: Record<string, readonly string[]> = {
  cline: CREDENTIAL_SEED_FILES,
  opencode: OPENCODE_CREDENTIAL_FILES,
};

/** A read-only instruction: the probe tests the invocation surface, not editing. */
const PROBE_PROMPT =
  "Reply with the single word READY and stop. " +
  "Do not create, modify, or delete any files. Do not run any commands.";

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function heading(title: string): void {
  out();
  out(title);
  out("-".repeat(title.length));
}

/** Show the payload verbatim, indented, so real CLI output is never reshaped. */
function block(label: string, body: string): void {
  const trimmed = body.trim();
  if (trimmed === "") {
    out(`${label}: (empty)`);
    return;
  }
  out(`${label}:`);
  for (const line of trimmed.split(/\r?\n/u)) out(`  | ${line}`);
}

/** Wrap the real runner so the probe reports the exact argv that was spawned. */
function recordingRunner(sink: { argv?: readonly string[] }): ProcessRunner {
  return (binary, args, options) => {
    sink.argv = [binary, ...args];
    return defaultRunner(binary, args, options);
  };
}

/** Every distinct top-level key across JSON-parsable stdout lines. */
function observedJsonKeys(stdout: string): string[] {
  const keys = new Set<string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) keys.add(key);
      }
    } catch {
      // Non-JSON output is expected on a stream that is not purely structured.
    }
  }
  return [...keys].sort();
}

interface ProbeRun {
  label: string;
  dataDir: string;
  result: AgentResult;
  argv: readonly string[];
  elapsedMs: number;
  seededFiles?: readonly string[];
}

async function runOnce(input: {
  label: string;
  kind: string;
  binary: string;
  model: string;
  provider: string;
  effort: ReasoningEffort;
  timeoutSec: number;
  scratch: string;
  seedSource: string | undefined;
  seedFiles: readonly string[] | undefined;
}): Promise<ProbeRun> {
  const dataDir = mkdtempSync(join(input.scratch, "data-"));
  const cwd = mkdtempSync(join(input.scratch, "work-"));
  const sink: { argv?: readonly string[] } = {};
  const factory = EXECUTOR_FACTORIES[input.kind];
  if (!factory) throw new Error(`no probe executor registered for kind "${input.kind}"`);
  const executor = factory(input.binary, recordingRunner(sink));
  heading(`Run: ${input.label}`);
  out(`data-dir     ${dataDir}`);
  out(`cwd          ${cwd}`);
  const isolationEnv = executor.additionalEnvironment(dataDir);
  if (Object.keys(isolationEnv).length > 0) {
    out(`state env    ${JSON.stringify(isolationEnv)}`);
  }
  let seeded: readonly string[] | undefined;
  if (input.seedSource) {
    const files = input.seedFiles ?? DEFAULT_SEED_FILES_BY_KIND[input.kind] ?? CREDENTIAL_SEED_FILES;
    try {
      const copied = seedAgentCredentials(input.seedSource, dataDir, files);
      seeded = copied;
      out(`seeded       ${copied.join(", ")} from ${input.seedSource}`);
      // Verify permissions: report that files are owner-only where possible
      out(`seed list    [${copied.map((f) => `"${f}"`).join(", ")}]`);
    } catch (error) {
      out(`seed failed  ${describe(error)}`);
      throw error;
    }
  } else {
    out(`seeded       (none — fresh isolated dir)`);
  }
  out(`waiting      up to ${String(input.timeoutSec)}s for the agent to exit...`);
  const startedAt = Date.now();
  const result = await executor.run({
    cwd,
    model: input.model,
    provider: input.provider,
    effort: input.effort,
    prompt: PROBE_PROMPT,
    env: buildAgentEnvironment(process.env, isolationEnv),
    timeoutSec: input.timeoutSec,
    retries: 1,
    dataDir,
    signal: AbortSignal.timeout((input.timeoutSec + 15) * 1_000),
  });
  return {
    label: input.label,
    dataDir,
    result,
    argv: sink.argv ?? [],
    elapsedMs: Date.now() - startedAt,
    ...(seeded ? { seededFiles: seeded } : {}),
  };
}

function reportRun(run: ProbeRun): void {
  out(`argv         ${JSON.stringify(run.argv)}`);
  out(`exit code    ${String(run.result.exitCode)}`);
  out(`timed out    ${String(run.result.timedOut)}`);
  out(`elapsed      ${String(run.elapsedMs)} ms`);
  if (run.seededFiles) {
    out(`seeded       ${run.seededFiles.join(", ")}`);
  } else {
    out(`seeded       (none)`);
  }
  const sessionId = extractSessionId(run.result.stdout);
  out(`session id   ${sessionId ?? "(not found by extractSessionId)"}`);
  const keys = observedJsonKeys(run.result.stdout);
  out(`json keys    ${keys.length > 0 ? keys.join(", ") : "(no JSON object lines)"}`);
  block("stdout", run.result.stdout);
  block("stderr", run.result.stderr);
  if (run.result.timedOut && run.result.stdout.trim() === "") {
    out("hint         timed out having written nothing — the agent is likely");
    out("             waiting on input or on a network call that never returns");
  }
  // Highlight authentication failure distinctly
  if (isAgentAuthenticationFailure(run.result)) {
    out(`auth         provider authentication failed`);
  } else if (run.result.exitCode === 0) {
    out(`auth         completed — agent authenticated`);
  }
}

export async function probe(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      kind: { type: "string" },
      binary: { type: "string" },
      model: { type: "string" },
      provider: { type: "string" },
      effort: { type: "string" },
      timeout: { type: "string" },
      "seed-source": { type: "string" },
      "seed-files": { type: "string" },
    },
    allowPositionals: false,
  });

  const kind = values.kind ?? process.env.GREMLYN_PROBE_KIND ?? "cline";
  if (!EXECUTOR_FACTORIES[kind]) {
    out(`kind "${kind}" is not a registered executor (known: ${Object.keys(EXECUTOR_FACTORIES).join(", ")})`);
    return 1;
  }
  const binary = values.binary ?? process.env.GREMLYN_PROBE_BINARY ?? kind;
  const model = values.model ?? process.env.GREMLYN_PROBE_MODEL;
  const provider = values.provider ?? process.env.GREMLYN_PROBE_PROVIDER;
  const effortRaw = values.effort ?? process.env.GREMLYN_PROBE_EFFORT ?? "none";
  const timeoutSec = Number(values.timeout ?? process.env.GREMLYN_PROBE_TIMEOUT ?? "120");
  const seedSource =
    (values["seed-source"] as string | undefined) ?? process.env.GREMLYN_PROBE_SEED_SOURCE;
  const seedFilesRaw =
    (values["seed-files"] as string | undefined) ?? process.env.GREMLYN_PROBE_SEED_FILES;
  const seedFiles = seedFilesRaw
    ? seedFilesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  if (!(REASONING_EFFORTS as readonly string[]).includes(effortRaw)) {
    out(`effort "${effortRaw}" is not a known tier (${REASONING_EFFORTS.join(", ")})`);
    return 1;
  }
  const effort = effortRaw as ReasoningEffort;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    out(`timeout "${String(values.timeout)}" must be a positive number of seconds`);
    return 1;
  }

  heading("Environment");
  out(`kind         ${kind}`);
  out(`binary       ${binary}`);
  const env = buildAgentEnvironment();
  const present = AGENT_ENV_ALLOWLIST.filter((key) => env[key] !== undefined);
  const absent = AGENT_ENV_ALLOWLIST.filter((key) => env[key] === undefined);
  out(`passed       ${present.join(", ")}`);
  out(`unset        ${absent.length > 0 ? absent.join(", ") : "(none)"}`);
  out("note         no provider API keys are in the allowlist; the agent must find");
  out("             credentials via HOME/APPDATA/USERPROFILE or its own state directory");

  heading("Version");
  const versionSink: { argv?: readonly string[] } = {};
  let version: ProbeRunVersion;
  try {
    version = await readVersion(binary, recordingRunner(versionSink), env);
  } catch (error) {
    out(`could not execute "${binary} --version": ${describe(error)}`);
    out(`${binary} is not installed, not on PATH, or not executable. Nothing else can run.`);
    return 1;
  }
  out(`argv         ${JSON.stringify(versionSink.argv ?? [])}`);
  out(`exit code    ${String(version.exitCode)}`);
  block("stdout", version.stdout);
  if (version.stderr.trim() !== "") block("stderr", version.stderr);
  if (version.exitCode !== 0) {
    out();
    out(`"${binary} --version" exited ${String(version.exitCode)}.`);
    out(`${binary} is not installed, not on PATH, or not executable. Nothing else can run.`);
    return 1;
  }
  const parsed = extractVersion(version.stdout);
  const expectedVersion = EXPECTED_VERSION_BY_KIND[kind];
  out(`parsed       ${parsed ?? "(extractVersion found no x.y.z)"}`);
  out(`expected     ${expectedVersion ?? "(no expectation registered for this kind)"}`);
  out(
    parsed === expectedVersion
      ? "match        yes — the orchestrator will start"
      : `match        NO — checkVersion() rejects this at startup (exact-match pin)`,
  );

  if (model === undefined || provider === undefined) {
    heading("Invocation runs: SKIPPED");
    out("Supply a provider and model to exercise the real invocation surface:");
    out("  npm run probe:agent -- --provider <id> --model <id>");
    out("or set GREMLYN_PROBE_PROVIDER and GREMLYN_PROBE_MODEL.");
    out("Use the same values as the repository entry you intend to run.");
    return 0;
  }

  // Seeded-run mode: if a credential source is supplied, run one unseeded
  // and one seeded isolated dir to verify the declared file set suffices.
  // This directly exercises design D3's empirical claim.
  const defaultSeedFiles = DEFAULT_SEED_FILES_BY_KIND[kind] ?? CREDENTIAL_SEED_FILES;
  if (seedSource) {
    heading(`Seed configuration`);
    out(`source       ${seedSource}`);
    out(`files        ${(seedFiles ?? [...defaultSeedFiles]).join(", ")}`);
    out(`note         these files will be copied into the seeded data dir`);
    out(`             with owner-only perms before invocation`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "gremlyn-probe-"));
  try {
    if (seedSource) {
      const first = await runOnce({
        label: "first — fresh data dir (unseeded)",
        kind,
        binary,
        model,
        provider,
        effort,
        timeoutSec,
        scratch,
        seedSource: undefined,
        seedFiles: undefined,
      });
      reportRun(first);

      const second = await runOnce({
        label: "second — fresh data dir (seeded)",
        kind,
        binary,
        model,
        provider,
        effort,
        timeoutSec,
        scratch,
        seedSource: seedSource,
        seedFiles: seedFiles,
      });
      reportRun(second);

      heading("Findings");
      const unseededFailed = first.result.exitCode !== 0;
      const seededOk = second.result.exitCode === 0;
      const seededUnauthorized = /Unauthorized/iu.test(
        `${second.result.stdout}\n${second.result.stderr}`,
      );
      out(`seed list    [${(seedFiles ?? [...defaultSeedFiles]).map((f) => `"${f}"`).join(", ")}]`);
      // Providers fail differently when unseeded: cline-pass says
      // "Unauthorized", openai-codex says "API key is missing". The property
      // that matters is unseeded-fails-and-seeded-succeeds, not the wording.
      out(
        seededOk && unseededFailed && !seededUnauthorized
          ? "auth         seeded run completed where unseeded failed"
          : seededOk
            ? "auth         seeded run succeeded (but unseeded did too — see below)"
            : "auth         seeded run failed — seed set may be incomplete",
      );
      if (unseededFailed && seededOk) {
        out("             --data-dir isolation with seeding restores credentials");
      } else if (!unseededFailed) {
        out(
          "             NOTE: unseeded run succeeded — --data-dir may not have isolated credentials",
        );
        out("             (check that the provider uses the data dir for auth)");
      } else if (!seededOk) {
        // Do NOT read "OPENAI_API_KEY" in the error as proof the credential
        // is env-only: cline names the env var as one of two options, and
        // openai-codex in fact stores an OAuth token at
        // settings/providers.json. A missing-key error usually means the seed
        // set is too narrow, and the decisive check is whether the same
        // invocation works with no --data-dir at all.
        const seededHay = `${second.result.stdout}\n${second.result.stderr}`;
        if (/Unauthorized/iu.test(seededHay)) {
          out("             HINT: the credential was seeded but rejected — present");
          out("             and invalid (expired, revoked, or wrong account), not");
          out("             missing. Re-authenticate at the source, then re-run.");
        } else {
          out("             HINT: the seed set is probably too narrow for this");
          out("             provider. Find the file it needs:");
          out("               1. confirm the credential is on disk at all —");
          out("                  run the same argv with NO --data-dir; if that");
          out("                  works, the credential exists and is unseeded");
          out("               2. `ls -lat <source>` and look for what changed when");
          out("                  you last ran `cline auth <provider>`");
          out("               3. re-run with --seed-files including it (nested");
          out("                  paths are allowed, e.g. settings/providers.json)");
        }
      }
      const sessionFound =
        extractSessionId(first.result.stdout) !== undefined ||
        extractSessionId(second.result.stdout) !== undefined;
      out(
        sessionFound
          ? "session id   extractSessionId() matched real output"
          : "session id   NOT FOUND — no taskId on the stream",
      );
      if (!sessionFound) {
        out("             Compare against the json keys listed above; the");
        out("             console's transcript link depends on this id.");
      }
      // Success criteria for seeded mode: unseeded Unauthorized + seeded completed
      // Success is "isolation broke it, seeding fixed it" — keyed on the
      // unseeded run failing at all, not on a provider-specific message.
      const seededModeOk = unseededFailed && seededOk;
      return seededModeOk ? 0 : 1;
    }

    const first = await runOnce({
      label: "first — fresh data dir",
      kind,
      binary,
      model,
      provider,
      effort,
      timeoutSec,
      scratch,
      seedSource: undefined,
      seedFiles: undefined,
    });
    reportRun(first);

    const second = await runOnce({
      label: "second — a different fresh data dir",
      kind,
      binary,
      model,
      provider,
      effort,
      timeoutSec,
      scratch,
      seedSource: undefined,
      seedFiles: undefined,
    });
    reportRun(second);

    heading("Findings");
    const bothOk = first.result.exitCode === 0 && second.result.exitCode === 0;
    out(
      bothOk
        ? "auth         both runs succeeded on independent data dirs — per-attempt"
        : "auth         at least one run failed; compare stderr above",
    );
    if (bothOk) {
      out("             --data-dir isolation does not strand credentials");
    } else if (first.result.exitCode === 0 && second.result.exitCode !== 0) {
      out("             NOTE: run 1 passed and run 2 failed on an identical setup.");
      out("             That is the signature of state cached in the first data dir.");
    }
    const bothUnauthorized = [first, second].every((run) =>
      /Unauthorized/iu.test(`${run.result.stdout}
${run.result.stderr}`),
    );
    if (bothUnauthorized) {
      // Without --seed-source this mode IS the control: it reproduces the
      // original defect on purpose. Say so, or the expected result reads as
      // a regression.
      out();
      out("This is the UNSEEDED control and Unauthorized is the expected result:");
      out("both runs used a fresh isolated state directory, which is where the");
      out("agent keeps its credentials. To exercise the fix, re-run with the");
      out("credential source this agent is configured with (config.example.yaml):");
      out();
      out(`  npm run probe:agent -- --kind ${kind} --provider <id> --model <id> --seed-source <path>`);
      out();
      out("That runs one unseeded and one seeded attempt and compares them.");
    }
    const sessionFound =
      extractSessionId(first.result.stdout) !== undefined ||
      extractSessionId(second.result.stdout) !== undefined;
    out(
      sessionFound
        ? "session id   extractSessionId() matched real output"
        : "session id   NOT FOUND — no taskId on the stream",
    );
    if (!sessionFound) {
      out("             Compare against the json keys listed above; the");
      out("             console's transcript link depends on this id.");
    }
    return bothOk ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface ProbeRunVersion {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

async function readVersion(
  binary: string,
  runner: ProcessRunner,
  env: Record<string, string>,
): Promise<ProbeRunVersion> {
  const result = await runner(binary, ["--version"], { env });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  probe()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${describe(error)}
`);
      process.exitCode = 1;
    });
}
