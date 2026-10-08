/**
 * The alias-aware OpenCode worker descriptor (task 1.3; design D3).
 *
 * Gremlyn can register more than one OpenCode installation under distinct
 * executor aliases (each with its own `binary` and credential roots). Every
 * operation that talks to OpenCode — effective-inventory discovery, the agent
 * run, session reads, interruption and recovery — must use the *one* context
 * the repository's configured executor alias actually resolves to. If a probe
 * drifted to the default `opencode` binary while a run used another
 * installation, the preflight could authorize a choice the run never loads.
 *
 * {@link resolveOpenCodeWorker} resolves that exact context once into an
 * immutable descriptor: the executor alias id, binary, pinned version, cwd and
 * the environment the caller resolved. The environment is preserved exactly as
 * supplied — the caller is responsible for passing `buildAgentEnvironment(...)`
 * (or an equivalent allowlisted environment); this module neither adds nor
 * removes keys, so probes and runs see the same context. It carries no
 * credential values of its own.
 *
 * The descriptor is deliberately a plain value so execution, discovery and
 * session transport share it instead of each re-deriving binary/cwd/env and
 * drifting apart.
 */

import { hasControlCharacters } from "./agent-inventory.js";
import { defaultRunner, type ProcessRunner } from "./launcher.js";
import { EXPECTED_OPENCODE_VERSION } from "./opencode.js";

/** A bounded, non-empty process label safe to carry into a subprocess argv. */
function assertWorkerIdentity(label: string, value: string): void {
  if (value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  if (value.startsWith("-") || hasControlCharacters(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} is not a safe process label`);
  }
}

/** One resolved OpenCode execution context, shared by every OpenCode surface. */
export interface OpenCodeWorker {
  /** The configured executor alias id this context belongs to. */
  readonly executorId: string;
  /** The exact binary to invoke (never a silent fallback to `opencode`). */
  readonly binary: string;
  /** The pinned release this invocation surface was probed against. */
  readonly version: string;
  /** The working directory the CLI runs in (source checkout or attempt workspace). */
  readonly cwd: string;
  /**
   * The exact environment the CLI receives, copied verbatim from the caller's
   * resolved environment (pass `buildAgentEnvironment(...)`). No key is added,
   * removed or rewritten here.
   */
  readonly env: Record<string, string>;
  /** The process launcher; injected in tests, the common launcher in production. */
  readonly runner: ProcessRunner;
}

export interface ResolveOpenCodeWorkerInput {
  /** The configured executor alias id (a config `agents` key). */
  readonly executorId: string;
  /**
   * The alias's configured binary. Defaults to the alias id, matching the
   * config loader's "id is the binary when `binary` is omitted" convention.
   */
  readonly binary?: string;
  /** The repository/workspace directory the CLI runs in. */
  readonly cwd: string;
  /**
   * The exact environment execution will receive. Pass
   * `buildAgentEnvironment(...)` output; this descriptor preserves it verbatim.
   */
  readonly env: Record<string, string>;
  /** Injected process launcher (tests). Defaults to the common launcher. */
  readonly runner?: ProcessRunner;
}

/**
 * Resolve the one OpenCode worker context for an executor alias. Pure and
 * synchronous: it pins the version, defaults the binary to the alias id, copies
 * and freezes the environment, and refuses an unsafe alias/binary/cwd label.
 * It does not run the CLI; `checkVersion` remains the executor's startup gate.
 */
export function resolveOpenCodeWorker(input: ResolveOpenCodeWorkerInput): OpenCodeWorker {
  assertWorkerIdentity("executorId", input.executorId);
  const binary = input.binary ?? input.executorId;
  assertWorkerIdentity("binary", binary);
  assertWorkerIdentity("cwd", input.cwd);
  return Object.freeze({
    executorId: input.executorId,
    binary,
    version: EXPECTED_OPENCODE_VERSION,
    cwd: input.cwd,
    env: Object.freeze({ ...input.env }),
    runner: input.runner ?? defaultRunner,
  });
}

/** One environment root whose value contributes to a worker's context. */
const WORKER_ENV_ROOT_KEYS = [
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "HOME",
  "USERPROFILE",
] as const;

/**
 * A stable fingerprint of the environment roots that select an OpenCode
 * installation's data/state/config/cache. Used internally to key discovery
 * cache entries; it is not for display and is never sent to a browser.
 */
export function workerEnvironmentFingerprint(worker: OpenCodeWorker): string {
  return WORKER_ENV_ROOT_KEYS.map((key) => `${key}=${worker.env[key] ?? ""}`).join("|");
}

/** Run one command through a worker's exact binary/cwd/env/runner. */
export async function runOpenCodeWorker(
  worker: OpenCodeWorker,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
) {
  return worker.runner(worker.binary, args, {
    cwd: worker.cwd,
    env: worker.env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
