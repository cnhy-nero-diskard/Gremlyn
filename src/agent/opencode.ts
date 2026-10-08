import { basename, dirname, resolve } from "node:path";
import { AgentVersionError, extractSessionId, extractVersion } from "./cline.js";
import { defaultRunner, type ProcessRunner } from "./launcher.js";
import { isOpenCodeAgentRuntimeId } from "./materialize.js";
import { isBoundedNativeAgentId, isGeneratedAttemptAgentId } from "./agent-inventory.js";
import { resolveOpenCodeWorker, type OpenCodeWorker } from "./opencode-worker.js";
import type { AgentExecutor, AgentResult, AgentRunOptions } from "../types.js";

/**
 * The single OpenCode release whose argv surface design D-opencode was probed
 * against. OpenCode releases often; a bump here should re-run the probe
 * rather than only editing the constant. OpenCode 2 moved workspace selection
 * to the process cwd and reasoning variants into the model id (`#variant`).
 * The CLI and paths were checked locally on 2.0.16; transcript export moved
 * to `opencode session export`.
 * @pin-sync 1.18.32 -> 2.0.16 on 2026-09-25; surface verified via opencode run --help, opencode debug paths, opencode session export --help.
 */
export const EXPECTED_OPENCODE_VERSION = "2.0.16";

/**
 * A distinct configuration failure for malformed/conflicting primary intent
 * or a mismatched worker context. Native identifiers and generated managed
 * runtime IDs have separate validation contracts; neither failure can spawn
 * a substitute primary.
 */
export class OpenCodeAgentSelectionError extends Error {
  readonly agentId: string;

  constructor(
    agentId: string,
    reason = "it is not a generated runtime id of the form <namespace>/<id>",
  ) {
    super(
      `Cannot select the captured OpenCode primary agent ${JSON.stringify(agentId)}: ` + reason,
    );
    this.name = "OpenCodeAgentSelectionError";
    this.agentId = agentId;
  }
}

/**
 * Real OpenCode CLI executor over the probed non-interactive argv surface:
 *
 *   run -m <provider/model[#variant]> --format json --auto --thinking <prompt>
 *   run ... --agent <native-id> <prompt>             # native source
 *   run ... --agent <namespace>/<primary> <prompt>   # managed source
 *
 * Explicit intent selects a native or generated managed primary; default
 * intent omits `--agent`. The orchestrator first validates effective inventory
 * in the actual attempt workspace. This executor separately guards argv shape
 * and exact worker context. The legacy `primaryAgentId` option remains generated
 * only, and cannot compete with the discriminated source option.
 * `provider` has no OpenCode argument — it is folded into the `provider/model`
 * form of `-m`, so it is accepted on the common payload and ignored here. The
 * subprocess cwd selects the workspace. OpenCode 2.0.16's private standalone
 * server returned no available models on the configured profile, while the
 * user's service exposed the expected routes, so runs use the configured
 * service and its credential database. Reasoning effort is the optional
 * `#variant` suffix in the model.
 * `retries` and `timeoutSec` have no OpenCode flag either: `timeoutSec` is
 * already enforced by the process timeout in `defaultRunner`, and `retries` is
 * bounded by the orchestrator itself (see `honorsRetries`).
 */
export class OpenCodeExecutor implements AgentExecutor {
  readonly id = "opencode";
  readonly usesSharedCredentials = true;
  /** OpenCode has no retry flag; the orchestrator bounds whole invocations instead. */
  readonly honorsRetries = false;

  constructor(
    private readonly binary = "opencode",
    private readonly runProcess: ProcessRunner = defaultRunner,
  ) {}

  /**
   * OpenCode 2 stores provider connections in its data database, and a fresh
   * standalone server did not expose the user's provider catalog. Keep the
   * configured data, state, config, and cache roots so the CLI can find the
   * same authenticated service as `opencode models`.
   */
  additionalEnvironment(_dataDir: string, credentialSource?: string): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    if (credentialSource !== undefined) {
      const source = resolve(credentialSource);
      if (basename(source).toLowerCase() === "opencode") {
        environment.XDG_DATA_HOME = dirname(source);
      }
    }
    return environment;
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

  resolveWorker(input: {
    executorId: string;
    cwd: string;
    env: Record<string, string>;
  }): OpenCodeWorker {
    return resolveOpenCodeWorker({ ...input, binary: this.binary, runner: this.runProcess });
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    // A supplied primary agent id is a trust-boundary input: it becomes
    // `--agent <id>` on a subprocess argv, so anything outside the generated
    // `<namespace>/<id>` shape fails closed before the process is spawned.
    if (opts.primaryAgentId !== undefined && typeof opts.primaryAgentId !== "string") {
      throw new OpenCodeAgentSelectionError("", "the primary agent ID must be a string");
    }
    if (opts.primaryAgentId !== undefined && !isOpenCodeAgentRuntimeId(opts.primaryAgentId)) {
      throw new OpenCodeAgentSelectionError(opts.primaryAgentId);
    }
    const selection = opts.openCodeSelection;
    if (
      selection !== undefined &&
      (typeof selection !== "object" || selection === null || Array.isArray(selection))
    ) {
      throw new OpenCodeAgentSelectionError("", "the primary selection must be an object");
    }
    if (selection !== undefined && opts.primaryAgentId !== undefined) {
      throw new OpenCodeAgentSelectionError(
        opts.primaryAgentId,
        "competing primary selectors are not allowed",
      );
    }
    let agentId = opts.primaryAgentId;
    if (selection !== undefined) {
      if (
        Object.keys(selection).some((key) =>
          selection.source === "default" ? key !== "source" : key !== "source" && key !== "agentId",
        )
      ) {
        throw new OpenCodeAgentSelectionError(
          "",
          "the primary selection contains unsupported fields",
        );
      }
      if (selection.source === "default") {
        agentId = undefined;
      } else if (selection.source === "managed") {
        if (typeof selection.agentId !== "string") {
          throw new OpenCodeAgentSelectionError(
            "",
            "the managed primary agent ID must be a string",
          );
        }
        if (!isOpenCodeAgentRuntimeId(selection.agentId)) {
          throw new OpenCodeAgentSelectionError(selection.agentId);
        }
        agentId = selection.agentId;
      } else if (selection.source === "native") {
        if (typeof selection.agentId !== "string") {
          throw new OpenCodeAgentSelectionError("", "the native primary agent ID must be a string");
        }
        if (
          !isBoundedNativeAgentId(selection.agentId) ||
          isGeneratedAttemptAgentId(selection.agentId)
        ) {
          throw new OpenCodeAgentSelectionError(
            selection.agentId,
            "it is not a bounded native primary identifier or names a generated attempt agent",
          );
        }
        agentId = selection.agentId;
      } else {
        throw new OpenCodeAgentSelectionError("", "the primary selection source is unknown");
      }
    }
    const hasTimeout = opts.timeoutSec !== undefined && opts.timeoutSec > 0;
    const modelId = opts.model.split("#", 1)[0] ?? opts.model;
    const model = opts.effort === "none" ? modelId : `${modelId}#${opts.effort}`;
    const args = [
      "run",
      "-m",
      model,
      "--format",
      "json",
      "--auto",
      "--thinking",
      ...(agentId === undefined ? [] : ["--agent", agentId]),
      opts.prompt,
    ];
    const worker =
      opts.openCodeWorker ??
      this.resolveWorker({
        executorId: this.id,
        cwd: opts.cwd,
        env: opts.env,
      });
    if (
      worker.binary !== this.binary ||
      worker.version !== EXPECTED_OPENCODE_VERSION ||
      worker.cwd !== opts.cwd ||
      JSON.stringify(Object.entries(worker.env).sort()) !==
        JSON.stringify(Object.entries(opts.env).sort()) ||
      worker.runner !== this.runProcess
    ) {
      throw new OpenCodeAgentSelectionError(
        agentId ?? "",
        "the worker context differs from this executor's binary, pinned version, workspace, environment, or runner",
      );
    }
    const result = await worker.runner(worker.binary, args, {
      cwd: worker.cwd,
      env: worker.env,
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
