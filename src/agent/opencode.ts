import { join } from "node:path";
import { AgentVersionError, extractSessionId, extractVersion } from "./cline.js";
import { defaultRunner, type ProcessRunner } from "./launcher.js";
import type { AgentExecutor, AgentResult, AgentRunOptions } from "../types.js";

/**
 * The single OpenCode release whose argv surface design D-opencode was probed
 * against. OpenCode releases often; a bump here should re-run the probe
 * rather than only editing the constant.
 */
export const EXPECTED_OPENCODE_VERSION = "1.18.27";

/**
 * Real OpenCode CLI executor over the probed non-interactive argv surface:
 *
 *   run --dir <cwd> -m <model> --format json --auto --thinking [--variant <effort>] <prompt>
 *
 * `provider` has no OpenCode argument — it is folded into the `provider/model`
 * form of `-m`, so it is accepted on the common payload and ignored here.
 * `retries` and `timeoutSec` have no OpenCode flag either: `timeoutSec` is
 * already enforced by the process timeout in `defaultRunner`, and `retries` is
 * bounded by the orchestrator itself (see `honorsRetries`).
 */
export class OpenCodeExecutor implements AgentExecutor {
  readonly id = "opencode";
  /** OpenCode has no retry flag; the orchestrator bounds whole invocations instead. */
  readonly honorsRetries = false;

  constructor(
    private readonly binary = "opencode",
    private readonly runProcess: ProcessRunner = defaultRunner,
  ) {}

  /**
   * Relocate the state OpenCode's own CLI mutates per attempt — sessions,
   * credentials, and locks — while leaving the operator's shared cache and
   * config (`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`) inherited. `opencode debug
   * paths` (probed against 1.18.27) put `auth.json` and `opencode.db` under
   * data and `locks/` under state; missing `locks/` would be the same class
   * of concurrency defect the credential-isolation change already fixed once.
   */
  additionalEnvironment(dataDir: string): Record<string, string> {
    return {
      XDG_DATA_HOME: join(dataDir, "xdg-data"),
      XDG_STATE_HOME: join(dataDir, "xdg-state"),
    };
  }

  async checkVersion(env: Record<string, string>): Promise<void> {
    const result = await this.runProcess(this.binary, ["--version"], { env });
    if (result.exitCode !== 0) {
      throw new AgentVersionError(
        `cannot execute ${this.binary} --version: ${result.stderr || `exit ${String(result.exitCode)}`}`,
      );
    }
    const actual = extractVersion(result.stdout);
    if (actual !== EXPECTED_OPENCODE_VERSION) {
      throw new AgentVersionError(
        `unsupported OpenCode version ${actual ?? "unknown"}; expected ${EXPECTED_OPENCODE_VERSION}`,
      );
    }
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const hasTimeout = opts.timeoutSec !== undefined && opts.timeoutSec > 0;
    const args = [
      "run",
      "--dir",
      opts.cwd,
      "-m",
      opts.model,
      "--format",
      "json",
      "--auto",
      "--thinking",
      // OpenCode accepts any --variant value silently (verified: an unknown
      // tier exits 0 rather than being rejected), so "none" — the tier with
      // no OpenCode analogue — is the one case left unpassed, matching a
      // model with no reasoning-variant concept at all.
      ...(opts.effort === "none" ? [] : ["--variant", opts.effort]),
      opts.prompt,
    ];
    const result = await this.runProcess(this.binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      ...(hasTimeout ? { timeoutMs: opts.timeoutSec! * 1_000 } : {}),
      signal: opts.signal,
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
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
