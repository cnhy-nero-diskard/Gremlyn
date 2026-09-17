import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CONSOLE_SESSION_COOKIE = "gremlyn_console_session";
export const CONSOLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface ConsoleSessionRecord {
  readonly digest: string;
  readonly expiresAt: number;
}

export interface ConsoleSessionStoreOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export type SessionLookup = "active" | "expired" | "absent";

export interface CreatedConsoleSession {
  readonly handle: string;
  readonly expiresAt: number;
}

/**
 * A process-local opaque browser-session store.
 *
 * Only the SHA-256 digest and absolute expiry are retained. The raw handle is
 * returned once to the route so it can be placed in an HttpOnly cookie, but it
 * is never kept in this store and no configured credential is involved.
 */
export class ConsoleSessionStore {
  private readonly records = new Map<string, ConsoleSessionRecord>();
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;

  constructor(options: ConsoleSessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? ((size) => randomBytes(size));
  }

  create(): CreatedConsoleSession {
    this.prune();
    const handle = Buffer.from(this.random(32)).toString("base64url");
    const expiresAt = this.now() + CONSOLE_SESSION_TTL_MS;
    const digest = digestSessionHandle(handle);
    this.records.set(digest, { digest, expiresAt });
    return { handle, expiresAt };
  }

  lookup(handle: string | undefined): SessionLookup {
    if (!handle) return "absent";
    const digest = digestSessionHandle(handle);
    const record = this.records.get(digest);
    const now = this.now();
    const result: SessionLookup =
      record === undefined ? "absent" : record.expiresAt <= now ? "expired" : "active";
    this.prune(now);
    if (result === "expired") {
      this.records.delete(digest);
    }
    return result;
  }

  validate(handle: string | undefined): boolean {
    return this.lookup(handle) === "active";
  }

  revoke(handle: string | undefined): boolean {
    this.prune();
    if (!handle) return false;
    return this.records.delete(digestSessionHandle(handle));
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    this.prune();
    return this.records.size;
  }

  /** A redacted diagnostic view useful to deterministic tests and shutdown checks. */
  snapshot(): readonly ConsoleSessionRecord[] {
    this.prune();
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  private prune(now = this.now()): void {
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(digest);
    }
  }
}

export function digestSessionHandle(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex");
}

/** Compare credential text without an early-exit value comparison. */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const size = Math.max(leftBytes.length, rightBytes.length);
  const paddedLeft = Buffer.alloc(size);
  const paddedRight = Buffer.alloc(size);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBytes.length === rightBytes.length;
}
