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
} from "../config/opencode-selection.js";
import { resetManagedSelectionToDefault } from "./opencode-selections.js";
import { recordOperatorAction } from "./actions.js";

export { OPENCODE_EXECUTOR_ID };

/**
 * Durable per-repository OpenCode profile read and atomic revision
 * compare-and-set save (design D1/D2; capability `opencode-agent-profiles`,
 * task 2.3).
 *
 * Profile storage is one nullable row keyed by repository id
 * (`opencode_agent_profiles`: canonical profile JSON plus an integer revision,
 * migration 0006). A missing row — or a row whose `profile_json` is NULL —
 * reads as "no dashboard profile" at revision 0 and never synthesizes a
 * default. A missing profile keeps the existing OpenCode invocation.
 *
 * Saving is a whole-document compare-and-set against that revision: the
 * operator edits against the revision they saw, and the save applies only if
 * the stored revision still matches. This is what makes stale editor writes
 * conflict instead of silently overwriting a newer profile. A successful save
 * records exactly one scoped operator action whose audit detail carries the
 * profile identifiers and new revision — never the instruction text — atomically
 * with the profile change.
 *
 * The OpenCode gate uses the repository's configured executor kind (an agent
 * id is a free operator label; its kind selects the registered executor).
 * Callers resolving the kind from the agent definitions pass it explicitly;
 * when omitted it falls back to the repository's agent id, which is the
 * loader's default kind.
 */

/** A durable profile read: the parsed profile plus its compare-and-set revision. */
export interface OpenCodeProfileRecord {
  repoId: number;
  revision: number;
  /** The saved profile, or null when the repository has no dashboard profile. */
  profile: OpenCodeAgentProfile | null;
}

/**
 * Privacy-safe profile projection: identifiers and revision only. Ordinary
 * projections (dashboard summaries, job diagnostics, audit detail) must never
 * carry the operators' private instruction text; this is the read to build
 * them from.
 */
export interface OpenCodeProfileSummary {
  repoId: number;
  revision: number;
  hasProfile: boolean;
  primaryId: string | null;
  subagentIds: string[];
  subagentCount: number;
}

/**
 * A whole-profile save attempt. The variant that lands is exactly one of:
 * success, a stale-write conflict, a validation failure (prior profile
 * untouched), a non-OpenCode executor rejection, or a missing repository.
 * Successes bump the revision by one and record one operator action.
 */
export type SaveOpenCodeProfileResult =
  | { ok: true; repoId: number; revision: number; profile: OpenCodeAgentProfile }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-opencode"; currentRevision: number }
  | {
      ok: false;
      reason: "validation";
      currentRevision: number;
      issues: readonly OpenCodeProfileFieldIssue[];
    }
  | { ok: false; reason: "conflict"; currentRevision: number };

/** The stored revision for a repository, reading a missing row as revision 0. */
function currentProfileRevision(db: Database.Database, repoId: number): number {
  const row = db
    .prepare("SELECT revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(repoId) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

interface ProfileRow {
  profileJson: string | null;
  revision: number;
}

function readProfileRow(db: Database.Database, repoId: number): ProfileRow | undefined {
  const row = db
    .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(repoId) as { profile_json: string | null; revision: number } | undefined;
  if (row === undefined) return undefined;
  return { profileJson: row.profile_json, revision: row.revision };
}

/**
 * Read the durable dashboard-managed OpenCode profile for one repository.
 * Returns undefined for an unknown repository. A repository that is present
 * but has no saved profile (no row, or `profile_json` NULL) reads as
 * `{ revision: 0, profile: null }`.
 *
 * A stored value that no longer parses as a versioned profile fails closed.
 * Silently treating it as unconfigured would run the default agent instead
 * of the operator's saved selection.
 */
export function readOpenCodeProfile(
  db: Database.Database,
  repoId: number,
): OpenCodeProfileRecord | undefined {
  if (!db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(repoId)) return undefined;
  const row = readProfileRow(db, repoId);
  if (row === undefined || row.profileJson === null) {
    return { repoId, revision: row?.revision ?? 0, profile: null };
  }
  const profile = parseOpenCodeAgentProfile(JSON.parse(row.profileJson));
  return { repoId, revision: row.revision, profile };
}

/**
 * Privacy-safe summary read: primary id, subagent ids and count, and the
 * revision. Instruction text and descriptions never leave this read, so
 * projections built from it cannot leak the operators' private instructions.
 */
export function readOpenCodeProfileSummary(
  db: Database.Database,
  repoId: number,
): OpenCodeProfileSummary | undefined {
  const record = readOpenCodeProfile(db, repoId);
  if (record === undefined) return undefined;
  if (record.profile === null) {
    return {
      repoId,
      revision: record.revision,
      hasProfile: false,
      primaryId: null,
      subagentIds: [],
      subagentCount: 0,
    };
  }
  return summarizeProfile(record.profile, record.revision, repoId);
}

function summarizeProfile(
  profile: OpenCodeAgentProfile,
  revision: number,
  repoId: number,
): OpenCodeProfileSummary {
  return {
    repoId,
    revision,
    hasProfile: true,
    primaryId: profile.primary.id,
    subagentIds: profile.subagents.map((agent) => agent.id),
    subagentCount: profile.subagents.length,
  };
}

/**
 * The scoped operator-audit detail recorded for a successful profile save:
 * the primary id, the subagent ids, and the new revision. Instructions,
 * descriptions, models, and permissions are deliberately absent, so the audit
 * names what changed without exposing private instruction text.
 */
export function openCodeProfileAuditDetail(
  profile: OpenCodeAgentProfile,
  revision: number,
): Record<string, unknown> {
  return {
    revision,
    primaryId: profile.primary.id,
    subagentIds: profile.subagents.map((agent) => agent.id),
  };
}

/**
 * Atomically save a whole profile with compare-and-set semantics.
 *
 * The candidate is fully validated and normalized before any write. On
 * success the profile row is upserted at `expectedRevision + 1` and exactly
 * one operator action is recorded in the same transaction. A stale write
 * (`expectedRevision` no longer matches), an invalid candidate, or a
 * non-OpenCode executor leaves the stored profile — and the audit — untouched.
 *
 * `executorKind` is the repository's resolved executor kind
 * (`agents[agent].kind ?? agent`); it defaults to the repository's `agent`
 * column, matching the loader's default kind.
 */
export function saveOpenCodeAgentProfile(
  db: Database.Database,
  input: {
    repoId: number;
    /** The revision the operator's edit began from; the key compare-and-set input. */
    expectedRevision: number;
    /** The submitted whole profile; validated before any write. */
    candidate: unknown;
    /** Resolved executor kind (`agents[agent].kind ?? agent`) when known. */
    executorKind?: string;
  },
): SaveOpenCodeProfileResult {
  const repository = db.prepare("SELECT agent FROM repositories WHERE id = ?").get(input.repoId) as
    { agent: string } | undefined;
  if (!repository) return { ok: false, reason: "not-found" };
  const executorKind = input.executorKind ?? repository.agent;
  if (executorKind !== OPENCODE_EXECUTOR_ID) {
    return {
      ok: false,
      reason: "not-opencode",
      currentRevision: currentProfileRevision(db, input.repoId),
    };
  }

  let profile: OpenCodeAgentProfile;
  try {
    profile = parseOpenCodeAgentProfile(input.candidate);
  } catch (error) {
    if (error instanceof OpenCodeProfileValidationError) {
      return {
        ok: false,
        reason: "validation",
        currentRevision: currentProfileRevision(db, input.repoId),
        issues: error.issues,
      };
    }
    throw error;
  }

  const json = canonicalOpenCodeProfileJson(profile);
  return db.transaction((): SaveOpenCodeProfileResult => {
    const currentRevision = currentProfileRevision(db, input.repoId);
    if (currentRevision !== input.expectedRevision) {
      return { ok: false, reason: "conflict", currentRevision };
    }
    const revision = currentRevision + 1;
    db.prepare(
      `INSERT INTO opencode_agent_profiles (repo_id, profile_json, revision)
       VALUES (?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET
         profile_json = excluded.profile_json,
         revision = excluded.revision`,
    ).run(input.repoId, json, revision);
    recordOperatorAction(db, {
      action: "opencode-agent-profile",
      target: `repository:${input.repoId}`,
      effect: `v${revision}`,
      detail: openCodeProfileAuditDetail(profile, revision),
    });
    return { ok: true, repoId: input.repoId, revision, profile };
  })();
}

/**
 * The outcome of deliberately clearing a saved profile (design D1; task 2.3).
 * A successful clear nulls the profile payload and bumps its revision (never
 * deletes the row, so the compare-and-set counter stays monotonic and a stale
 * editor cannot re-apply), and — only when the current selection is managed —
 * atomically returns the primary source to default at the next selection
 * revision. A dormant (native/default) selection is left alone.
 */
export type ClearOpenCodeProfileResult =
  | {
      ok: true;
      repoId: number;
      /** The new profile revision after clearing. */
      revision: number;
      /** Whether an active managed selection was reset to default. */
      selectionReset: boolean;
      selection: OpenCodePrimarySelection;
      selectionRevision: number;
    }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-opencode"; currentRevision: number }
  | { ok: false; reason: "conflict"; currentRevision: number }
  | { ok: false; reason: "no-profile"; currentRevision: number };

/**
 * Deliberately clear a repository's saved OpenCode profile with the same
 * compare-and-set discipline as a save. `expectedRevision` is the profile
 * revision the operator saw; a mismatch conflicts and changes nothing.
 *
 * Clearing an active managed profile is atomic: the profile payload is nulled
 * and the selection returns to default in the same transaction, so no job can
 * capture a managed source without a profile. Clearing a dormant profile only
 * removes the definition; the current native/default source is preserved.
 * Exactly one scoped operator action records the safe outcome and never the
 * instruction text.
 */
export function clearOpenCodeAgentProfile(
  db: Database.Database,
  input: {
    repoId: number;
    /** The profile revision the operator saw; the key compare-and-set input. */
    expectedRevision: number;
    /** Resolved executor kind (`agents[agent].kind ?? agent`) when known. */
    executorKind?: string;
  },
): ClearOpenCodeProfileResult {
  return db.transaction((): ClearOpenCodeProfileResult => {
    // Re-check repository identity/kind in the transaction so a concurrent
    // executor resynchronization cannot clear an OpenCode profile after this
    // alias changed to another executor.
    const repository = db
      .prepare("SELECT agent FROM repositories WHERE id = ?")
      .get(input.repoId) as { agent: string } | undefined;
    if (!repository) return { ok: false, reason: "not-found" };
    const revisionNow = currentProfileRevision(db, input.repoId);
    const executorKind = input.executorKind ?? repository.agent;
    if (executorKind !== OPENCODE_EXECUTOR_ID) {
      return { ok: false, reason: "not-opencode", currentRevision: revisionNow };
    }
    if (revisionNow !== input.expectedRevision) {
      return { ok: false, reason: "conflict", currentRevision: revisionNow };
    }
    const existing = readProfileRow(db, input.repoId);
    if (existing === undefined || existing.profileJson === null) {
      return { ok: false, reason: "no-profile", currentRevision: revisionNow };
    }
    const revision = revisionNow + 1;
    db.prepare(
      "UPDATE opencode_agent_profiles SET profile_json = NULL, revision = ? WHERE repo_id = ?",
    ).run(revision, input.repoId);
    const reset = resetManagedSelectionToDefault(db, input.repoId);
    recordOperatorAction(db, {
      action: "opencode-agent-profile-clear",
      target: `repository:${input.repoId}`,
      effect: `v${revision}`,
      detail: {
        profileRevision: revision,
        selectionReset: reset.reset,
        selectionSource: reset.selection.source,
        selectionRevision: reset.revision,
      },
    });
    return {
      ok: true,
      repoId: input.repoId,
      revision,
      selectionReset: reset.reset,
      selection: reset.selection,
      selectionRevision: reset.revision,
    };
  })();
}
