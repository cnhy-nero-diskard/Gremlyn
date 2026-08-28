import { GitHubError } from "../github/client.js";
import { GitError } from "../workspace/gitops.js";
import { WorkspaceError } from "../workspace/worktree.js";
import type { AgentResult, FailureStage } from "../types.js";

export const FAILURE_REASONS = [
  "github-unavailable",
  "authentication-expired",
  "target-branch-deleted",
  "pull-request-closed",
  "workspace-corrupted",
  "workspace-invalid",
  "workspace-conflicted",
  "git-conflict",
  "agent-cli-missing",
  "model-unavailable",
  "agent-process-crash",
  "agent-timeout",
  "agent-nonzero-exit",
  "agent-auth-failed",
  "validation-failed",
  "push-rejected",
  "comment-post-failed",
  "job-interrupted",
  "no-changes",
  "head-changed",
  "wrong-branch",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export class StageFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly reason: FailureReason,
    message: string = reason,
  ) {
    super(message);
    this.name = "StageFailure";
  }
}

/**
 * Detect provider authentication failure from the agent result.
 *
 * Cline 3.0.60 surfaces this as a `run_result` with `finishReason: "error"` and
 * a `text` beginning "Unauthorized: ...", plus a `{"type":"error"}` line on
 * stderr carrying the same message.
 *
 * Detection is deliberately narrow. A substring search over the whole stream
 * would misfire on this tool's own subject matter: resolving review feedback on
 * code containing `401 Unauthorized`, `UnauthorizedError`, or an HTTP fixture
 * would classify a genuine agent failure as an auth failure — a reason that is
 * reported to the reviewer and tells the operator every later job will fail
 * identically. Only the agent's own terminal status counts.
 */
export function isAgentAuthenticationFailure(
  result: Pick<AgentResult, "stdout" | "stderr">,
): boolean {
  const unauthorized = /^Unauthorized\b/u;
  const combined = `${result.stdout}\n${result.stderr}`;
  for (const line of combined.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: { type?: unknown; finishReason?: unknown; text?: unknown; message?: unknown };
    try {
      value = JSON.parse(trimmed) as typeof value;
    } catch {
      continue;
    }
    if (
      value.type === "run_result" &&
      value.finishReason === "error" &&
      typeof value.text === "string" &&
      unauthorized.test(value.text)
    ) {
      return true;
    }
    if (
      value.type === "error" &&
      typeof value.message === "string" &&
      unauthorized.test(value.message)
    ) {
      return true;
    }
  }
  return false;
}

export function agentFailureReason(result: AgentResult): FailureReason {
  if (isAgentAuthenticationFailure(result)) return "agent-auth-failed";
  return "agent-nonzero-exit";
}

/** Map known operational failures to distinct stable reason codes. */
export function classifyFailure(error: unknown, stage: FailureStage): StageFailure {
  if (error instanceof StageFailure) return error;
  if (error instanceof WorkspaceError) {
    const reason: FailureReason =
      error.reason === "head-changed"
        ? "head-changed"
        : error.reason === "workspace-conflicted"
          ? "git-conflict"
          : "workspace-corrupted";
    return new StageFailure(stage, reason, error.message);
  }
  if (error instanceof GitHubError) {
    if (error.status === 401 || error.status === 403) {
      return new StageFailure(stage, "authentication-expired", error.message);
    }
    if (error.status === 404) {
      return new StageFailure(stage, "target-branch-deleted", error.message);
    }
    return new StageFailure(stage, "github-unavailable", error.message);
  }
  if (error instanceof GitError) {
    return new StageFailure(
      stage,
      stage === "publishing" ? "push-rejected" : "workspace-corrupted",
      error.message,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Unauthorized/iu.test(message) && stage === "running") {
    return new StageFailure(stage, "agent-auth-failed", message);
  }
  if (/ENOENT|not recognized|not found/iu.test(message)) {
    return new StageFailure(stage, "agent-cli-missing", message);
  }
  if (/model/iu.test(message)) return new StageFailure(stage, "model-unavailable", message);
  return new StageFailure(stage, "agent-process-crash", message);
}
