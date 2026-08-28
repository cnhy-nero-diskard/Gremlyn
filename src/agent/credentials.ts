import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Credential seed set (design D3).
 *
 * The data directory layout (see design.md Context):
 *   ~/.cline/
 *     data/
 *       secrets.json              <- API-key credentials
 *       settings/providers.json   <- OAuth provider credentials
 *       db, locks.db              <- run state, locks (isolated per attempt)
 *       sessions/                 <- session history
 *       globalState.json          <- provider/model selection (not required)
 *
 * Empirically determined against cline 3.0.60 via `npm run probe:agent
 * --seed-source`, widening only as required. Two providers with different
 * credential shapes were needed to find the whole set:
 *
 *   cline-pass (API key)   secrets.json alone suffices.
 *   openai-codex (OAuth)   secrets.json alone FAILS with "OpenAI API key is
 *                          missing"; the PKCE refresh token lives in
 *                          settings/providers.json.
 *
 * `globalState.json` was tested and is not required for either: it carries
 * provider/model selection, which the orchestrator supplies via argv.
 *
 * Both providers reach `finishReason: "completed"` on an isolated --data-dir
 * with the set below, where an unseeded run fails. Entries may name nested
 * paths; parents are created on seed.
 */
export const CREDENTIAL_SEED_FILES = ["secrets.json", "settings/providers.json"] as const;
export type CredentialSeedFile = (typeof CREDENTIAL_SEED_FILES)[number];

/**
 * Seed the declared credential files from a configured source directory into a
 * fresh attempt data directory, with owner-only permissions (0o600).
 *
 * The source is treated as read-only; this function never writes to it.
 */
export function seedAgentCredentials(
  sourceDir: string,
  destDir: string,
  files: readonly string[] = CREDENTIAL_SEED_FILES,
): string[] {
  mkdirSync(destDir, { recursive: true });
  const seeded: string[] = [];
  for (const file of files) {
    const src = join(sourceDir, file);
    const dest = join(destDir, file);
    if (!existsSync(src)) {
      throw new Error(`credential source file not found: ${src}`);
    }
    const stat = statSync(src);
    if (!stat.isFile()) {
      throw new Error(`credential source entry is not a file: ${src}`);
    }
    // A seed entry may name a nested path (openai-codex keeps its OAuth
    // credential in settings/providers.json), so create the parent, not just
    // the attempt root.
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    seeded.push(file);
    try {
      chmodSync(dest, 0o600);
    } catch {
      // Windows may not honor POSIX permissions; the file is still copied.
      // The attempt directory is already under Gremlyn-managed storage and
      // is removed with the attempt, so lifetime remains the mitigation.
    }
  }
  return seeded;
}

/**
 * Verify that the credential source directory exists and is readable (and
 * that each required seed file exists). Used at startup to fail fast with a
 * configuration error rather than per-job agent failures.
 */
export function verifyCredentialSource(
  agentId: string,
  sourceDir: string,
  files: readonly string[] = CREDENTIAL_SEED_FILES,
): void {
  if (!existsSync(sourceDir)) {
    throw new Error(
      `credential source for agent "${agentId}" not found: ${sourceDir} (conventional default: ~/.cline/data)`,
    );
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(sourceDir);
  } catch (error) {
    throw new Error(
      `credential source for agent "${agentId}" is not readable: ${sourceDir} — ${error instanceof Error ? error.message : String(error)} (conventional default: ~/.cline/data)`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `credential source for agent "${agentId}" is not a directory: ${sourceDir} (conventional default: ~/.cline/data)`,
    );
  }
  // Check readability by attempting to read directory.
  try {
    readdirSync(sourceDir);
  } catch (error) {
    throw new Error(
      `credential source for agent "${agentId}" is not readable: ${sourceDir} — ${error instanceof Error ? error.message : String(error)} (conventional default: ~/.cline/data)`,
    );
  }
  for (const file of files) {
    const candidate = join(sourceDir, file);
    if (!existsSync(candidate)) {
      throw new Error(
        `credential source for agent "${agentId}" is missing required file "${file}": ${sourceDir} (conventional default: ~/.cline/data)`,
      );
    }
  }
}

/**
 * Remove seeded credential files from an attempt directory. Used on every
 * terminal path (success, failure, timeout, cancellation) and for stale
 * directories on startup.
 *
 * The function is tolerant of missing files/directories.
 */
export function clearSeededCredentials(
  destDir: string,
  files: readonly string[] = CREDENTIAL_SEED_FILES,
): void {
  for (const file of files) {
    const target = join(destDir, file);
    try {
      rmSync(target, { force: true });
    } catch {
      // Ignore missing file.
    }
  }
}

/**
 * Remove the entire attempt data directory (which also removes any seeded
 * credential). Tolerant of missing directory.
 */
export function removeAttemptDataDir(attemptDataDir: string): void {
  try {
    rmSync(attemptDataDir, { recursive: true, force: true });
  } catch {
    // Ignore.
  }
}
