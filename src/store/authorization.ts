import type Database from "better-sqlite3";
import type { CommandOutcome, NormalizedEvent, ParsedCommand } from "../types.js";

export interface ProcessedCommandRow {
  id: number;
  repo_id: number;
  pr_number: number;
  comment_id: number;
  command: string;
  author_login: string;
  observed_at: string;
  outcome: CommandOutcome;
  reason: string | null;
  job_id: number | null;
}

export class AuthorizationStore {
  constructor(private readonly db: Database.Database) {}

  isProcessed(repoId: number, event: NormalizedEvent, command: ParsedCommand): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM processed_commands
         WHERE repo_id = ? AND pr_number = ? AND comment_id = ? AND command = ?`,
      )
      .get(repoId, event.prNumber, event.commentId, command.name);
    return row !== undefined;
  }

  record(
    repoId: number,
    event: NormalizedEvent,
    command: ParsedCommand,
    outcome: Extract<CommandOutcome, "rejected" | "ignored">,
    reason: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO processed_commands
           (repo_id, pr_number, comment_id, command, author_login,
            observed_at, outcome, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repoId,
        event.prNumber,
        event.commentId,
        command.name,
        event.authorLogin,
        event.observedAt,
        outcome,
        reason,
      );
  }

  get(repoId: number, event: NormalizedEvent, command: ParsedCommand): ProcessedCommandRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM processed_commands
         WHERE repo_id = ? AND pr_number = ? AND comment_id = ? AND command = ?`,
      )
      .get(repoId, event.prNumber, event.commentId, command.name) as
      ProcessedCommandRow | undefined;
    return row ?? null;
  }
}
