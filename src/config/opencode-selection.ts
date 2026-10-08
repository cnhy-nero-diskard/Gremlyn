/**
 * Discriminated OpenCode primary-source selection (design D1; capabilities
 * `opencode-agent-selection`, `repository-registry`, task 2.2).
 *
 * A repository's execution intent is exactly one of three mutually exclusive
 * sources:
 * - `default`: OpenCode resolves its own effective primary; Gremlyn omits an
 *   explicit agent.
 * - `native { agentId }`: an existing OpenCode agent discovered in the
 *   repository's context.
 * - `managed`: a Gremlyn-managed profile saved for the repository.
 *
 * The union is intentionally narrow: a source alone decides whether a managed
 * profile is active, so a retained native id or a dormant profile can never
 * compete as a silent override. Parsing is strict and atomic — unknown fields,
 * invalid combinations and malformed native identifiers are rejected with
 * field-specific issues and nothing is normalized on the side.
 *
 * Revision checking is *not* part of the selection value. The selection is
 * stored with a separate optimistic revision that lives in the store; the
 * store's save operation compares that revision (and, for managed activation,
 * the active profile revision) in one transaction.
 */

import { MAX_NATIVE_AGENT_ID_LENGTH, isBoundedNativeAgentId } from "../agent/agent-inventory.js";

export const OPENCODE_PRIMARY_SOURCES = ["default", "native", "managed"] as const;
export type OpenCodePrimarySource = (typeof OPENCODE_PRIMARY_SOURCES)[number];

/** The registered executor kind that owns OpenCode primary selection. */
export const OPENCODE_EXECUTOR_ID = "opencode";

/** The narrowed execution intent persisted for one repository. */
export type OpenCodePrimarySelection =
  { source: "default" } | { source: "native"; agentId: string } | { source: "managed" };

export interface OpenCodeSelectionFieldIssue {
  /** Field path within the submitted selection, e.g. `source` or `agentId`. */
  path: string;
  message: string;
}

/**
 * Raised by {@link parseOpenCodePrimarySelection} when a candidate is invalid.
 * Carries every field-specific issue found in one pass so a route can surface
 * each problem beside the relevant control.
 */
export class OpenCodeSelectionValidationError extends Error {
  readonly issues: readonly OpenCodeSelectionFieldIssue[];
  constructor(issues: readonly OpenCodeSelectionFieldIssue[]) {
    super(
      `Invalid OpenCode primary selection:\n- ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n- ")}`,
    );
    this.name = "OpenCodeSelectionValidationError";
    this.issues = issues;
  }
}

/**
 * A native agent id is a bounded, non-empty identifier safe to pass as a
 * `--agent <id>` argument. Validation is delegated to the single canonical
 * inventory helper (`isBoundedNativeAgentId`), so selection and preflight agree
 * exactly: it rejects control and Unicode format characters, whitespace and
 * backslashes, a leading argument-like dash, and `.`/`..`/empty path segments,
 * and bounds the length. Exact inventory membership is validated separately
 * against the effective discovery result (design D3).
 */
export const NATIVE_AGENT_ID_MAX_LENGTH = MAX_NATIVE_AGENT_ID_LENGTH;

export function isValidNativeAgentId(value: unknown): value is string {
  return typeof value === "string" && isBoundedNativeAgentId(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_FIELDS = new Set(["source", "agentId"]);

/**
 * Validate and normalize a selection candidate. Atomic: either the whole
 * candidate is accepted as a normalized {@link OpenCodePrimarySelection}, or
 * {@link OpenCodeSelectionValidationError} is thrown carrying every issue.
 * Unknown fields and invalid source/field combinations are rejected rather
 * than dropped, so a caller that sends `{ source: "default", agentId: "x" }`
 * cannot silently lose the id.
 */
export function parseOpenCodePrimarySelection(input: unknown): OpenCodePrimarySelection {
  if (!isRecord(input)) {
    throw new OpenCodeSelectionValidationError([
      { path: "selection", message: "must be an object" },
    ]);
  }
  const issues: OpenCodeSelectionFieldIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      issues.push({
        path: key,
        message: `unknown field "${key}"; allowed fields are source and agentId`,
      });
    }
  }

  const source = input.source;
  if (source === "native") {
    if (!("agentId" in input)) {
      issues.push({ path: "agentId", message: "agentId is required for native source" });
    } else if (!isValidNativeAgentId(input.agentId)) {
      issues.push({
        path: "agentId",
        message:
          `agentId must be a non-empty identifier of at most ${NATIVE_AGENT_ID_MAX_LENGTH} ` +
          "characters with no whitespace, control characters or backslashes, no leading " +
          'dash, and no "."/".." path segments',
      });
    }
  } else if (source === "default" || source === "managed") {
    if ("agentId" in input) {
      issues.push({
        path: "agentId",
        message: `agentId is not allowed for ${source} source`,
      });
    }
  } else {
    issues.push({
      path: "source",
      message:
        `source must be one of ${OPENCODE_PRIMARY_SOURCES.join(", ")} ` +
        `(got ${JSON.stringify(source)})`,
    });
  }

  if (issues.length > 0) throw new OpenCodeSelectionValidationError(issues);
  if (source === "native") return { source: "native", agentId: input.agentId as string };
  if (source === "managed") return { source: "managed" };
  return { source: "default" };
}

/**
 * Privacy-safe audit/projection detail for a selection: the source and, only
 * for native mode, the id. Never carries descriptions, instructions or raw
 * inventory. Suitable for operator audit and dashboard projections.
 */
export function openCodeSelectionDetail(selection: OpenCodePrimarySelection): {
  source: OpenCodePrimarySource;
  agentId?: string;
} {
  return selection.source === "native"
    ? { source: "native", agentId: selection.agentId }
    : { source: selection.source };
}
