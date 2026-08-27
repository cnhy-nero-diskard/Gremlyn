import { GitHubError } from "../github/client.js";
import { GitError } from "../workspace/gitops.js";
import { WorkspaceError } from "../workspace/worktree.js";
import type { FailureStage } from "../types.js";

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
  if (/ENOENT|not recognized|not found/iu.test(message)) {
    return new StageFailure(stage, "agent-cli-missing", message);
  }
  if (/model/iu.test(message)) return new StageFailure(stage, "model-unavailable", message);
  return new StageFailure(stage, "agent-process-crash", message);
}
