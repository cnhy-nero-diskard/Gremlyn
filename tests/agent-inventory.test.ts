/**
 * Focused tests for task 1.2: the shared effective-inventory reader and the
 * safe public metadata projection (`src/agent/agent-inventory.ts`), plus the
 * managed-preflight compatibility reexports.
 *
 * Coverage: parser support for primary/all/subagent modes, hidden entries,
 * names/descriptions and malformed records; instruction/credential exclusion
 * (a raw `system` prompt, `request` overlay or credential-shaped field never
 * reaches the parsed record or any projection); eligibility of visible
 * primary/all agents; exclusion of subagent-only, hidden, malformed and
 * Gremlyn-generated attempt ids; evidenced-versus-unknown origin; bounded,
 * control-character-free description projection; bounded id validation; and
 * forwarding of the per-call timeout/signal to the pinned-CLI reader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundNativeAgentDescription,
  boundNativeAgentName,
  canonicalAgentModel,
  eligibleNativeAgentChoices,
  hasControlCharacters,
  hasUnsafeIdentifierCharacters,
  isBoundedNativeAgentId,
  isEligibleNativeAgentRecord,
  isGeneratedAttemptAgentId,
  isPrimaryCapableMode,
  OpenCodeAgentInventoryError,
  parseAgentInventory,
  projectNativeAgentRecord,
  projectNativeAgentRecords,
  readBoundedAgentInventory,
  readCliAgentInventory,
  redactCredentialLikeText,
  type AgentInventoryReader,
  type AgentInventoryRecord,
} from "../src/agent/agent-inventory.js";
import {
  OpenCodeAgentPreflightError as ReexportedError,
  parseAgentInventory as reexportedParse,
  type AgentInventory as ReexportedInventory,
} from "../src/agent/managed-preflight.js";
import type { ProcessRunner } from "../src/agent/launcher.js";

function rawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "reviewer", mode: "primary", permissions: [], ...overrides };
}

function record(overrides: Partial<AgentInventoryRecord> = {}): AgentInventoryRecord {
  return { id: "reviewer", mode: "primary", permissions: [], hasModel: false, ...overrides };
}

/* ------------------------------------------------------------------ *
 * Parsing and privacy
 * ------------------------------------------------------------------ */

test("parseAgentInventory retains display metadata for primary/all/subagent modes", () => {
  const raw = [
    rawRecord({ id: "build", mode: "primary", name: "Build", description: "Default agent" }),
    rawRecord({ id: "writer", mode: "all", description: "Writes docs" }),
    rawRecord({ id: "reviewer", mode: "subagent" }),
  ];
  const inventory = parseAgentInventory(JSON.stringify(raw));
  assert.ok(inventory !== undefined);
  assert.equal(inventory.records.length, 3);
  assert.equal(inventory.records[0]?.name, "Build");
  assert.equal(inventory.records[0]?.description, "Default agent");
  assert.equal(inventory.records[0]?.mode, "primary");
  assert.equal(inventory.records[1]?.mode, "all");
  assert.equal(inventory.records[2]?.mode, "subagent");
});

test("parseAgentInventory records hidden state and origin evidence", () => {
  const raw = [
    rawRecord({ id: "summary", mode: "primary", hidden: true }),
    rawRecord({ id: "team/reviewer", mode: "primary", origin: "project" }),
    rawRecord({ id: "global-helper", mode: "all", origin: "global" }),
    rawRecord({ id: "mystery", mode: "primary", origin: "somewhere" }),
  ];
  const inventory = parseAgentInventory(JSON.stringify(raw));
  assert.ok(inventory !== undefined);
  assert.equal(inventory.records[0]?.hidden, true);
  assert.equal(inventory.records[1]?.origin, "project");
  assert.equal(inventory.records[2]?.origin, "global");
  // An unrecognized origin string is not evidence: it stays absent -> unknown.
  assert.equal(inventory.records[3]?.origin, undefined);
});

test("parseAgentInventory fails closed on malformed records", () => {
  const malformed = [
    [rawRecord({ id: "" })],
    [rawRecord({ mode: "" })],
    [rawRecord({ permissions: "nope" })],
    [rawRecord({ permissions: [{ action: "read" }] })],
  ];
  for (const raw of malformed) {
    assert.equal(parseAgentInventory(JSON.stringify(raw)), undefined);
  }
});

test("parsed records never carry system prompts, request overlays or credentials", () => {
  const raw = [
    rawRecord({
      id: "reviewer",
      mode: "primary",
      name: "Reviewer",
      description: "Reviews changes",
      system: "PRIVATE SYSTEM INSTRUCTIONS",
      request: { headers: { Authorization: "Bearer SECRET-TOKEN" }, body: { temperature: 0.1 } },
      apiKey: "sk-live-SECRET",
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    }),
  ];
  const inventory = parseAgentInventory(JSON.stringify(raw));
  assert.ok(inventory !== undefined);
  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("PRIVATE SYSTEM INSTRUCTIONS"));
  assert.ok(!serialized.includes("SECRET-TOKEN"));
  assert.ok(!serialized.includes("sk-live-SECRET"));
  assert.ok(!serialized.includes("request"));
  assert.ok(!serialized.includes("system"));
  // The permission tail is retained: the managed checks depend on it.
  assert.deepEqual(inventory.records[0]?.permissions, [
    { action: "shell", resource: "*", effect: "ask" },
  ]);
});

test("canonicalAgentModel still normalizes string and object forms", () => {
  assert.equal(canonicalAgentModel("opencode-go/kimi-k3#max"), "opencode-go/kimi-k3#max");
  assert.equal(
    canonicalAgentModel({ providerID: "opencode-go", id: "kimi-k3", variant: "max" }),
    "opencode-go/kimi-k3#max",
  );
  assert.equal(canonicalAgentModel({}), undefined);
});

/* ------------------------------------------------------------------ *
 * Public projection and eligibility
 * ------------------------------------------------------------------ */

test("visible primary and all modes are eligible; subagent-only is not", () => {
  assert.equal(isPrimaryCapableMode("primary"), true);
  assert.equal(isPrimaryCapableMode("all"), true);
  assert.equal(isPrimaryCapableMode("subagent"), false);
  assert.equal(isEligibleNativeAgentRecord(record({ id: "p", mode: "primary" })), true);
  assert.equal(isEligibleNativeAgentRecord(record({ id: "a", mode: "all" })), true);
  assert.equal(isEligibleNativeAgentRecord(record({ id: "s", mode: "subagent" })), false);
});

test("hidden and generated attempts are not eligible native choices", () => {
  assert.equal(
    isEligibleNativeAgentRecord(record({ id: "h", mode: "primary", hidden: true })),
    false,
  );
  assert.equal(isGeneratedAttemptAgentId("attempt-7/primary"), true);
  assert.equal(isGeneratedAttemptAgentId("attempt-7/reviewer"), true);
  assert.equal(isGeneratedAttemptAgentId("team/reviewer"), false);
  assert.equal(isGeneratedAttemptAgentId("attempt-x/primary"), false);
  assert.equal(
    isEligibleNativeAgentRecord(record({ id: "attempt-7/primary", mode: "primary" })),
    false,
  );
});

test("malformed or unbounded ids are never eligible", () => {
  for (const id of ["", "-oops", "has space", "line\nbreak", "a/../b", "a//b", "a".repeat(300)]) {
    assert.equal(isBoundedNativeAgentId(id), false, `expected ${JSON.stringify(id)} rejected`);
    assert.equal(isEligibleNativeAgentRecord(record({ id })), false);
  }
  assert.equal(isBoundedNativeAgentId("team/reviewer"), true);
  assert.equal(isBoundedNativeAgentId("build"), true);
});

test("projectNativeAgentRecord exposes only the safe allowlist and unknown origin", () => {
  const choice = projectNativeAgentRecord(
    record({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      mode: "all",
      origin: undefined,
    }),
  );
  assert.deepEqual(choice, {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews changes",
    mode: "all",
    hidden: false,
    eligible: true,
    origin: "unknown",
  });
  // No permissions, model, system or request field can appear.
  assert.equal("permissions" in choice, false);
  assert.equal("model" in choice, false);
});

test("projectNativeAgentRecord preserves evidenced origin", () => {
  assert.equal(
    projectNativeAgentRecord(record({ id: "a", mode: "primary", origin: "project" })).origin,
    "project",
  );
  assert.equal(
    projectNativeAgentRecord(record({ id: "b", mode: "primary", origin: "global" })).origin,
    "global",
  );
});

test("description projection is bounded and strips control characters", () => {
  const multiline = boundNativeAgentDescription("line one\nline two\ttabbed\u0000");
  assert.equal(multiline, "line one line two tabbed");
  const long = boundNativeAgentDescription("x".repeat(500));
  assert.ok(long !== undefined);
  assert.ok(long.length <= 240);
  assert.ok(long.endsWith("…"));
  assert.equal(boundNativeAgentDescription("   "), undefined);
  assert.equal(boundNativeAgentName(42), undefined);
  assert.equal(hasControlCharacters("clean"), false);
  assert.equal(hasControlCharacters("dirty\n"), true);
});

test("eligibleNativeAgentChoices filters hidden, subagent and generated ids", () => {
  const inventory = {
    records: [
      record({ id: "build", mode: "primary" }),
      record({ id: "writer", mode: "all" }),
      record({ id: "reviewer", mode: "subagent" }),
      record({ id: "summary", mode: "primary", hidden: true }),
      record({ id: "attempt-3/primary", mode: "primary" }),
    ],
  };
  const eligible = eligibleNativeAgentChoices(inventory);
  assert.deepEqual(
    eligible.map((choice) => choice.id),
    ["build", "writer"],
  );
  const projected = projectNativeAgentRecords(inventory);
  assert.equal(projected.length, 5);
  assert.equal(projected.find((choice) => choice.id === "attempt-3/primary")?.eligible, false);
});

test("the server envelope directory is retained", () => {
  const inventory = parseAgentInventory(
    JSON.stringify({ location: { directory: "C:\\work" }, data: [rawRecord()] }),
  );
  assert.equal(inventory?.directory, "C:\\work");
});

/* ------------------------------------------------------------------ *
 * Reader timeout/signal forwarding and managed-preflight compatibility
 * ------------------------------------------------------------------ */

test("the pinned-CLI reader forwards the per-call timeout and signal", async () => {
  const calls: Parameters<ProcessRunner>[] = [];
  const runner: ProcessRunner = (binary, args, options) => {
    calls.push([binary, args, options]);
    return Promise.resolve({
      stdout: "[]",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isCanceled: false,
    });
  };
  const controller = new AbortController();
  await readCliAgentInventory({
    binary: "opencode-test",
    cwd: "C:\\work",
    env: { PATH: "x" },
    runner,
    timeoutMs: 1234,
    signal: controller.signal,
  });
  const [, args, options] = calls[0]!;
  assert.deepEqual(args, ["debug", "agents"]);
  assert.equal(options.timeoutMs, 1234);
  assert.equal(options.signal, controller.signal);
});

test("the pinned-CLI reader fails closed on a timed-out call", async () => {
  const runner: ProcessRunner = () =>
    Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: undefined,
      timedOut: true,
      isCanceled: false,
    });
  await assert.rejects(
    () => readCliAgentInventory({ binary: "opencode", cwd: "C:\\work", env: {}, runner }),
    OpenCodeAgentInventoryError,
  );
});

test("managed-preflight reexports the shared reader and error class unchanged", () => {
  assert.equal(ReexportedError, OpenCodeAgentInventoryError);
  assert.equal(reexportedParse, parseAgentInventory);
  // The reexported type is the same shape (compile-time only assertion).
  const inventory: ReexportedInventory = { records: [] };
  assert.deepEqual(inventory.records, []);
});

/* ------------------------------------------------------------------ *
 * Strict display shapes, identifier safety and duplicate rejection
 * ------------------------------------------------------------------ */

test("a present but malformed display shape rejects the whole inventory", () => {
  for (const bad of [
    rawRecord({ hidden: "yes" }),
    rawRecord({ hidden: 1 }),
    rawRecord({ hidden: null }),
    rawRecord({ name: 7 }),
    rawRecord({ description: { text: "nope" } }),
  ]) {
    assert.equal(
      parseAgentInventory(JSON.stringify([bad])),
      undefined,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  // A normal hidden boolean is retained.
  const ok = parseAgentInventory(JSON.stringify([rawRecord({ hidden: true })]));
  assert.equal(ok?.records[0]?.hidden, true);
});

test("duplicate ids make the inventory ambiguous and are rejected", () => {
  const raw = [rawRecord({ id: "reviewer" }), rawRecord({ id: "reviewer", mode: "all" })];
  assert.equal(parseAgentInventory(JSON.stringify(raw)), undefined);
});

test("control, C1 and format identifiers are rejected consistently", () => {
  const c0 = "rev\u0007iewer";
  const c1 = "rev\u0085iewer";
  const cf = "rev\u200biewer";
  for (const id of [c0, c1, cf]) {
    assert.equal(hasUnsafeIdentifierCharacters(id), true);
    assert.equal(isBoundedNativeAgentId(id), false);
    assert.equal(parseAgentInventory(JSON.stringify([rawRecord({ id })])), undefined);
    assert.equal(isEligibleNativeAgentRecord(record({ id })), false);
  }
  assert.equal(hasUnsafeIdentifierCharacters("reviewer"), false);
});

/* ------------------------------------------------------------------ *
 * Credential redaction and private-value suppression
 * ------------------------------------------------------------------ */

test("credential-like description and name literals are redacted", () => {
  assert.ok(!redactCredentialLikeText("key sk-live-abcdef1234567890").includes("sk-live-"));
  assert.equal(redactCredentialLikeText("Bearer abcdefghijklmnop"), "[redacted]");
  assert.equal(redactCredentialLikeText("api_key: supersecretvalue"), "[redacted]");
  assert.equal(
    redactCredentialLikeText("Reviews changes for correctness"),
    "Reviews changes for correctness",
  );

  const choice = projectNativeAgentRecord(
    record({
      id: "reviewer",
      name: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      description: "Authenticate with sk-live-abcdef1234567890 first",
    }),
  );
  assert.ok(choice.name?.includes("[redacted]"));
  assert.ok(choice.description?.includes("[redacted]"));
  assert.ok(!choice.description?.includes("sk-live-abcdef1234567890"));
});

test("a display field identical to the private system payload is dropped", () => {
  const raw = [
    rawRecord({
      id: "reviewer",
      name: "Reviewer",
      description: "PRIVATE SYSTEM PROMPT",
      system: "PRIVATE SYSTEM PROMPT",
    }),
  ];
  const inventory = parseAgentInventory(JSON.stringify(raw));
  assert.ok(inventory !== undefined);
  assert.equal(inventory.records[0]?.description, undefined);
  const choice = projectNativeAgentRecord(inventory.records[0]!);
  assert.equal(choice.description, undefined);
  assert.ok(!JSON.stringify(choice).includes("PRIVATE SYSTEM PROMPT"));
  // The private value itself is never persisted on the record.
  assert.ok(!JSON.stringify(inventory).includes("PRIVATE SYSTEM PROMPT"));
});

test("a display field identical to a private request leaf is dropped", () => {
  const raw = [
    rawRecord({
      id: "reviewer",
      description: "header-secret-value",
      request: { headers: { "x-secret": "header-secret-value" } },
    }),
  ];
  const inventory = parseAgentInventory(JSON.stringify(raw));
  assert.ok(inventory !== undefined);
  assert.equal(inventory.records[0]?.description, undefined);
});

/* ------------------------------------------------------------------ *
 * Bounded read wrapper
 * ------------------------------------------------------------------ */

const DUMMY_RUNNER: ProcessRunner = () =>
  Promise.resolve({ stdout: "[]", stderr: "", exitCode: 0, timedOut: false, isCanceled: false });

function neverReader(): AgentInventoryReader {
  return () => new Promise(() => {});
}

test("readBoundedAgentInventory bounds a reader that ignores its signal", async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      readBoundedAgentInventory({
        inventory: neverReader(),
        binary: "opencode",
        cwd: "C:\\work",
        env: {},
        runner: DUMMY_RUNNER,
        timeoutMs: 25,
      }),
    OpenCodeAgentInventoryError,
  );
  assert.ok(Date.now() - started < 1_000);
});

test("readBoundedAgentInventory shortens the bound to the remaining deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      readBoundedAgentInventory({
        inventory: neverReader(),
        binary: "opencode",
        cwd: "C:\\work",
        env: {},
        runner: DUMMY_RUNNER,
        timeoutMs: 60_000,
        deadline: Date.now() + 20,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeAgentInventoryError);
      assert.ok(error.reasons[0]?.includes("timed out"));
      return true;
    },
  );
  assert.ok(Date.now() - started < 1_000);
});

test("readBoundedAgentInventory never returns a late success after abort", async () => {
  const controller = new AbortController();
  const reader: AgentInventoryReader = () =>
    new Promise((resolve) => setTimeout(() => resolve({ records: [] }), 50));
  const pending = readBoundedAgentInventory({
    inventory: reader,
    binary: "opencode",
    cwd: "C:\\work",
    env: {},
    runner: DUMMY_RUNNER,
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeAgentInventoryError);
      assert.ok(error.reasons[0]?.includes("cancelled"));
      return true;
    },
  );
});

test("readBoundedAgentInventory resolves a well-behaved reader unchanged", async () => {
  const inventory = await readBoundedAgentInventory({
    inventory: () => Promise.resolve({ records: [record({ id: "reviewer" })] }),
    binary: "opencode",
    cwd: "C:\\work",
    env: {},
    runner: DUMMY_RUNNER,
    timeoutMs: 1_000,
  });
  assert.deepEqual(
    inventory.records.map((entry) => entry.id),
    ["reviewer"],
  );
});
