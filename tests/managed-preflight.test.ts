/**
 * Focused tests for task 3.3: preflighting the effective generated OpenCode V2
 * agents before a managed attempt runs (`src/agent/managed-preflight.ts`).
 *
 * The inventory and effective-record shapes asserted here were probe-verified
 * against the installed pinned OpenCode 2.0.16 CLI: `opencode debug agents`
 * prints a JSON array of `{id, name, mode, permissions, model?}` records whose
 * permissions merge a global base header BEFORE the generated rules, which are
 * appended contiguously starting at a `{action:"*",resource:"*",effect:"deny"}`
 * baseline. Discovery has a cold-location race — the first call can return
 * `[]` for an attempt directory that later lists the generated ids — so the
 * preflight polls with a bounded wait. Child model overrides surface as
 * `{providerID, id, variant?}`; an omitted override stays absent.
 *
 * Coverage: inventory parsing (CLI array and `{location,data}` envelope forms),
 * the default CLI reader contract (binary/args/cwd/env), the pure inventory
 * verification (modes, deny-then-allow allowlist, child rules and model
 * override/omission, location, fail-closed reasons), and the bounded polling
 * entry point (cold-location race, budget exhaustion, reader failure, abort,
 * and the full pinned-CLI path through an injected runner).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import {
  parseOpenCodeAgentProfile,
  type OpenCodeAgentProfile,
} from "../src/config/opencode-profile.js";
import {
  OPENCODE_AGENT_DIR,
  serializeOpenCodeAgents,
  type AgentPermissionRule,
  type SerializedOpenCodeAgents,
} from "../src/agent/materialize.js";
import {
  canonicalAgentModel,
  OpenCodeAgentPreflightError,
  parseAgentInventory,
  preflightManagedOpenCodeAgents,
  readCliAgentInventory,
  verifyManagedAgentInventory,
  type AgentInventory,
  type AgentInventoryRecord,
  type AgentInventoryRule,
} from "../src/agent/managed-preflight.js";
import type { ProcessRunner } from "../src/agent/launcher.js";

/** A minimal stand-in for the global base header the pinned CLI merges first. */
const HEADER: readonly AgentInventoryRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];

const NAMESPACE = "att-1";
const CWD = "C:\\attempts\\att-1";

function profileInput(): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description: "Primary review agent",
      permissions: ["edit", "shell"],
    },
    subagents: [
      {
        id: "explicit",
        description: "Explicit model child",
        enabled: true,
        model: "opencode-go/kimi-k3#max",
        permissions: ["edit"],
      },
      {
        id: "inherits",
        description: "Inherits the session model",
        enabled: true,
        permissions: ["web"],
      },
      { id: "disabled", description: "Disabled child", enabled: false, permissions: [] },
    ],
  };
}

function profile(): OpenCodeAgentProfile {
  return parseOpenCodeAgentProfile(profileInput());
}

function serialized(): SerializedOpenCodeAgents {
  return serializeOpenCodeAgents({ profile: profile(), namespace: NAMESPACE });
}

function runtimeIdOf(rel: string): string {
  const id = rel.slice(rel.lastIndexOf("/") + 1, -".md".length);
  return `${NAMESPACE}/${id}`;
}

/** The closing frontmatter delimiter: the newline ending YAML, `---`, newline. */
const CLOSING_DELIMITER = "\n---\n";

function frontmatterOf(content: string): Record<string, unknown> {
  const close = content.indexOf(CLOSING_DELIMITER);
  assert.ok(close !== -1, "expected a closing frontmatter delimiter");
  const parsed = parseYaml(content.slice(0, close + 1));
  assert.ok(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    "frontmatter must parse to an object",
  );
  return parsed as Record<string, unknown>;
}

/** The ordered rules one generated file serialized, taken from its frontmatter. */
function fileRulesOf(file: { content: string }): AgentInventoryRule[] {
  const permissions = frontmatterOf(file.content).permissions;
  assert.ok(Array.isArray(permissions));
  return (permissions as unknown as AgentPermissionRule[]).map((rule) => ({
    action: rule.action,
    resource: rule.resource,
    effect: rule.effect,
  }));
}

function withHeader(rules: readonly AgentInventoryRule[]): AgentInventoryRule[] {
  return [...HEADER, ...rules];
}

function fileByRel(agents: SerializedOpenCodeAgents, rel: string) {
  const file = agents.files.find((entry) => entry.path === rel);
  assert.ok(file, `expected a generated file at ${rel}`);
  return file;
}

/**
 * Build the effective inventory record for one generated file, exactly as the
 * pinned CLI reports it: mode and rules from the file's frontmatter, with the
 * base header merged before the generated rule tail.
 */
function effectiveRecord(
  agents: SerializedOpenCodeAgents,
  rel: string,
  patch?: (draft: {
    id: string;
    mode: string;
    hasModel: boolean;
    model: string | undefined;
    permissions: AgentInventoryRule[];
  }) => void,
): AgentInventoryRecord {
  const file = fileByRel(agents, rel);
  const frontmatter = frontmatterOf(file.content);
  const draft = {
    id: runtimeIdOf(rel),
    mode: frontmatter.mode as string,
    hasModel: frontmatter.model !== undefined,
    model: frontmatter.model as string | undefined,
    permissions: withHeader(fileRulesOf(file)),
  };
  patch?.(draft);
  const base: AgentInventoryRecord = {
    id: draft.id,
    mode: draft.mode,
    hasModel: draft.hasModel,
    permissions: draft.permissions,
  };
  return draft.model === undefined ? base : { ...base, model: draft.model };
}

function inventoryOf(
  agents: SerializedOpenCodeAgents,
  records: readonly AgentInventoryRecord[],
  directory?: string,
): AgentInventory {
  return directory === undefined ? { records: [...records] } : { records: [...records], directory };
}

const PRIMARY_REL = `${OPENCODE_AGENT_DIR}/${NAMESPACE}/primary.md`;
const EXPLICIT_REL = `${OPENCODE_AGENT_DIR}/${NAMESPACE}/explicit.md`;
const INHERITS_REL = `${OPENCODE_AGENT_DIR}/${NAMESPACE}/inherits.md`;
const DISABLED_REL = `${OPENCODE_AGENT_DIR}/${NAMESPACE}/disabled.md`;

/** Every generated file's record: the golden, fully effective inventory. */
function goldenRecords(agents: SerializedOpenCodeAgents): AgentInventoryRecord[] {
  return [PRIMARY_REL, EXPLICIT_REL, INHERITS_REL, DISABLED_REL].map((rel) =>
    effectiveRecord(agents, rel),
  );
}

function reasonsOf(
  agents: SerializedOpenCodeAgents,
  records: readonly AgentInventoryRecord[],
  cwd = CWD,
): readonly string[] {
  return verifyManagedAgentInventory({ agents, cwd, inventory: inventoryOf(agents, records) });
}

function hasReason(reasons: readonly string[], needle: string): boolean {
  return reasons.some((reason) => reason.includes(needle));
}

function okResult(stdout = "") {
  return Promise.resolve({ stdout, stderr: "", exitCode: 0, timedOut: false, isCanceled: false });
}

/* ------------------------------------------------------------------ *
 * parseAgentInventory, canonicalAgentModel
 * ------------------------------------------------------------------ */

test("parseAgentInventory reads the pinned CLI's bare JSON array form", () => {
  const agents = serialized();
  // The pinned CLI reports the record shape with `name`, `request`, `hidden`,
  // and a merged header before the generated tail; extra fields are ignored.
  const raw = [
    {
      id: "att-1/primary",
      name: "att-1/primary",
      request: { settings: {}, headers: {}, body: {} },
      description: "Primary review agent",
      mode: "primary",
      hidden: false,
      permissions: withHeader(fileRulesOf(fileByRel(agents, PRIMARY_REL))),
    },
    {
      id: "att-1/reviewer",
      name: "att-1/reviewer",
      request: { settings: {}, headers: {}, body: {} },
      description: "Child",
      mode: "subagent",
      hidden: false,
      permissions: withHeader(fileRulesOf(fileByRel(agents, EXPLICIT_REL))),
    },
  ];
  const inventory = parseAgentInventory(JSON.stringify(raw));
  assert.ok(inventory !== undefined);
  assert.equal(inventory.directory, undefined);
  assert.equal(inventory.records.length, 2);
  assert.equal(inventory.records[0]?.id, "att-1/primary");
  assert.equal(inventory.records[0]?.mode, "primary");
  assert.equal(inventory.records[0]?.hasModel, false);
  assert.equal(inventory.records[0]?.model, undefined);
  // The generated tail is preserved after the header, baseline first.
  const primary = inventory.records[0]!;
  const tail = primary.permissions.slice(
    primary.permissions.findLastIndex(
      (rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny",
    ),
  );
  assert.deepEqual(tail, fileRulesOf(fileByRel(agents, PRIMARY_REL)));
});

test("parseAgentInventory reads the {location,data} server envelope and canonicalizes models", () => {
  const agents = serialized();
  const raw = {
    location: { directory: "C:\\attempts\\att-1" },
    data: [
      {
        id: "att-1/explicit",
        mode: "subagent",
        permissions: withHeader(fileRulesOf(fileByRel(agents, EXPLICIT_REL))),
        // The pinned API surfaces an override in providerID/id/variant form.
        model: { providerID: "opencode-go", id: "kimi-k3", variant: "max" },
      },
      {
        id: "att-1/inherits",
        mode: "subagent",
        permissions: withHeader(fileRulesOf(fileByRel(agents, INHERITS_REL))),
      },
    ],
  };
  const inventory = parseAgentInventory(JSON.stringify(raw));
  assert.ok(inventory !== undefined);
  assert.equal(inventory.directory, "C:\\attempts\\att-1");
  const explicit = inventory.records[0]!;
  assert.equal(explicit.hasModel, true);
  assert.equal(explicit.model, "opencode-go/kimi-k3#max");
  const inherits = inventory.records[1]!;
  assert.equal(inherits.hasModel, false);
  assert.equal(inherits.model, undefined);
});

test("parseAgentInventory accepts an empty CLI inventory (the cold-location race)", () => {
  const inventory = parseAgentInventory("[]");
  assert.ok(inventory !== undefined);
  assert.deepEqual(inventory.records, []);
});

test("parseAgentInventory fails closed on unusable output", () => {
  for (const garbage of ["", "   ", "not json", "42", '{"location":{}}', '{"data":null}']) {
    assert.equal(
      parseAgentInventory(garbage),
      undefined,
      `expected ${JSON.stringify(garbage)} to be unusable`,
    );
  }
});

test("parseAgentInventory fails closed on a malformed record", () => {
  const raw = [
    { id: "att-1/primary", permissions: [] },
    { id: "att-1/reviewer", mode: "subagent", permissions: [] },
  ];
  assert.equal(parseAgentInventory(JSON.stringify(raw)), undefined);
});

test("canonicalAgentModel round-trips string and providerID/id/variant forms", () => {
  assert.equal(canonicalAgentModel("opencode-go/kimi-k3#max"), "opencode-go/kimi-k3#max");
  assert.equal(
    canonicalAgentModel({ providerID: "opencode-go", id: "kimi-k3", variant: "max" }),
    "opencode-go/kimi-k3#max",
  );
  assert.equal(
    canonicalAgentModel({ providerID: "opencode-go", id: "kimi-k3" }),
    "opencode-go/kimi-k3",
  );
  for (const unusable of [undefined, null, "", 42, {}, { id: "kimi-k3" }, { providerID: "x" }]) {
    assert.equal(canonicalAgentModel(unusable), undefined);
  }
});

/* ------------------------------------------------------------------ *
 * readCliAgentInventory (default pinned-CLI source)
 * ------------------------------------------------------------------ */

test("readCliAgentInventory runs debug agents under the attempt cwd and env", async () => {
  const calls: Parameters<ProcessRunner>[] = [];
  const runner: ProcessRunner = (binary, args, options) => {
    calls.push([binary, args, options]);
    return okResult("[]");
  };
  const inventory = await readCliAgentInventory({
    binary: "opencode-test",
    cwd: "C:\\attempts\\att-1",
    env: { PATH: "test-path", XDG_STATE_HOME: "C:\\state" },
    runner,
  });
  assert.equal(calls.length, 1);
  const [binary, args, options] = calls[0]!;
  assert.equal(binary, "opencode-test");
  assert.deepEqual(args, ["debug", "agents"]);
  assert.equal(options.cwd, "C:\\attempts\\att-1");
  assert.deepEqual(options.env, { PATH: "test-path", XDG_STATE_HOME: "C:\\state" });
  assert.deepEqual(inventory.records, []);
});

test("readCliAgentInventory fails on a non-zero debug agents exit", async () => {
  const runner: ProcessRunner = () =>
    Promise.resolve({
      stdout: "",
      stderr: "boom",
      exitCode: 3,
      timedOut: false,
      isCanceled: false,
    });
  await assert.rejects(
    () =>
      readCliAgentInventory({
        binary: "opencode-test",
        cwd: CWD,
        env: {},
        runner,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeAgentPreflightError);
      assert.ok(error.reasons[0]?.includes("debug agents"));
      assert.ok(error.reasons[0]?.includes("boom"));
      return true;
    },
  );
});

test("readCliAgentInventory fails on unparsable output", async () => {
  const runner: ProcessRunner = () => okResult("not json at all");
  await assert.rejects(
    () => readCliAgentInventory({ binary: "opencode-test", cwd: CWD, env: {}, runner }),
    OpenCodeAgentPreflightError,
  );
});

/* ------------------------------------------------------------------ *
 * verifyManagedAgentInventory
 * ------------------------------------------------------------------ */

test("the golden effective inventory verifies cleanly", () => {
  const agents = serialized();
  const records = goldenRecords(agents);
  const reasons = reasonsOf(agents, records);
  assert.deepEqual(reasons, []);
});

test("an explicit child model override and an omitted override are both honored", () => {
  const agents = serialized();
  const records = goldenRecords(agents);
  const explicit = effectiveRecord(agents, EXPLICIT_REL);
  assert.equal(explicit.model, "opencode-go/kimi-k3#max");
  const inherits = effectiveRecord(agents, INHERITS_REL);
  assert.equal(inherits.model, undefined);
  assert.deepEqual(
    reasonsOf(agents, [...records.filter((r) => r.id !== explicit.id), explicit]),
    [],
  );
  assert.deepEqual(
    reasonsOf(agents, [...records.filter((r) => r.id !== inherits.id), inherits]),
    [],
  );
});

test("a missing primary fails closed naming the generated primary id", () => {
  const agents = serialized();
  const records = goldenRecords(agents).filter((record) => record.id !== agents.primaryRuntimeId);
  const reasons = reasonsOf(agents, records);
  assert.equal(reasons.length, 1);
  assert.ok(hasReason(reasons, agents.primaryRuntimeId));
  assert.ok(hasReason(reasons, "not present"));
});

test("an enabled child missing from the inventory fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).filter((record) => record.id !== "att-1/inherits");
  const reasons = reasonsOf(agents, records);
  assert.equal(reasons.length, 1);
  assert.ok(hasReason(reasons, "enabled child agent att-1/inherits"));
  assert.ok(hasReason(reasons, "not present"));
});

test("a wrong effective primary mode fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/primary" ? { ...record, mode: "subagent" } : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "primary agent att-1/primary"));
  assert.ok(hasReason(reasons, "expected"));
});

test("a wrong effective child mode fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/explicit" ? { ...record, mode: "primary" } : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "child agent att-1/explicit"));
  assert.ok(hasReason(reasons, "expected"));
});

test("a primary that unexpectedly carries a model fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/primary" ? { ...record, hasModel: true, model: "opencode-go/x" } : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.equal(reasons.length, 1);
  assert.ok(hasReason(reasons, "unexpectedly carries a model override"));
});

test("an allowlisted target that is not in the profile fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/primary"
      ? {
          ...record,
          permissions: [
            ...record.permissions,
            { action: "subagent", resource: "att-1/disabled", effect: "allow" },
          ],
        }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "allowlist targets"));
  assert.ok(hasReason(reasons, "att-1/disabled"));
  assert.ok(hasReason(reasons, "must never be invocable"));
});

test("an enabled child dropped from the allowlist fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/primary"
      ? {
          ...record,
          permissions: record.permissions.filter(
            (rule) =>
              !(
                rule.action === "subagent" &&
                rule.resource === "att-1/inherits" &&
                rule.effect === "allow"
              ),
          ),
        }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "allowlist targets"));
  assert.ok(hasReason(reasons, "expected exactly att-1/explicit"));
});

test("a primary allowlist without the leading deny-all fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/primary"
      ? {
          ...record,
          permissions: record.permissions.filter(
            (rule) =>
              !(rule.action === "subagent" && rule.resource === "*" && rule.effect === "deny"),
          ),
        }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "missing the deny-all subagent rule"));
});

test("an allow placed before the deny-all fails the deny-then-allow order", () => {
  const agents = serialized();
  const allowed = [
    { action: "subagent", resource: "att-1/explicit", effect: "allow" },
    { action: "subagent", resource: "att-1/inherits", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
  ] as const;
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/primary"
      ? {
          ...record,
          permissions: [
            ...record.permissions.filter((rule) => rule.action !== "subagent"),
            ...allowed,
          ],
        }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "ordered deny-then-allow"));
});

test("a primary whose generated tail differs from its serialized file fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/primary"
      ? {
          ...record,
          permissions: [
            // Insert a foreign allow right after the baseline: the allowlist
            // itself is untouched, so only the strict rule-tail check can fire.
            ...record.permissions.slice(0, HEADER.length + 1),
            { action: "wifi", resource: "*", effect: "allow" },
            ...record.permissions.slice(HEADER.length + 1),
          ],
        }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "effective rules do not match the serialized definition"));
});

test("an agent whose generated baseline never loaded fails closed", () => {
  const agents = serialized();
  // Header only: no generated deny-all baseline means the file did not load.
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/inherits" ? { ...record, permissions: [...HEADER] } : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.equal(reasons.length, 1);
  assert.ok(hasReason(reasons, "did not load"));
});

test("a child missing its required model override fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/explicit"
      ? { id: record.id, mode: record.mode, hasModel: false, permissions: record.permissions }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "child agent att-1/explicit"));
  assert.ok(hasReason(reasons, "missing its model override"));
});

test("a child with a wrong model override fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/explicit"
      ? {
          id: record.id,
          mode: record.mode,
          hasModel: true,
          model: "opencode-go/something-else",
          permissions: record.permissions,
        }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "expected opencode-go/kimi-k3#max"));
});

test("a child that inherits the session model must not carry an override", () => {
  const agents = serialized();
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/inherits"
      ? { ...record, hasModel: true, model: "anthropic/claude-sonnet-4-5" }
      : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "unexpectedly carries model"));
});

test("a disabled child present with a wrong mode fails closed; its rules are not load-bearing", () => {
  const agents = serialized();
  // A disabled child that appears with mode primary is a misconfiguration even
  // though the primary never allowlists it.
  const records = goldenRecords(agents).map((record) =>
    record.id === "att-1/disabled" ? { ...record, mode: "primary" } : record,
  );
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "child agent att-1/disabled"));
});

test("an inventory computed for a different directory fails closed", () => {
  const agents = serialized();
  const records = goldenRecords(agents);
  const reasons = verifyManagedAgentInventory({
    agents,
    cwd: CWD,
    inventory: inventoryOf(agents, records, "C:\\somewhere\\else"),
  });
  assert.equal(reasons.length, 1);
  assert.ok(hasReason(reasons, "not the attempt workspace"));
});

test("an inventory computed for the attempt directory passes", () => {
  const agents = serialized();
  const records = goldenRecords(agents);
  const reasons = verifyManagedAgentInventory({
    agents,
    cwd: CWD,
    inventory: inventoryOf(agents, records, CWD),
  });
  assert.deepEqual(reasons, []);
});

test("every deviation is collected in one pass", () => {
  const agents = serialized();
  const records = goldenRecords(agents)
    .map((record) => (record.id === "att-1/primary" ? { ...record, mode: "not-a-mode" } : record))
    .filter((record) => record.id !== "att-1/inherits");
  const reasons = reasonsOf(agents, records);
  assert.ok(hasReason(reasons, "not-a-mode"));
  assert.ok(hasReason(reasons, "enabled child agent att-1/inherits"));
});

/* ------------------------------------------------------------------ *
 * preflightManagedOpenCodeAgents (bounded polling)
 * ------------------------------------------------------------------ */

test("preflight succeeds on the first inventory poll", async () => {
  const agents = serialized();
  const reader = async () => inventoryOf(agents, goldenRecords(agents));
  const result = await preflightManagedOpenCodeAgents({
    agents,
    cwd: CWD,
    env: {},
    inventory: reader,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.polls, 1);
  assert.equal(result.namespace, NAMESPACE);
  assert.equal(result.primaryRuntimeId, "att-1/primary");
  assert.deepEqual(result.verifiedChildren, ["att-1/explicit", "att-1/inherits"]);
});

test("preflight tolerates the cold-location race with bounded polling", async () => {
  const agents = serialized();
  let calls = 0;
  const reader = async () => {
    calls += 1;
    if (calls === 1) return { records: [] };
    if (calls === 2) {
      // Partial discovery: the primary has appeared but the children have not.
      return inventoryOf(
        agents,
        goldenRecords(agents).filter((record) => record.id === agents.primaryRuntimeId),
      );
    }
    return inventoryOf(agents, goldenRecords(agents));
  };
  const result = await preflightManagedOpenCodeAgents({
    agents,
    cwd: CWD,
    env: {},
    inventory: reader,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.polls, 3);
  assert.deepEqual(result.verifiedChildren, ["att-1/explicit", "att-1/inherits"]);
});

test("preflight fails closed once the bounded wait expires", async () => {
  const agents = serialized();
  const reader = async () => ({ records: [] });
  await assert.rejects(
    () =>
      preflightManagedOpenCodeAgents({
        agents,
        cwd: CWD,
        env: {},
        inventory: reader,
        pollIntervalMs: 5,
        pollBudgetMs: 20,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeAgentPreflightError);
      assert.ok(error.reasons.some((reason) => reason.includes("att-1/primary")));
      assert.ok(error.reasons.some((reason) => reason.includes("enabled child agent")));
      return true;
    },
  );
});

test("preflight never falls back to an unmanaged agent on a stable mismatch", async () => {
  const agents = serialized();
  // The primary is present but unverifiable every single poll: the preflight
  // must not accept it, even under polling pressure.
  const reader = async () =>
    inventoryOf(
      agents,
      goldenRecords(agents).map((record) =>
        record.id === "att-1/primary" ? { ...record, mode: "subagent" } : record,
      ),
    );
  await assert.rejects(
    () =>
      preflightManagedOpenCodeAgents({
        agents,
        cwd: CWD,
        env: {},
        inventory: reader,
        pollIntervalMs: 5,
        pollBudgetMs: 25,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeAgentPreflightError);
      assert.ok(error.reasons.some((reason) => reason.includes("primary agent att-1/primary")));
      return true;
    },
  );
});

test("preflight fails immediately when the inventory source errors", async () => {
  const agents = serialized();
  const reader = async () => {
    throw new OpenCodeAgentPreflightError(["the CLI exploded"]);
  };
  await assert.rejects(
    () => preflightManagedOpenCodeAgents({ agents, cwd: CWD, env: {}, inventory: reader }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeAgentPreflightError);
      assert.ok(error.reasons[0]?.includes("agent inventory source failed"));
      assert.ok(error.reasons[0]?.includes("the CLI exploded"));
      return true;
    },
  );
});

test("preflight honors an aborted attempt signal", async () => {
  const agents = serialized();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      preflightManagedOpenCodeAgents({
        agents,
        cwd: CWD,
        env: {},
        inventory: async () => ({ records: [] }),
        signal: controller.signal,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeAgentPreflightError);
      assert.ok(error.reasons.some((reason) => reason.includes("interrupted")));
      return true;
    },
  );
});

test("the full pinned-CLI path polls the real debug agents command via the runner", async () => {
  const agents = serialized();
  const calls: Parameters<ProcessRunner>[] = [];
  const runner: ProcessRunner = (binary, args, options) => {
    calls.push([binary, args, options]);
    // Cold-location race then the effective records, exactly as the CLI prints.
    if (calls.length === 1) return okResult("[]");
    const records = goldenRecords(agents).map((record) => ({
      id: record.id,
      name: record.id,
      request: { settings: {}, headers: {}, body: {} },
      description: "probe",
      mode: record.mode,
      hidden: false,
      permissions: record.permissions.map((rule) => ({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect,
      })),
      ...(record.model === undefined ? {} : { model: cliModelObject(record.model) }),
    }));
    return okResult(JSON.stringify(records));
  };
  const result = await preflightManagedOpenCodeAgents({
    agents,
    cwd: "C:\\attempts\\att-1",
    env: { PATH: "test-path", XDG_STATE_HOME: "C:\\state" },
    binary: "opencode-test",
    runner,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.polls, 2);
  assert.equal(calls.length, 2);
  const [binary, args, options] = calls[0]!;
  assert.equal(binary, "opencode-test");
  assert.deepEqual(args, ["debug", "agents"]);
  assert.equal(options.cwd, "C:\\attempts\\att-1");
  assert.deepEqual(options.env, { PATH: "test-path", XDG_STATE_HOME: "C:\\state" });
});

/** The pinned API/CLI reports an override as {providerID, id, variant?}. */
function cliModelObject(canonical: string): unknown {
  const hash = canonical.indexOf("#");
  const base = hash === -1 ? canonical : canonical.slice(0, hash);
  const variant = hash === -1 ? undefined : canonical.slice(hash + 1);
  const slash = base.indexOf("/");
  const providerID = base.slice(0, slash);
  const id = base.slice(slash + 1);
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}
