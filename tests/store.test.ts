import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { MIGRATIONS } from "../src/store/migrations.js";

test("migrations apply cleanly against a fresh database", () => {
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const applied = store.db
    .prepare("SELECT id FROM schema_migrations ORDER BY id")
    .all() as { id: string }[];
  assert.deepEqual(
    applied.map((r) => r.id),
    MIGRATIONS.map((m) => m.id),
  );
  // Spot-check the D6 tables exist.
  const tables = (
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((t) => t.name);
  for (const table of [
    "repositories",
    "processed_commands",
    "jobs",
    "attempts",
    "status_events",
    "validation_runs",
    "log_entries",
    "ingestion_state",
  ]) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  store.close();
});

test("migrations are idempotent against an already-migrated database", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-store-"));
  const first = new Store({ dataDir: dir });
  first.db.prepare("INSERT INTO log_entries (at, level, event) VALUES (?, ?, ?)").run(
    new Date().toISOString(),
    "info",
    "marker",
  );
  first.close();

  // Reopen: no migration re-runs, existing data survives.
  const second = new Store({ dataDir: dir });
  const count = second.db
    .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
    .get() as { n: number };
  assert.equal(count.n, MIGRATIONS.length);
  const marker = second.db
    .prepare("SELECT event FROM log_entries")
    .get() as { event: string };
  assert.equal(marker.event, "marker");
  second.close();
});

test("processed_commands enforces the at-most-once unique constraint", () => {
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const insert = store.db.prepare(
    `INSERT INTO processed_commands
       (repo_id, pr_number, comment_id, command, author_login, observed_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(1, 42, 1001, "RESOLVE", "someuser", new Date().toISOString(), "executed");
  assert.throws(() =>
    insert.run(1, 42, 1001, "RESOLVE", "someuser", new Date().toISOString(), "executed"),
  );
  store.close();
});
