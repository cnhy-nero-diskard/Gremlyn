/**
 * Versioned OpenCode agent profile types and field-specific validation
 * (design D1; capability `opencode-agent-profiles`).
 *
 * A profile is a whole, versioned document: exactly one named primary agent
 * definition and an ordered list of subagent definitions. It is the operator's
 * source of truth for a managed OpenCode agent team and is persisted per
 * repository as canonical JSON (see {@link canonicalOpenCodeProfileJson}).
 *
 * Parsing is atomic and pure: a candidate is either accepted as a normalized
 * profile or rejected with every field-specific issue it carries, and nothing
 * the caller already holds is mutated. An invalid save therefore leaves the
 * previously saved profile unchanged by construction.
 *
 * Design constraints encoded here:
 * - IDs are unique case-insensitively across the whole profile and restricted
 *   to a safe single path segment (usable as one filename segment and as a
 *   `--agent <id>` argument, never misparsed as a flag).
 * - Descriptions are required; instructions are optional data, never shell
 *   input. Model overrides must be `provider/model[#variant]`.
 * - Step limits are positive integers; every subagent carries an enabled flag.
 * - The only supported tool permissions are workspace edit, shell, web access,
 *   and skill loading. External-directory access and nested child delegation
 *   are always denied for managed children: they are not part of the
 *   vocabulary and any such value is rejected as unsupported.
 * - Subagents default to read-only: an omitted or empty permission list grants
 *   no tools. A child without a model override inherits the primary session
 *   model.
 */

export const OPENCODE_AGENT_PROFILE_VERSION = 1 as const;
export type OpenCodeAgentProfileVersion = typeof OPENCODE_AGENT_PROFILE_VERSION;

/**
 * The supported tool permissions a managed OpenCode agent may declare.
 * External-directory access and nested child delegation are deliberately
 * absent — see {@link DENIED_CHILD_SCOPES}.
 */
export const OPENCODE_PERMISSIONS = ["edit", "shell", "web", "skill"] as const;
export type OpenCodePermission = (typeof OPENCODE_PERMISSIONS)[number];

/**
 * Tool scopes that are never part of the managed vocabulary. External-directory
 * access and nested child delegation are always denied for managed children
 * (design D1); a profile that names one is rejected rather than silently
 * downgraded.
 */
export const DENIED_CHILD_SCOPES = ["directory", "subagent"] as const;
export type DeniedChildScope = (typeof DENIED_CHILD_SCOPES)[number];

/**
 * An optional-field carrier shared by the primary and subagent definitions.
 * `instructions` is free-form text stored and serialized as data, never
 * interpolated into a shell command. `stepLimit` bounds the agent's steps and
 * must be a positive integer. `permissions` is always present on the parsed
 * (normalized) profile; an empty list means read-only.
 */
export interface OpenCodeAgentDefinitionBase {
  /** Unique, case-insensitive, safe single path segment within the profile. */
  id: string;
  description: string;
  /** Optional free-form instructions; stored and serialized as data. */
  instructions?: string;
  /** Optional positive step limit for this agent definition. */
  stepLimit?: number;
  /** Supported tool permissions; an empty list means read-only. */
  permissions: OpenCodePermission[];
}

/**
 * The primary agent definition. Its session model is the repository's selected
 * OpenCode model and never appears in the profile.
 */
export type OpenCodePrimaryAgent = OpenCodeAgentDefinitionBase;

export interface OpenCodeSubAgent extends OpenCodeAgentDefinitionBase {
  /** Whether the managed primary may invoke this subagent. */
  enabled: boolean;
  /**
   * Optional `provider/model[#variant]` override. An omitted override inherits
   * the primary session model (the repository's selected OpenCode model).
   */
  model?: string;
}

/**
 * Version 1 of the dashboard-managed profile: one primary and an ordered list
 * of subagents. The primary's session model is the repository's selected model
 * and never appears in the profile.
 */
export interface OpenCodeAgentProfileV1 {
  version: typeof OPENCODE_AGENT_PROFILE_VERSION;
  primary: OpenCodePrimaryAgent;
  /** Ordered subagent definitions; the managed primary may invoke enabled ones. */
  subagents: OpenCodeSubAgent[];
}

export type OpenCodeAgentProfile = OpenCodeAgentProfileV1;

export interface OpenCodeProfileFieldIssue {
  /**
   * Field path within the submitted profile, e.g. `primary.id`,
   * `subagents[1].model`, or `subagents[0].permissions[2]`.
   */
  path: string;
  message: string;
}

/**
 * Raised by {@link parseOpenCodeAgentProfile} when a profile candidate is
 * invalid. Carries every field-specific issue found in one pass so the console
 * can surface each problem beside the relevant control.
 */
export class OpenCodeProfileValidationError extends Error {
  readonly issues: readonly OpenCodeProfileFieldIssue[];
  constructor(issues: readonly OpenCodeProfileFieldIssue[]) {
    super(
      `Invalid OpenCode agent profile:\n- ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n- ")}`,
    );
    this.name = "OpenCodeProfileValidationError";
    this.issues = issues;
  }
}

/**
 * IDs are restricted to a safe single path segment: they begin and end with an
 * alphanumeric character (so a leading dash can never be misread as a CLI
 * flag and a trailing dot or space cannot be silently stripped by Windows),
 * and contain only letters, digits, `.`, `_`, and `-` — never a path
 * separator, whitespace, or traversal sequence.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/** Windows device names that cannot be used as a filename segment. */
const RESERVED_WINDOWS_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$/iu;

function isReservedWindowsName(value: string): boolean {
  const firstSegment = value.split(".", 1)[0] ?? value;
  return RESERVED_WINDOWS_NAME_PATTERN.test(firstSegment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseId(
  value: unknown,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "id is required and must be a non-empty string" });
    return undefined;
  }
  if (!SAFE_ID_PATTERN.test(value) || isReservedWindowsName(value)) {
    issues.push({
      path,
      message:
        `id "${value}" is not a safe single path segment: use letters, digits, ".", "_", or "-", ` +
        "starting and ending with a letter or digit, and avoid path separators, whitespace, and reserved names",
    });
    return undefined;
  }
  return value;
}

function parseDescription(
  value: unknown,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "description is required and must not be blank" });
    return undefined;
  }
  return value;
}

/**
 * Instructions are optional data. An empty string is treated as absent; any
 * other non-string value is rejected. No content rules apply — the text is
 * stored and serialized verbatim, encoded as data at materialization time.
 */
function parseInstructions(
  value: unknown,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({ path, message: "instructions must be a string" });
    return undefined;
  }
  return value.length === 0 ? undefined : value;
}

function parseStepLimit(
  value: unknown,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push({ path, message: `step limit must be a positive integer (got ${String(value)})` });
    return undefined;
  }
  return value;
}

function parseEnabled(value: unknown, path: string, issues: OpenCodeProfileFieldIssue[]): boolean {
  if (typeof value !== "boolean") {
    issues.push({ path, message: `enabled must be a boolean (got ${String(value)})` });
    return false;
  }
  return value;
}

/**
 * Permissions accept only the supported vocabulary. Unsupported values —
 * including external-directory access (`directory`) and nested delegation
 * (`subagent`), which are always denied for managed children — are rejected
 * with a field-specific issue. Duplicate supported values collapse to the
 * first occurrence so the canonical JSON carries no repeats.
 */
function parsePermissions(
  value: unknown,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): OpenCodePermission[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path, message: "permissions must be a list of supported tool permissions" });
    return [];
  }
  const result: OpenCodePermission[] = [];
  value.forEach((entry, index) => {
    const denied = (DENIED_CHILD_SCOPES as readonly string[]).includes(String(entry));
    const supported =
      typeof entry === "string"
        ? (OPENCODE_PERMISSIONS as readonly string[]).includes(entry)
        : false;
    if (denied) {
      issues.push({
        path: `${path}[${index}]`,
        message: `permission "${String(entry)}" is always denied for managed children (external-directory access and nested delegation are not supported)`,
      });
    } else if (!supported) {
      issues.push({
        path: `${path}[${index}]`,
        message: `unsupported permission ${JSON.stringify(entry)}; supported values: ${OPENCODE_PERMISSIONS.join(", ")}`,
      });
    } else if (!result.includes(entry)) {
      result.push(entry as OpenCodePermission);
    }
  });
  return result;
}

/**
 * True when a model id contains whitespace, a control character, or DEL — all
 * of which make it invalid as `provider/model[#variant]`. Implemented via code
 * points rather than a control-character regex literal so the rule set stays
 * lint-clean.
 */
function hasForbiddenModelCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A model override must be `provider/model[#variant]`: exactly one `/`, an
 * optional non-empty `#variant`, and no whitespace or control characters in
 * any part. Absent means "inherit the primary session model".
 */
function isProviderModelVariant(value: string): boolean {
  if (hasForbiddenModelCharacters(value)) return false;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  if (value.indexOf("/", slash + 1) !== -1) return false;
  const rest = value.slice(slash + 1);
  const hash = rest.indexOf("#");
  if (hash === 0) return false;
  if (hash === -1) return rest.length > 0;
  if (rest.indexOf("#", hash + 1) !== -1) return false;
  const model = rest.slice(0, hash);
  const variant = rest.slice(hash + 1);
  return model.length > 0 && variant.length > 0;
}

function parseModel(
  value: unknown,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isProviderModelVariant(value)) {
    issues.push({
      path,
      message: `model must be provider/model[#variant] (got ${JSON.stringify(value)})`,
    });
    return undefined;
  }
  return value;
}

function parsePrimary(
  raw: Record<string, unknown>,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): OpenCodePrimaryAgent | undefined {
  const id = parseId(raw.id, `${path}.id`, issues);
  const description = parseDescription(raw.description, `${path}.description`, issues);
  const instructions = parseInstructions(raw.instructions, `${path}.instructions`, issues);
  const stepLimit = parseStepLimit(raw.stepLimit, `${path}.stepLimit`, issues);
  const permissions = parsePermissions(raw.permissions, `${path}.permissions`, issues);
  if (id === undefined || description === undefined) return undefined;
  return {
    id,
    description,
    permissions,
    ...(instructions === undefined ? {} : { instructions }),
    ...(stepLimit === undefined ? {} : { stepLimit }),
  };
}

function parseSubagent(
  raw: unknown,
  path: string,
  issues: OpenCodeProfileFieldIssue[],
): OpenCodeSubAgent | undefined {
  if (!isRecord(raw)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const id = parseId(raw.id, `${path}.id`, issues);
  const description = parseDescription(raw.description, `${path}.description`, issues);
  const instructions = parseInstructions(raw.instructions, `${path}.instructions`, issues);
  const model = parseModel(raw.model, `${path}.model`, issues);
  const stepLimit = parseStepLimit(raw.stepLimit, `${path}.stepLimit`, issues);
  const enabled = parseEnabled(raw.enabled, `${path}.enabled`, issues);
  const permissions = parsePermissions(raw.permissions, `${path}.permissions`, issues);
  if (id === undefined || description === undefined) return undefined;
  return {
    id,
    description,
    enabled,
    permissions,
    ...(instructions === undefined ? {} : { instructions }),
    ...(model === undefined ? {} : { model }),
    ...(stepLimit === undefined ? {} : { stepLimit }),
  };
}

function collectId(
  id: string,
  path: string,
  seen: Map<string, string>,
  issues: OpenCodeProfileFieldIssue[],
): void {
  const key = id.toLowerCase();
  const prior = seen.get(key);
  if (prior === undefined) {
    seen.set(key, path);
  } else {
    issues.push({
      path,
      message: `id "${id}" duplicates the id at ${prior}; ids must be unique case-insensitively within a profile`,
    });
  }
}

/**
 * Validate, normalize, and return a profile candidate. Atomic: either the
 * whole candidate is accepted and returned as a normalized
 * {@link OpenCodeAgentProfile}, or {@link OpenCodeProfileValidationError} is
 * thrown carrying every field-specific issue found, and no partial or mutated
 * state is ever produced.
 */
export function parseOpenCodeAgentProfile(input: unknown): OpenCodeAgentProfile {
  const issues: OpenCodeProfileFieldIssue[] = [];
  if (!isRecord(input)) {
    throw new OpenCodeProfileValidationError([{ path: "profile", message: "must be an object" }]);
  }
  if (input.version !== OPENCODE_AGENT_PROFILE_VERSION) {
    issues.push({
      path: "version",
      message:
        `unsupported profile version ${JSON.stringify(input.version)}; ` +
        `expected ${OPENCODE_AGENT_PROFILE_VERSION}`,
    });
  }
  let primary: OpenCodePrimaryAgent | undefined;
  if (!isRecord(input.primary)) {
    issues.push({ path: "primary", message: "must be an object" });
  } else {
    primary = parsePrimary(input.primary, "primary", issues);
  }
  const subagents: OpenCodeSubAgent[] = [];
  const seen = new Map<string, string>();
  if (primary !== undefined) collectId(primary.id, "primary.id", seen, issues);
  if (!Array.isArray(input.subagents)) {
    issues.push({ path: "subagents", message: "must be a list" });
  } else {
    input.subagents.forEach((raw, index) => {
      const agent = parseSubagent(raw, `subagents[${index}]`, issues);
      if (agent !== undefined) {
        collectId(agent.id, `subagents[${index}].id`, seen, issues);
        subagents.push(agent);
      }
    });
  }
  if (issues.length > 0) throw new OpenCodeProfileValidationError(issues);
  // `primary` resolves to undefined only when its id or description failed,
  // and both of those push an issue; an issue-free parse always has a primary.
  return { version: OPENCODE_AGENT_PROFILE_VERSION, primary: primary!, subagents };
}

/**
 * The effective tool permissions a managed child runs with. Children default
 * to read-only: the normalized profile always carries an explicit permission
 * list, and an empty list grants no tools.
 */
export function effectiveChildPermissions(
  subagent: OpenCodeSubAgent,
): readonly OpenCodePermission[] {
  return subagent.permissions;
}

/**
 * The model a managed child runs with. A child without an explicit override
 * inherits the primary session model — the repository's selected OpenCode
 * model, which never appears inside the profile itself.
 */
export function resolveChildModel(subagent: OpenCodeSubAgent, primaryModel: string): string {
  return subagent.model ?? primaryModel;
}

/**
 * Canonical JSON for a normalized profile: keys are emitted in sorted order
 * and optional fields are absent when unset, so equivalent profiles serialize
 * byte-identically. Suitable for the durable profile column and for operator
 * change detection.
 */
export function canonicalOpenCodeProfileJson(profile: OpenCodeAgentProfile): string {
  return JSON.stringify(profile, (_key, value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "object" && value !== null) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort())
        sorted[key] = (value as Record<string, unknown>)[key];
      return sorted;
    }
    return value;
  });
}
