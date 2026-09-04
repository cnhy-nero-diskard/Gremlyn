import type Database from "better-sqlite3";
import { REASONING_EFFORTS, type ReasoningEffort } from "../types.js";
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

/** The agent id a repository row is bound to, for agent-aware console behavior. */
export function repositoryAgent(db: Database.Database, repoId: number): string | undefined {
  const row = db.prepare("SELECT agent FROM repositories WHERE id = ?").get(repoId) as
    { agent: string } | undefined;
  return row?.agent;
}

export type SetRepositoryModelResult =
  { ok: true; model: string } | { ok: false; reason: "not-found" };

/** Set a repository's default model. */
export function setRepositoryModel(
  db: Database.Database,
  repoId: number,
  model: string,
): SetRepositoryModelResult {
  if (!repositoryExists(db, repoId)) return { ok: false, reason: "not-found" };
  const trimmed = model.trim();
  db.prepare("UPDATE repositories SET model = ? WHERE id = ?").run(trimmed, repoId);
  return { ok: true, model: trimmed };
}

export type SetRepositoryProviderResult =
  { ok: true; provider: string } | { ok: false; reason: "not-found" | "provider-required" };

export type SetRepositoryModelProviderResult =
  | { ok: true; provider: string; model: string; effort: ReasoningEffort }
  | {
      ok: false;
      reason:
        | "not-found"
        | "provider-required"
        | "model-required"
        | "effort-required"
        | "effort-not-supported";
    };

/**
 * Atomically update the dashboard's provider/model/effort settings.
 *
 * `providerRequired` mirrors the repository's agent kind: a CLI that takes a
 * first-class provider argument (Cline) still rejects an empty provider here,
 * while a kind that folds the provider into the model id (OpenCode) accepts
 * one — a valid OpenCode repository carries `provider === ""`.
 */
export function setRepositoryModelProvider(
  db: Database.Database,
  repoId: number,
  provider: string,
  model: string,
  effort: string,
  supportedEfforts: readonly ReasoningEffort[] = REASONING_EFFORTS,
  providerRequired = true,
): SetRepositoryModelProviderResult {
  if (!repositoryExists(db, repoId)) return { ok: false, reason: "not-found" };
  const trimmedProvider = provider.trim();
  if (!trimmedProvider && providerRequired) return { ok: false, reason: "provider-required" };
  const trimmedModel = model.trim();
  if (!trimmedModel) return { ok: false, reason: "model-required" };
  const trimmedEffort = effort.trim();
  if (!trimmedEffort) return { ok: false, reason: "effort-required" };
  if (!supportedEfforts.includes(trimmedEffort as ReasoningEffort)) {
    return { ok: false, reason: "effort-not-supported" };
  }
  db.prepare("UPDATE repositories SET provider = ?, model = ?, effort = ? WHERE id = ?").run(
    trimmedProvider,
    trimmedModel,
    trimmedEffort,
    repoId,
  );
  return {
    ok: true,
    provider: trimmedProvider,
    model: trimmedModel,
    effort: trimmedEffort as ReasoningEffort,
  };
}

export type SetRepositoryEffortResult =
  | { ok: true; effort: ReasoningEffort }
  | { ok: false; reason: "not-found" | "effort-required" | "effort-not-supported" };

/** Set only a repository's reasoning effort, preserving provider and model. */
export function setRepositoryEffort(
  db: Database.Database,
  repoId: number,
  effort: string,
  supportedEfforts: readonly ReasoningEffort[] = REASONING_EFFORTS,
): SetRepositoryEffortResult {
  if (!repositoryExists(db, repoId)) return { ok: false, reason: "not-found" };
  const trimmed = effort.trim();
  if (!trimmed) return { ok: false, reason: "effort-required" };
  if (!supportedEfforts.includes(trimmed as ReasoningEffort)) {
    return { ok: false, reason: "effort-not-supported" };
  }
  db.prepare("UPDATE repositories SET effort = ? WHERE id = ?").run(trimmed, repoId);
  return { ok: true, effort: trimmed as ReasoningEffort };
}

/**
 * Set a repository's default provider. Providers are opaque ids passed through to the agent CLI.
 * An empty provider is refused only when the repository's agent requires one (see above).
 */
export function setRepositoryProvider(
  db: Database.Database,
  repoId: number,
  provider: string,
  providerRequired = true,
): SetRepositoryProviderResult {
  if (!repositoryExists(db, repoId)) return { ok: false, reason: "not-found" };
  const trimmed = provider.trim();
  if (!trimmed && providerRequired) return { ok: false, reason: "provider-required" };
  db.prepare("UPDATE repositories SET provider = ? WHERE id = ?").run(trimmed, repoId);
  return { ok: true, provider: trimmed };
}

export type SetRepositoryTimeoutResult =
  | { ok: true; timeoutSeconds: number | null }
  | { ok: false; reason: "not-found" | "timeout-invalid" };

/** Set the live per-repository agent timeout; null means no outer limit. */
export function setRepositoryTimeout(
  db: Database.Database,
  repoId: number,
  value: unknown,
): SetRepositoryTimeoutResult {
  if (!repositoryExists(db, repoId)) return { ok: false, reason: "not-found" };
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    db.prepare("UPDATE repositories SET timeout_seconds = NULL WHERE id = ?").run(repoId);
    return { ok: true, timeoutSeconds: null };
  }
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(seconds) || seconds < 0) {
    return { ok: false, reason: "timeout-invalid" };
  }
  if (seconds === 0) {
    db.prepare("UPDATE repositories SET timeout_seconds = NULL WHERE id = ?").run(repoId);
    return { ok: true, timeoutSeconds: null };
  }
  db.prepare("UPDATE repositories SET timeout_seconds = ? WHERE id = ?").run(seconds, repoId);
  return { ok: true, timeoutSeconds: seconds };
}
