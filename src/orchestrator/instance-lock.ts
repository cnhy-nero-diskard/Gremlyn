import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export interface InstanceLockClaim {
  pid: number;
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
    return { pid: (value as { pid: number }).pid };
  } catch {
    return undefined;
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
    const path = join(dataDir, ".gremlyn.lock");
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
        if (owner !== undefined && isProcessAlive(owner.pid)) {
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
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
