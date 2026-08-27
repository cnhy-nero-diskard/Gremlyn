import type Database from "better-sqlite3";
import type { RepoConfig } from "../config/loader.js";
import type { RuntimeRepository } from "../orchestrator/resolution.js";

/** Upsert file configuration into the durable repository registry. */
export function syncRepositories(
  db: Database.Database,
  repositories: readonly RepoConfig[],
): RuntimeRepository[] {
  const upsert = db.prepare(
    `INSERT INTO repositories
       (owner, name, source_path, workspace_root, agent, model, provider, effort,
        enabled, validation_commands, agent_instructions, allowed_models)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, name) DO UPDATE SET
       source_path = excluded.source_path,
       workspace_root = excluded.workspace_root,
       agent = excluded.agent,
       model = excluded.model,
       provider = excluded.provider,
       effort = excluded.effort,
       enabled = excluded.enabled,
       validation_commands = excluded.validation_commands,
       agent_instructions = excluded.agent_instructions,
       allowed_models = excluded.allowed_models`,
  );
  const select = db.prepare("SELECT id FROM repositories WHERE owner = ? AND name = ?");
  return db.transaction(() =>
    repositories.map((repository) => {
      upsert.run(
        repository.owner,
        repository.name,
        repository.sourcePath,
        repository.workspaceRoot,
        repository.agent,
        repository.model,
        repository.provider,
        repository.effort,
        repository.enabled ? 1 : 0,
        JSON.stringify(repository.validationCommands),
        repository.agentInstructions ?? null,
        JSON.stringify(repository.allowedModels),
      );
      const row = select.get(repository.owner, repository.name) as { id: number };
      return { ...repository, id: row.id };
    }),
  )();
}
