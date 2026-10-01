import type Database from "better-sqlite3";

/**
 * Operator action audit (workspace-isolation spec: a reset is recorded;
 * operator-console spec: every operator action is recorded with its time and
 * effect). Both refusals and effects land here.
 */

export interface OperatorActionRow {
  id: number;
  at: string;
  action: string;
  target: string;
  effect: string | null;
  detail: string | null;
}

export interface OperatorActionInput {
  action: string;
  target: string;
  effect?: string;
  detail?: Record<string, unknown>;
}

/**
 * Insert one operator action row. Standalone statements join whatever
 * transaction is already open on `db`, so a store operation can record its
 * audit atomically with the change it audited (see the OpenCode profile save,
 * which runs inside a compare-and-set transaction).
 */
export function recordOperatorAction(db: Database.Database, input: OperatorActionInput): number {
  const result = db
    .prepare(
      "INSERT INTO operator_actions (at, action, target, effect, detail) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      new Date().toISOString(),
      input.action,
      input.target,
      input.effect ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
    );
  return Number(result.lastInsertRowid);
}

export class OperatorActionStore {
  constructor(private readonly db: Database.Database) {}

  record(input: OperatorActionInput): number {
    return recordOperatorAction(this.db, input);
  }

  list(limit = 50): OperatorActionRow[] {
    return this.db
      .prepare("SELECT * FROM operator_actions ORDER BY id DESC LIMIT ?")
      .all(limit) as OperatorActionRow[];
  }
}
