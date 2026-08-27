import { execa } from "execa";
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

const defaultRunner: ProcessRunner = async (binary, args, options) => {
  const result = await execa(binary, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    extendEnv: false,
    shell: false,
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
      opts.prompt,
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
      opts.dataDir,
      "--auto-approve",
      "true",
      "--retries",
      String(opts.retries),
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

function extractVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/u)?.[0];
}

function extractSessionId(output: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const id = value.sessionId ?? value.session_id;
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      // Non-JSON output is still retained verbatim; it simply has no session id.
    }
  }
  return undefined;
}
