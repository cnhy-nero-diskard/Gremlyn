/**
 * Focused tests for task 1.4: bounded source discovery, keyed advisory caching
 * and abortable workspace-context preflight (`src/agent/native-discovery.ts`).
 *
 * Coverage: cold convergence, the distinct empty/pending/failed outcomes,
 * repository+worker-scoped cache keys and TTL expiry, refresh bypassing the
 * cache, preflight's uncached authorization, per-call timeout forwarding,
 * cancellation, wrong-directory inventories and the source-versus-worktree
 * mismatch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverNativeAgents,
  NativeAgentDiscoveryCache,
  nativeDiscoveryCacheKey,
  preflightNativeAgent,
  readNativeAgentInventory,
  NATIVE_DISCOVERY_CALL_TIMEOUT_MS,
} from "../src/agent/native-discovery.js";
import {
  OpenCodeAgentInventoryError,
  type AgentInventory,
  type AgentInventoryReader,
  type AgentInventoryRecord,
} from "../src/agent/agent-inventory.js";
import { resolveOpenCodeWorker, type OpenCodeWorker } from "../src/agent/opencode-worker.js";

const CWD = "C:\\repos\\a";

function record(overrides: Partial<AgentInventoryRecord> = {}): AgentInventoryRecord {
  return { id: "reviewer", mode: "primary", permissions: [], hasModel: false, ...overrides };
}

function worker(
  overrides: Partial<Parameters<typeof resolveOpenCodeWorker>[0]> = {},
): OpenCodeWorker {
  return resolveOpenCodeWorker({ executorId: "opencode", cwd: CWD, env: {}, ...overrides });
}

function inventory(records: readonly AgentInventoryRecord[], directory?: string): AgentInventory {
  return directory === undefined ? { records: [...records] } : { records: [...records], directory };
}

function throwingReader(message = "boom"): AgentInventoryReader {
  return () => Promise.reject(new OpenCodeAgentInventoryError([message]));
}

/* ------------------------------------------------------------------ *
 * Source discovery: cold convergence and distinct outcomes
 * ------------------------------------------------------------------ */

test("discovery converges across the cold-location race", async () => {
  let calls = 0;
  const reader: AgentInventoryReader = () => {
    calls += 1;
    if (calls < 3) return Promise.resolve(inventory([]));
    return Promise.resolve(inventory([record({ id: "native-a", mode: "all" })]));
  };
  const outcome = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: reader,
    pollIntervalMs: 1,
    budgetMs: 1_000,
  });
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") return;
  assert.equal(outcome.polls, 3);
  assert.deepEqual(
    outcome.agents.map((choice) => choice.id),
    ["native-a"],
  );
});

test("discovery reports an empty successful inventory distinctly from cold pending", async () => {
  const emptyReader: AgentInventoryReader = () =>
    Promise.resolve(inventory([record({ id: "hidden", mode: "primary", hidden: true })]));
  const empty = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: emptyReader,
  });
  assert.equal(empty.status, "empty");
  if (empty.status === "empty") assert.equal(empty.recordCount, 1);

  const pending = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: () => Promise.resolve(inventory([])),
    pollIntervalMs: 1,
    budgetMs: 15,
  });
  assert.equal(pending.status, "pending");
  if (pending.status === "pending") assert.equal(pending.recordCount, 0);
});

test("discovery surfaces a transport failure as failed, not empty", async () => {
  const outcome = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: throwingReader("cannot reach CLI"),
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.ok(outcome.reason.includes("source unavailable"));
  }
});

test("discovery and preflight errors do not project private configuration or credentials from reader failures", async () => {
  const input = worker();
  const inventory = throwingReader(
    "PRIVATE SYSTEM INSTRUCTIONS password=fixture-credential-not-for-output",
  );
  const discovery = await discoverNativeAgents({
    worker: input,
    repositoryId: "privacy",
    inventory,
  });
  const preflight = await preflightNativeAgent({ worker: input, agentId: "build", inventory });
  assert.equal(discovery.status, "failed");
  assert.equal(preflight.status, "failed");
  assert.doesNotMatch(
    JSON.stringify([discovery, preflight]),
    /PRIVATE SYSTEM|fixture-credential|password=/u,
  );
});

/* ------------------------------------------------------------------ *
 * Advisory cache: keying, TTL, isolation, refresh
 * ------------------------------------------------------------------ */

test("a live cache entry is returned without re-reading the source", async () => {
  const cache = new NativeAgentDiscoveryCache();
  let calls = 0;
  const reader: AgentInventoryReader = () => {
    calls += 1;
    return Promise.resolve(inventory([record({ id: "native-a" })]));
  };
  const first = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: reader,
    cache,
  });
  const second = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: throwingReader("must not be called"),
    cache,
  });
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  if (second.status === "ready") assert.equal(second.fromCache, true);
  assert.equal(calls, 1);
});

test("cache entries are isolated by repository and worker context", async () => {
  const cache = new NativeAgentDiscoveryCache();
  const workerA = worker({ executorId: "opencode", cwd: "C:\\repos\\a" });
  const workerB = worker({ executorId: "opencode", cwd: "C:\\repos\\b" });
  assert.notEqual(
    nativeDiscoveryCacheKey("repo-a", workerA),
    nativeDiscoveryCacheKey("repo-b", workerA),
  );
  assert.notEqual(
    nativeDiscoveryCacheKey("repo-a", workerA),
    nativeDiscoveryCacheKey("repo-a", workerB),
  );

  const seen: string[] = [];
  const reader: AgentInventoryReader = (input) => {
    seen.push(input.cwd);
    return Promise.resolve(inventory([record({ id: input.cwd === workerA.cwd ? "a" : "b" })]));
  };
  await discoverNativeAgents({ worker: workerA, repositoryId: "repo-a", inventory: reader, cache });
  await discoverNativeAgents({ worker: workerB, repositoryId: "repo-a", inventory: reader, cache });
  assert.deepEqual(seen, ["C:\\repos\\a", "C:\\repos\\b"]);
  assert.equal(cache.size, 2);
});

test("a cache entry expires after the TTL", async () => {
  let clock = 1_000;
  const cache = new NativeAgentDiscoveryCache({ ttlMs: 100, now: () => clock });
  let calls = 0;
  const reader: AgentInventoryReader = () => {
    calls += 1;
    return Promise.resolve(inventory([record({ id: "native-a" })]));
  };
  await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: reader,
    cache,
  });
  clock += 99;
  const live = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: reader,
    cache,
  });
  assert.equal(live.status, "ready");
  if (live.status === "ready") assert.equal(live.fromCache, true);
  assert.equal(calls, 1);

  clock += 2;
  const expired = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: reader,
    cache,
  });
  assert.equal(expired.status, "ready");
  if (expired.status === "ready") assert.equal(expired.fromCache, false);
  assert.equal(calls, 2);
});

test("refresh bypasses the cache and repopulates it", async () => {
  const cache = new NativeAgentDiscoveryCache();
  let version = "old";
  const reader: AgentInventoryReader = () =>
    Promise.resolve(inventory([record({ id: version === "old" ? "old-agent" : "new-agent" })]));
  await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: reader,
    cache,
  });
  version = "new";
  const refreshed = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: reader,
    cache,
    refresh: true,
  });
  assert.equal(refreshed.status, "ready");
  if (refreshed.status === "ready") {
    assert.equal(refreshed.fromCache, false);
    assert.deepEqual(
      refreshed.agents.map((choice) => choice.id),
      ["new-agent"],
    );
  }
  const cached = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: throwingReader("must not be called"),
    cache,
  });
  assert.equal(cached.status, "ready");
  if (cached.status === "ready") {
    assert.equal(cached.fromCache, true);
    assert.deepEqual(
      cached.agents.map((choice) => choice.id),
      ["new-agent"],
    );
  }
});

test("readNativeAgentInventory forwards the default per-call timeout", async () => {
  let observedTimeout: number | undefined;
  const reader: AgentInventoryReader = (input) => {
    observedTimeout = input.timeoutMs;
    return Promise.resolve(inventory([record({ id: "x" })]));
  };
  await readNativeAgentInventory({ worker: worker(), inventory: reader });
  assert.equal(observedTimeout, NATIVE_DISCOVERY_CALL_TIMEOUT_MS);
});

/* ------------------------------------------------------------------ *
 * Workspace preflight (uncached authorization)
 * ------------------------------------------------------------------ */

test("preflight authorizes an eligible agent in the workspace", async () => {
  const outcome = await preflightNativeAgent({
    worker: worker(),
    agentId: "reviewer",
    inventory: () => Promise.resolve(inventory([record({ id: "reviewer", mode: "all" })])),
  });
  assert.equal(outcome.status, "ok");
  if (outcome.status === "ok") assert.equal(outcome.agent.id, "reviewer");
});

test("preflight rejects a malformed id before any CLI call", async () => {
  let called = false;
  const outcome = await preflightNativeAgent({
    worker: worker(),
    agentId: "-not-an-agent",
    inventory: () => {
      called = true;
      return Promise.resolve(inventory([]));
    },
  });
  assert.equal(outcome.status, "invalid");
  assert.equal(called, false);
});

test("preflight reports an absent id as ineligible after the bound", async () => {
  const outcome = await preflightNativeAgent({
    worker: worker(),
    agentId: "missing",
    inventory: () => Promise.resolve(inventory([record({ id: "build", mode: "primary" })])),
    pollIntervalMs: 1,
    budgetMs: 15,
  });
  assert.equal(outcome.status, "ineligible");
  if (outcome.status === "ineligible") {
    assert.deepEqual(outcome.available, ["build"]);
  }
});

test("preflight reports a cold location that never converges as pending", async () => {
  const outcome = await preflightNativeAgent({
    worker: worker(),
    agentId: "reviewer",
    inventory: () => Promise.resolve(inventory([])),
    pollIntervalMs: 1,
    budgetMs: 15,
  });
  assert.equal(outcome.status, "pending");
});

test("preflight fails closed on a wrong-directory inventory", async () => {
  const outcome = await preflightNativeAgent({
    worker: worker({ cwd: "C:\\work" }),
    agentId: "reviewer",
    inventory: () =>
      Promise.resolve(inventory([record({ id: "reviewer" })], "C:\\somewhere\\else")),
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.ok(outcome.reason.includes("not the expected directory"));
  }
});

test("preflight never reuses a source-checkout discovery cache", async () => {
  // A source checkout discovers native-a.
  const sourceWorker = worker({ cwd: "C:\\repos\\a" });
  const cache = new NativeAgentDiscoveryCache();
  const source = await discoverNativeAgents({
    worker: sourceWorker,
    repositoryId: "repo-a",
    inventory: () => Promise.resolve(inventory([record({ id: "native-a" })])),
    cache,
  });
  assert.equal(source.status, "ready");

  // The prepared workspace never loads native-a; preflight must re-read (not
  // consult the cache) and refuse rather than reuse the source authorization.
  let calls = 0;
  const workspaceWorker = worker({ cwd: "C:\\work\\pr-1" });
  const outcome = await preflightNativeAgent({
    worker: workspaceWorker,
    agentId: "native-a",
    inventory: () => {
      calls += 1;
      return Promise.resolve(inventory([record({ id: "build", mode: "primary" })]));
    },
    pollIntervalMs: 1,
    budgetMs: 15,
  });
  assert.equal(outcome.status, "ineligible");
  assert.ok(calls >= 1);
});

test("preflight surfaces a transport failure with an actionable reason", async () => {
  const outcome = await preflightNativeAgent({
    worker: worker(),
    agentId: "reviewer",
    inventory: throwingReader("service unavailable"),
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.ok(outcome.reason.includes("source unavailable"));
});

test("preflight honors an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await preflightNativeAgent({
    worker: worker(),
    agentId: "reviewer",
    inventory: () => Promise.resolve(inventory([])),
    signal: controller.signal,
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.ok(outcome.reason.includes("cancelled"));
});

test("discovery can be cancelled mid-poll", async () => {
  const controller = new AbortController();
  let calls = 0;
  const outcome = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: () => {
      calls += 1;
      controller.abort();
      return Promise.resolve(inventory([]));
    },
    signal: controller.signal,
    pollIntervalMs: 1,
    budgetMs: 1_000,
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.ok(outcome.reason.includes("cancelled"));
  assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ *
 * Wrong-directory safety and bounded reads (review gaps)
 * ------------------------------------------------------------------ */

test("discovery fails on a wrong-directory inventory before caching", async () => {
  const cache = new NativeAgentDiscoveryCache();
  const outcome = await discoverNativeAgents({
    worker: worker({ cwd: "C:\\work" }),
    repositoryId: "repo-a",
    inventory: () =>
      Promise.resolve(inventory([record({ id: "native-a" })], "C:\\somewhere\\else")),
    cache,
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.ok(outcome.reason.includes("not the expected directory"));
  }
  assert.equal(cache.size, 0);
});

test("discovery re-verifies a cached directory and evicts a mismatched entry", async () => {
  const cache = new NativeAgentDiscoveryCache();
  const target = worker({ cwd: "C:\\work" });
  cache.set(nativeDiscoveryCacheKey("repo-a", target), {
    agents: [{ id: "native-a", mode: "primary", hidden: false, eligible: true, origin: "unknown" }],
    directory: "C:\\somewhere\\else",
    recordCount: 1,
  });
  let calls = 0;
  const outcome = await discoverNativeAgents({
    worker: target,
    repositoryId: "repo-a",
    inventory: () => {
      calls += 1;
      return Promise.resolve(inventory([record({ id: "native-a" })]));
    },
    cache,
  });
  assert.equal(outcome.status, "failed");
  assert.equal(cache.size, 0);
  assert.equal(calls, 0);
});

test("discovery bounds a reader that never settles", async () => {
  const started = Date.now();
  const outcome = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: () => new Promise(() => {}),
    pollIntervalMs: 1,
    budgetMs: 40,
    callTimeoutMs: 40,
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.ok(outcome.reason.includes("timed out"));
  assert.ok(Date.now() - started < 1_000);
});

test("discovery sleeps only up to the remaining budget", async () => {
  const started = Date.now();
  const outcome = await discoverNativeAgents({
    worker: worker(),
    repositoryId: "repo-a",
    inventory: () => Promise.resolve(inventory([])),
    // A poll interval longer than the whole budget must not extend the wait.
    pollIntervalMs: 10_000,
    budgetMs: 30,
  });
  assert.equal(outcome.status, "pending");
  assert.ok(Date.now() - started < 1_000);
});

test("preflight bounds a reader that never settles", async () => {
  const started = Date.now();
  const outcome = await preflightNativeAgent({
    worker: worker(),
    agentId: "reviewer",
    inventory: () => new Promise(() => {}),
    pollIntervalMs: 1,
    budgetMs: 40,
    callTimeoutMs: 40,
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.ok(outcome.reason.includes("timed out"));
  assert.ok(Date.now() - started < 1_000);
});

test("the default CLI path bounds a runner that ignores cancellation", async () => {
  const workerWithHangingRunner = resolveOpenCodeWorker({
    executorId: "opencode",
    cwd: CWD,
    env: {},
    runner: () => new Promise(() => {}),
  });
  const started = Date.now();
  await assert.rejects(
    () => readNativeAgentInventory({ worker: workerWithHangingRunner, timeoutMs: 25 }),
    OpenCodeAgentInventoryError,
  );
  assert.ok(Date.now() - started < 1_000);
});
