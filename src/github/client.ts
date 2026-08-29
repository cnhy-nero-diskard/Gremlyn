/**
 * The GitHub seam (design D5). Everything the orchestrator needs from GitHub
 * is behind this interface so tests run against recorded fixtures with no
 * network, and the transport can be replaced without touching the job
 * lifecycle.
 */

export interface PullRequestInfo {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  headBranch: string;
  headSha: string;
  headRepoOwner: string;
  headRepoName: string;
  baseRepoOwner: string;
  baseRepoName: string;
  htmlUrl: string;
}

/** Same-repository check (command-authorization spec: fork pull request). */
export function isForkPullRequest(pr: PullRequestInfo): boolean {
  return (
    pr.headRepoOwner.toLowerCase() !== pr.baseRepoOwner.toLowerCase() ||
    pr.headRepoName.toLowerCase() !== pr.baseRepoName.toLowerCase()
  );
}

export interface ReviewCommentPayload {
  id: number;
  inReplyToId: number | null;
  path: string;
  diffHunk: string;
  body: string;
  authorLogin: string;
  createdAt: string;
  prNumber: number;
}

export interface ReviewThread {
  /** Identifier of the thread's root comment; used as the thread identity. */
  rootCommentId: number;
  /** Thread comments in chronological order, root first. */
  comments: ReviewCommentPayload[];
  path: string;
  diffHunk: string;
}

export interface PollCommentsOptions {
  /** ISO-8601 timestamp; only comments created after it are returned. */
  since?: string;
  /** ETag from a previous poll, sent as If-None-Match. */
  etag?: string;
}

export interface PollCommentsResult {
  /** 200 with fresh comments, or 304 when nothing changed. */
  status: 200 | 304;
  /** ETag to present on the next poll; null when the server sent none. */
  etag: string | null;
  comments: ReviewCommentPayload[];
}

/** GitHub's fixed reaction vocabulary. */
export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export interface GitHubClient {
  /** Login of the identity the client authenticates as. */
  getAuthenticatedLogin(): Promise<string>;
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo>;
  /** All review comments on a pull request, chronological. */
  listReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewCommentPayload[]>;
  /** The review thread containing the given comment, root first. */
  getReviewThread(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
  ): Promise<ReviewThread>;
  /** Reply within a review comment thread. Returns the new comment id. */
  postReviewReply(
    owner: string,
    repo: string,
    prNumber: number,
    inReplyToCommentId: number,
    body: string,
  ): Promise<number>;
  /** Post a top-level pull-request conversation comment. */
  postConversationReply(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<number>;
  /**
   * Repository-level review-comment poll with `since` and ETag conditional
   * request support (design D4). A 304 result consumes no rate limit.
   */
  pollReviewComments(
    owner: string,
    repo: string,
    options: PollCommentsOptions,
  ): Promise<PollCommentsResult>;
  /**
   * Replace the orchestrator's status reaction on the triggering review
   * comment. Any reaction the authenticated identity already left on the
   * comment is removed first, so exactly one status reaction is visible at a
   * time, letting the comment itself surface the job's progress at a glance.
   */
  setCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent,
  ): Promise<void>;
}

export class GitHubError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}
