import { join, resolve } from "node:path";
import { AgentVersionError, extractSessionId, extractVersion } from "./cline.js";
import { defaultRunner, type ProcessRunner } from "./launcher.js";
import type { AgentExecutor, AgentResult, AgentRunOptions } from "../types.js";

/**
 * The single OpenCode release whose argv surface design D-opencode was probed
 * against. OpenCode releases often; a bump here should re-run the probe
 * rather than only editing the constant. OpenCode 2 moved workspace selection
 * to the process cwd and reasoning variants into the model id (`#variant`),
 * and its shared server requires `--standalone` to honor per-attempt state.
 * The CLI and paths were checked locally on 2.0.16; transcript export moved
 * to `opencode session export`.
 * @pin-sync 1.18.32 -> 2.0.16 on 2026-09-25; surface verified via opencode run --help, opencode debug paths, opencode session export --help.
 */
export const EXPECTED_OPENCODE_VERSION = "2.0.16";

/**
 * Real OpenCode CLI executor over the probed non-interactive argv surface:
 *
 *   run --standalone -m <provider/model[#variant]> --format json --auto --thinking <prompt>
 *
 * `provider` has no OpenCode argument — it is folded into the `provider/model`
 * form of `-m`, so it is accepted on the common payload and ignored here. The
 * subprocess cwd selects the workspace; `--standalone` makes the attempt's
 * XDG directories authoritative instead of connecting to the user's shared
 * server; reasoning effort is the optional `#variant` suffix in the model.
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
   * paths` (probed against 1.18.27, re-verified on 1.18.29) put `auth.json` and `opencode.db` under
   * data and `locks/` under state; missing `locks/` would be the same class
   * of concurrency defect the credential-isolation change already fixed once.
   */
  additionalEnvironment(dataDir: string): Record<string, string> {
    // Absolute, for the same reason Cline's --data-dir is: Gremlyn creates and
    // seeds the attempt directory from its own process cwd, while the agent
    // runs with the workspace as cwd. A relative XDG_DATA_HOME would resolve
    // against the workspace instead, so OpenCode would write its session
    // database inside the repository it is editing — committed wholesale by
    // the publish step — and would look for the seeded auth.json somewhere it
    // was never written.
    const attempt = resolve(dataDir);
    return {
      XDG_DATA_HOME: join(attempt, "xdg-data"),
      XDG_STATE_HOME: join(attempt, "xdg-state"),
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
    const modelId = opts.model.split("#", 1)[0] ?? opts.model;
    const model = opts.effort === "none" ? modelId : `${modelId}#${opts.effort}`;
    const args = [
      "run",
      "--standalone",
      "-m",
      model,
      "--format",
      "json",
      "--auto",
      "--thinking",
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
