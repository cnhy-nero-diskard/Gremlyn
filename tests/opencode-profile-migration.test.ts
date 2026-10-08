/**
 * Tests for task 2.2: the additive OpenCode agent profile migration (design
 * D1/D2, Migration Plan step 1).
 *
 * The profile migration adds a nullable, per-repository profile row keyed by
 * repository id (`opencode_agent_profiles`: canonical profile JSON plus an
 * integer compare-and-set revision) and nullable job snapshot columns
 * (`opencode_profile_json` / `opencode_profile_revision`). It must be additive:
 * an old database built from every prior migration gains the new shape without
 * synthesizing any profile, and existing OpenCode and Cline repositories plus
 * their jobs still load after the schema change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import {
  canonicalOpenCodeProfileJson,
  parseOpenCodeAgentProfile,
} from "../src/config/opencode-profile.js";

/** The migration under test; every migration before it forms the "old" database. */
const PROFILE_MIGRATION_ID = "0006_opencode_agent_profiles";
/**
 * The selection migration (0008) reads the profile table, so it must be left
 * pending alongside the profile migration; otherwise the "old" database would
 * apply a migration that depends on a table this fixture deliberately omits.
 */
const SELECTION_MIGRATION_ID = "0008_opencode_primary_selection";

function openStoreAt(dir: string): Store {
  return new Store({ dataDir: dir });
}

/**
 * Build the "old" database: apply every migration except the profile migration
 * and record them in `schema_migrations`, just as a shipped older Gremlyn
 * version would have left them. Reopening through {@link Store} then applies
 * only the pending profile migration.
 */
function createPreProfileDatabase(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const prior = MIGRATIONS.filter(
    (migration) => migration.id !== PROFILE_MIGRATION_ID && migration.id !== SELECTION_MIGRATION_ID,
  );
  const record = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const migration of prior) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
    })();
  }
  db.close();
}

interface SeedRepository {
  owner: string;
  name: string;
  agent: string;
  model: string;
  provider: string;
  effort: string;
}

/** Insert a repository exactly as pre-profile file synchronization would have. */
function insertRepository(db: Database.Database, repository: SeedRepository): number {
  const result = db
    .prepare(
      `INSERT INTO repositories
         (owner, name, source_path, workspace_root, agent, model, provider, effort,
          enabled, validation_commands, agent_instructions, allowed_models, timeout_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repository.owner,
      repository.name,
      `/src/${repository.owner}/${repository.name}`,
      `/workspaces/${repository.owner}/${repository.name}`,
      repository.agent,
      repository.model,
      repository.provider,
      repository.effort,
      1,
      "[]",
      null,
      "[]",
      null,
    );
  return Number(result.lastInsertRowid);
}

/** Insert a job exactly as the pre-profile schema would have stored it. */
function insertJob(db: Database.Database, repoId: number, commentId: number): number {
  const result = db
    .prepare(
      `INSERT INTO jobs
         (repo_id, pr_number, comment_id, command, thread_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(repoId, 42, commentId, "RESOLVE", null, "queued", new Date().toISOString());
  return Number(result.lastInsertRowid);
}

test("old databases migrate with no active profiles and existing OpenCode/Cline rows load", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-profile-migration-"));
  createPreProfileDatabase(join(dir, "gremlyn.db"));

  // Seed the old database with an OpenCode repository and a Cline repository
  // and one job each, then close it so the migration runs on a prior version's
  // durable state.
  const old = new Database(join(dir, "gremlyn.db"));
  const opencodeRepoId = insertRepository(old, {
    owner: "acme",
    name: "web",
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "xhigh",
  });
  const clineRepoId = insertRepository(old, {
    owner: "acme",
    name: "docs",
    agent: "cline",
    model: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    effort: "medium",
  });
  const opencodeJobId = insertJob(old, opencodeRepoId, 1001);
  const clineJobId = insertJob(old, clineRepoId, 2001);
  old.close();

  const store = openStoreAt(dir);
  const db = store.db;

  // The migration is additive and synthesizes no profile: the new per-repository
  // table is empty and no migrated job carries a snapshot.
  const profileCount = db.prepare("SELECT COUNT(*) AS n FROM opencode_agent_profiles").get() as {
    n: number;
  };
  assert.equal(profileCount.n, 0);
  const snapshotCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE opencode_profile_json IS NOT NULL OR opencode_profile_revision IS NOT NULL`,
    )
    .get() as { n: number };
  assert.equal(snapshotCount.n, 0);

  // Existing OpenCode and Cline repository rows load with every prior field.
  const opencodeRepo = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(opencodeRepoId) as {
    owner: string;
    name: string;
    agent: string;
    provider: string;
    model: string;
    effort: string;
    enabled: number;
  };
  assert.equal(opencodeRepo.owner, "acme");
  assert.equal(opencodeRepo.name, "web");
  assert.equal(opencodeRepo.agent, "opencode");
  assert.equal(opencodeRepo.provider, "opencode");
  assert.equal(opencodeRepo.model, "opencode/gpt-5.4");
  assert.equal(opencodeRepo.effort, "xhigh");
  assert.equal(opencodeRepo.enabled, 1);

  const clineRepo = db.prepare("SELECT * FROM repositories WHERE id = ?").get(clineRepoId) as {
    agent: string;
    provider: string;
    model: string;
    effort: string;
  };
  assert.equal(clineRepo.agent, "cline");
  assert.equal(clineRepo.provider, "anthropic");
  assert.equal(clineRepo.model, "anthropic/claude-sonnet-4-5");
  assert.equal(clineRepo.effort, "medium");

  // Existing job rows load and expose the new nullable snapshot columns as NULL.
  const opencodeJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(opencodeJobId) as {
    repo_id: number;
    status: string;
    review_context: string | null;
    opencode_profile_json: string | null;
    opencode_profile_revision: number | null;
  };
  assert.equal(opencodeJob.repo_id, opencodeRepoId);
  assert.equal(opencodeJob.status, "queued");
  assert.equal(opencodeJob.review_context, null);
  assert.equal(opencodeJob.opencode_profile_json, null);
  assert.equal(opencodeJob.opencode_profile_revision, null);

  const clineJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(clineJobId) as {
    repo_id: number;
  };
  assert.equal(clineJob.repo_id, clineRepoId);

  store.close();
});

test("profile storage is one nullable row keyed by repository id with an integer revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-profile-migration-"));
  createPreProfileDatabase(join(dir, "gremlyn.db"));

  const old = new Database(join(dir, "gremlyn.db"));
  const firstRepoId = insertRepository(old, {
    owner: "acme",
    name: "web",
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "xhigh",
  });
  const secondRepoId = insertRepository(old, {
    owner: "acme",
    name: "api",
    agent: "opencode",
    model: "opencode/gpt-5.4",
    provider: "opencode",
    effort: "high",
  });
  old.close();

  const store = openStoreAt(dir);
  const db = store.db;

  // The shape holds a real validated profile: canonical JSON plus an integer
  // compare-and-set revision, per repository id.
  const profile = parseOpenCodeAgentProfile({
    version: 1,
    primary: {
      id: "primary",
      description: "Primary review agent",
      permissions: ["edit", "shell", "web", "skill"],
    },
    subagents: [
      {
        id: "reviewer",
        description: "Reviewer",
        enabled: true,
        permissions: [],
      },
    ],
  });
  const json = canonicalOpenCodeProfileJson(profile);
  db.prepare(
    "INSERT INTO opencode_agent_profiles (repo_id, profile_json, revision) VALUES (?, ?, ?)",
  ).run(firstRepoId, json, 1);
  db.prepare(
    "INSERT INTO opencode_agent_profiles (repo_id, profile_json, revision) VALUES (?, ?, ?)",
  ).run(secondRepoId, null, 0);

  const first = db
    .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(firstRepoId) as { profile_json: string; revision: number };
  assert.equal(first.profile_json, json);
  assert.equal(first.revision, 1);

  // A repository with no dashboard profile is a NULL profile row (revision 0),
  // never a synthesized default profile.
  const second = db
    .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
    .get(secondRepoId) as { profile_json: string | null; revision: number };
  assert.equal(second.profile_json, null);
  assert.equal(second.revision, 0);

  // The row is keyed by repository id: one profile per repository, no more.
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO opencode_agent_profiles (repo_id, profile_json, revision) VALUES (?, ?, ?)",
      )
      .run(firstRepoId, json, 2),
  );

  store.close();
});
