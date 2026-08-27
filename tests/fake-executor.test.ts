import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_OUTCOMES, FakeExecutor, type FakeOutcome } from "../src/agent/fake.js";
import type { AgentRunOptions } from "../src/types.js";

function opts(cwd: string, signal?: AbortSignal): AgentRunOptions {
  return {
    cwd,
    model: "m",
    provider: "p",
    effort: "xhigh",
    prompt: "prompt",
    env: {},
    timeoutSec: 5,
    retries: 1,
    dataDir: join(cwd, "data"),
    signal: signal ?? new AbortController().signal,
  };
}

test("all six outcomes from design D10 are selectable and observable", async () => {
  for (const outcome of FAKE_OUTCOMES) {
    const cwd = mkdtempSync(join(tmpdir(), "gremlyn-fake-"));
    const executor = new FakeExecutor({
      outcome,
      edits: { "changed.txt": "new content\n" },
    });
    const result = await executor.run(opts(cwd));
    assert.equal(executor.runs.length, 1, `${outcome}: run not recorded`);
    assert.equal(executor.runs[0]!.options.prompt, "prompt");
    assert.equal(executor.runs[0]!.result, result);
  }
});

test("success outcome applies edits and exits zero", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gremlyn-fake-"));
  const executor = new FakeExecutor({
    outcome: "success",
    edits: { "src/fix.ts": "fixed\n" },
  });
  const result = await executor.run(opts(cwd));
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(cwd, "src", "fix.ts"), "utf8"), "fixed\n");
});

test("failure outcome exits non-zero and changes nothing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gremlyn-fake-"));
  const executor = new FakeExecutor({ outcome: "failure", edits: { "x.txt": "x" } });
  const result = await executor.run(opts(cwd));
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(join(cwd, "x.txt")), false);
});

test("no-changes outcome exits zero and changes nothing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gremlyn-fake-"));
  const executor = new FakeExecutor({ outcome: "no-changes" });
  const result = await executor.run(opts(cwd));
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /DECLINED/);
});

test("files-modified and validation-failure outcomes apply edits", async () => {
  for (const outcome of ["files-modified", "validation-failure"] as FakeOutcome[]) {
    const cwd = mkdtempSync(join(tmpdir(), "gremlyn-fake-"));
    const executor = new FakeExecutor({ outcome, edits: { "m.txt": "m" } });
    const result = await executor.run(opts(cwd));
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(join(cwd, "m.txt")), true, `${outcome} did not edit`);
  }
});

test("timeout outcome runs until aborted and reports timedOut", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gremlyn-fake-"));
  const controller = new AbortController();
  const executor = new FakeExecutor({ outcome: "timeout", delayMs: 60_000 });
  const promise = executor.run(opts(cwd, controller.signal));
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.timedOut, true);
});
