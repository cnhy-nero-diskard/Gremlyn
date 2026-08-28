/**
 * Agent probe — a diagnostic that exercises the real Cline CLI through the real
 * `ClineExecutor`, with no config file, no SQLite store, and no GitHub token.
 *
 * It exists because the test suite injects a fake `ProcessRunner` everywhere, so
 * the suite proves Gremlyn *constructs* the documented argv but never that Cline
 * *accepts* it. This closes that gap cheaply, ahead of the full acceptance run.
 *
 * It answers three questions the inferred CLI contract leaves open:
 *   1. Is the installed CLI the version design D10 was probed against?
 *   2. Does provider authentication survive a fresh per-attempt `--data-dir`?
 *      (D10 isolates state per attempt; `cline auth` persists it somewhere the
 *      operator controls. If those are the same directory, every attempt starts
 *      unauthenticated.)
 *   3. Does `--json` actually carry a session id in the shape
 *      `extractSessionId` expects? A mismatch is silent: the console simply
 *      never gets a `cline history export` handle.
 *
 * Nothing here writes to a workspace: each run gets a throwaway working
 * directory and a read-only prompt.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ClineExecutor,
  EXPECTED_CLINE_VERSION,
  defaultRunner,
  extractSessionId,
  extractVersion,
  type ProcessRunner,
} from "./cline.js";
import { AGENT_ENV_ALLOWLIST, buildAgentEnvironment } from "./environment.js";
import { REASONING_EFFORTS, type AgentResult, type ReasoningEffort } from "../types.js";

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
}

async function runOnce(input: {
  label: string;
  binary: string;
  model: string;
  provider: string;
  effort: ReasoningEffort;
  timeoutSec: number;
  scratch: string;
}): Promise<ProbeRun> {
  const dataDir = mkdtempSync(join(input.scratch, "data-"));
  const cwd = mkdtempSync(join(input.scratch, "work-"));
  const sink: { argv?: readonly string[] } = {};
  const executor = new ClineExecutor(input.binary, recordingRunner(sink));
  heading(`Run: ${input.label}`);
  out(`data-dir     ${dataDir}`);
  out(`cwd          ${cwd}`);
  out(`waiting      up to ${String(input.timeoutSec)}s for the agent to exit...`);
  const startedAt = Date.now();
  const result = await executor.run({
    cwd,
    model: input.model,
    provider: input.provider,
    effort: input.effort,
    prompt: PROBE_PROMPT,
    env: buildAgentEnvironment(),
    timeoutSec: input.timeoutSec,
    retries: 0,
    dataDir,
    signal: AbortSignal.timeout((input.timeoutSec + 15) * 1_000),
  });
  return {
    label: input.label,
    dataDir,
    result,
    argv: sink.argv ?? [],
    elapsedMs: Date.now() - startedAt,
  };
}

function reportRun(run: ProbeRun): void {
  out(`argv         ${JSON.stringify(run.argv)}`);
  out(`exit code    ${String(run.result.exitCode)}`);
  out(`timed out    ${String(run.result.timedOut)}`);
  out(`elapsed      ${String(run.elapsedMs)} ms`);
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
}

export async function probe(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      binary: { type: "string" },
      model: { type: "string" },
      provider: { type: "string" },
      effort: { type: "string" },
      timeout: { type: "string" },
    },
    allowPositionals: false,
  });

  const binary = values.binary ?? process.env.GREMLYN_PROBE_BINARY ?? "cline";
  const model = values.model ?? process.env.GREMLYN_PROBE_MODEL;
  const provider = values.provider ?? process.env.GREMLYN_PROBE_PROVIDER;
  const effortRaw = values.effort ?? process.env.GREMLYN_PROBE_EFFORT ?? "none";
  const timeoutSec = Number(values.timeout ?? process.env.GREMLYN_PROBE_TIMEOUT ?? "120");

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
  out(`binary       ${binary}`);
  const env = buildAgentEnvironment();
  const present = AGENT_ENV_ALLOWLIST.filter((key) => env[key] !== undefined);
  const absent = AGENT_ENV_ALLOWLIST.filter((key) => env[key] === undefined);
  out(`passed       ${present.join(", ")}`);
  out(`unset        ${absent.length > 0 ? absent.join(", ") : "(none)"}`);
  out("note         no provider API keys are in the allowlist; Cline must find");
  out("             credentials via HOME/APPDATA/USERPROFILE or its data dir");

  heading("Version");
  const versionSink: { argv?: readonly string[] } = {};
  let version: ProbeRunVersion;
  try {
    version = await readVersion(binary, recordingRunner(versionSink), env);
  } catch (error) {
    out(`could not execute "${binary} --version": ${describe(error)}`);
    out("Cline is not installed, not on PATH, or not executable. Nothing else can run.");
    return 1;
  }
  out(`argv         ${JSON.stringify(versionSink.argv ?? [])}`);
  out(`exit code    ${String(version.exitCode)}`);
  block("stdout", version.stdout);
  if (version.stderr.trim() !== "") block("stderr", version.stderr);
  if (version.exitCode !== 0) {
    out();
    out(`"${binary} --version" exited ${String(version.exitCode)}.`);
    out("Cline is not installed, not on PATH, or not executable. Nothing else can run.");
    return 1;
  }
  const parsed = extractVersion(version.stdout);
  out(`parsed       ${parsed ?? "(extractVersion found no x.y.z)"}`);
  out(`expected     ${EXPECTED_CLINE_VERSION}`);
  out(
    parsed === EXPECTED_CLINE_VERSION
      ? "match        yes — the orchestrator will start"
      : `match        NO — checkVersion() rejects this at startup (exact-match pin)`,
  );

  if (model === undefined || provider === undefined) {
    heading("Invocation runs: SKIPPED");
    out("Supply a provider and model to exercise the real invocation surface:");
    out(`  npm run probe:agent -- --provider <id> --model <id>`);
    out("or set GREMLYN_PROBE_PROVIDER and GREMLYN_PROBE_MODEL.");
    out("Use the same values as the repository entry you intend to run.");
    return 0;
  }

  const scratch = mkdtempSync(join(tmpdir(), "gremlyn-probe-"));
  try {
    const first = await runOnce({
      label: "first — fresh data dir",
      binary,
      model,
      provider,
      effort,
      timeoutSec,
      scratch,
    });
    reportRun(first);

    const second = await runOnce({
      label: "second — a different fresh data dir",
      binary,
      model,
      provider,
      effort,
      timeoutSec,
      scratch,
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
