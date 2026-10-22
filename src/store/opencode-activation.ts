import type Database from "better-sqlite3";
import {
  type OpenCodeAgentProfile,
  type OpenCodeProfileFieldIssue,
  canonicalOpenCodeProfileJson,
  OpenCodeProfileValidationError,
  parseOpenCodeAgentProfile,
} from "../config/opencode-profile.js";
import {
  OPENCODE_EXECUTOR_ID,
  type OpenCodePrimarySelection,
  openCodeSelectionDetail,
} from "../config/opencode-selection.js";
import { recordOperatorAction } from "./actions.js";
import { currentSelectionRevision, readOpenCodeSelection } from "./opencode-selections.js";

/**
 * Coordinated explicit OpenCode team activation (design D2; capability
 * `opencode-agent-selection`, tasks 2.1-2.3).
 *
 * The console keeps three separate operations, never two HTTP writes for one
 * intent:
 * - the profile save stays save-only and never changes the primary source;
 * - the selection save stays a deliberate source switch;
 * - this module adds the two activation modes whose whole point is to bind a
 *   profile and the managed source together.
 *
 * `activate-saved` selects exactly the already-reviewed saved profile without
 * touching its bytes. `save-and-activate` validates and writes the reviewed
 * candidate and selects managed source as one atomic operation. Both recheck
 * repository existence, the resolved executor kind (including aliases) and
 * *both* optimistic revisions inside one transaction, then write and record
 * exactly one safe operator action. A validation, revision, executor or
 * persistence/audit failure rolls the whole transaction back, so a job created
 * concurrently captures either the complete previous workflow or the complete
 * committed one — never a profile without its selection or the reverse.
 *
 * The audit never carries descriptions, instructions, raw profile bodies or
 * inventory: only the operation, safe before/after source identifiers, the
 * resulting revisions and the primary/child ids.
 */

/** The two explicit activation modes. */
export type OpenCodeTeamActivationMode = "activate-saved" | "save-and-activate";

/** The operator-action name recorded for one successful activation. */
export const OPENCODE_TEAM_ACTIVATION_ACTION = "opencode-team-activation";

/** The common inputs shared by both activation modes. */
export interface ActivateOpenCodeTeamCommonInput {
  repoId: number;
  /** The profile revision the operator reviewed. */
  expectedProfileRevision: number;
  /** The primary-selection revision the operator reviewed. */
  expectedSelectionRevision: number;
  /**
   * Authoritative executor-kind resolver, evaluated inside the transaction
   * against the repository row's *current* agent id. When present it is the
   * only source of truth, so a cached alias kind can never override a row that
   * changed to another executor. The server passes
   * `(agentId) => agents[agentId]?.kind ?? agentId`.
   */
  resolveExecutorKind?: (agentId: string) => string | undefined;
  /**
   * A pre-resolved executor kind (`agents[agent].kind ?? agent`) supplied by a
   * caller that does not provide {@link resolveExecutorKind}. Inside the
   * transaction this value is trusted only while the repository's agent id is
   * still the one the caller observed (identified by {@link executorAgentId}
   * when given, otherwise the agent id read before the transaction). Once the
   * row changes, the stale kind is discarded and the changed agent id resolves
   * as its own kind, which fails closed for a non-OpenCode executor.
   */
  executorKind?: string;
  /**
   * The agent id the caller observed when it resolved {@link executorKind}.
   * Ties the cached kind to an exact repository identity; a mismatch prevents
   * the stale kind from being applied to a changed row.
   */
  executorAgentId?: string;
}

/**
 * A strict discriminated activation request. `activate-saved` accepts no
 * candidate; `save-and-activate` requires the reviewed whole profile.
 */
export type ActivateOpenCodeTeamRequest =
  | (ActivateOpenCodeTeamCommonInput & { mode: "activate-saved" })
  | (ActivateOpenCodeTeamCommonInput & { mode: "save-and-activate"; candidate: unknown });

/** The authoritative safe workflow state produced by a successful activation. */
export interface OpenCodeActivationState {
  repoId: number;
  operation: OpenCodeTeamActivationMode;
  /**
   * True when this call changed persisted state. False for an idempotent
   * activation of an already-active matching team, which changes no revision,
   * records no audit row and issues no runtime notification.
   */
  changed: boolean;
  /** The selected source after the operation; always managed on success. */
  selection: Extract<OpenCodePrimarySelection, { source: "managed" }>;
  selectionRevision: number;
  profileRevision: number;
  primaryId: string;
  subagentIds: string[];
}

/** A refusal or conflict. Refusals never change either resource or the audit. */
export type ActivateOpenCodeTeamResult =
  | ({ ok: true } & OpenCodeActivationState)
  | { ok: false; reason: "not-found" }
  | {
      ok: false;
      reason: "not-opencode" | "conflict" | "profile-conflict" | "no-profile" | "corrupt-profile";
      currentSelectionRevision: number;
      currentProfileRevision: number;
    }
  | {
      ok: false;
      reason: "validation";
      currentSelectionRevision: number;
      currentProfileRevision: number;
      issues: readonly OpenCodeProfileFieldIssue[];
    };

/**
 * A safe read of the repository's activation-relevant state: the current
 * source, both revision counters and whether a parseable saved team is active.
 * Never carries instruction text. Used by the editor read and by post-commit
 * reconciliation when a runtime refresh notification fails.
 */
export interface OpenCodeActivationContext {
  repoId: number;
  selection: OpenCodePrimarySelection;
  selectionRevision: number;
  selectionExplicit: boolean;
  /** The stored profile revision, whether or not a payload is present. */
  profileRevision: number;
  hasProfile: boolean;
  /** True when a payload is present but no longer parses as a profile. */
  profileCorrupt: boolean;
  /** True when managed source selects a parseable saved profile. */
  active: boolean;
  primaryId: string | null;
  subagentIds: string[];
}

interface RawProfileRow {
  profileJson: string | null;
  revision: number;
}

function readRawProfileRow(db: Database.Database, repoId: number): RawProfileRow | undefined {
  const row = db
    .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(repoId) as { profile_json: string | null; revision: number } | undefined;
  if (row === undefined) return undefined;
  return { profileJson: row.profile_json, revision: row.revision };
}

/**
 * Parse a stored profile payload. Throws the ordinary parse/JSON error; callers
 * that must treat a corrupt payload as a scoped refusal catch it themselves.
 */
function parseStoredProfile(json: string): OpenCodeAgentProfile {
  return parseOpenCodeAgentProfile(JSON.parse(json));
}

/**
 * Read the safe activation context for one repository, or undefined for an
 * unknown repository. The two resource reads happen against one consistent
 * snapshot so the returned revision pair is coherent.
 */
export function readOpenCodeActivationContext(
  db: Database.Database,
  repoId: number,
): OpenCodeActivationContext | undefined {
  return db.transaction((): OpenCodeActivationContext | undefined => {
    const selection = readOpenCodeSelection(db, repoId);
    if (selection === undefined) return undefined;
    const row = readRawProfileRow(db, repoId);
    const hasProfile = row !== undefined && row.profileJson !== null;
    let primaryId: string | null = null;
    let subagentIds: string[] = [];
    let profileCorrupt = false;
    if (hasProfile && row?.profileJson !== null && row?.profileJson !== undefined) {
      try {
        const profile = parseStoredProfile(row.profileJson);
        primaryId = profile.primary.id;
        subagentIds = profile.subagents.map((agent) => agent.id);
      } catch {
        // A stored payload that no longer parses is a scoped corruption state,
        // never a silent fallback to the default workflow.
        profileCorrupt = true;
      }
    }
    const profileRevision = row?.revision ?? 0;
    return {
      repoId,
      selection: selection.selection,
      selectionRevision: selection.revision,
      selectionExplicit: selection.explicit,
      profileRevision,
      hasProfile,
      profileCorrupt,
      active: selection.selection.source === "managed" && hasProfile && !profileCorrupt,
      primaryId,
      subagentIds,
    };
  })();
}

/**
 * The scoped operator-audit detail for one successful activation: the mode,
 * safe before/after source identifiers, both resulting revisions and the
 * primary/child ids. Descriptions, instructions, raw profile bodies and
 * inventory are deliberately absent.
 */
export function openCodeActivationAuditDetail(input: {
  mode: OpenCodeTeamActivationMode;
  before: OpenCodePrimarySelection;
  after: OpenCodePrimarySelection;
  selectionRevision: number;
  profileRevision: number;
  profile: OpenCodeAgentProfile;
}): Record<string, unknown> {
  return {
    mode: input.mode,
    before: openCodeSelectionDetail(input.before),
    after: openCodeSelectionDetail(input.after),
    selectionRevision: input.selectionRevision,
    profileRevision: input.profileRevision,
    primaryId: input.profile.primary.id,
    subagentIds: input.profile.subagents.map((agent) => agent.id),
  };
}

function stateFromProfile(
  repoId: number,
  operation: OpenCodeTeamActivationMode,
  changed: boolean,
  selectionRevision: number,
  profileRevision: number,
  profile: OpenCodeAgentProfile,
): ActivateOpenCodeTeamResult {
  return {
    ok: true,
    repoId,
    operation,
    changed,
    selection: { source: "managed" },
    selectionRevision,
    profileRevision,
    primaryId: profile.primary.id,
    subagentIds: profile.subagents.map((agent) => agent.id),
  };
}

/**
 * Atomically activate a saved OpenCode team or save-and-activate a reviewed
 * candidate. Every check — repository existence, the resolved executor kind
 * against the row's current agent, both optimistic revisions and the full
 * candidate — runs inside one transaction, so a concurrent row change cannot
 * be bypassed by a cached alias kind and a refusal always reports coherent
 * revision context.
 */
export function activateOpenCodeTeam(
  db: Database.Database,
  input: ActivateOpenCodeTeamRequest,
): ActivateOpenCodeTeamResult {
  // Observe the repository's agent id before the transaction so a cached kind
  // can be tied to the identity the caller actually saw. This read decides
  // nothing on its own; every check happens in the transaction below.
  const observed = db.prepare("SELECT agent FROM repositories WHERE id = ?").get(input.repoId) as
    { agent: string } | undefined;
  if (!observed) return { ok: false, reason: "not-found" };
  const observedAgent = observed.agent;

  return db.transaction((): ActivateOpenCodeTeamResult => {
    const repositoryNow = db
      .prepare("SELECT agent FROM repositories WHERE id = ?")
      .get(input.repoId) as { agent: string } | undefined;
    if (!repositoryNow) return { ok: false, reason: "not-found" };
    const selectionRevisionNow = currentSelectionRevision(db, input.repoId);
    const profileRow = readRawProfileRow(db, input.repoId);
    const profileRevisionNow = profileRow?.revision ?? 0;
    // The executor kind is (re)derived here from the row's current agent and,
    // when supplied, the authoritative resolver. A caller-supplied cached kind
    // is honored only while the row's agent still matches the identity the
    // caller observed; a changed row discards it rather than overriding it.
    const executorKindNow = resolveActivationExecutorKind(
      input,
      repositoryNow.agent,
      observedAgent,
    );
    if (executorKindNow !== OPENCODE_EXECUTOR_ID) {
      return {
        ok: false,
        reason: "not-opencode",
        currentSelectionRevision: selectionRevisionNow,
        currentProfileRevision: profileRevisionNow,
      };
    }
    if (selectionRevisionNow !== input.expectedSelectionRevision) {
      return {
        ok: false,
        reason: "conflict",
        currentSelectionRevision: selectionRevisionNow,
        currentProfileRevision: profileRevisionNow,
      };
    }
    if (profileRevisionNow !== input.expectedProfileRevision) {
      return {
        ok: false,
        reason: "profile-conflict",
        currentSelectionRevision: selectionRevisionNow,
        currentProfileRevision: profileRevisionNow,
      };
    }

    const before = readOpenCodeSelection(db, input.repoId)?.selection ?? { source: "default" };

    if (input.mode === "activate-saved") {
      if (profileRow === undefined || profileRow.profileJson === null) {
        return {
          ok: false,
          reason: "no-profile",
          currentSelectionRevision: selectionRevisionNow,
          currentProfileRevision: profileRevisionNow,
        };
      }
      let profile: OpenCodeAgentProfile;
      try {
        profile = parseStoredProfile(profileRow.profileJson);
      } catch {
        return {
          ok: false,
          reason: "corrupt-profile",
          currentSelectionRevision: selectionRevisionNow,
          currentProfileRevision: profileRevisionNow,
        };
      }
      // A repeated activation of the already-active matching team is an
      // idempotent no-op: no revision bump, no duplicate audit, no notification.
      if (before.source === "managed") {
        return stateFromProfile(
          input.repoId,
          input.mode,
          false,
          selectionRevisionNow,
          profileRevisionNow,
          profile,
        );
      }
      const selectionRevision = selectionRevisionNow + 1;
      writeManagedSelection(db, input.repoId, selectionRevision);
      recordOperatorAction(db, {
        action: OPENCODE_TEAM_ACTIVATION_ACTION,
        target: `repository:${input.repoId}`,
        effect: `v${selectionRevision}`,
        detail: openCodeActivationAuditDetail({
          mode: input.mode,
          before,
          after: { source: "managed" },
          selectionRevision,
          profileRevision: profileRevisionNow,
          profile,
        }),
      });
      return stateFromProfile(
        input.repoId,
        input.mode,
        true,
        selectionRevision,
        profileRevisionNow,
        profile,
      );
    }

    // save-and-activate: validate the whole candidate inside the transaction so
    // a refusal reports the same revision context it just checked. `candidate`
    // is required by the discriminated union.
    let candidate: OpenCodeAgentProfile;
    try {
      candidate = parseOpenCodeAgentProfile(input.candidate);
    } catch (error) {
      if (error instanceof OpenCodeProfileValidationError) {
        return {
          ok: false,
          reason: "validation",
          currentSelectionRevision: selectionRevisionNow,
          currentProfileRevision: profileRevisionNow,
          issues: error.issues,
        };
      }
      throw error;
    }
    // The profile is always saved and bumps its revision. The selection
    // revision increments only when the source actually changes (design D2):
    // re-selecting an already-managed team writes no selection row and leaves
    // its counter untouched while still recording one activation action.
    const profileRevision = profileRevisionNow + 1;
    const selectionRevision =
      before.source === "managed" ? selectionRevisionNow : selectionRevisionNow + 1;
    db.prepare(
      `INSERT INTO opencode_agent_profiles (repo_id, profile_json, revision)
       VALUES (?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET
         profile_json = excluded.profile_json,
         revision = excluded.revision`,
    ).run(input.repoId, canonicalOpenCodeProfileJson(candidate), profileRevision);
    if (before.source !== "managed") writeManagedSelection(db, input.repoId, selectionRevision);
    recordOperatorAction(db, {
      action: OPENCODE_TEAM_ACTIVATION_ACTION,
      target: `repository:${input.repoId}`,
      effect: `v${selectionRevision}`,
      detail: openCodeActivationAuditDetail({
        mode: input.mode,
        before,
        after: { source: "managed" },
        selectionRevision,
        profileRevision,
        profile: candidate,
      }),
    });
    return stateFromProfile(
      input.repoId,
      input.mode,
      true,
      selectionRevision,
      profileRevision,
      candidate,
    );
  })();
}

/**
 * Resolve an agent id to its executor kind for the activation transaction.
 *
 * When `resolveExecutorKind` is supplied it is authoritative and follows the
 * transaction's current agent id. Otherwise a caller-supplied `executorKind` is
 * trusted only when the current agent id is still the one the caller observed
 * (`executorAgentId` when present, otherwise the id read before the
 * transaction). A changed row discards the cached kind and resolves the new id
 * as its own kind, which fails closed for a non-OpenCode executor.
 */
function resolveActivationExecutorKind(
  input: ActivateOpenCodeTeamCommonInput,
  agentId: string,
  observedAgent: string,
): string {
  if (input.resolveExecutorKind !== undefined) {
    return input.resolveExecutorKind(agentId) ?? agentId;
  }
  const observedIdentity = input.executorAgentId ?? observedAgent;
  if (agentId === observedIdentity) return input.executorKind ?? agentId;
  return agentId;
}

/** Inside an open transaction: write managed source at the given revision. */
function writeManagedSelection(db: Database.Database, repoId: number, revision: number): void {
  db.prepare(
    `INSERT INTO opencode_primary_selections (repo_id, source, native_agent_id, revision)
     VALUES (?, 'managed', NULL, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       source = excluded.source,
       native_agent_id = excluded.native_agent_id,
       revision = excluded.revision`,
  ).run(repoId, revision);
}
