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
