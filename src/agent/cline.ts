import { execa } from "execa";
import { resolve } from "node:path";
import type { AgentExecutor, AgentResult, AgentRunOptions } from "../types.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  timedOut: boolean;
  isCanceled: boolean;
}

export type ProcessRunner = (
  binary: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) => Promise<ProcessResult>;

export const defaultRunner: ProcessRunner = async (binary, args, options) => {
  const result = await execa(binary, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    extendEnv: false,
    shell: false,
    // Reads must hit EOF immediately. execa's default is an open pipe that is
    // never written to, so an agent that prompts for input would block until
    // the timeout instead of failing fast.
    stdin: "ignore",
    reject: false,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    isCanceled: result.isCanceled,
  };
};

/** The single Cline release whose argv surface design D10 was probed against. */
export const EXPECTED_CLINE_VERSION = "3.0.60";

export class AgentVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentVersionError";
  }
}

/** Real Cline CLI executor over the probed non-interactive argv surface. */
export class ClineExecutor implements AgentExecutor {
  readonly id = "cline";

  constructor(
    private readonly binary = "cline",
    private readonly runProcess: ProcessRunner = defaultRunner,
  ) {}

  async checkVersion(expectedVersion: string, env: Record<string, string>): Promise<void> {
    const result = await this.runProcess(this.binary, ["--version"], { env });
    if (result.exitCode !== 0) {
      throw new AgentVersionError(
        `cannot execute ${this.binary} --version: ${result.stderr || `exit ${String(result.exitCode)}`}`,
      );
    }
    const actual = extractVersion(result.stdout);
    if (actual !== expectedVersion) {
      throw new AgentVersionError(
        `unsupported Cline version ${actual ?? "unknown"}; expected ${expectedVersion}`,
      );
    }
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const args = [
      "-c",
      opts.cwd,
      "-m",
      opts.model,
      "-P",
      opts.provider,
      "--json",
      "-t",
      String(opts.timeoutSec),
      "--thinking",
      opts.effort,
      "--data-dir",
      // Cline resolves relative paths from opts.cwd, while Gremlyn seeds the
      // directory from its own process cwd. Pass an absolute path so both
      // processes refer to the same credential-seeded attempt directory.
      resolve(opts.dataDir),
      "--auto-approve",
      "true",
      "--retries",
      String(opts.retries),
      "--",
      opts.prompt,
    ];
    const result = await this.runProcess(this.binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutSec * 1_000,
      signal: opts.signal,
    });
    const sessionId = extractSessionId(result.stdout);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
      ...(sessionId === undefined ? {} : { sessionId }),
      startedAt,
      endedAt: new Date().toISOString(),
      timedOut: result.timedOut,
    };
  }
}

export function extractVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/u)?.[0];
}

/**
 * The correlation id Cline actually emits on its `--json` stream.
 *
 * Verified against cline 3.0.60: the stream carries `taskId` ("conv_<n>_<rand>")
 * and `agentId` ("agent_<n>_<rand>") on hook events. It does NOT carry
 * `sessionId` in any form. Note that `cline history export <sessionId>` takes a
 * *different* identifier shape ("<epoch>_<rand>") recorded in the data dir's
 * session history, so this id correlates attempts to stream output but is not
 * yet an export handle.
 */
export function extractSessionId(output: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      const id = value.taskId ?? value.sessionId ?? value.session_id;
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      // Non-JSON output is still retained verbatim; it simply has no id.
    }
  }
  return undefined;
}

/**
 * Effort tiers the model advertised on its `run_result` metadata.
 *
 * Cline validates reasoning effort per *model*, not per agent: a model may
 * accept only a subset of the CLI's tiers (deepseek-v4-flash advertises
 * `["high","xhigh"]`). An unsupported tier is accepted silently, so the only
 * signal is this metadata. Returns undefined when the model advertised nothing.
 */
export function extractSupportedEfforts(output: string): string[] | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as {
        type?: unknown;
        model?: { info?: { reasoningOptions?: unknown } };
      };
      if (value.type !== "run_result") continue;
      const options = value.model?.info?.reasoningOptions;
      if (!Array.isArray(options)) continue;
      for (const option of options) {
        const entry = option as { type?: unknown; values?: unknown };
        if (entry.type !== "effort" || !Array.isArray(entry.values)) continue;
        const values = entry.values.filter((v): v is string => typeof v === "string");
        if (values.length > 0) return values;
      }
    } catch {
      // A malformed line simply carries no metadata.
    }
  }
  return undefined;
}
