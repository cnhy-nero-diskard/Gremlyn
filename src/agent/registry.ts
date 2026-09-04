import { ClineExecutor, EXPECTED_CLINE_VERSION } from "./cline.js";
import type { ProcessRunner } from "./launcher.js";
import { EXPECTED_OPENCODE_VERSION, OpenCodeExecutor } from "./opencode.js";
import type { AgentExecutor } from "../types.js";

/**
 * Executor construction keyed by an agent's declared kind rather than its
 * (operator-chosen, free-label) id, so more than one agent can be registered
 * at once and an id is never load-bearing for behavior (design D-opencode).
 * Shared by the orchestrator's startup and the standalone probe — the probe
 * supplies its own recording runner to capture argv, so the factory accepts
 * one instead of always defaulting to the real process launcher.
 */
export const EXECUTOR_FACTORIES: Record<string, (binary: string, runner?: ProcessRunner) => AgentExecutor> = {
  cline: (binary, runner) => new ClineExecutor(binary, runner),
  opencode: (binary, runner) => new OpenCodeExecutor(binary, runner),
};

/**
 * The pinned release each registered kind runs under, kept beside the
 * factories so setup's prerequisite messaging reads the same source of truth
 * the executor's `checkVersion` enforces rather than restating it.
 */
export const EXECUTOR_EXPECTED_VERSIONS: Record<string, string> = {
  cline: EXPECTED_CLINE_VERSION,
  opencode: EXPECTED_OPENCODE_VERSION,
};
