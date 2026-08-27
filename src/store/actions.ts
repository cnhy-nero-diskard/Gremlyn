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

export class OperatorActionStore {
  constructor(private readonly db: Database.Database) {}

  record(input: {
    action: string;
    target: string;
    effect?: string;
    detail?: Record<string, unknown>;
  }): number {
    const result = this.db
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

  list(limit = 50): OperatorActionRow[] {
    return this.db
      .prepare("SELECT * FROM operator_actions ORDER BY id DESC LIMIT ?")
      .all(limit) as OperatorActionRow[];
  }
}
