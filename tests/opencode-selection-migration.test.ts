/**
 * Tests for task 2.1: the additive primary-selection/job-capture/invocation
 * migration (`0008_opencode_primary_selection`, design Migration Plan step 1).
 *
 * It must preserve every existing profile payload and revision byte-for-byte,
 * seed managed mode for a repository with an existing non-null profile and
 * default mode otherwise, and leave legacy jobs untouched so their capture can
 * be derived from their own profile.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { MIGRATIONS } from "../src/store/migrations.js";

const SELECTION_MIGRATION_ID = "0008_opencode_primary_selection";

/** Apply every migration except 0008, exactly as a shipped older Gremlyn did. */
function createPreSelectionDatabase(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const prior = MIGRATIONS.filter((migration) => migration.id !== SELECTION_MIGRATION_ID);
  const record = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const migration of prior) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
    })();
  }
  db.close();
}

function insertRepository(
  db: Database.Database,
  repo: { owner: string; name: string; agent: string },
): number {
  const result = db
    .prepare(
      `INSERT INTO repositories
         (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      repo.owner,
      repo.name,
      `/src/${repo.name}`,
      `/ws/${repo.name}`,
      repo.agent,
      "m",
      "p",
      "high",
    );
  return Number(result.lastInsertRowid);
}

function insertJob(db: Database.Database, repoId: number, commentId: number): number {
  const result = db
    .prepare(
      `INSERT INTO jobs (repo_id, pr_number, comment_id, command, thread_id, status, created_at)
       VALUES (?, 42, ?, 'RESOLVE', NULL, 'queued', ?)`,
    )
    .run(repoId, commentId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

test("legacy databases seed managed/default sources and preserve profile bytes and revisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-selection-migration-"));
  createPreSelectionDatabase(join(dir, "gremlyn.db"));

  const storedProfile =
    '{"subagents":[],"primary":{"id":"legacy","description":"Legacy"},"version":1}';
  const old = new Database(join(dir, "gremlyn.db"));
  const managedRepoId = insertRepository(old, {
    owner: "acme",
    name: "managed",
    agent: "opencode",
  });
  const defaultRepoId = insertRepository(old, { owner: "acme", name: "plain", agent: "opencode" });
  const clineRepoId = insertRepository(old, { owner: "acme", name: "docs", agent: "cline" });
  old
    .prepare(
      "INSERT INTO opencode_agent_profiles (repo_id, profile_json, revision) VALUES (?, ?, ?)",
    )
    .run(managedRepoId, storedProfile, 7);
  const legacyJobId = insertJob(old, defaultRepoId, 1001);
  old.close();

  const store = new Store({ dataDir: dir });
  const db = store.db;

  // Existing profile payloads/revisions are byte-for-byte untouched.
  const profile = db
    .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(managedRepoId) as { profile_json: string; revision: number };
  assert.equal(profile.profile_json, storedProfile);
  assert.equal(profile.revision, 7);

  // Sources are seeded correctly: managed for the profile repository and
  // default for the repositories without a profile. No profile is synthesized.
  const selections = db
    .prepare("SELECT repo_id, source, native_agent_id, revision FROM opencode_primary_selections")
    .all() as Array<{
    repo_id: number;
    source: string;
    native_agent_id: string | null;
    revision: number;
  }>;
  const byRepo = new Map(selections.map((row) => [row.repo_id, row]));
  assert.deepEqual(byRepo.get(managedRepoId), {
    repo_id: managedRepoId,
    source: "managed",
    native_agent_id: null,
    revision: 0,
  });
  assert.deepEqual(byRepo.get(defaultRepoId), {
    repo_id: defaultRepoId,
    source: "default",
    native_agent_id: null,
    revision: 0,
  });
  assert.deepEqual(byRepo.get(clineRepoId), {
    repo_id: clineRepoId,
    source: "default",
    native_agent_id: null,
    revision: 0,
  });

  // Legacy jobs expose NULL capture columns so a reader derives their source
  // from the job's own profile rather than the seeded repository selection.
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(legacyJobId) as {
    opencode_source: string | null;
    opencode_native_agent_id: string | null;
    opencode_selection_revision: number | null;
    opencode_profile_json: string | null;
    opencode_profile_revision: number | null;
  };
  assert.equal(job.opencode_source, null);
  assert.equal(job.opencode_native_agent_id, null);
  assert.equal(job.opencode_selection_revision, null);
  assert.equal(job.opencode_profile_json, null);
  assert.equal(job.opencode_profile_revision, null);

  // The generic invocation table exists and is empty.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM opencode_invocations").get() as { n: number }).n,
    0,
  );

  store.close();
});

test("a fresh database has no seeded selection and defaults only on demand", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const count = store.db.prepare("SELECT COUNT(*) AS n FROM opencode_primary_selections").get() as {
    n: number;
  };
  assert.equal(count.n, 0);

  // A repository created after migration has no row; its choice appears only
  // after an explicit save.
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('acme', 'new', 's', 'w', 'opencode', 'm', 'p', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  assert.equal(
    (
      store.db
        .prepare("SELECT COUNT(*) AS n FROM opencode_primary_selections WHERE repo_id = ?")
        .get(repoId) as { n: number }
    ).n,
    0,
  );
  store.close();
});
