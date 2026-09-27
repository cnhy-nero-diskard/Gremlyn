import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export interface InstanceLockClaim {
  pid: number;
  claimedAtMs?: number;
}

export interface DataDirectoryLockInspection {
  path: string;
  exists: boolean;
  owner?: InstanceLockClaim;
  ownerAlive: boolean;
}

/** Parse the current claim format, rejecting legacy and malformed contents. */
export function parseLockClaim(contents: string): InstanceLockClaim | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { pid?: unknown }).pid !== "number" ||
      !Number.isSafeInteger((value as { pid: number }).pid) ||
      (value as { pid: number }).pid < 1
    ) {
      return undefined;
    }
    const claimedAtMs = (value as { claimedAtMs?: unknown }).claimedAtMs;
    if (
      claimedAtMs !== undefined &&
      (typeof claimedAtMs !== "number" || !Number.isSafeInteger(claimedAtMs) || claimedAtMs < 0)
    ) {
      return undefined;
    }
    return {
      pid: (value as { pid: number }).pid,
      ...(claimedAtMs === undefined ? {} : { claimedAtMs }),
    };
  } catch {
    return undefined;
  }
}

export function dataDirectoryLockPath(dataDir: string): string {
  return join(dataDir, ".gremlyn.lock");
}

/** Inspect a claim without opening the data directory or database. */
export function inspectDataDirectoryLock(dataDir: string): DataDirectoryLockInspection {
  const path = dataDirectoryLockPath(dataDir);
  try {
    const owner = parseLockClaim(readFileSync(path, "utf8"));
    return {
      path,
      exists: true,
      ...(owner === undefined ? {} : { owner }),
      ownerAlive: owner !== undefined && isDataDirectoryLockOwnerAlive(owner, path),
    };
  } catch (error) {
    if (isMissingError(error)) return { path, exists: false, ownerAlive: false };
    return { path, exists: true, ownerAlive: false };
  }
}

/** Remove a claim without starting an orchestrator. */
export function removeDataDirectoryLockClaim(dataDir: string): boolean {
  try {
    unlinkSync(dataDirectoryLockPath(dataDir));
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

/** Exclusive process marker for the configured data directory. */
export class DataDirectoryLock {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly descriptor: number,
  ) {}

  static acquire(dataDir: string): DataDirectoryLock {
    mkdirSync(dataDir, { recursive: true });
    const path = dataDirectoryLockPath(dataDir);
    for (;;) {
      let descriptor: number;
      try {
        descriptor = openSync(path, "wx");
      } catch (err) {
        if (!isAlreadyExistsError(err)) {
          throw new InstanceLockError(
            `could not claim data directory ${dataDir}: ${errorMessage(err)}`,
          );
        }

        const owner = readLockOwner(path);
        if (owner !== undefined && isDataDirectoryLockOwnerAlive(owner, path)) {
          throw new InstanceLockError(
            `another Gremlyn instance is already using data directory ${dataDir} (pid ${owner.pid})`,
          );
        }

        report(
          "reclaiming abandoned Gremlyn data directory claim",
          owner === undefined ? { path, reason: "unparseable-owner" } : { path, pid: owner.pid },
        );
        try {
          unlinkSync(path);
        } catch (reclaimError) {
          throw new InstanceLockError(
            `could not reclaim abandoned data directory claim ${path}: ${errorMessage(reclaimError)}`,
          );
        }
        continue;
      }
      writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, claimedAtMs: Date.now() })}\n`,
        "utf8",
      );
      return new DataDirectoryLock(path, descriptor);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      closeSync(this.descriptor);
    } catch (error) {
      report("failed to close Gremlyn data directory claim", {
        path: this.path,
        error: errorMessage(error),
      });
    }
    try {
      unlinkSync(this.path);
    } catch (error) {
      if (!isMissingError(error)) {
        report("failed to remove Gremlyn data directory claim", {
          path: this.path,
          error: errorMessage(error),
        });
      }
    }
  }
}

function readLockOwner(path: string): InstanceLockClaim | undefined {
  try {
    return parseLockClaim(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function isLockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A PID from an interrupted run may already belong to an unrelated live process. */
function isDataDirectoryLockOwnerAlive(owner: InstanceLockClaim, path: string): boolean {
  if (!isLockOwnerAlive(owner.pid)) return false;
  try {
    const claimedAtMs = owner.claimedAtMs ?? statSync(path).mtimeMs;
    const startedAtMs = processStartTimeMs(owner.pid);
    // Allow timestamp rounding, but reject a PID now belonging to a newer process.
    if (startedAtMs !== undefined && startedAtMs > claimedAtMs + 2_000) return false;
    // Windows Fast Startup can preserve uptime, so the process check above is
    // essential there. The boot check also covers other hosts and query failures.
    if (claimedAtMs < currentBootTimeMs() - 30_000) return false;
  } catch {
    // If the file cannot be inspected, retain the live-PID protection.
  }
  return true;
}

function processStartTimeMs(pid: number): number | undefined {
  if (pid === process.pid) return Date.now() - process.uptime() * 1_000;
  if (process.platform !== "win32") return undefined;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ],
    { encoding: "utf8", timeout: 3_000, windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  const startedAtMs = Date.parse(result.stdout.trim());
  return Number.isNaN(startedAtMs) ? undefined : startedAtMs;
}

function currentBootTimeMs(): number {
  return Date.now() - uptime() * 1_000;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function report(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), level: "warn", event, ...fields })}\n`,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
