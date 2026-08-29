import type Database from "better-sqlite3";
export function toggleRepository(db: Database.Database, repoId: number): boolean | undefined {
  const row = db.prepare("SELECT enabled FROM repositories WHERE id = ?").get(repoId) as
    { enabled: number } | undefined;
  if (!row) return undefined;
  const enabled = row.enabled === 0 ? 1 : 0;
  db.prepare("UPDATE repositories SET enabled = ? WHERE id = ?").run(enabled, repoId);
  return enabled === 1;
}
export function repositoryExists(db: Database.Database, repoId: number): boolean {
  return db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(repoId) !== undefined;
}

function parseAllowedModels(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export type SetRepositoryModelResult =
  | { ok: true; model: string }
  | { ok: false; reason: "not-found" | "model-not-allowed" };

/** Set a repository's default model, honoring the same allowed_models rule the config loader enforces. */
export function setRepositoryModel(
  db: Database.Database,
  repoId: number,
  model: string,
): SetRepositoryModelResult {
  const row = db.prepare("SELECT allowed_models FROM repositories WHERE id = ?").get(repoId) as
    { allowed_models: string } | undefined;
  if (!row) return { ok: false, reason: "not-found" };
  const allowed = parseAllowedModels(row.allowed_models);
  if (allowed.length > 0 && !allowed.includes(model)) {
    return { ok: false, reason: "model-not-allowed" };
  }
  db.prepare("UPDATE repositories SET model = ? WHERE id = ?").run(model, repoId);
  return { ok: true, model };
}

export type SetRepositoryProviderResult =
  | { ok: true; provider: string }
  | { ok: false; reason: "not-found" | "provider-required" };

export type SetRepositoryModelProviderResult =
  | { ok: true; provider: string; model: string }
  | {
      ok: false;
      reason: "not-found" | "provider-required" | "model-required" | "model-not-allowed";
    };

/** Atomically update the dashboard's provider/model pair under repository policy. */
export function setRepositoryModelProvider(
  db: Database.Database,
  repoId: number,
  provider: string,
  model: string,
): SetRepositoryModelProviderResult {
  const row = db.prepare("SELECT allowed_models FROM repositories WHERE id = ?").get(repoId) as
    { allowed_models: string } | undefined;
  if (!row) return { ok: false, reason: "not-found" };
  const trimmedProvider = provider.trim();
  if (!trimmedProvider) return { ok: false, reason: "provider-required" };
  const trimmedModel = model.trim();
  if (!trimmedModel) return { ok: false, reason: "model-required" };
  const allowed = parseAllowedModels(row.allowed_models);
  if (allowed.length > 0 && !allowed.includes(trimmedModel)) {
    return { ok: false, reason: "model-not-allowed" };
  }
  db.prepare("UPDATE repositories SET provider = ?, model = ? WHERE id = ?").run(
    trimmedProvider,
    trimmedModel,
    repoId,
  );
  return { ok: true, provider: trimmedProvider, model: trimmedModel };
}

/** Set a repository's default provider. Providers are opaque ids passed through to the agent CLI. */
export function setRepositoryProvider(
  db: Database.Database,
  repoId: number,
  provider: string,
): SetRepositoryProviderResult {
  if (!repositoryExists(db, repoId)) return { ok: false, reason: "not-found" };
  const trimmed = provider.trim();
  if (!trimmed) return { ok: false, reason: "provider-required" };
  db.prepare("UPDATE repositories SET provider = ? WHERE id = ?").run(trimmed, repoId);
  return { ok: true, provider: trimmed };
}
