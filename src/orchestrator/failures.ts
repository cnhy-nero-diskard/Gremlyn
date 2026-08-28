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
 * Cline 3.0.60 surfaces this as `Unauthorized` on a `run_result` with
 * `finishReason: "error"` and `durationMs ~333`, plus exit 1. The probe
 * fixtures carry it as `"text":"Unauthorized"`. We detect it from the raw
 * stdout/stderr so a transcript-free `Unauthorized` in either stream maps to
 * the dedicated reason rather than `agent-nonzero-exit`.
 */
export function isAgentAuthenticationFailure(
  result: Pick<AgentResult, "stdout" | "stderr">,
): boolean {
  const haystack = `${result.stdout}\n${result.stderr}`;
  if (/Unauthorized/iu.test(haystack)) return true;
  // Also detect JSON structured form: look for run_result with text Unauthorized
  for (const line of haystack.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (value.type === "run_result" && value.text === "Unauthorized") return true;
      if (typeof value.text === "string" && /Unauthorized/iu.test(value.text)) return true;
    } catch {
      // Ignore malformed JSON
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
