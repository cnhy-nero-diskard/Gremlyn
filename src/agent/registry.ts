import { ClineExecutor } from "./cline.js";
import type { ProcessRunner } from "./launcher.js";
import { OpenCodeExecutor } from "./opencode.js";
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
