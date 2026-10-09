/**
 * Shared effective OpenCode V2 agent inventory (tasks 1.2-1.4; design D3;
 * capability `opencode-agent-selection`).
 *
 * This module owns three things that the managed preflight and native
 * discovery both need from OpenCode's effective configuration:
 *
 * 1. Reading and parsing the pinned CLI's effective inventory
 *    (`opencode debug agents`, pinned probe task 1.1). Parsing preserves the
 *    private, machine-facing records — notably the ordered permission rules a
 *    managed profile's checks compare byte-for-byte — and never reads the
 *    `system` prompt, `request` overlays or any credential-shaped field.
 * 2. A separate, explicit public projection for the console picker: identity,
 *    bounded/redacted name and description, mode, hidden/eligible state and an
 *    *evidenced* origin label. Missing origin evidence stays `unknown`; it is
 *    never inferred from the agent name. A generated runtime id keeps its
 *    private detail internally but is never an eligible native choice.
 * 3. Bounded native-id validation shared by selection and preflight.
 *
 * Private-by-construction: the parser copies only `id`, `mode`, `permissions`,
 * `model`, and the display-only `name`/`description`/`hidden` fields. A raw
 * `system` prompt or `request` map is dropped on the floor, so neither the
 * authenticated discovery route nor any diagnostic can forward it.
 */

import { resolve } from "node:path";
import type { ProcessRunner } from "./launcher.js";

/** One effective V2 permission rule as the inventory reports it. */
export interface AgentInventoryRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

/**
 * A non-privacy-sensitive origin label. `project` and `global` are only ever
 * reported when the inventory source actually carried that evidence; an
 * ordinary `debug agents` record carries none and projects to `unknown`.
 */
export type NativeAgentOrigin = "project" | "global" | "unknown";

/** One effective agent record from the inventory source. */
export interface AgentInventoryRecord {
  /** The runtime agent id, e.g. `<namespace>/primary` or `build`. */
  readonly id: string;
  /** The effective mode: `primary`, `subagent` or `all`. */
  readonly mode: string;
  /** The effective ordered permission rules (base header plus generated tail). */
  readonly permissions: readonly AgentInventoryRule[];
  /** True when the source record actually carried a `model` value. */
  readonly hasModel: boolean;
  /**
   * The canonical `provider/id[#variant]` of the record's model, when it is
   * usable. Unusable (malformed) models keep `hasModel: true` and omit this.
   */
  readonly model?: string;
  /** The display name, when the source record carried one. */
  readonly name?: string;
  /** The display description, when the source record carried one. */
  readonly description?: string;
  /** True when the source record marked the agent hidden. */
  readonly hidden?: boolean;
  /** Evidenced origin, or absent when the source offered no evidence. */
  readonly origin?: NativeAgentOrigin;
}

/**
 * An effective agent inventory for one directory: a list of agent records,
 * plus the directory the source reports it computed for when it reports one
 * (the server envelope's `location.directory`).
 */
export interface AgentInventory {
  readonly records: readonly AgentInventoryRecord[];
  readonly directory?: string;
}

/**
 * Reads the effective agent inventory for an attempt location. The default
 * ({@link readCliAgentInventory}) runs the pinned CLI under that cwd and
 * environment; tests inject their own. A reader failure throws
 * {@link OpenCodeAgentInventoryError} — an unusable source is an immediate
 * failure, distinct from the cold-location *race* (an empty or partial
 * inventory), which is not an error.
 */
export type AgentInventoryReader = (input: {
  readonly binary: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly runner: ProcessRunner;
  /** Bound on this single inventory call. */
  readonly timeoutMs?: number;
  /** Cancels this single inventory call. */
  readonly signal?: AbortSignal;
}) => Promise<AgentInventory>;

/**
 * Raised whenever the inventory source cannot be read or parsed. Kept distinct
 * from the cold-location race: an empty but well-formed inventory is valid.
 *
 * The managed preflight reexports this class as `OpenCodeAgentPreflightError`
 * for its existing callers; it is the same class object, so `instanceof` is
 * unchanged.
 */
export class OpenCodeAgentInventoryError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(
      reasons.length === 0
        ? "OpenCode agent inventory failed"
        : `OpenCode agent inventory failed:\n- ${reasons.join("\n- ")}`,
    );
    this.name = "OpenCodeAgentInventoryError";
    this.reasons = reasons;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The largest id a native selection or discovery projection will carry. */
export const MAX_NATIVE_AGENT_ID_LENGTH = 256;
/** Bound on a projected display name. */
export const MAX_NATIVE_AGENT_NAME_LENGTH = 120;
/** Bound on a projected display description. */
export const MAX_NATIVE_AGENT_DESCRIPTION_LENGTH = 240;

/** Modes that permit running as a session's primary agent (pinned V2 contract). */
export const NATIVE_PRIMARY_CAPABLE_MODES = ["primary", "all"] as const;

/** True when a mode may run as a primary agent for a session. */
export function isPrimaryCapableMode(mode: string): boolean {
  return mode === "primary" || mode === "all";
}

/**
 * A namespace Gremlyn itself generates for a managed attempt. Generated ids
 * (`attempt-<n>/<id>`) end up in a workspace's effective inventory, but they
 * are never a native operator choice: they are this system's own output.
 */
const GENERATED_ATTEMPT_NAMESPACE_PATTERN = /^attempt-[0-9]+$/u;

/** True when an id names a generated managed-attempt agent, not a native one. */
export function isGeneratedAttemptAgentId(id: string): boolean {
  const slash = id.indexOf("/");
  if (slash <= 0) return false;
  return GENERATED_ATTEMPT_NAMESPACE_PATTERN.test(id.slice(0, slash));
}

/**
 * True when a string contains a C0/C1 control character (including newline,
 * carriage return, tab and NUL). Scanned by code point so the check itself
 * carries no control-character regex.
 */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Unicode format (Cf) characters, which are unsafe inside an identifier. */
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/u;

/**
 * True when an identifier contains a C0/C1 control character or a Unicode
 * format (Cf) character. These are rejected consistently everywhere an id is
 * parsed, validated or projected, so a malformed identifier can never slip
 * through as eligible.
 */
export function hasUnsafeIdentifierCharacters(value: string): boolean {
  if (hasControlCharacters(value)) return true;
  return FORMAT_CHARACTER_PATTERN.test(value);
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code < 0x20 || code === 0x7f ? " " : character;
  }
  return result;
}

/**
 * True when a value is a bounded, non-empty native agent identifier safe to
 * carry through selection and into a `--agent` argv. Rejects control
 * characters, whitespace, argument-like leading dashes, empty/oversized values
 * and `.`/`..` path segments. This only bounds the identifier; eligibility
 * still requires exact membership in the effective inventory.
 */
export function isBoundedNativeAgentId(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_NATIVE_AGENT_ID_LENGTH) return false;
  if (value.startsWith("-")) return false;
  if (hasUnsafeIdentifierCharacters(value)) return false;
  if (/[\s\\]/u.test(value)) return false;
  for (const segment of value.split("/")) {
    if (segment === "." || segment === ".." || segment.length === 0) return false;
  }
  return true;
}

/**
 * Canonicalize an effective model into the profile's `provider/id[#variant]`
 * spelling. The CLI reports a model override as `{providerID, id, variant?}`;
 * a bare string is already canonical. Anything else is unusable.
 */
export function canonicalAgentModel(model: unknown): string | undefined {
  if (typeof model === "string") return model.length > 0 ? model : undefined;
  if (isRecord(model)) {
    const providerID = model.providerID;
    const id = model.id;
    if (
      typeof providerID === "string" &&
      providerID.length > 0 &&
      typeof id === "string" &&
      id.length > 0
    ) {
      const variant = model.variant;
      return typeof variant === "string" && variant.length > 0
        ? `${providerID}/${id}#${variant}`
        : `${providerID}/${id}`;
    }
  }
  return undefined;
}

function evidencedOrigin(value: unknown): NativeAgentOrigin | undefined {
  return value === "project" || value === "global" ? value : undefined;
}

/** Collapse control characters and whitespace runs, then trim. */
function collapseNativeAgentText(value: string): string {
  return stripControlCharacters(value).replace(/\s+/gu, " ").trim();
}

/**
 * Candidate private strings from a raw record — the system prompt and any
 * string leaf inside the request overlay. Used only to suppress a display
 * field that exactly reproduces private content; the values themselves are
 * never stored on the record or projected.
 */
function transientPrivateValues(raw: Record<string, unknown>): Set<string> {
  const values = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const cleaned = collapseNativeAgentText(value);
    if (cleaned !== "") values.add(cleaned);
  };
  add(raw.system);
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string") {
      add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isRecord(node)) {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  };
  walk(raw.request, 0);
  return values;
}

function normalizeInventoryRecord(raw: unknown): AgentInventoryRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw.id;
  const mode = raw.mode;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof mode !== "string" || mode.length === 0) return undefined;
  // A control/C1/Cf character makes the identifier unusable for selection or
  // argv, so the whole record is malformed rather than silently skipped.
  if (hasUnsafeIdentifierCharacters(id)) return undefined;
  const permissions: AgentInventoryRule[] = [];
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) return undefined;
    for (const entry of raw.permissions) {
      if (!isRecord(entry)) return undefined;
      const action = entry.action;
      const resource = entry.resource;
      const effect = entry.effect;
      if (
        typeof action !== "string" ||
        typeof resource !== "string" ||
        typeof effect !== "string"
      ) {
        return undefined;
      }
      permissions.push({ action, resource, effect });
    }
  }
  const hasModel = raw.model !== undefined && raw.model !== null;
  const model = canonicalAgentModel(raw.model);

  // A display field present with the wrong shape is malformed, not absent: a
  // non-boolean `hidden` must never silently make an agent eligible, and a
  // non-string name/description must never be coerced. A display value that
  // exactly reproduces a transient private value is dropped so it cannot be
  // projected; the private value is never persisted.
  const privateValues = transientPrivateValues(raw);
  let name: string | undefined;
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") return undefined;
    const cleaned = collapseNativeAgentText(raw.name);
    if (cleaned !== "" && !privateValues.has(cleaned)) name = raw.name;
  }
  let description: string | undefined;
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") return undefined;
    const cleaned = collapseNativeAgentText(raw.description);
    if (cleaned !== "" && !privateValues.has(cleaned)) description = raw.description;
  }
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") return undefined;
  const hidden = typeof raw.hidden === "boolean" ? raw.hidden : undefined;
  const origin = evidencedOrigin(raw.origin);
  // Only display-safe fields are retained; a `system` prompt or `request`
  // overlay is never copied, so it cannot leak through any projection.
  return {
    id,
    mode,
    permissions,
    hasModel,
    ...(model === undefined || !hasModel ? {} : { model }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(hidden === undefined ? {} : { hidden }),
    ...(origin === undefined ? {} : { origin }),
  };
}

/**
 * Parse an inventory document into records. Accepts the CLI's bare JSON array
 * and the server envelope `{location:{directory}, data:[…]}`. Returns
 * `undefined` when the output is unusable: empty, not JSON, or carrying a
 * malformed record. `[]` is valid and parses to an empty inventory — that is
 * the cold-location race, handled by the caller's polling, not a parse error.
 */
export function parseAgentInventory(stdout: string): AgentInventory | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  let rawRecords: unknown;
  let directory: string | undefined;
  if (Array.isArray(parsed)) {
    rawRecords = parsed;
  } else if (isRecord(parsed)) {
    if (isRecord(parsed.location) && typeof parsed.location.directory === "string") {
      directory = parsed.location.directory;
    }
    if (!Array.isArray(parsed.data)) return undefined;
    rawRecords = parsed.data;
  } else {
    return undefined;
  }
  if (!Array.isArray(rawRecords)) return undefined;

  const records: AgentInventoryRecord[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawRecords) {
    const record = normalizeInventoryRecord(raw);
    // A record without id/mode/permission shape is not filterable noise: an
    // agent we cannot read could be the one we must refuse to skip.
    if (record === undefined) return undefined;
    // Two records sharing one id are ambiguous (last-one-wins would silently
    // pick a definition), so the whole inventory is unusable.
    if (seenIds.has(record.id)) return undefined;
    seenIds.add(record.id);
    records.push(record);
  }
  return directory === undefined ? { records } : { records, directory };
}

/** The default inventory source: the pinned CLI under the attempt cwd + env. */
export const readCliAgentInventory: AgentInventoryReader = async (input) => {
  const result = await input.runner(input.binary, ["debug", "agents"], {
    cwd: input.cwd,
    env: input.env,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (result.timedOut) {
    throw new OpenCodeAgentInventoryError([
      `${input.binary} debug agents timed out after ${String(input.timeoutMs ?? "?")} ms`,
    ]);
  }
  if (result.isCanceled) {
    throw new OpenCodeAgentInventoryError([`${input.binary} debug agents was cancelled`]);
  }
  if (result.exitCode !== 0) {
    throw new OpenCodeAgentInventoryError([
      `${input.binary} debug agents exited ${String(result.exitCode)}: ` +
        `${result.stderr.trim() || "(no stderr)"}`,
    ]);
  }
  const inventory = parseAgentInventory(result.stdout);
  if (inventory === undefined) {
    throw new OpenCodeAgentInventoryError([
      `${input.binary} debug agents printed no usable agent inventory ` +
        "(empty, unparsable, or malformed output)",
    ]);
  }
  return inventory;
};

export interface BoundedAgentInventoryReadInput {
  /** The inventory reader to bound. */
  readonly inventory: AgentInventoryReader;
  readonly binary: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly runner: ProcessRunner;
  /** Upper bound on this one call. */
  readonly timeoutMs: number;
  /** Absolute overall deadline; each call is bounded by the time left. */
  readonly deadline?: number;
  /** Caller cancellation, composed with the timeout. */
  readonly signal?: AbortSignal;
}

/**
 * Read one inventory snapshot under a bound that a misbehaving reader cannot
 * escape. The supplied timeout is shortened to the remaining overall budget,
 * the reader receives a composed abort signal, and a `Promise.race` settles on
 * the first of: the reader, the timeout, or the caller's abort. The underlying
 * promise can never resolve into a late success after the race has already
 * rejected, and every timer/listener is removed on settle.
 *
 * The default CLI reader already honours `timeoutMs`/`signal`; this wrapper
 * additionally bounds an injected reader (or a runner that ignores both) so a
 * single hung call cannot consume the whole discovery budget.
 */
export async function readBoundedAgentInventory(
  input: BoundedAgentInventoryReadInput,
): Promise<AgentInventory> {
  if (input.signal?.aborted) {
    throw new OpenCodeAgentInventoryError(["agent inventory read was cancelled"]);
  }
  const remaining = input.deadline === undefined ? input.timeoutMs : input.deadline - Date.now();
  const boundMs = Math.max(1, Math.min(input.timeoutMs, remaining));

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOuterAbort: (() => void) | undefined;

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (onOuterAbort !== undefined && input.signal !== undefined) {
      input.signal.removeEventListener("abort", onOuterAbort);
    }
  };

  const timeoutError = new OpenCodeAgentInventoryError([
    `agent inventory read timed out after ${String(boundMs)} ms`,
  ]);
  const abortError = new OpenCodeAgentInventoryError(["agent inventory read was cancelled"]);

  const readPromise = Promise.resolve().then(() =>
    input.inventory({
      binary: input.binary,
      cwd: input.cwd,
      env: input.env,
      runner: input.runner,
      timeoutMs: boundMs,
      signal: controller.signal,
    }),
  );

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, boundMs);
  });

  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (input.signal === undefined) return;
    onOuterAbort = () => {
      controller.abort();
      reject(abortError);
    };
    if (input.signal.aborted) {
      onOuterAbort();
      return;
    }
    input.signal.addEventListener("abort", onOuterAbort, { once: true });
  });

  try {
    return await Promise.race([readPromise, timeoutPromise, abortPromise]);
  } catch (error) {
    if (error instanceof OpenCodeAgentInventoryError) throw error;
    throw new OpenCodeAgentInventoryError([error instanceof Error ? error.message : String(error)]);
  } finally {
    cleanup();
  }
}

/** A display-safe native agent offered to the picker. */
export interface NativeAgentChoice {
  /** The runtime agent id. */
  readonly id: string;
  /** Bounded display name, when the source carried one. */
  readonly name?: string;
  /** Bounded, whitespace-collapsed description, when one was carried. */
  readonly description?: string;
  /** The effective mode (`primary`, `subagent` or `all`). */
  readonly mode: string;
  /** Whether the source marked the agent hidden. */
  readonly hidden: boolean;
  /**
   * True when this record is a legal native primary choice: bounded id,
   * visible, primary-capable, and not a Gremlyn-generated attempt id.
   */
  readonly eligible: boolean;
  /** Evidenced origin, or `unknown` when the source carried none. */
  readonly origin: NativeAgentOrigin;
}

/**
 * Obvious credential-like literals that must never reach a console or audit
 * line even when an operator pasted one into an agent description. Kept
 * minimal and anchored so ordinary prose is not over-redacted.
 */
const CREDENTIAL_LIKE_SOURCES: readonly string[] = [
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "\\bsk-[A-Za-z0-9_-]{12,}\\b",
  "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b",
  "\\bAKIA[0-9A-Z]{16}\\b",
  "\\bBearer\\s+[A-Za-z0-9._~+/=-]{10,}",
  "\\b(?:api[_-]?key|client[_-]?secret|secret|token|password|passwd|authorization)\\b\\s*[:=]\\s*\\S+",
];

/** Replace obvious credential-like literals in display text with a marker. */
export function redactCredentialLikeText(value: string): string {
  let result = value;
  for (const source of CREDENTIAL_LIKE_SOURCES) {
    result = result.replace(new RegExp(source, "giu"), "[redacted]");
  }
  return result;
}

/**
 * Collapse control characters, collapse whitespace runs, trim, redact obvious
 * credential-like literals and bound a display string. Returns undefined for a
 * non-string or empty-after-cleaning value. The output never contains a newline
 * or control character, so a description cannot smuggle structure into a
 * console or audit line.
 */
export function boundNativeAgentText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = collapseNativeAgentText(value);
  if (cleaned === "") return undefined;
  const redacted = redactCredentialLikeText(cleaned);
  if (redacted === "") return undefined;
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Bound a name to the display limit. */
export function boundNativeAgentName(value: unknown): string | undefined {
  return boundNativeAgentText(value, MAX_NATIVE_AGENT_NAME_LENGTH);
}

/** Bound a description to the display limit. */
export function boundNativeAgentDescription(value: unknown): string | undefined {
  return boundNativeAgentText(value, MAX_NATIVE_AGENT_DESCRIPTION_LENGTH);
}

/**
 * True when an inventory record is an eligible native primary choice. This is
 * the single eligibility rule shared by discovery and selection validation.
 */
export function isEligibleNativeAgentRecord(record: AgentInventoryRecord): boolean {
  if (!isBoundedNativeAgentId(record.id)) return false;
  if (record.hidden === true) return false;
  if (!isPrimaryCapableMode(record.mode)) return false;
  if (isGeneratedAttemptAgentId(record.id)) return false;
  return true;
}

/**
 * Project one internal record into the public, privacy-safe choice shape. An
 * explicit allowlist of fields leaves permissions, `model` and any dropped
 * private field behind; the description is bounded and control characters are
 * stripped. Missing origin evidence becomes `unknown`.
 */
export function projectNativeAgentRecord(record: AgentInventoryRecord): NativeAgentChoice {
  const name = boundNativeAgentName(record.name);
  const description = boundNativeAgentDescription(record.description);
  return {
    id: record.id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    mode: record.mode,
    hidden: record.hidden === true,
    eligible: isEligibleNativeAgentRecord(record),
    origin: record.origin ?? "unknown",
  };
}

/** Project every record, in inventory order, for diagnostics that need them. */
export function projectNativeAgentRecords(inventory: AgentInventory): readonly NativeAgentChoice[] {
  return inventory.records.map((record) => projectNativeAgentRecord(record));
}

/** The eligible native primary choices in inventory order. */
export function eligibleNativeAgentChoices(
  inventory: AgentInventory,
): readonly NativeAgentChoice[] {
  return inventory.records
    .filter((record) => isEligibleNativeAgentRecord(record))
    .map((record) => projectNativeAgentRecord(record));
}

/** Compare two paths the way the host filesystem resolves them. */
export function sameInventoryDirectory(left: string, right: string): boolean {
  const l = resolve(left);
  const r = resolve(right);
  return process.platform === "win32" ? l.toLowerCase() === r.toLowerCase() : l === r;
}
