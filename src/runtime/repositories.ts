import type Database from "better-sqlite3";
import { providerSupportsAgentKind, bundledProviderCatalog, type ProviderCatalogSnapshot } from "../agent/provider-catalog.js";
import { KINDS_REQUIRING_PROVIDER, type AgentDefinition } from "../config/loader.js";
import type { RepoConfig } from "../config/loader.js";
import type { RuntimeRepository } from "../orchestrator/resolution.js";
import type { ReasoningEffort } from "../types.js";

export interface ProviderMismatchReporter {
  warn(event: string, fields: Record<string, unknown>): void;
}

/** Report persisted provider choices known not to fit their configured agent. */
export function reportRepositoryProviderMismatches(
  repositories: readonly RuntimeRepository[],
  agents: Readonly<Record<string, AgentDefinition>>,
  logger: ProviderMismatchReporter,
  catalog: ProviderCatalogSnapshot = bundledProviderCatalog(),
): number {
  let count = 0;
  for (const repository of repositories) {
    const definition = agents[repository.agent];
    if (!definition) continue;
    const providerUsable = repository.provider
      ? providerSupportsAgentKind(catalog, repository.provider, definition.kind)
      : !KINDS_REQUIRING_PROVIDER.has(definition.kind);
    if (providerUsable) continue;
    logger.warn("repository provider mismatch", {
      repository: repository.id,
      name: `${repository.owner}/${repository.name}`,
      agent: repository.agent,
      kind: definition.kind,
      provider: repository.provider,
      model: repository.model,
    });
    count += 1;
  }
  return count;
}

/** Upsert file configuration into the durable repository registry. */
export function syncRepositories(
  db: Database.Database,
  repositories: readonly RepoConfig[],
  initialTimeoutSec?: number,
): RuntimeRepository[] {
  const upsert = db.prepare(
    `INSERT INTO repositories
       (owner, name, source_path, workspace_root, agent, model, provider, effort,
        enabled, validation_commands, agent_instructions, allowed_models, timeout_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, name) DO UPDATE SET
       source_path = excluded.source_path,
       workspace_root = excluded.workspace_root,
       agent = excluded.agent,
       enabled = excluded.enabled,
       validation_commands = excluded.validation_commands,
       agent_instructions = excluded.agent_instructions,
       allowed_models = excluded.allowed_models`,
  );
  const select = db.prepare(
    "SELECT id, model, provider, effort, timeout_seconds FROM repositories WHERE owner = ? AND name = ?",
  );
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
        initialTimeoutSec ?? null,
      );
      // Provider/model/effort are operator-editable from the console and are
      // excluded from the ON CONFLICT update above, so a prior operator
      // choice can differ from what's in the config file; read back the
      // row that actually won so the runtime and dashboard agree.
      const row = select.get(repository.owner, repository.name) as {
        id: number;
        model: string;
        provider: string;
        effort: ReasoningEffort;
        timeout_seconds: number | null;
      };
      return {
        ...repository,
        id: row.id,
        model: row.model,
        provider: row.provider,
        effort: row.effort,
        ...(row.timeout_seconds === null ? {} : { timeoutSec: row.timeout_seconds }),
      };
    }),
  )();
}
