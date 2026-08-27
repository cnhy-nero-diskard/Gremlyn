import type { PullRequestInfo, ReviewCommentPayload } from "./client.js";

/**
 * Pure mapping functions from GitHub REST payloads to internal shapes.
 * Isolated from the HTTP layer so they are testable against recorded
 * fixtures (design D17).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function mapPullRequest(payload: any): PullRequestInfo {
  return {
    number: payload.number,
    title: payload.title,
    state: payload.state === "open" ? "open" : "closed",
    merged: Boolean(payload.merged_at),
    headBranch: payload.head.ref,
    headSha: payload.head.sha,
    headRepoOwner: payload.head.repo?.owner?.login ?? payload.head.user?.login,
    headRepoName: payload.head.repo?.name ?? "",
    baseRepoOwner: payload.base.repo.owner.login,
    baseRepoName: payload.base.repo.name,
    htmlUrl: payload.html_url,
  };
}

export function mapReviewComment(payload: any): ReviewCommentPayload {
  // pull_request_url ends with /pulls/<number>.
  const prNumber = Number(
    String(payload.pull_request_url ?? "")
      .split("/")
      .pop(),
  );
  return {
    id: payload.id,
    inReplyToId: payload.in_reply_to_id ?? null,
    path: payload.path ?? "",
    diffHunk: payload.diff_hunk ?? "",
    body: payload.body ?? "",
    authorLogin: payload.user?.login ?? "",
    createdAt: payload.created_at,
    prNumber,
  };
}
