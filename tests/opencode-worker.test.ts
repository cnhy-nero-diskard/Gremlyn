/**
 * Focused tests for task 1.3: the alias-aware OpenCode worker descriptor
 * (`src/agent/opencode-worker.ts`).
 *
 * Coverage: binary defaulting to the executor alias, the pinned version, the
 * sanitized environment copy (frozen, not aliased to the caller's object), the
 * injected runner, and the central isolation guarantee — two repository aliases
 * resolve to two descriptors whose binary/cwd/env/runner are each used
 * verbatim, with no context leaking between them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentEnvironment } from "../src/agent/environment.js";
import { EXPECTED_OPENCODE_VERSION } from "../src/agent/opencode.js";
import {
  resolveOpenCodeWorker,
  runOpenCodeWorker,
  workerEnvironmentFingerprint,
} from "../src/agent/opencode-worker.js";
import type { ProcessRunner } from "../src/agent/launcher.js";

function okResult(stdout = "[]") {
  return Promise.resolve({
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    isCanceled: false,
  });
}

test("the binary defaults to the executor alias and the version is pinned", () => {
  const worker = resolveOpenCodeWorker({
    executorId: "opencode-go",
    cwd: "C:\\repos\\b",
    env: { PATH: "p" },
  });
  assert.equal(worker.executorId, "opencode-go");
  assert.equal(worker.binary, "opencode-go");
  assert.equal(worker.version, EXPECTED_OPENCODE_VERSION);
  assert.equal(worker.cwd, "C:\\repos\\b");
  assert.deepEqual(worker.env, { PATH: "p" });
});

test("an explicit binary overrides the alias and both are preserved", () => {
  const worker = resolveOpenCodeWorker({
    executorId: "opencode-b",
    binary: "C:\\tools\\opencode-b\\opencode.exe",
    cwd: "C:\\repos\\b",
    env: {},
  });
  assert.equal(worker.executorId, "opencode-b");
  assert.equal(worker.binary, "C:\\tools\\opencode-b\\opencode.exe");
});

test("the environment is copied and frozen, never aliased to the caller", () => {
  const env: Record<string, string> = { PATH: "p", XDG_DATA_HOME: "C:\\data" };
  const worker = resolveOpenCodeWorker({ executorId: "opencode", cwd: "C:\\r", env });
  env.PATH = "mutated";
  assert.equal(worker.env.PATH, "p");
  assert.equal(Object.isFrozen(worker.env), true);
  assert.equal(Object.isFrozen(worker), true);
});

test("the injected runner is preserved, defaulting to the common launcher", () => {
  const runner: ProcessRunner = () => okResult();
  const injected = resolveOpenCodeWorker({
    executorId: "opencode",
    cwd: "C:\\r",
    env: {},
    runner,
  });
  assert.equal(injected.runner, runner);
  const defaulted = resolveOpenCodeWorker({ executorId: "opencode", cwd: "C:\\r", env: {} });
  assert.equal(typeof defaulted.runner, "function");
  assert.notEqual(defaulted.runner, runner);
});

test("two repository aliases resolve to fully isolated contexts", () => {
  const callsA: Parameters<ProcessRunner>[] = [];
  const callsB: Parameters<ProcessRunner>[] = [];
  const runnerA: ProcessRunner = (binary, args, options) => {
    callsA.push([binary, args, options]);
    return okResult();
  };
  const runnerB: ProcessRunner = (binary, args, options) => {
    callsB.push([binary, args, options]);
    return okResult();
  };
  const workerA = resolveOpenCodeWorker({
    executorId: "opencode-a",
    binary: "opencode-a",
    cwd: "C:\\repos\\a",
    env: { PATH: "a", XDG_DATA_HOME: "C:\\data-a" },
    runner: runnerA,
  });
  const workerB = resolveOpenCodeWorker({
    executorId: "opencode-b",
    binary: "opencode-b",
    cwd: "C:\\repos\\b",
    env: { PATH: "b", XDG_DATA_HOME: "C:\\data-b" },
    runner: runnerB,
  });

  assert.notEqual(workerA.binary, workerB.binary);
  assert.notEqual(workerA.cwd, workerB.cwd);
  assert.notDeepEqual(workerA.env, workerB.env);
  assert.notEqual(workerA.runner, workerB.runner);

  assert.equal(
    workerEnvironmentFingerprint(workerA) === workerEnvironmentFingerprint(workerB),
    false,
  );
});

test("runOpenCodeWorker routes through the worker's exact context", async () => {
  const calls: Parameters<ProcessRunner>[] = [];
  const runner: ProcessRunner = (binary, args, options) => {
    calls.push([binary, args, options]);
    return okResult();
  };
  const controller = new AbortController();
  const worker = resolveOpenCodeWorker({
    executorId: "opencode",
    binary: "opencode-x",
    cwd: "C:\\repos\\x",
    env: { PATH: "x" },
    runner,
  });
  await runOpenCodeWorker(worker, ["debug", "agents"], {
    timeoutMs: 250,
    signal: controller.signal,
  });
  const [binary, args, options] = calls[0]!;
  assert.equal(binary, "opencode-x");
  assert.deepEqual(args, ["debug", "agents"]);
  assert.equal(options.cwd, "C:\\repos\\x");
  assert.deepEqual(options.env, { PATH: "x" });
  assert.equal(options.timeoutMs, 250);
  assert.equal(options.signal, controller.signal);
});

test("an unsafe alias, binary or cwd is refused", () => {
  for (const bad of ["", "-oops", "line\nbreak", "a".repeat(300)]) {
    assert.throws(() => resolveOpenCodeWorker({ executorId: bad, cwd: "C:\\r", env: {} }));
    assert.throws(() =>
      resolveOpenCodeWorker({ executorId: "opencode", binary: bad, cwd: "C:\\r", env: {} }),
    );
    assert.throws(() => resolveOpenCodeWorker({ executorId: "opencode", cwd: bad, env: {} }));
  }
});

test("workerEnvironmentFingerprint is stable and root-sensitive", () => {
  const base = { executorId: "opencode", cwd: "C:\\r", env: { PATH: "p" } };
  const one = resolveOpenCodeWorker({ ...base, env: { PATH: "p", XDG_STATE_HOME: "C:\\s" } });
  const same = resolveOpenCodeWorker({ ...base, env: { XDG_STATE_HOME: "C:\\s", PATH: "p" } });
  const other = resolveOpenCodeWorker({ ...base, env: { XDG_STATE_HOME: "C:\\other" } });
  assert.equal(workerEnvironmentFingerprint(one), workerEnvironmentFingerprint(same));
  assert.notEqual(workerEnvironmentFingerprint(one), workerEnvironmentFingerprint(other));
});

test("the worker preserves the exact buildAgentEnvironment context execution passes", () => {
  // The parent builds the child environment with the allowlist plus executor
  // roots; the descriptor must carry that exact map, adding and dropping
  // nothing, so discovery and execution share one context.
  const env = buildAgentEnvironment(
    { PATH: "p", HOME: "h", GREMLYN_GITHUB_TOKEN: "should-not-appear", OPENAI_API_KEY: "nope" },
    { XDG_DATA_HOME: "C:\\data", XDG_STATE_HOME: "C:\\state" },
  );
  const worker = resolveOpenCodeWorker({
    executorId: "opencode",
    binary: "opencode",
    cwd: "C:\\repos\\a",
    env,
  });
  assert.deepEqual(worker.env, env);
  assert.equal("GREMLYN_GITHUB_TOKEN" in worker.env, false);
  assert.equal("OPENAI_API_KEY" in worker.env, false);
  assert.equal(worker.env.PATH, "p");
  assert.equal(worker.env.HOME, "h");
  assert.equal(worker.env.XDG_DATA_HOME, "C:\\data");
  assert.equal(worker.env.XDG_STATE_HOME, "C:\\state");
});
