/**
 * Bounded helpers for the task 5.1 real-orchestrator delegation-observation
 * fixture integration.
 *
 * Everything here is read-only, bounded and fixture-only:
 *
 * - {@link waitFor} polls a predicate with a hard deadline so a fixture that
 *   never reaches the expected live state fails loudly instead of hanging the
 *   suite.
 * - {@link allObservationNodes} / {@link observationNodesForAttempt} reuse the
 *   stable batched store read rather than inventing a projection.
 * - {@link installObservationStorageFailureTrigger} simulates a database fault
 *   on the OBSERVATION-ONLY tables (never a safety table) so a test can prove an
 *   observation-storage failure cannot change a job's gates.
 *
 * Nothing here performs network access; the repositories and GitHub surface are
 * the local fixtures the caller already built.
 */

import type Database from "better-sqlite3";
import {
  readDelegationObservations,
  type DelegationObservationNode,
} from "../../src/store/delegation-observations.js";

/** A promise that settles after at least `ms` (clamped to zero). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Poll `condition` until it is true or the deadline passes. Bounded by
 * construction: a fixture that never observes the expected state throws a clear
 * error instead of wedging the test process.
 */
export async function waitFor(
  condition: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = Math.max(1, options.intervalMs ?? 5);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${String(timeoutMs)}ms waiting for ${options.label ?? "condition"}`,
      );
    }
    await delay(intervalMs);
  }
}

/** Every observation node across every attempt, via the stable batched read. */
export function allObservationNodes(db: Database.Database): DelegationObservationNode[] {
  const ids = (
    db.prepare("SELECT DISTINCT attempt_id AS id FROM delegation_observation_nodes").all() as {
      id: number;
    }[]
  ).map((row) => row.id);
  if (ids.length === 0) return [];
  const nodes: DelegationObservationNode[] = [];
  for (const bucket of readDelegationObservations(db, ids).values()) nodes.push(...bucket.nodes);
  return nodes;
}

/** One attempt's observation nodes, via the stable batched read. */
export function observationNodesForAttempt(
  db: Database.Database,
  attemptId: number,
): DelegationObservationNode[] {
  return readDelegationObservations(db, [attemptId]).get(attemptId)?.nodes ?? [];
}

export interface ObservationGapRow {
  signature: string;
  detail: string;
  openedAt: string;
  closedAt: string | null;
}

/** Every observation gap recorded for an attempt (or all attempts). */
export function observationGaps(db: Database.Database, attemptId?: number): ObservationGapRow[] {
  const filter = attemptId === undefined ? "" : " WHERE attempt_id = ?";
  const params = attemptId === undefined ? [] : [attemptId];
  return (
    db
      .prepare(
        `SELECT signature, detail, opened_at, closed_at FROM delegation_observation_gaps${filter}
         ORDER BY id`,
      )
      .all(...params) as Array<{
      signature: string;
      detail: string;
      opened_at: string;
      closed_at: string | null;
    }>
  ).map((row) => ({
    signature: row.signature,
    detail: row.detail,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  }));
}

/** The transport state of every invocation-coverage row, in ordinal order. */
export function coverageTransportStates(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT transport_state AS state FROM delegation_invocation_coverage
         ORDER BY attempt_id, invocation_ordinal`,
      )
      .all() as { state: string }[]
  ).map((row) => row.state);
}

/** Count currently-open gaps with a given machine signature. */
export function countOpenGaps(db: Database.Database, signature: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM delegation_observation_gaps
         WHERE signature = ? AND closed_at IS NULL`,
      )
      .get(signature) as { n: number }
  ).n;
}

/**
 * Fail every write to the four OBSERVATION-ONLY tables with a SQLite trigger.
 * The safety tables (`attempts`, `opencode_invocations`,
 * `managed_child_sessions`, ...) are deliberately untouched, so a test can
 * prove that a broken observation store cannot alter a job's gates.
 */
export function installObservationStorageFailureTrigger(db: Database.Database): void {
  removeObservationStorageFailureTrigger(db);
  db.exec(`
    CREATE TRIGGER test_obs_nodes_insert BEFORE INSERT ON delegation_observation_nodes
    BEGIN SELECT RAISE(ABORT, 'delegation observation storage disabled'); END;
    CREATE TRIGGER test_obs_nodes_update BEFORE UPDATE ON delegation_observation_nodes
    BEGIN SELECT RAISE(ABORT, 'delegation observation storage disabled'); END;
    CREATE TRIGGER test_obs_transitions_insert BEFORE INSERT ON delegation_observation_transitions
    BEGIN SELECT RAISE(ABORT, 'delegation observation storage disabled'); END;
    CREATE TRIGGER test_obs_coverage_insert BEFORE INSERT ON delegation_invocation_coverage
    BEGIN SELECT RAISE(ABORT, 'delegation observation storage disabled'); END;
    CREATE TRIGGER test_obs_coverage_update BEFORE UPDATE ON delegation_invocation_coverage
    BEGIN SELECT RAISE(ABORT, 'delegation observation storage disabled'); END;
    CREATE TRIGGER test_obs_gaps_insert BEFORE INSERT ON delegation_observation_gaps
    BEGIN SELECT RAISE(ABORT, 'delegation observation storage disabled'); END;
  `);
}

/** Remove the simulated observation-storage failure triggers, if present. */
export function removeObservationStorageFailureTrigger(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS test_obs_nodes_insert;
    DROP TRIGGER IF EXISTS test_obs_nodes_update;
    DROP TRIGGER IF EXISTS test_obs_transitions_insert;
    DROP TRIGGER IF EXISTS test_obs_coverage_insert;
    DROP TRIGGER IF EXISTS test_obs_coverage_update;
    DROP TRIGGER IF EXISTS test_obs_gaps_insert;
  `);
}

/**
 * Dispose every live observer through the orchestrator's stable teardown API.
 * Typed minimally so the helper still compiles if the teardown method is
 * between revisions; the real orchestrator exposes it.
 */
export function disposeDelegationObservation(orchestrator: {
  disposeDelegationObservation?: () => void;
}): void {
  orchestrator.disposeDelegationObservation?.();
}
