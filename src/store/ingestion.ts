import type Database from "better-sqlite3";

export interface IngestionCheckpoint {
  repoId: number;
  etag: string | null;
  since: string | null;
  lastPolledAt: string | null;
}

export class IngestionStore {
  constructor(private readonly db: Database.Database) {}

  get(repoId: number): IngestionCheckpoint | null {
    const row = this.db
      .prepare(
        `SELECT repo_id AS repoId, etag, since, last_polled_at AS lastPolledAt
         FROM ingestion_state WHERE repo_id = ?`,
      )
      .get(repoId) as IngestionCheckpoint | undefined;
    return row ?? null;
  }

  save(checkpoint: IngestionCheckpoint): void {
    this.db
      .prepare(
        `INSERT INTO ingestion_state (repo_id, etag, since, last_polled_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           etag = excluded.etag,
           since = excluded.since,
           last_polled_at = excluded.last_polled_at`,
      )
      .run(checkpoint.repoId, checkpoint.etag, checkpoint.since, checkpoint.lastPolledAt);
  }
}
