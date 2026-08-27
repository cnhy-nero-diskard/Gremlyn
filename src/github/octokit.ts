import { Octokit } from "octokit";
import {
  GitHubError,
  type GitHubClient,
  type PollCommentsOptions,
  type PollCommentsResult,
  type PullRequestInfo,
  type ReviewCommentPayload,
  type ReviewThread,
} from "./client.js";
import { mapPullRequest, mapReviewComment } from "./mappers.js";

/**
 * Octokit-backed GitHub client (design: GitHubClient seam). All traffic goes
 * through the token from configuration; no secrets ever leave this module.
 */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getAuthenticatedLogin(): Promise<string> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return data.login;
  }

  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestInfo> {
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return mapPullRequest(data);
  }

  async listReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewCommentPayload[]> {
    const comments = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviewComments,
      { owner, repo, pull_number: prNumber, per_page: 100, sort: "created", direction: "asc" },
    );
    return comments.map(mapReviewComment);
  }

  async getReviewThread(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
  ): Promise<ReviewThread> {
    return buildThread(await this.listReviewComments(owner, repo, prNumber), commentId);
  }

  async postReviewReply(
    owner: string,
    repo: string,
    prNumber: number,
    inReplyToCommentId: number,
    body: string,
  ): Promise<number> {
    const { data } = await this.octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      comment_id: inReplyToCommentId,
      body,
    });
    return data.id;
  }

  async pollReviewComments(
    owner: string,
    repo: string,
    options: PollCommentsOptions,
  ): Promise<PollCommentsResult> {
    const headers: Record<string, string> = {};
    if (options.etag) headers["if-none-match"] = options.etag;
    try {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/pulls/comments",
        {
          owner,
          repo,
          per_page: 100,
          sort: "created",
          direction: "asc",
          ...(options.since ? { since: options.since } : {}),
          headers,
        },
      );
      const etag = response.headers.etag ?? null;
      const comments = (response.data as unknown[]).map(mapReviewComment);
      return { status: 200, etag, comments };
    } catch (err) {
      // A conditional request with no changes answers 304; Octokit surfaces
      // it as an error. It is a normal, rate-limit-free result.
      if (isRequestError(err) && err.status === 304) {
        return { status: 304, etag: options.etag ?? null, comments: [] };
      }
      throw err;
    }
  }
}

function isRequestError(err: unknown): err is { status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

/**
 * Reconstruct the thread containing `commentId` from a PR's review comments.
 * Thread members chain through `inReplyToId` back to the root comment.
 */
export function buildThread(
  comments: ReviewCommentPayload[],
  commentId: number,
): ReviewThread {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const target = byId.get(commentId);
  if (!target) {
    throw new GitHubError(`review comment ${commentId} not found`);
  }
  let root = target;
  while (root.inReplyToId !== null) {
    const parent = byId.get(root.inReplyToId);
    if (!parent) break;
    root = parent;
  }
  const members = comments
    .filter((c) => {
      let cur: ReviewCommentPayload | undefined = c;
      while (cur) {
        if (cur.id === root.id) return true;
        cur = cur.inReplyToId !== null ? byId.get(cur.inReplyToId) : undefined;
      }
      return false;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  return {
    rootCommentId: root.id,
    comments: members,
    path: root.path,
    diffHunk: root.diffHunk,
  };
}
