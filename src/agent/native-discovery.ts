/**
 * Bounded, repository-scoped native agent discovery (tasks 1.3-1.4; design D3;
 * capability `opencode-agent-selection`).
 *
 * Two distinct operations share one effective-inventory reader:
 *
 * - {@link discoverNativeAgents} is *advisory* source-context discovery for the
 *   console picker. It reads the configured worker's effective inventory and
 *   caches only safe projected metadata briefly, keyed by repository and worker
 *   context. {@link discoverNativeAgents} with `refresh: true` bypasses the
 *   cache.
 * - {@link preflightNativeAgent} is the *authorization* check. It runs in the
 *   actual prepared attempt workspace with the same worker execution will use,
 *   never reads the cache, and confirms the captured native id is an eligible
 *   primary before any agent work starts. A choice discovered in the source
 *   checkout is never reused to authorize a different workspace.
 *
 * Fail-closed semantics keep three states apart:
 *
 * - a successful inventory with eligible agents is `ready`;
 * - a successful inventory with records but no eligible primary is `empty`;
 * - a cold inventory that never produces any record within the bound is
 *   `pending`, not an empty success and not a transport error;
 * - a transport/parse failure is `failed` with an actionable reason.
 *
 * Every wait is bounded and abortable, and each underlying CLI call carries its
 * own timeout so one wedged probe cannot consume the whole budget.
 */

import { resolve } from "node:path";
import {
  eligibleNativeAgentChoices,
  isBoundedNativeAgentId,
  readBoundedAgentInventory,
  readCliAgentInventory,
  sameInventoryDirectory,
  type AgentInventoryReader,
  type NativeAgentChoice,
} from "./agent-inventory.js";
import type { ProcessRunner } from "./launcher.js";
import { workerEnvironmentFingerprint, type OpenCodeWorker } from "./opencode-worker.js";

/** Advisory source-context cache lifetime. */
export const NATIVE_DISCOVERY_CACHE_TTL_MS = 15_000;
/** Overall bound for advisory source-context discovery. */
export const NATIVE_DISCOVERY_BUDGET_MS = 10_000;
/** Overall bound for an attempt-workspace preflight (uncached). */
export const NATIVE_DISCOVERY_PREFLIGHT_BUDGET_MS = 10_000;
/** Wait between inventory polls while a cold location settles. */
export const NATIVE_DISCOVERY_POLL_INTERVAL_MS = 500;
/** Bound on one underlying `debug agents` call. */
export const NATIVE_DISCOVERY_CALL_TIMEOUT_MS = 5_000;

/** One projected inventory read: eligible choices plus the raw record count. */
export interface NativeAgentInventorySnapshot {
  readonly agents: readonly NativeAgentChoice[];
  readonly directory?: string;
  /** How many records the source returned before eligibility filtering. */
  readonly recordCount: number;
}

/**
 * Read one bounded effective-inventory snapshot in a worker's exact context.
 * The default reader is the shared pinned-CLI reader; tests inject their own.
 * The call is bounded even for a reader that ignores its abort signal, and is
 * shortened to any remaining overall `deadline`. Transport/parse failures
 * throw {@link OpenCodeAgentInventoryError}.
 */
export async function readNativeAgentInventory(input: {
  readonly worker: OpenCodeWorker;
  readonly inventory?: AgentInventoryReader;
  readonly timeoutMs?: number;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
}): Promise<NativeAgentInventorySnapshot> {
  const reader = input.inventory ?? readCliAgentInventory;
  const timeoutMs = input.timeoutMs ?? NATIVE_DISCOVERY_CALL_TIMEOUT_MS;
  const inventory = await readBoundedAgentInventory({
    inventory: reader,
    binary: input.worker.binary,
    cwd: input.worker.cwd,
    env: input.worker.env,
    runner: input.worker.runner,
    timeoutMs,
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return {
    agents: eligibleNativeAgentChoices(inventory),
    ...(inventory.directory === undefined ? {} : { directory: inventory.directory }),
    recordCount: inventory.records.length,
  };
}

/** Safe metadata stored in the advisory cache; never permissions or prompts. */
export interface NativeDiscoveryCacheValue {
  readonly agents: readonly NativeAgentChoice[];
  readonly directory?: string;
  readonly recordCount: number;
}

/** A cache entry with the time it was stored, used for TTL expiry. */
export interface NativeDiscoveryCacheEntry extends NativeDiscoveryCacheValue {
  readonly storedAt: number;
}

export interface NativeAgentDiscoveryCacheOptions {
  readonly ttlMs?: number;
  /** Injected clock for deterministic expiry tests. */
  readonly now?: () => number;
}

/**
 * A small advisory cache of projected source-context discovery. Entries expire
 * after {@link NATIVE_DISCOVERY_CACHE_TTL_MS}; authorization never reads it.
 */
export class NativeAgentDiscoveryCache {
  private readonly entries = new Map<string, NativeDiscoveryCacheEntry>();

  constructor(private readonly options: NativeAgentDiscoveryCacheOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get ttlMs(): number {
    return this.options.ttlMs ?? NATIVE_DISCOVERY_CACHE_TTL_MS;
  }

  get(key: string): NativeDiscoveryCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: NativeDiscoveryCacheValue): void {
    this.entries.set(key, { ...value, storedAt: this.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The process-wide advisory cache used by the console discovery route. */
export const nativeAgentDiscoveryCache = new NativeAgentDiscoveryCache();

/**
 * The cache key: repository plus the worker context that selects an
 * installation (executor alias, binary, pinned version, resolved cwd and
 * environment-root fingerprint). Two repositories never share an entry.
 */
export function nativeDiscoveryCacheKey(repositoryId: string, worker: OpenCodeWorker): string {
  return JSON.stringify([
    repositoryId,
    worker.executorId,
    worker.binary,
    worker.version,
    resolve(worker.cwd),
    workerEnvironmentFingerprint(worker),
  ]);
}

/** A resolved advisory discovery result. */
export interface NativeDiscoveryReady {
  readonly status: "ready";
  readonly agents: readonly NativeAgentChoice[];
  readonly directory?: string;
  readonly recordCount: number;
  readonly polls: number;
  readonly fromCache: boolean;
}

/** A successful inventory that contained records but no eligible primary. */
export interface NativeDiscoveryEmpty {
  readonly status: "empty";
  readonly agents: readonly NativeAgentChoice[];
  readonly directory?: string;
  readonly recordCount: number;
  readonly polls: number;
  readonly fromCache: boolean;
}

/** A cold location that produced no records at all within the bound. */
export interface NativeDiscoveryPending {
  readonly status: "pending";
  readonly polls: number;
  readonly recordCount: 0;
}

/** The inventory source could not be read. */
export interface NativeDiscoveryFailed {
  readonly status: "failed";
  readonly reason: string;
  readonly polls: number;
}

export type NativeDiscoveryOutcome =
  NativeDiscoveryReady | NativeDiscoveryEmpty | NativeDiscoveryPending | NativeDiscoveryFailed;

export interface DiscoverNativeAgentsInput {
  readonly worker: OpenCodeWorker;
  /** The repository the discovery is scoped to; part of the cache key. */
  readonly repositoryId: string;
  /** Advisory cache; omit for an uncached read. */
  readonly cache?: NativeAgentDiscoveryCache;
  /** Bypass any cache entry and repopulate it. */
  readonly refresh?: boolean;
  /** Injected inventory reader (tests). */
  readonly inventory?: AgentInventoryReader;
  readonly signal?: AbortSignal;
  readonly budgetMs?: number;
  readonly pollIntervalMs?: number;
  readonly callTimeoutMs?: number;
}

function resolvedDirectoryFields(directory: string | undefined): { directory?: string } {
  return directory === undefined ? {} : { directory };
}

/** A safe reason a reported inventory directory is not the expected location. */
function wrongDirectoryReason(expectedCwd: string, reported: string): string {
  return (
    `the agent inventory was computed for ${reported}, ` +
    `not the expected directory ${expectedCwd}`
  );
}

/**
 * Discover eligible native primary agents for a repository's configured worker.
 * Advisory and bounded: a live cached entry is returned when `refresh` is not
 * set; otherwise the inventory is polled until it produces at least one record,
 * the bound expires (`pending`), or the source fails. An inventory computed for
 * a different directory fails closed *before* it is cached or returned, and a
 * cached entry is re-verified against the worker cwd before use.
 */
export async function discoverNativeAgents(
  input: DiscoverNativeAgentsInput,
): Promise<NativeDiscoveryOutcome> {
  const cache = input.cache;
  const key = nativeDiscoveryCacheKey(input.repositoryId, input.worker);
  const cached = input.refresh === true ? undefined : cache?.get(key);
  if (cached !== undefined) {
    if (
      cached.directory !== undefined &&
      !sameInventoryDirectory(cached.directory, input.worker.cwd)
    ) {
      cache?.delete(key);
      return {
        status: "failed",
        reason: wrongDirectoryReason(input.worker.cwd, cached.directory),
        polls: 0,
      };
    }
    return {
      status: cached.agents.length > 0 ? "ready" : "empty",
      agents: cached.agents,
      ...resolvedDirectoryFields(cached.directory),
      recordCount: cached.recordCount,
      polls: 0,
      fromCache: true,
    };
  }

  const budget = input.budgetMs ?? NATIVE_DISCOVERY_BUDGET_MS;
  const interval = input.pollIntervalMs ?? NATIVE_DISCOVERY_POLL_INTERVAL_MS;
  const callTimeout = input.callTimeoutMs ?? NATIVE_DISCOVERY_CALL_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  let polls = 0;

  for (;;) {
    if (input.signal?.aborted) {
      return { status: "failed", reason: "native agent discovery was cancelled", polls };
    }
    if (Date.now() >= deadline) {
      return { status: "pending", polls, recordCount: 0 };
    }
    polls += 1;
    let snapshot: NativeAgentInventorySnapshot;
    try {
      snapshot = await readNativeAgentInventory({
        worker: input.worker,
        ...(input.inventory === undefined ? {} : { inventory: input.inventory }),
        timeoutMs: callTimeout,
        deadline,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      return {
        status: "failed",
        reason: safeInventoryFailure(error),
        polls,
      };
    }

    // A wrong-context inventory is never cached and never treated as a result.
    if (
      snapshot.directory !== undefined &&
      !sameInventoryDirectory(snapshot.directory, input.worker.cwd)
    ) {
      return {
        status: "failed",
        reason: wrongDirectoryReason(input.worker.cwd, snapshot.directory),
        polls,
      };
    }

    if (snapshot.recordCount > 0) {
      cache?.set(key, {
        agents: snapshot.agents,
        ...resolvedDirectoryFields(snapshot.directory),
        recordCount: snapshot.recordCount,
      });
      return {
        status: snapshot.agents.length > 0 ? "ready" : "empty",
        agents: snapshot.agents,
        ...resolvedDirectoryFields(snapshot.directory),
        recordCount: snapshot.recordCount,
        polls,
        fromCache: false,
      };
    }

    if (Date.now() >= deadline) {
      return { status: "pending", polls, recordCount: 0 };
    }
    const sleepMs = Math.min(interval, Math.max(0, deadline - Date.now()));
    if (!(await delay(sleepMs, input.signal))) {
      return { status: "failed", reason: "native agent discovery was cancelled", polls };
    }
  }
}

/** The selected native agent is eligible in the attempt workspace. */
export interface PreflightNativeAgentOk {
  readonly status: "ok";
  readonly agent: NativeAgentChoice;
  readonly polls: number;
  readonly directory?: string;
}

/** The identifier itself is malformed, before any CLI call. */
export interface PreflightNativeAgentInvalid {
  readonly status: "invalid";
  readonly reason: string;
}

/** The identifier is well-formed but not an eligible primary in the workspace. */
export interface PreflightNativeAgentIneligible {
  readonly status: "ineligible";
  readonly reason: string;
  readonly polls: number;
  readonly available: readonly string[];
}

/** No inventory appeared within the bound (cold location never converged). */
export interface PreflightNativeAgentPending {
  readonly status: "pending";
  readonly reason: string;
  readonly polls: number;
}

/** The inventory source failed, the context mismatched, or preflight aborted. */
export interface PreflightNativeAgentFailed {
  readonly status: "failed";
  readonly reason: string;
  readonly polls: number;
}

export type PreflightNativeAgentOutcome =
  | PreflightNativeAgentOk
  | PreflightNativeAgentInvalid
  | PreflightNativeAgentIneligible
  | PreflightNativeAgentPending
  | PreflightNativeAgentFailed;

export interface PreflightNativeAgentInput {
  /**
   * The worker resolved for the *prepared attempt workspace* exactly as
   * execution will use it. Its `cwd` is the workspace being authorized.
   */
  readonly worker: OpenCodeWorker;
  /** The captured native id to validate. */
  readonly agentId: string;
  /** Injected inventory reader (tests). */
  readonly inventory?: AgentInventoryReader;
  readonly signal?: AbortSignal;
  readonly budgetMs?: number;
  readonly pollIntervalMs?: number;
  readonly callTimeoutMs?: number;
}

/**
 * Authorize a captured native agent id in the prepared attempt workspace,
 * before any agent work. Never reads the advisory cache. Fails closed with a
 * configuration reason for a malformed id, an absent/ineligible id, a
 * wrong-context inventory, a cold location that never converges, or an aborted
 * signal — and never substitutes another agent.
 */
export async function preflightNativeAgent(
  input: PreflightNativeAgentInput,
): Promise<PreflightNativeAgentOutcome> {
  if (!isBoundedNativeAgentId(input.agentId)) {
    return {
      status: "invalid",
      reason:
        `native agent id ${JSON.stringify(input.agentId)} is not a bounded identifier: ` +
        "use a non-empty value without control characters or a leading dash",
    };
  }

  const budget = input.budgetMs ?? NATIVE_DISCOVERY_PREFLIGHT_BUDGET_MS;
  const interval = input.pollIntervalMs ?? NATIVE_DISCOVERY_POLL_INTERVAL_MS;
  const callTimeout = input.callTimeoutMs ?? NATIVE_DISCOVERY_CALL_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  let polls = 0;
  let sawRecords = false;
  let available: readonly string[] = [];

  for (;;) {
    if (input.signal?.aborted) {
      return { status: "failed", reason: "native agent preflight was cancelled", polls };
    }
    if (Date.now() >= deadline) {
      return sawRecords ? ineligibleOutcome() : pendingOutcome();
    }
    polls += 1;
    let snapshot: NativeAgentInventorySnapshot;
    try {
      snapshot = await readNativeAgentInventory({
        worker: input.worker,
        ...(input.inventory === undefined ? {} : { inventory: input.inventory }),
        timeoutMs: callTimeout,
        deadline,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      return {
        status: "failed",
        reason: safeInventoryFailure(error),
        polls,
      };
    }

    if (snapshot.recordCount > 0) sawRecords = true;
    if (
      snapshot.directory !== undefined &&
      !sameInventoryDirectory(snapshot.directory, input.worker.cwd)
    ) {
      return {
        status: "failed",
        reason: wrongDirectoryReason(input.worker.cwd, snapshot.directory),
        polls,
      };
    }

    const match = snapshot.agents.find((agent) => agent.id === input.agentId);
    if (match !== undefined) {
      return {
        status: "ok",
        agent: match,
        polls,
        ...resolvedDirectoryFields(snapshot.directory),
      };
    }
    available = snapshot.agents.map((agent) => agent.id);

    if (Date.now() >= deadline) {
      return sawRecords ? ineligibleOutcome() : pendingOutcome();
    }
    const sleepMs = Math.min(interval, Math.max(0, deadline - Date.now()));
    if (!(await delay(sleepMs, input.signal))) {
      return { status: "failed", reason: "native agent preflight was cancelled", polls };
    }
  }

  function pendingOutcome(): PreflightNativeAgentPending {
    return {
      status: "pending",
      reason:
        `no effective agent inventory appeared for ${input.worker.cwd} ` +
        "within the bounded discovery wait",
      polls,
    };
  }

  function ineligibleOutcome(): PreflightNativeAgentIneligible {
    return {
      status: "ineligible",
      reason:
        `native agent ${input.agentId} is not an eligible primary in ` +
        `${input.worker.cwd}; eligible agents: ${available.length > 0 ? available.join(", ") : "(none)"}`,
      polls,
      available,
    };
  }
}

/** Raw CLI stderr or reader errors may quote private configuration. Never project them. */
function safeInventoryFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/cancelled|aborted/iu.test(message)) return "native agent inventory read was cancelled";
  if (/timed out/iu.test(message))
    return "native agent inventory read timed out; retry refresh and check the pinned worker context";
  return "native agent inventory source unavailable; check the pinned CLI binary, authentication, and repository execution context";
}

/** Wait `ms`, resolving `false` immediately when the signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reexport the runner type so transport callers can name the worker's runner. */
export type { ProcessRunner };
