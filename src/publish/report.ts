import type { GitHubClient } from "../github/client.js";
import type { JobStore } from "../store/jobs.js";

/**
 * The success reply names a commit the caller supplies, never one read back
 * from the attempt record. That matters now that `commit_sha` is recorded
 * before the push: a sha in the record is not evidence of publication, so a
 * reply built from one could claim work reached the pull request when it did
 * not. The orchestrator only builds a `success` outcome after the push.
 */
export type ReportOutcome =
  | {
      kind: "success";
      commitSha: string;
      summary: string;
      validationSummary: string;
    }
  | { kind: "failure"; stage: string; reason: string }
  | { kind: "declined"; reason: string; jobId: number };

export function buildOutcomeReply(
  outcome: ReportOutcome,
  redact: (value: string) => string = (value) => value,
): string {
  let reply: string;
  switch (outcome.kind) {
    case "success":
      reply = `Resolved in commit ${outcome.commitSha}. ${outcome.summary} Validation: ${outcome.validationSummary}.`;
      break;
    case "failure":
      reply = `Resolution failed during ${outcome.stage}: ${outcome.reason}. No changes were pushed.`;
      break;
    case "declined":
      reply = `No change was pushed. The agent declined the feedback: ${outcome.reason}. See local job ${outcome.jobId} for details.`;
      break;
  }
  return redact(reply);
}

/** Reply only; the GitHub seam deliberately exposes no thread-resolution operation. */
export async function postOutcomeReply(input: {
  github: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  outcome: ReportOutcome;
  redact?: (value: string) => string;
}): Promise<number> {
  return input.github.postReviewReply(
    input.owner,
    input.repo,
    input.prNumber,
    input.commentId,
    buildOutcomeReply(input.outcome, input.redact),
  );
}

export async function reportAttemptOutcome(
  input: Parameters<typeof postOutcomeReply>[0] & {
    jobs: Pick<JobStore, "recordReportStatus">;
    attemptId: number;
  },
): Promise<{ posted: true; commentId: number } | { posted: false; error: unknown }> {
  try {
    const commentId = await postOutcomeReply(input);
    input.jobs.recordReportStatus(input.attemptId, "posted");
    return { posted: true, commentId };
  } catch (error) {
    input.jobs.recordReportStatus(input.attemptId, "failed");
    return { posted: false, error };
  }
}
