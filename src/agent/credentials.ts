import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
    setOwnerOnlyPermissions(dest);
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
 * Persist credential files the agent rotated during an attempt back to the
 * source directory (design D3 amendment).
 *
 * Seeding alone is correct only for *static* credentials. An API key in
 * `secrets.json` is a fixed string, so copying it into an isolated per-attempt
 * data dir and discarding the dir loses nothing. An OAuth credential is not:
 * `settings/providers.json` holds a PKCE refresh token, and redeeming it makes
 * the provider issue a replacement and invalidate the one just used.
 *
 * Without write-back the sequence is fatal and silent:
 *   1. the attempt seeds a snapshot of the refresh token
 *   2. the agent redeems it; the provider invalidates it, issuing a new one
 *   3. the replacement is written into the ephemeral attempt dir
 *   4. `removeAttemptDataDir` deletes it
 * The source keeps the token consumed at step 2, so the first attempt after
 * each `cline auth` succeeds and every attempt after it fails `Unauthorized`
 * identically, forever.
 *
 * Only files whose contents actually changed are written back, so a static
 * `secrets.json` is left untouched. The write is atomic (staging file +
 * rename) because the source is the operator's live `~/.cline/data`, shared
 * with their interactive CLI: a torn credential file would strand them too.
 */
export function persistRotatedCredentials(
  sourceDir: string,
  attemptDataDir: string,
  files: readonly string[] = CREDENTIAL_SEED_FILES,
): string[] {
  const rotated: string[] = [];
  for (const file of files) {
    const src = join(attemptDataDir, file);
    const dest = join(sourceDir, file);
    if (!existsSync(src)) continue;
    let updated: Buffer;
    try {
      updated = readFileSync(src);
    } catch {
      // An unreadable attempt file has nothing to teach the source.
      continue;
    }
    // Unchanged content is the common case (static API keys); skipping it
    // keeps the operator's source directory from churning on every attempt.
    if (existsSync(dest)) {
      try {
        if (readFileSync(dest).equals(updated)) continue;
      } catch {
        // Unreadable destination: fall through and replace it.
      }
    }
    const staging = `${dest}.gremlyn-${String(process.pid)}-${String(Date.now())}.tmp`;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(staging, updated);
      setOwnerOnlyPermissions(staging);
      renameSync(staging, dest);
      rotated.push(file);
    } catch (error) {
      try {
        rmSync(staging, { force: true });
      } catch {
        // Best effort; a surviving staging file is inert.
      }
      throw new Error(
        `cannot persist rotated credential "${file}" to ${sourceDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return rotated;
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

function setOwnerOnlyPermissions(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }

  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const powershell = systemRoot
    ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  // Read the file's existing descriptor rather than building a fresh
  // FileSecurity and calling SetOwner. A new descriptor marks its OWNER
  // section dirty, so applying it asks Windows to *rewrite the owner* — which
  // a normal user process is refused ("Attempted to perform an unauthorized
  // operation") even for a file it already owns. Get-Acl returns a descriptor
  // whose owner is already correct, leaving only the DACL modified.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = Get-Acl -LiteralPath $env:GREMLYN_ACL_TARGET",
    // Detach inherited rules, then strip what inheritance already copied in,
    // so the surviving grant is the one added below and nothing else.
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRule($existing) }",
    "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')",
    "$acl.SetAccessRule($rule)",
    "[System.IO.File]::SetAccessControl($env:GREMLYN_ACL_TARGET, $acl)",
  ].join("; ");
  const env: Record<string, string> = { GREMLYN_ACL_TARGET: path };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(`cannot restrict credential file ACL ${path}: ${detail}`);
  }
}
