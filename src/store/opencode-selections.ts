import type Database from "better-sqlite3";
import {
  OPENCODE_EXECUTOR_ID,
  type OpenCodePrimarySelection,
  type OpenCodePrimarySource,
  type OpenCodeSelectionFieldIssue,
  OpenCodeSelectionValidationError,
  openCodeSelectionDetail,
  parseOpenCodePrimarySelection,
} from "../config/opencode-selection.js";
import { recordOperatorAction } from "./actions.js";

/**
 * Durable per-repository OpenCode primary-source selection with an optimistic
 * revision compare-and-set (design D1; capabilities `opencode-agent-selection`
 * and `repository-registry`, tasks 2.2/2.3).
 *
 * Storage is one row per repository (`opencode_primary_selections`, migration
 * 0008): `source`, a retained `native_agent_id`, and an integer `revision`. A
 * missing row reads as `{ source: "default" }` at revision 0 with
 * `explicit: false`; the `explicit` flag lets a caller distinguish "the
 * operator deliberately chose default" from "this repository predates
 * selection tracking" for backward-compatible reading (see
 * {@link OpenCodeSelectionRecord}).
 *
 * The selection never duplicates or overrides other repository fields: a save
 * writes only the selection row and one scoped audit action. Provider, model,
 * effort, timeout, enablement and the managed profile row are untouched.
 *
 * Managed activation is the only source change that consults the profile row:
 * it requires an existing profile and a matching expected profile revision,
 * checked inside the same transaction as the source write, so an active
 * profile revision race cannot split a selection from its team.
 */

/** The registered executor kind that owns OpenCode primary selection. */
export { OPENCODE_EXECUTOR_ID };

/** A durable selection read. */
export interface OpenCodeSelectionRecord {
  repoId: number;
  revision: number;
  selection: OpenCodePrimarySelection;
  /**
   * True when a selection row exists (the operator has made a deliberate
   * choice, or migration seeded one). False for a legacy/untracked repository,
   * which reads as default for backward compatibility. Callers that must tell
   * a deliberate default from an untracked repository use this flag.
   */
  explicit: boolean;
}

/**
 * A selection save either lands exactly one revision or refuses: unknown
 * repository, non-OpenCode executor, invalid candidate, stale selection
 * revision, managed source without a saved profile, or a stale expected
 * profile revision. Refusals never change the selection or the audit.
 */
export type SaveOpenCodeSelectionResult =
  | { ok: true; repoId: number; revision: number; selection: OpenCodePrimarySelection }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-opencode"; currentRevision: number }
  | {
      ok: false;
      reason: "validation";
      currentRevision: number;
      issues: readonly OpenCodeSelectionFieldIssue[];
    }
  | { ok: false; reason: "conflict"; currentRevision: number }
  | {
      ok: false;
      reason: "no-profile";
      currentRevision: number;
      currentProfileRevision: number;
    }
  | {
      ok: false;
      reason: "profile-revision-required";
      currentRevision: number;
      currentProfileRevision: number;
    }
  | {
      ok: false;
      reason: "profile-conflict";
      currentRevision: number;
      currentProfileRevision: number;
    };

interface SelectionRow {
  source: string;
  native_agent_id: string | null;
  revision: number;
}

function readSelectionRow(db: Database.Database, repoId: number): SelectionRow | undefined {
  return db
    .prepare(
      "SELECT source, native_agent_id, revision FROM opencode_primary_selections WHERE repo_id = ?",
    )
    .get(repoId) as SelectionRow | undefined;
}

/** The stored selection revision, reading a missing row as revision 0. */
export function currentSelectionRevision(db: Database.Database, repoId: number): number {
  return readSelectionRow(db, repoId)?.revision ?? 0;
}

function selectionFromRow(row: SelectionRow): OpenCodePrimarySelection {
  if (row.source === "native" && row.native_agent_id !== null) {
    return { source: "native", agentId: row.native_agent_id };
  }
  if (row.source === "managed") return { source: "managed" };
  return { source: "default" };
}

/**
 * Read the durable primary source for one repository. Returns undefined for an
 * unknown repository. A repository with no selection row reads as
 * `{ source: "default" }` at revision 0 with `explicit: false`.
 */
export function readOpenCodeSelection(
  db: Database.Database,
  repoId: number,
): OpenCodeSelectionRecord | undefined {
  if (!db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(repoId)) return undefined;
  const row = readSelectionRow(db, repoId);
  if (row === undefined) {
    return { repoId, revision: 0, selection: { source: "default" }, explicit: false };
  }
  return { repoId, revision: row.revision, selection: selectionFromRow(row), explicit: true };
}

interface ProfileRevisionRow {
  profileJson: string | null;
  revision: number;
}

function readProfileRevisionRow(
  db: Database.Database,
  repoId: number,
): ProfileRevisionRow | undefined {
  const row = db
    .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(repoId) as { profile_json: string | null; revision: number } | undefined;
  if (row === undefined) return undefined;
  return { profileJson: row.profile_json, revision: row.revision };
}

/**
 * Atomically save a whole primary selection with compare-and-set semantics.
 *
 * `expectedRevision` is the selection revision the operator's edit began from.
 * For `managed` source the save additionally requires a saved profile and an
 * `expectedProfileRevision` matching the stored profile revision; both checks
 * run in the same transaction as the write, so an activation that races a
 * profile save conflicts instead of binding the selection to a newer team.
 *
 * On success the selection row is upserted at `expectedRevision + 1` and
 * exactly one scoped operator action records the safe before/after identifiers
 * and revision. Native/default switches never touch the profile row: a saved
 * managed team stays dormant for later reuse.
 */
export function saveOpenCodeSelection(
  db: Database.Database,
  input: {
    repoId: number;
    /** The selection revision the operator's edit began from. */
    expectedRevision: number;
    /** The submitted selection; validated before any write. */
    candidate: unknown;
    /** Resolved executor kind (`agents[agent].kind ?? agent`) when known. */
    executorKind?: string;
    /** For managed source, the profile revision the operator saw. */
    expectedProfileRevision?: number;
  },
): SaveOpenCodeSelectionResult {
  const repository = db.prepare("SELECT agent FROM repositories WHERE id = ?").get(input.repoId) as
    { agent: string } | undefined;
  if (!repository) return { ok: false, reason: "not-found" };
  const executorKind = input.executorKind ?? repository.agent;
  const currentRevision = currentSelectionRevision(db, input.repoId);
  if (executorKind !== OPENCODE_EXECUTOR_ID) {
    return { ok: false, reason: "not-opencode", currentRevision };
  }

  let selection: OpenCodePrimarySelection;
  try {
    selection = parseOpenCodePrimarySelection(input.candidate);
  } catch (error) {
    if (error instanceof OpenCodeSelectionValidationError) {
      return {
        ok: false,
        reason: "validation",
        currentRevision,
        issues: error.issues,
      };
    }
    throw error;
  }

  return db.transaction((): SaveOpenCodeSelectionResult => {
    // D4: the executor gate is re-derived inside the transaction. The
    // repository's agent can change concurrently (file-configuration
    // synchronization), so re-read it here; a caller-supplied resolved kind
    // (an alias mapped to OpenCode) is authoritative and constant, but a
    // default kind follows the row and must still resolve to OpenCode.
    const repositoryNow = db
      .prepare("SELECT agent FROM repositories WHERE id = ?")
      .get(input.repoId) as { agent: string } | undefined;
    if (!repositoryNow) return { ok: false, reason: "not-found" };
    const revisionNow = currentSelectionRevision(db, input.repoId);
    const executorKindNow = input.executorKind ?? repositoryNow.agent;
    if (executorKindNow !== OPENCODE_EXECUTOR_ID) {
      return { ok: false, reason: "not-opencode", currentRevision: revisionNow };
    }
    if (revisionNow !== input.expectedRevision) {
      return { ok: false, reason: "conflict", currentRevision: revisionNow };
    }

    if (selection.source === "managed") {
      const profileRow = readProfileRevisionRow(db, input.repoId);
      const currentProfileRevision = profileRow?.revision ?? 0;
      if (profileRow === undefined || profileRow.profileJson === null) {
        return {
          ok: false,
          reason: "no-profile",
          currentRevision: revisionNow,
          currentProfileRevision,
        };
      }
      if (input.expectedProfileRevision === undefined) {
        return {
          ok: false,
          reason: "profile-revision-required",
          currentRevision: revisionNow,
          currentProfileRevision,
        };
      }
      if (input.expectedProfileRevision !== currentProfileRevision) {
        return {
          ok: false,
          reason: "profile-conflict",
          currentRevision: revisionNow,
          currentProfileRevision,
        };
      }
    }

    const before =
      readOpenCodeSelection(db, input.repoId)?.selection ?? ({ source: "default" } as const);
    const revision = revisionNow + 1;
    db.prepare(
      `INSERT INTO opencode_primary_selections (repo_id, source, native_agent_id, revision)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET
         source = excluded.source,
         native_agent_id = excluded.native_agent_id,
         revision = excluded.revision`,
    ).run(
      input.repoId,
      selection.source,
      selection.source === "native" ? selection.agentId : null,
      revision,
    );
    recordOperatorAction(db, {
      action: "opencode-primary-source",
      target: `repository:${input.repoId}`,
      effect: `v${revision}`,
      detail: {
        before: openCodeSelectionDetail(before),
        after: openCodeSelectionDetail(selection),
      },
    });
    return { ok: true, repoId: input.repoId, revision, selection };
  })();
}

/**
 * Inside an open transaction: reset the repository's selection to default if it
 * currently selects managed, so clearing an active profile returns the source
 * to default atomically with the profile write. A dormant (native/default)
 * selection is left untouched. Does not audit; the caller records one action.
 */
export function resetManagedSelectionToDefault(
  db: Database.Database,
  repoId: number,
): { reset: boolean; selection: OpenCodePrimarySelection; revision: number } {
  const record = readOpenCodeSelection(db, repoId);
  if (record === undefined || record.selection.source !== "managed") {
    return {
      reset: false,
      selection: record?.selection ?? { source: "default" },
      revision: record?.revision ?? 0,
    };
  }
  const revision = record.revision + 1;
  db.prepare(
    `UPDATE opencode_primary_selections
     SET source = 'default', native_agent_id = NULL, revision = ?
     WHERE repo_id = ?`,
  ).run(revision, repoId);
  return { reset: true, selection: { source: "default" }, revision };
}

/** Narrow an unknown source string to the durable source vocabulary. */
export function isOpenCodePrimarySource(value: unknown): value is OpenCodePrimarySource {
  return value === "default" || value === "native" || value === "managed";
}
