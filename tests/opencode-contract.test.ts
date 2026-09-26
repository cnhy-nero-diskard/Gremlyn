/**
 * Contract tests for the OpenCode executor (design D-opencode), mirroring
 * `cline-contract.test.ts`. Fixtures are captured verbatim from a real
 * `opencode run --format json` stream (opencode 1.18.27, the free
 * `opencode/big-pickle` OpenCode Zen model — zero-cost, no credential
 * required), not an invented shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ClineExecutor, extractSessionId } from "../src/agent/cline.js";
import type { ProcessRunner } from "../src/agent/launcher.js";
import { EXPECTED_OPENCODE_VERSION, OpenCodeExecutor } from "../src/agent/opencode.js";
import type { AgentRunOptions } from "../src/types.js";
import { AgentVersionError } from "../src/agent/cline.js";

/** Captured verbatim from a real `opencode run --format json` run (text/reasoning/usage). */
const REAL_STREAM_TEXT = [
  '{"type":"step_start","timestamp":1788408388432,"sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf",' +
    '"part":{"id":"prt_065725b4c001v1P6KRvn9iTfQF","messageID":"msg_065724bb5001k0od7gwv5lWz1A",' +
    '"sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf","snapshot":"738873bc","type":"step-start"}}',
  '{"type":"reasoning","timestamp":1788408389114,"sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf",' +
    '"part":{"id":"prt_065725b82001sa1IVFXs1OvN0Q","messageID":"msg_065724bb5001k0od7gwv5lWz1A",' +
    '"sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf","type":"reasoning",' +
    '"text":"The user is asking me to reply with a single word.","time":{"start":1,"end":2}}}',
  '{"type":"text","timestamp":1788408389127,"sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf",' +
    '"part":{"id":"prt_065725df7001FKjJH0N3dTOrdD","messageID":"msg_065724bb5001k0od7gwv5lWz1A",' +
    '"sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf","type":"text","text":"READY","time":{"start":1,"end":2}}}',
  '{"type":"step_finish","timestamp":1788408389489,"sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf",' +
    '"part":{"id":"prt_065725f6b001gg44XT4lPz88di","reason":"stop","snapshot":"1f374d08",' +
    '"messageID":"msg_065724bb5001k0od7gwv5lWz1A","sessionID":"ses_f9a8db611ffebnXFRCbFX8r5qf",' +
    '"type":"step-finish","tokens":{"total":8080,"input":6244,"output":44,"reasoning":0,' +
    '"cache":{"write":0,"read":1792}},"cost":0}}',
].join("\n");

/** Captured verbatim from a real invalid-model run: a session-level error event. */
const REAL_STREAM_ERROR =
  '{"type":"error","timestamp":1788408457085,"sessionID":"ses_f9a8c9a4affeLTGg97zsvkQvOC",' +
  '"error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs ' +
  'for details.","ref":"err_7be42bd4"}}}';

function options(root: string, overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    cwd: join(root, "workspace"),
    model: "opencode/big-pickle",
    provider: "should-be-ignored",
    effort: "high",
    prompt: "fix the review feedback",
    env: { PATH: "test-path" },
    timeoutSec: 45,
    retries: 2,
    dataDir: join(root, "attempt-data"),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function okResult(stdout = "") {
  return Promise.resolve({ stdout, stderr: "", exitCode: 0, timedOut: false, isCanceled: false });
}

test("OpenCode executor builds the v2 argv with #variant carrying the effort tier", async () => {
  const calls: Parameters<ProcessRunner>[] = [];
  const runner: ProcessRunner = (binary, args, runOptions) => {
    calls.push([binary, args, runOptions]);
    return okResult(REAL_STREAM_TEXT);
  };
  const root = mkdtempSync(join(tmpdir(), "gremlyn-opencode-"));
  const opts = options(root);
  const result = await new OpenCodeExecutor("opencode-test", runner).run(opts);

  assert.equal(calls.length, 1);
  const [binary, args, runOptions] = calls[0]!;
  assert.equal(binary, "opencode-test");
  assert.equal(new OpenCodeExecutor().usesSharedCredentials, true);
  assert.deepEqual(args, [
    "run",
    "-m",
    `${opts.model}#high`,
    "--format",
    "json",
    "--auto",
    "--thinking",
    opts.prompt,
  ]);
  assert.equal(runOptions.cwd, opts.cwd);
  assert.equal(runOptions.timeoutMs, 45_000);
  assert.equal(result.sessionId, "ses_f9a8db611ffebnXFRCbFX8r5qf");
});

test("OpenCode omits #variant for the none effort tier", async () => {
  let passedArgs: readonly string[] = [];
  const runner: ProcessRunner = (_binary, args) => {
    passedArgs = args;
    return okResult();
  };
  const root = mkdtempSync(join(tmpdir(), "gremlyn-opencode-"));
  const opts = options(root, { effort: "none" });
  await new OpenCodeExecutor("opencode-test", runner).run(opts);
  assert.equal(passedArgs[passedArgs.indexOf("-m") + 1], opts.model);
  assert.ok(
    passedArgs.includes("--thinking"),
    "bare --thinking must still be passed for the reasoning stream",
  );
});

test("OpenCode ignores provider entirely: no -P argument on the argv", async () => {
  let passedArgs: readonly string[] = [];
  const runner: ProcessRunner = (_binary, args) => {
    passedArgs = args;
    return okResult();
  };
  const root = mkdtempSync(join(tmpdir(), "gremlyn-opencode-"));
  await new OpenCodeExecutor("opencode-test", runner).run(
    options(root, { provider: "some-provider-that-must-not-appear" }),
  );
  assert.equal(passedArgs.includes("-P"), false);
  assert.equal(passedArgs.includes("some-provider-that-must-not-appear"), false);
});

test("OpenCode's #variant and bare --thinking cannot be crossed with Cline's --thinking <tier>", async () => {
  const openCodeArgs: string[][] = [];
  const openCodeRunner: ProcessRunner = (_binary, args) => {
    openCodeArgs.push([...args]);
    return okResult();
  };
  const clineArgs: string[][] = [];
  const clineRunner: ProcessRunner = (_binary, args) => {
    clineArgs.push([...args]);
    return okResult();
  };
  const root = mkdtempSync(join(tmpdir(), "gremlyn-cross-"));
  await new OpenCodeExecutor("opencode-test", openCodeRunner).run(
    options(root, { effort: "xhigh" }),
  );
  await new ClineExecutor("cline-test", clineRunner).run(options(root, { effort: "xhigh" }));

  // OpenCode: --thinking is a bare flag, the tier is appended to the model.
  const openCode = openCodeArgs[0]!;
  assert.equal(openCode[openCode.indexOf("-m") + 1], "opencode/big-pickle#xhigh");
  assert.equal(openCode.includes("--variant"), false);

  // Cline: --thinking is unaffected and still carries the tier directly.
  const cline = clineArgs[0]!;
  assert.equal(cline[cline.indexOf("--thinking") + 1], "xhigh");
});

test("OpenCode uses the configured data profile and preserves service discovery paths", () => {
  const executor = new OpenCodeExecutor();
  const profile = join(mkdtempSync(join(tmpdir(), "gremlyn-opencode-profile-")), "opencode");
  const env = executor.additionalEnvironment(join("D:", "attempts", "42"), profile);
  assert.ok(isAbsolute(env.XDG_DATA_HOME!), `expected ${env.XDG_DATA_HOME} to be absolute`);
  assert.equal(env.XDG_DATA_HOME, dirname(resolve(profile)));
  for (const key of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const) {
    assert.equal(env[key], process.env[key]);
  }
  assert.doesNotMatch(JSON.stringify(env), /sk-|token|secret|api[_-]?key/iu);
});

test("OpenCode profile roots do not vary with the attempt data directory", () => {
  const executor = new OpenCodeExecutor();
  const profile = join(mkdtempSync(join(tmpdir(), "gremlyn-opencode-profile-")), "opencode");
  const first = executor.additionalEnvironment(join("D:", "attempts", "1"), profile);
  const second = executor.additionalEnvironment(join("D:", "attempts", "2"), profile);
  assert.equal(first.XDG_DATA_HOME, second.XDG_DATA_HOME);
  assert.equal(first.XDG_STATE_HOME, second.XDG_STATE_HOME);
});

test("OpenCode declares it does not honor the retry allowance itself", () => {
  assert.equal(new OpenCodeExecutor().honorsRetries, false);
});

test("Cline still declares that it honors the retry allowance itself", () => {
  assert.equal(new ClineExecutor().honorsRetries, true);
});

test("OpenCode version mismatch fails as a startup configuration error", async () => {
  const runner: ProcessRunner = () => okResult("1.0.0");
  const executor = new OpenCodeExecutor("opencode", runner);
  await assert.rejects(() => executor.checkVersion({}), AgentVersionError);
});

test("OpenCode version match succeeds", async () => {
  const runner: ProcessRunner = () => okResult(EXPECTED_OPENCODE_VERSION);
  const executor = new OpenCodeExecutor("opencode", runner);
  await assert.doesNotReject(() => executor.checkVersion({}));
});

test("session id is read from OpenCode's top-level sessionID on a real captured stream", () => {
  assert.equal(extractSessionId(REAL_STREAM_TEXT), "ses_f9a8db611ffebnXFRCbFX8r5qf");
});

test("a real session-level error event does not defeat session id extraction of other lines", () => {
  // The error event itself carries no `part`, only `error` — extractSessionId
  // still finds the id because it reads the top-level `sessionID` present on
  // every event, error included.
  assert.equal(extractSessionId(REAL_STREAM_ERROR), "ses_f9a8c9a4affeLTGg97zsvkQvOC");
});
