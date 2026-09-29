/**
 * Serialize a validated OpenCode agent profile into pinned OpenCode 2.0.16 V2
 * Markdown agent files (task 3.1; design D3; capability
 * `opencode-agent-profiles`).
 *
 * For an attempt with a managed profile, Gremlyn generates one V2 Markdown
 * agent file per profile definition beneath a unique, attempt-owned directory:
 *
 *   .opencode/agents/<namespace>/<id>.md
 *
 * OpenCode 2 discovers nested files and folds the directory into the agent id,
 * so `<namespace>/<id>` is the runtime id (`opencode debug agents` lists it
 * that way and `opencode run --agent <namespace>/<id>` selects it). A per-attempt
 * namespace keeps every generated id disjoint from repository and global agent
 * definitions (pinned probe, task 1.1).
 *
 * This module is pure serialization: it turns a validated profile and a namespace
 * into file paths and byte content and nothing else. Writing, journaling, and
 * cleanup of those files live in the attempt lifecycle (tasks 3.2+), not here.
 *
 * The generated contract (pinned probe, task 1.1, matched against the OpenCode
 * V2 agent/permissions documentation for 2.0.16):
 *
 * - The primary file carries `mode: primary`; every child carries
 *   `mode: subagent`.
 * - The primary's permissions start with an explicit deny-all and then allow
 *   only the *enabled* subagents named in the profile, in profile order. The
 *   probe observed the effective primary retaining exactly this ordered shape
 *   (`deny *`, then `allow <generated child>`), so a managed primary cannot
 *   invoke disabled or unrelated agents.
 * - Each child receives its own explicit tool rules: intrinsic reads
 *   (`read`, `glob`, `grep`) stay allowed, the profile-declared tools map to
 *   explicit allow rules, and external-directory access and nested child
 *   delegation are always denied (`external_directory` deny and a final
 *   `subagent` deny). A child with no declared tools is read-only, and a child
 *   cannot spawn grandchildren.
 * - A child with no model override keeps no `model` field at all. Per the V2
 *   agent contract the parent session model is then used, which is the
 *   repository's selected OpenCode model.
 * - The profile's step limit maps to the V2 `steps` field.
 *
 * Safety properties:
 *
 * - Instructions are preserved *as data*: the raw text becomes the Markdown
 *   body, never interpolated, and never able to inject frontmatter.
 * - Every other field is emitted through the `yaml` stringifier, so arbitrary
 *   descriptions (colons, quotes, newlines, `#`) are escaped instead of
 *   changing the document shape. The frontmatter is therefore closed: parsing
 *   it back yields exactly the keys this module wrote.
 * - The permission mapping is closed and fails closed: any profile permission
 *   value with no OpenCode 2.0.16 tool action raises
 *   {@link OpenCodeAgentSerializeError} instead of silently writing a narrower
 *   or wider rule. The namespace is validated as a safe single path segment so
 *   the generated directory can never traverse out of `.opencode/agents/`.
 */

import { stringify as stringifyYaml } from "yaml";
import type { OpenCodeAgentProfile, OpenCodePermission } from "../config/opencode-profile.js";

/** Repository-relative root beneath which generated V2 agent files are placed. */
export const OPENCODE_AGENT_DIR = ".opencode/agents";

/** A single ordered V2 permission rule (action, resource, effect). */
export interface AgentPermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny";
}

/**
 * The closed mapping from Gremlyn's profile permission vocabulary to the
 * OpenCode 2.0.16 tool actions granted by each value. `web` covers both V2 web
 * tools (webfetch and websearch); every other value maps to exactly one action.
 * Any value absent here must be rejected, never serialized into an
 * approximation.
 */
const PERMISSION_ACTION_MAP: Readonly<Record<string, readonly string[]>> = {
  edit: ["edit"],
  shell: ["shell"],
  web: ["webfetch", "websearch"],
  skill: ["skill"],
};

/** A safe single path segment, mirroring Gremlyn's profile id rule. */
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/** Windows device names that cannot be used as a directory segment. */
const RESERVED_WINDOWS_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$/iu;

/**
 * True when the namespace is a safe single path segment usable as one directory
 * under `.opencode/agents/`. The caller picks the unique value (an attempt id);
 * this only refuses values that could traverse or collide on the filesystem.
 */
export function isSafeAttemptNamespace(namespace: string): boolean {
  if (!SAFE_PATH_SEGMENT_PATTERN.test(namespace)) return false;
  const first = namespace.split(".", 1)[0] ?? namespace;
  return !RESERVED_WINDOWS_NAME_PATTERN.test(first);
}

/**
 * The runtime OpenCode agent id for a generated definition, produced by the
 * nested-path discovery documented for V2: `.opencode/agents/<ns>/<id>.md`
 * resolves to agent id `<ns>/<id>`.
 */
export function agentRuntimeId(namespace: string, id: string): string {
  return `${namespace}/${id}`;
}

/**
 * True when a value is a syntactically valid generated runtime id:
 * exactly two safe single path segments joined by one `/`
 * (`<namespace>/<id>`), the shape this module emits. The check exists so the
 * executor's trust boundary can refuse anything else before it reaches a
 * subprocess argv — a malformed id could never have been generated here, so an
 * attempt that carried one must fail closed rather than be launched.
 */
export function isOpenCodeAgentRuntimeId(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  if (value.indexOf("/", slash + 1) !== -1) return false;
  return (
    isSafeAttemptNamespace(value.slice(0, slash)) && isSafeAttemptNamespace(value.slice(slash + 1))
  );
}

/** A generated V2 Markdown agent file, keyed by a repository-relative path. */
export interface GeneratedOpenCodeAgentFile {
  readonly path: string;
  /** The complete UTF-8 file content (frontmatter plus body). */
  readonly content: string;
}

/** A generated child reference: profile id, runtime id, and enabled state. */
export interface GeneratedOpenCodeAgentChild {
  /** The profile's id (single path segment). */
  readonly id: string;
  /** The OpenCode runtime id `<namespace>/<id>`. */
  readonly runtimeId: string;
  /** Whether the managed primary may invoke this child. */
  readonly enabled: boolean;
}

/** The result of serializing one profile into one attempt namespace. */
export interface SerializedOpenCodeAgents {
  /** The validated attempt namespace, shared by every generated id. */
  readonly namespace: string;
  /** One file per primary/subagent definition, in a deterministic order. */
  readonly files: readonly GeneratedOpenCodeAgentFile[];
  /** The generated primary's runtime id, for `opencode run --agent`. */
  readonly primaryRuntimeId: string;
  /** Every generated child, in profile order, with its enabled state. */
  readonly children: readonly GeneratedOpenCodeAgentChild[];
}

export interface SerializeOpenCodeAgentsInput {
  /** A validated profile (see {@link parseOpenCodeAgentProfile}). */
  readonly profile: OpenCodeAgentProfile;
  /**
   * A unique, attempt-owned, safe single path segment. Two attempts sharing a
   * namespace would collide; the caller must never reuse one.
   */
  readonly namespace: string;
}

/**
 * Raised when a profile or namespace cannot be serialized. Every reason is
 * collected in one pass so the caller sees the whole problem, and nothing is
 * written or returned. The serializer prefers this to silently granting or
 * dropping anything it does not understand.
 */
export class OpenCodeAgentSerializeError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Cannot serialize OpenCode agent profile:\n- ${reasons.join("\n- ")}`);
    this.name = "OpenCodeAgentSerializeError";
    this.reasons = reasons;
  }
}

function agentFilePath(namespace: string, id: string): string {
  // String concatenation, never path joining: generated paths must stay
  // slash-separated and repository-relative on every platform.
  return `${OPENCODE_AGENT_DIR}/${namespace}/${id}.md`;
}

/**
 * The permission rules shared by every managed agent. Starts from an explicit
 * deny-all (the V2 base policy would otherwise allow every tool implicitly) and
 * re-opens only the intrinsic reading surface and the profile's declared tools.
 * External-directory access and nested delegation are then always denied; the
 * caller appends a primary's subagent allowances after the shared deny.
 */
function sharedManagedAgentRules(
  permissions: readonly OpenCodePermission[] | undefined,
  reasons: string[],
  owner: string,
): AgentPermissionRule[] {
  const rules: AgentPermissionRule[] = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
  ];
  for (const permission of permissions ?? []) {
    const actions = Object.hasOwn(PERMISSION_ACTION_MAP, permission)
      ? PERMISSION_ACTION_MAP[permission]
      : undefined;
    if (actions === undefined) {
      reasons.push(
        `unsupported permission ${JSON.stringify(permission)} for ${owner}: ` +
          "it has no OpenCode 2.0.16 tool action and cannot be granted or denied by this serializer",
      );
      continue;
    }
    for (const action of actions) {
      rules.push({ action, resource: "*", effect: "allow" });
    }
  }
  rules.push(
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  );
  return rules;
}

interface AgentFrontmatterInput {
  readonly description: string;
  readonly mode: "primary" | "subagent";
  /** Undefined omits the `model` field, inheriting the primary session model. */
  readonly model: string | undefined;
  /** Undefined omits the `steps` field. */
  readonly stepLimit: number | undefined;
  readonly permissions: readonly AgentPermissionRule[];
}

/** Build the frontmatter object in a fixed field order, emitting only set fields. */
function agentFrontmatter(input: AgentFrontmatterInput): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    description: input.description,
    mode: input.mode,
  };
  if (input.model !== undefined) frontmatter.model = input.model;
  if (input.stepLimit !== undefined) frontmatter.steps = input.stepLimit;
  frontmatter.permissions = input.permissions;
  return frontmatter;
}

/**
 * Assemble one V2 Markdown agent file: a `---` delimited YAML frontmatter
 * followed by the instructions text verbatim as the body. The closing delimiter
 * terminates the frontmatter, so any instruction text after it — including
 * lines that look like `---`, `mode:`, `permissions:`, or other config — is
 * inert markdown body, never parsed as configuration.
 */
function assembleAgentFile(
  frontmatter: Record<string, unknown>,
  instructions: string | undefined,
): string {
  const head = `---\n${stringifyYaml(frontmatter)}---\n`;
  const body = instructions ?? "";
  if (body === "") return head;
  return body.endsWith("\n") ? `${head}${body}` : `${head}${body}\n`;
}

/**
 * Serialize a validated profile into pinned V2 Markdown agent files for one
 * attempt namespace. Throws {@link OpenCodeAgentSerializeError} when the
 * namespace is unsafe or a permission value cannot be mapped to an OpenCode
 * tool action; it never writes a file or returns a partial set.
 */
export function serializeOpenCodeAgents(
  input: SerializeOpenCodeAgentsInput,
): SerializedOpenCodeAgents {
  const { profile, namespace } = input;
  const reasons: string[] = [];

  if (!isSafeAttemptNamespace(namespace)) {
    reasons.push(
      `namespace ${JSON.stringify(namespace)} is not a safe single path segment: ` +
        'use letters, digits, ".", "_", or "-", starting and ending with a letter or digit',
    );
  }

  const files: GeneratedOpenCodeAgentFile[] = [];
  const children: GeneratedOpenCodeAgentChild[] = [];
  const seenPaths = new Set<string>();
  const seenIds = new Map<string, string>();
  const primaryRuntimeId = agentRuntimeId(namespace, profile.primary.id);

  // Reject duplicate runtime ids on a hand-built profile even though the parser
  // already guarantees uniqueness: two definitions must never share a file.
  const registerId = (id: string, owner: string): void => {
    const key = id.toLowerCase();
    const prior = seenIds.get(key);
    if (prior !== undefined) {
      reasons.push(
        `id "${id}" for ${owner} duplicates the id at ${prior}; generated files would collide`,
      );
    } else {
      seenIds.set(key, owner);
    }
  };
  const registerPath = (path: string): void => {
    if (seenPaths.has(path)) {
      reasons.push(`generated path "${path}" is produced more than once`);
    } else {
      seenPaths.add(path);
    }
  };

  // The primary keeps the profile's declared tools plus an explicit subagent
  // deny-all, then allows each enabled child in profile order. Disabled and
  // unrelated children are never allowlisted.
  const primaryRules = sharedManagedAgentRules(profile.primary.permissions, reasons, "primary");
  registerId(profile.primary.id, "primary");
  for (const subagent of profile.subagents) {
    if (subagent.enabled) {
      primaryRules.push({
        action: "subagent",
        resource: agentRuntimeId(namespace, subagent.id),
        effect: "allow",
      });
    }
  }
  registerPath(agentFilePath(namespace, profile.primary.id));
  files.push({
    path: agentFilePath(namespace, profile.primary.id),
    content: assembleAgentFile(
      agentFrontmatter({
        description: profile.primary.description,
        mode: "primary",
        model: undefined,
        stepLimit: profile.primary.stepLimit,
        permissions: primaryRules,
      }),
      profile.primary.instructions,
    ),
  });

  // Every child definition gets its own file, enabled or not, so the attempt's
  // set of generated agents matches the profile snapshot exactly. Only the
  // primary's allowlist controls invocability; a child never receives a
  // subagent rule (nested delegation is always denied).
  for (const subagent of profile.subagents) {
    registerId(subagent.id, `subagent "${subagent.id}"`);
    const childRules = sharedManagedAgentRules(
      subagent.permissions,
      reasons,
      `subagent "${subagent.id}"`,
    );
    registerPath(agentFilePath(namespace, subagent.id));
    files.push({
      path: agentFilePath(namespace, subagent.id),
      content: assembleAgentFile(
        agentFrontmatter({
          description: subagent.description,
          mode: "subagent",
          model: subagent.model,
          stepLimit: subagent.stepLimit,
          permissions: childRules,
        }),
        subagent.instructions,
      ),
    });
    children.push({
      id: subagent.id,
      runtimeId: agentRuntimeId(namespace, subagent.id),
      enabled: subagent.enabled,
    });
  }

  if (reasons.length > 0) throw new OpenCodeAgentSerializeError(reasons);

  return { namespace, files, primaryRuntimeId, children };
}
