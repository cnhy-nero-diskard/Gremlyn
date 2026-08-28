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
