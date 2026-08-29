/**
 * Contract tests for behavior observed from the real Cline CLI (3.0.60) via
 * `npm run probe:agent`. Every fixture here is captured output, not invented
 * shape — the rest of the agent suite injects a fake `ProcessRunner`, so these
 * are the assertions that would have caught the inferred contract being wrong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunner, extractSessionId, extractSupportedEfforts } from "../src/agent/cline.js";
import { ConfigError, loadConfig } from "../src/config/loader.js";

/** Captured verbatim from a real `cline --json` run. */
const REAL_STREAM = [
  '\u001b[2m[warn] ignoring invalid --retries value "0" (expected integer >= 1)\u001b[0m',
  '{"ts":"2026-08-28T01:53:11.892Z","type":"hook_event","hookEventName":"agent_start",' +
    '"agentId":"agent_1787881991854_zjl64k","taskId":"conv_1787881991885_uzysg3d",' +
    '"parentAgentId":null}',
  '{"ts":"2026-08-28T01:53:11.893Z","type":"agent_event","event":{"type":"iteration_start",' +
    '"iteration":1}}',
  '{"ts":"2026-08-28T01:53:12.687Z","type":"run_result","finishReason":"error","iterations":1,' +
    '"durationMs":333,"text":"Unauthorized",' +
    '"model":{"id":"cline-pass/deepseek-v4-flash","provider":"cline-pass","info":{' +
    '"name":"DeepSeek V4 Flash","contextWindow":1048576,' +
    '"reasoningOptions":[{"type":"toggle"},{"type":"effort","values":["high","xhigh"]}]}}}',
].join("\n");

test("session id comes from the taskId the stream actually carries", () => {
  // The stream has no `sessionId` in any form; reading one was silently
  // returning undefined on every real run.
  assert.equal(extractSessionId(REAL_STREAM), "conv_1787881991885_uzysg3d");
});

test("session id is absent when no correlation id was emitted", () => {
  assert.equal(extractSessionId('{"ts":"x","type":"agent_event"}\nplain text'), undefined);
});

test("non-JSON preamble does not defeat id extraction", () => {
  // The warn line is ANSI-wrapped and not JSON; it precedes every stream.
  assert.ok(REAL_STREAM.startsWith("\u001b[2m[warn]"));
  assert.equal(extractSessionId(REAL_STREAM), "conv_1787881991885_uzysg3d");
});

test("model metadata reveals the effort tiers the model actually accepts", () => {
  // The agent advertises none|low|medium|high|xhigh; this model accepts two.
  assert.deepEqual(extractSupportedEfforts(REAL_STREAM), ["high", "xhigh"]);
});

test("supported efforts are undefined when the model advertises none", () => {
  assert.equal(extractSupportedEfforts('{"type":"run_result","model":{"info":{}}}'), undefined);
});

test("a retry budget below the CLI minimum is a configuration error", () => {
  // cline 3.0.60: `ignoring invalid --retries value "0" (expected integer >= 1)`
  // — it warns and substitutes its own default, so the configured value never runs.
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-retries-"));
  const path = join(dir, "gremlyn.yaml");
  writeFileSync(
    path,
    `
data_dir: .gremlyn-test
github:
  orchestrator_login: gremlyn-bot
git:
  author_name: Human Developer
  author_email: developer@example.com
agent_defaults:
  retries: 0
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
`,
    "utf8",
  );
  assert.throws(
    () =>
      loadConfig(path, {
        GREMLYN_GITHUB_TOKEN: "ghp_test_token",
        GREMLYN_CONSOLE_TOKEN: "console_test_token",
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof ConfigError && /retries must be an integer >= 1/u.test(String(error)),
  );
});

test("a spawned agent reading stdin gets EOF instead of blocking", async () => {
  // execa's default stdin is an open pipe that is never written to, so an agent
  // that prompts for input would hang until the timeout rather than fail fast.
  const result = await defaultRunner(
    process.execPath,
    [
      "-e",
      "let n=0;process.stdin.on('data',()=>{n++});" +
        "process.stdin.on('end',()=>{process.stdout.write('EOF:'+n)});" +
        "process.stdin.resume();",
    ],
    { env: {}, timeoutMs: 10_000 },
  );
  assert.equal(result.stdout, "EOF:0");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("the max reasoning tier is expressible and selectable", () => {
  // gpt-5.6-luna advertises reasoningOptions
  // ["none","low","medium","high","xhigh","max"]. Design D10 originally claimed
  // xhigh was the CLI-wide ceiling; the ceiling is per-model and max is real.
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-maxeffort-"));
  const path = join(dir, "gremlyn.yaml");
  writeFileSync(
    path,
    `
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
    efforts: [none, low, medium, high, xhigh, max]
    credential_source: C:/Users/test/.cline/data
repositories:
  - owner: someuser
    name: repo
    source_path: D:/code/repo
    workspace_root: D:/code/workspaces/repo
    agent: cline
    provider: test-provider
    model: test-provider/gpt-5.6-luna
    effort: max
    allowed_models: [test-provider/gpt-5.6-luna]
    validation_commands: []
`,
    "utf8",
  );
  const config = loadConfig(path, {
    GREMLYN_GITHUB_TOKEN: "ghp_test_token",
    GREMLYN_CONSOLE_TOKEN: "console_test_token",
  } as NodeJS.ProcessEnv);
  assert.equal(config.repositories[0]?.effort, "max");
});

test("an agent that stops at xhigh still rejects max", () => {
  // Widening the enum must not grant a tier the agent never declared.
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-nomax-"));
  const path = join(dir, "gremlyn.yaml");
  writeFileSync(
    path,
    `
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
    effort: max
    allowed_models: [test-provider/model-1]
    validation_commands: []
`,
    "utf8",
  );
  assert.throws(
    () =>
      loadConfig(path, {
        GREMLYN_GITHUB_TOKEN: "ghp_test_token",
        GREMLYN_CONSOLE_TOKEN: "console_test_token",
      } as NodeJS.ProcessEnv),
    /not supported by agent "cline"/u,
  );
});

/**
 * A prompt carrying a review thread plus repository instructions runs past
 * cmd.exe's 8191-character command line. Node will not exec a `.cmd` directly
 * (CVE-2024-27980), so `cline` on Windows went through cmd.exe and every job
 * died in ~40ms with "The command line is too long." before the agent started.
 * `defaultRunner` resolves the npm shim to its Node entry to skip that cap.
 */
test(
  "an argv past cmd.exe's limit still reaches the agent",
  { skip: process.platform !== "win32" },
  async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const oversized = "y".repeat(20_000);
    const result = await defaultRunner("cline", ["--version", oversized], { env });
    assert.ok(
      !/command line is too long/iu.test(result.stderr),
      `spawn hit the cmd.exe cap: ${result.stderr}`,
    );
    assert.equal(result.exitCode, 0);
  },
);

/**
 * Streaming exists so an attempt is observable while it runs: the buffered
 * stdout only arrives on exit, which for a 2-minute agent is 2 minutes of
 * silence. Observing must not change what the completed result contains.
 */
test("stdout lines are delivered while the process runs, and the buffer is unchanged", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const seen: string[] = [];
  const script =
    "process.stdout.write('one\\ntw'); process.stdout.write('o\\nthree\\n'); process.stdout.write('trailing');";
  const result = await defaultRunner(process.execPath, ["-e", script], {
    env,
    onLine: (line) => seen.push(line),
  });
  // Chunk boundaries fall mid-line; the reader must rejoin them.
  assert.deepEqual(seen, ["one", "two", "three", "trailing"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /one\r?\ntwo\r?\nthree\r?\ntrailing/u);
});

test("a throwing line observer cannot fail the run it is watching", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const result = await defaultRunner(process.execPath, ["-e", "process.stdout.write('x\\n')"], {
    env,
    onLine: () => {
      throw new Error("observer blew up");
    },
  });
  assert.equal(result.exitCode, 0);
});
