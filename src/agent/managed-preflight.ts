/**
 * Preflight the effective generated OpenCode V2 agents before a managed attempt
 * runs (task 3.3; design D3; capability `opencode-agent-profiles`).
 *
 * {@link serializeOpenCodeAgents} turns a validated profile into V2 Markdown
 * agent files whose runtime ids are `<namespace>/<primary>` and
 * `<namespace>/<child>`. OpenCode discovers those files from the *project*
 * — the same process cwd and environment the executor's `run` will use — and
 * `opencode run --agent <id>` selects the primary. That selection works only
 * when OpenCode actually loaded the generated definitions: if the primary id
 * is absent, `run` falls back to the default `build` agent and the attempt
 * silently runs without the operator's delegation rules. This module is the
 * gate that makes that impossible: it verifies the *effective* inventory for
 * the attempt location under the exact cwd/env that `run` will receive, and
 * fails with a distinct configuration reason before any agent work if the
 * generated team is not effective.
 *
 * Inventory surface (pinned probe against the installed 2.0.16 CLI):
 *
 * - The authoritative machine surface is the pinned CLI's
 *   `opencode debug agents`, run under the attempt cwd and environment. It
 *   prints a JSON array of effective agent records
 *   `{id, name, mode, permissions:[{action,resource,effect}], model?}`. The
 *   "normal" `opencode api` server route (*GET /api/agent?location[directory]=
 *   <encoded absolute cwd>*) returns the same records under a
 *   `{location:{directory}, data:[…]}` envelope, but it requires an
 *   already-running service, so the preflight defaults to the CLI. The parser
 *   accepts both shapes so an injected inventory source (including a
 *   service-backed one) can supply either.
 * - Discovery has a *cold-location race*: the first inventory call for an
 *   attempt can return `[]` even though the generated files are present; the
 *   generated ids appear on a later call. The preflight therefore polls the
 *   exact attempt location with a bounded wait and fails closed if the primary
 *   and every enabled child have not appeared and passed every check within
 *   the budget.
 * - The effective record merges a global base header (the default `*` allow,
 *   `.env` reads, and host tool directories) *before* the file's own rules,
 *   which are appended contiguously in the exact order the serializer wrote
 *   them. The generated rules always begin with a `{action:"*","resource":"*",
 *   effect:"deny"}` baseline, so the preflight isolates the generated tail at
 *   the *last* such deny-all rule and compares it byte-for-byte against what
 *   the attempt serialized.
 * - A child model override appears as `{providerID, id, variant?}` in the
 *   record; an omitted override leaves `model` absent entirely. The preflight
 *   canonicalizes the record form to `provider/id[#variant]` and asserts
 *   presence matches the profile's override-or-inherit decision exactly.
 *
 * Verification contract (design D3, `agent-execution` and
 * `opencode-agent-profiles` delta requirements):
 *
 * - The generated primary and every *enabled* child must exist in the
 *   inventory with their effective `mode` matching the serialized frontmatter.
 * - The primary's subagent allowlist must be exactly the enabled generated
 *   children in profile order, past a leading deny-all, with nothing else —
 *   so disabled and unrelated agents are never invocable.
 * - Each enabled child's effective rule tail must equal the serialized rules
 *   (intrinsic reads, declared tools, `external_directory` deny, a final
 *   `subagent` deny) and its model must be present iff the profile declared an
 *   override, equal to it when present.
 * - Any deviation — a missing primary, a blocked/missing child, a mode or
 *   rule mismatch, an allowlist that opens with an allow, a model that does
 *   not follow the profile, an inventory computed for the wrong directory —
 *   throws {@link OpenCodeAgentPreflightError}, a configuration failure that
 *   never falls back to another agent.
 *
 * The inventory source is replaceable for tests (a fake runner, a fake reader,
 * or a scripted cold-location sequence); the default reads the installed
 * pinned CLI through the common launcher. Nothing here writes, edits, stages,
 * or commits — preflight runs before `run` and owns no side effects.
 */

import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  OpenCodeAgentInventoryError,
  readBoundedAgentInventory,
  readCliAgentInventory,
  type AgentInventory,
  type AgentInventoryReader,
  type AgentInventoryRecord,
  type AgentInventoryRule,
} from "./agent-inventory.js";
import { defaultRunner, type ProcessRunner } from "./launcher.js";
import { OPENCODE_AGENT_DIR, type SerializedOpenCodeAgents } from "./materialize.js";

/**
 * Compatibility reexports. The shared reader, parser and record shapes now
 * live in `agent-inventory.ts` so native discovery consumes the exact same
 * effective inventory and privacy projection. Existing managed-preflight
 * callers keep importing them from here.
 */
export {
  canonicalAgentModel,
  parseAgentInventory,
  readCliAgentInventory,
} from "./agent-inventory.js";
export type {
  AgentInventory,
  AgentInventoryReader,
  AgentInventoryRecord,
  AgentInventoryRule,
} from "./agent-inventory.js";
export { OpenCodeAgentInventoryError as OpenCodeAgentPreflightError } from "./agent-inventory.js";

/** Default wait between inventory polls while the cold-location race settles. */
export const OPENCODE_AGENT_PREFLIGHT_POLL_INTERVAL_MS = 500;

/**
 * Bound on the whole preflight wait. Discovery can take several calls (the
 * generated ids have appeared straight away and on later calls in probing);
 * anything still unverified after this budget fails closed.
 */
export const OPENCODE_AGENT_PREFLIGHT_POLL_BUDGET_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameResolvedPath(left: string, right: string): boolean {
  const l = resolve(left);
  const r = resolve(right);
  return process.platform === "win32" ? l.toLowerCase() === r.toLowerCase() : l === r;
}

/** The expected shape of one generated definition, parsed from its file. */
interface GeneratedDefinition {
  readonly mode: string;
  /** The frontmatter `model` field, which materialize emits only for overrides. */
  readonly model?: string;
  /** The exact ordered permission rules the file serialized. */
  readonly permissions: readonly AgentInventoryRule[];
}

/** The runtime id of a generated file path beneath `.opencode/agents/<ns>/`. */
function runtimeIdForFile(namespace: string, path: string): string | undefined {
  const prefix = `${OPENCODE_AGENT_DIR}/${namespace}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  if (!rest.endsWith(".md")) return undefined;
  const id = rest.slice(0, -".md".length);
  return id.length === 0 ? undefined : `${namespace}/${id}`;
}

/**
 * Parse one generated file's closed frontmatter back into the mode, model, and
 * exact ordered rules the serializer wrote. The frontmatter is closed by
 * construction (the serializer's own tests prove parsing it back yields exactly
 * the keys it emitted), so this is a faithful source of the attempt's contract.
 */
function parseGeneratedDefinition(content: string): GeneratedDefinition | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const close = content.indexOf("\n---\n");
  if (close === -1) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(content.slice(0, close + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const mode = parsed.mode;
  if (typeof mode !== "string" || mode.length === 0) return undefined;
  let model: string | undefined;
  if (parsed.model !== undefined) {
    if (typeof parsed.model !== "string") return undefined;
    model = parsed.model;
  }
  if (!Array.isArray(parsed.permissions)) return undefined;
  const permissions: AgentInventoryRule[] = [];
  for (const raw of parsed.permissions) {
    if (!isRecord(raw)) return undefined;
    const action = raw.action;
    const resource = raw.resource;
    const effect = raw.effect;
    if (typeof action !== "string" || typeof resource !== "string") return undefined;
    // The serializer emits only allow/deny; anything else means the file was
    // not the one this attempt wrote.
    if (effect !== "allow" && effect !== "deny") return undefined;
    permissions.push({ action, resource, effect });
  }
  return model === undefined ? { mode, permissions } : { mode, model, permissions };
}

/**
 * Parse every serialized file into its expected definition, keyed by runtime
 * id. Any file that cannot be parsed yields a reason — a generated file this
 * attempt cannot read can never be verified, so the preflight must fail.
 */
function generatedDefinitions(
  agents: SerializedOpenCodeAgents,
  reasons: string[],
): Map<string, GeneratedDefinition> {
  const definitions = new Map<string, GeneratedDefinition>();
  for (const file of agents.files) {
    const runtimeId = runtimeIdForFile(agents.namespace, file.path);
    if (runtimeId === undefined) {
      reasons.push(
        `generated file ${file.path} does not sit directly inside ` +
          `${OPENCODE_AGENT_DIR}/${agents.namespace}/; its runtime id cannot be determined`,
      );
      continue;
    }
    const definition = parseGeneratedDefinition(file.content);
    if (definition === undefined) {
      reasons.push(
        `generated file ${file.path} has no parseable V2 frontmatter; ` +
          "the preflight cannot compare it to the effective inventory",
      );
      continue;
    }
    definitions.set(runtimeId, definition);
  }
  return definitions;
}

/**
 * True when two ordered rule lists are field-for-field identical. The
 * effective inventory's generated tail must match the serialized rules
 * exactly — opencode appends them contiguously in the pinned 2.0.16 probe.
 */
function sameRules(
  left: readonly AgentInventoryRule[],
  right: readonly AgentInventoryRule[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.action !== b.action || a.resource !== b.resource || a.effect !== b.effect) {
      return false;
    }
  }
  return true;
}

/**
 * The generated rule tail starts at the last deny-all baseline. The merged
 * header's `*` rule is an allow; only the generated file introduces the
 * `{action:"*", resource:"*", effect:"deny"}` baseline it opens with.
 */
function generatedTailStart(permissions: readonly AgentInventoryRule[]): number {
  let start = -1;
  permissions.forEach((rule, index) => {
    if (rule.action === "*" && rule.resource === "*" && rule.effect === "deny") start = index;
  });
  return start;
}

/** Readable problems with a primary's subagent allowlist shape and order. */
function checkAllowlist(
  record: AgentInventoryRecord,
  expectedAllowed: readonly string[],
  owner: string,
): string[] {
  const problems: string[] = [];
  const subagent = record.permissions.filter((rule) => rule.action === "subagent");
  let lastDenyAll = -1;
  subagent.forEach((rule, index) => {
    if (rule.resource === "*" && rule.effect === "deny") lastDenyAll = index;
  });
  const allowed = subagent.filter((rule) => rule.effect === "allow").map((rule) => rule.resource);
  const expected = expectedAllowed.join("/");
  const actual = allowed.join("/");
  if (allowed.length !== expectedAllowed.length || actual !== expected) {
    problems.push(
      `${owner} allowlist targets ${actual === "" ? "(none)" : actual}; expected exactly ` +
        `${expected === "" ? "(none)" : expected} — disabled and unrelated agents must never ` +
        "be invocable",
    );
  }
  if (lastDenyAll === -1) {
    problems.push(
      `${owner} is missing the deny-all subagent rule; the allowlist must open with a deny`,
    );
  } else {
    const firstAllow = subagent.findIndex((rule) => rule.effect === "allow");
    if (firstAllow !== -1 && firstAllow < lastDenyAll) {
      problems.push(
        `${owner} places a subagent allow before the deny-all rule; ` +
          "the allowlist must be ordered deny-then-allow",
      );
    }
  }
  return problems;
}

/** Readable problems with a record's generated rule tail versus its file. */
function checkGeneratedTail(
  record: AgentInventoryRecord,
  expected: GeneratedDefinition,
  owner: string,
): string[] {
  const problems: string[] = [];
  const start = generatedTailStart(record.permissions);
  if (start === -1) {
    problems.push(
      `${owner} effective rules lack the generated deny-all baseline; ` +
        "the serialized definition did not load",
    );
    return problems;
  }
  const tail = record.permissions.slice(start);
  if (!sameRules(tail, expected.permissions)) {
    problems.push(
      `${owner} effective rules do not match the serialized definition ` +
        `(${String(tail.length)} rules after the baseline vs ${String(expected.permissions.length)} ` +
        "serialized)",
    );
  }
  return problems;
}

/**
 * Verify an effective inventory against the serialized attempt agents. Pure
 * and synchronous, so tests can drive the exact checks the preflight applies.
 * Returns every deviation found in one pass; an empty list means the inventory
 * proves the generated team effective for the attempt location.
 */
export function verifyManagedAgentInventory(input: {
  readonly agents: SerializedOpenCodeAgents;
  readonly cwd: string;
  readonly inventory: AgentInventory;
}): readonly string[] {
  const reasons: string[] = [];
  const { agents, cwd, inventory } = input;

  if (inventory.directory !== undefined && !sameResolvedPath(inventory.directory, cwd)) {
    reasons.push(
      `the agent inventory was computed for ${inventory.directory}, ` +
        `not the attempt workspace ${cwd}`,
    );
  }

  const byId = new Map<string, AgentInventoryRecord>();
  for (const record of inventory.records) byId.set(record.id, record);

  const expectedDefinitions = generatedDefinitions(agents, reasons);
  if (reasons.length > 0) return reasons;

  const expectedAllowed = agents.children
    .filter((child) => child.enabled)
    .map((child) => child.runtimeId);

  const expectedPrimary = expectedDefinitions.get(agents.primaryRuntimeId);
  if (expectedPrimary === undefined) {
    reasons.push(`the serialized attempt defines no primary file for ${agents.primaryRuntimeId}`);
    return reasons;
  }

  const primary = byId.get(agents.primaryRuntimeId);
  if (primary === undefined) {
    reasons.push(
      `primary agent ${agents.primaryRuntimeId} is not present in the effective agent inventory`,
    );
  } else {
    if (primary.mode !== expectedPrimary.mode) {
      reasons.push(
        `primary agent ${agents.primaryRuntimeId} has effective mode "${primary.mode}", ` +
          `expected "${expectedPrimary.mode}"`,
      );
    }
    if (primary.hasModel) {
      reasons.push(
        `primary agent ${agents.primaryRuntimeId} unexpectedly carries a model override; ` +
          "the primary session model comes from the repository selection",
      );
    }
    reasons.push(...checkAllowlist(primary, expectedAllowed, agents.primaryRuntimeId));
    reasons.push(...checkGeneratedTail(primary, expectedPrimary, agents.primaryRuntimeId));
  }

  for (const child of agents.children) {
    const expected = expectedDefinitions.get(child.runtimeId);
    if (expected === undefined) {
      reasons.push(`the serialized attempt defines no child file for ${child.runtimeId}`);
      continue;
    }
    const record = byId.get(child.runtimeId);
    if (!child.enabled) {
      // A disabled child's file exists but is never allowlisted, so it spends
      // its lifecycle inert. When it is present its mode must still be sane;
      // its rules and model cannot matter because the primary cannot invoke it.
      if (record !== undefined && record.mode !== expected.mode) {
        reasons.push(
          `child agent ${child.runtimeId} has effective mode "${record.mode}", ` +
            `expected "${expected.mode}"`,
        );
      }
      continue;
    }
    if (record === undefined) {
      reasons.push(
        `enabled child agent ${child.runtimeId} is not present in the effective agent inventory`,
      );
      continue;
    }
    if (record.mode !== expected.mode) {
      reasons.push(
        `child agent ${child.runtimeId} has effective mode "${record.mode}", ` +
          `expected "${expected.mode}"`,
      );
    }
    if (expected.model !== undefined) {
      if (!record.hasModel) {
        reasons.push(
          `child agent ${child.runtimeId} is missing its model override ${expected.model}; ` +
            "the profile requires this child to use it",
        );
      } else if (record.model !== expected.model) {
        reasons.push(
          `child agent ${child.runtimeId} has model ${record.model ?? "(unusable)"}, ` +
            `expected ${expected.model}`,
        );
      }
    } else if (record.hasModel) {
      reasons.push(
        `child agent ${child.runtimeId} unexpectedly carries model ` +
          `${record.model ?? "(unusable)"}; an omitted override must inherit the primary session ` +
          "model",
      );
    }
    reasons.push(...checkGeneratedTail(record, expected, child.runtimeId));
  }

  return reasons;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new OpenCodeAgentInventoryError(["preflight interrupted"]));
      return;
    }
    const settle = (): void => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OpenCodeAgentInventoryError(["preflight interrupted"]));
    };
    const timer = setTimeout(settle, ms);
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ManagedAgentPreflightInput {
  /** The serialized attempt agents, consumed verbatim (materialize output). */
  readonly agents: SerializedOpenCodeAgents;
  /**
   * The absolute attempt workspace — exactly the cwd `opencode run` will use.
   * The inventory is read for this location.
   */
  readonly cwd: string;
  /** The exact environment `run` will receive (allowlist + executor additions). */
  readonly env: Record<string, string>;
  /** The pinned CLI binary, matching the executor's default. */
  readonly binary?: string;
  /** Injected process launcher for the CLI inventory (tests). */
  readonly runner?: ProcessRunner;
  /**
   * Injected inventory source. Defaults to {@link readCliAgentInventory},
   * which runs `opencode debug agents` under `cwd` and `env`.
   */
  readonly inventory?: AgentInventoryReader;
  readonly pollIntervalMs?: number;
  readonly pollBudgetMs?: number;
  readonly signal?: AbortSignal;
}

export interface ManagedAgentPreflightResult {
  readonly status: "ok";
  readonly namespace: string;
  /** The generated primary id that is now verifiably effective. */
  readonly primaryRuntimeId: string;
  /** The enabled children verified present, effective, and profile-correct. */
  readonly verifiedChildren: readonly string[];
  /** The inventory snapshot that satisfied every check. */
  readonly inventory: AgentInventory;
  /** How many inventory polls the preflight took (1 when first-try clean). */
  readonly polls: number;
}

/**
 * Prove the generated primary and enabled children are effective for the
 * attempt before `run`. Polls the inventory source under the attempt's cwd and
 * environment until every check passes or the budget is exhausted.
 *
 * Fail-closed by construction:
 * - An inventory source that errors fails immediately (that is not the
 *   cold-location race, which is an empty or partial inventory).
 * - An inventory that never proves the primary and enabled children within the
 *   bounded wait throws {@link OpenCodeAgentPreflightError} carrying every
 *   deviation seen, so the attempt fails with a configuration reason and never
 *   falls back to an unmanaged agent.
 * - An aborted signal interrupts the wait with the same configuration error.
 */
export async function preflightManagedOpenCodeAgents(
  input: ManagedAgentPreflightInput,
): Promise<ManagedAgentPreflightResult> {
  const binary = input.binary ?? "opencode";
  const runner = input.runner ?? defaultRunner;
  const reader = input.inventory ?? readCliAgentInventory;
  const interval = input.pollIntervalMs ?? OPENCODE_AGENT_PREFLIGHT_POLL_INTERVAL_MS;
  const budget = input.pollBudgetMs ?? OPENCODE_AGENT_PREFLIGHT_POLL_BUDGET_MS;

  const verifiedChildren = input.agents.children
    .filter((child) => child.enabled)
    .map((child) => child.runtimeId);
  const deadline = Date.now() + budget;
  let polls = 0;
  let lastReasons: readonly string[] = [];

  for (;;) {
    if (input.signal?.aborted) {
      throw new OpenCodeAgentInventoryError([
        "preflight interrupted: the attempt signal was aborted before the generated agents were verified",
      ]);
    }
    if (lastReasons.length > 0 && Date.now() >= deadline) {
      throw new OpenCodeAgentInventoryError(lastReasons);
    }
    polls += 1;
    let inventory: AgentInventory;
    try {
      // Bound every read by the remaining budget so a hung reader or CLI
      // cannot stall the preflight past its own deadline.
      inventory = await readBoundedAgentInventory({
        inventory: reader,
        binary,
        cwd: input.cwd,
        env: input.env,
        runner,
        timeoutMs: budget,
        deadline,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw new OpenCodeAgentInventoryError([`agent inventory source failed: ${describe(error)}`]);
    }
    lastReasons = verifyManagedAgentInventory({
      agents: input.agents,
      cwd: input.cwd,
      inventory,
    });
    if (lastReasons.length === 0) {
      return {
        status: "ok",
        namespace: input.agents.namespace,
        primaryRuntimeId: input.agents.primaryRuntimeId,
        verifiedChildren,
        inventory,
        polls,
      };
    }
    if (Date.now() >= deadline) {
      throw new OpenCodeAgentInventoryError(lastReasons);
    }
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())), input.signal);
  }
}
