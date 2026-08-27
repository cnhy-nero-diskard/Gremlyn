import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "./migrations.js";

/**
 * SQLite store (design D3). One database file under the data directory,
 * synchronous API, WAL mode so the console can read while the orchestrator
 * writes.
 */

export interface StoreOptions {
  dataDir: string;
  /** Defaults to `gremlyn.db` inside the data directory. Pass ":memory:" for tests. */
  file?: string;
}

export class Store {
  readonly db: Database.Database;

  constructor(options: StoreOptions) {
    if (options.file !== ":memory:") {
      mkdirSync(options.dataDir, { recursive: true });
    }
    const file = options.file ?? join(options.dataDir, "gremlyn.db");
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /**
   * Apply pending migrations in order. Idempotent: the schema_migrations
   * table records what has run, so a fresh database applies everything and an
   * already-migrated database applies nothing.
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (this.db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map(
        (r) => r.id,
      ),
    );
    const record = this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        record.run(migration.id, new Date().toISOString());
      })();
    }
  }

  close(): void {
    this.db.close();
  }
}
