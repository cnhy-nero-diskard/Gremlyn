import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
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
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch (err) {
      throw new InstanceLockError(
        `another Gremlyn instance is already using data directory ${dataDir}: ${errorMessage(err)}`,
      );
    }
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    return new DataDirectoryLock(path, descriptor);
  }

  release(): void {
    if (this.released) return;
    closeSync(this.descriptor);
    unlinkSync(this.path);
    this.released = true;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
