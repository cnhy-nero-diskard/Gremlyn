import {
  GitHubError,
  type GitHubClient,
  type PollCommentsOptions,
  type PollCommentsResult,
  type PullRequestInfo,
  type ReactionContent,
  type ReviewCommentPayload,
  type ReviewThread,
} from "./client.js";
import { buildThread } from "./octokit.js";

/**
 * Fixture-backed GitHub client (design D17). Drives end-to-end tests with
 * recorded fixtures and no network. Replies it "posts" are recorded for
 * assertion.
 */
export class FixtureGitHubClient implements GitHubClient {
  private readonly login: string;
  private readonly prs = new Map<string, PullRequestInfo>();
  private readonly comments = new Map<string, ReviewCommentPayload[]>();
  /** Every reply posted through this client, in order. */
  readonly replies: { prNumber: number; inReplyTo: number; body: string }[] = [];
  /** Top-level pull-request conversation replies posted by the fixture. */
  readonly conversationReplies: { prNumber: number; body: string }[] = [];
  /** Every reaction content applied per comment, in order. */
  readonly reactionHistory: { commentId: number; content: ReactionContent }[] = [];
  /** Current reaction left on each comment, keyed by comment id. */
  readonly reactions = new Map<number, ReactionContent>();
  /** Fixture-observable count of requests that consumed rate limit. */
  rateLimitConsumed = 0;
  private nextCommentId = 1;
  private etagCounter = 1;

  constructor(options: {
    login: string;
    prs?: PullRequestInfo[];
    comments?: ReviewCommentPayload[];
  }) {
    this.login = options.login;
    for (const pr of options.prs ?? []) {
      this.prs.set(`${pr.baseRepoOwner}/${pr.baseRepoName}/${pr.number}`, pr);
    }
    for (const c of options.comments ?? []) {
      const key = `${c.prNumber}`;
      const list = this.comments.get(key) ?? [];
      list.push(c);
      this.comments.set(key, list);
      this.nextCommentId = Math.max(this.nextCommentId, c.id + 1);
    }
  }

  /** Test helper: register or replace a pull request. */
  addPullRequest(pr: PullRequestInfo): void {
    this.prs.set(`${pr.baseRepoOwner}/${pr.baseRepoName}/${pr.number}`, pr);
  }

  /** Test helper: append a comment to a pull request. */
  addComment(comment: ReviewCommentPayload): void {
    const key = `${comment.prNumber}`;
    const list = this.comments.get(key) ?? [];
    list.push(comment);
    this.comments.set(key, list);
    this.nextCommentId = Math.max(this.nextCommentId, comment.id + 1);
  }

  private key(owner: string, repo: string, prNumber: number): string {
    return `${owner}/${repo}/${prNumber}`;
  }

  getAuthenticatedLogin(): Promise<string> {
    return Promise.resolve(this.login);
  }

  getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo> {
    const pr = this.prs.get(this.key(owner, repo, prNumber));
    if (!pr) throw new GitHubError(`no fixture PR ${owner}/${repo}#${prNumber}`, 404);
    return Promise.resolve(pr);
  }

  listReviewComments(
    _owner: string,
    _repo: string,
    prNumber: number,
  ): Promise<ReviewCommentPayload[]> {
    return Promise.resolve(this.comments.get(`${prNumber}`) ?? []);
  }

  getReviewThread(
    _owner: string,
    _repo: string,
    prNumber: number,
    commentId: number,
  ): Promise<ReviewThread> {
    return Promise.resolve(buildThread(this.comments.get(`${prNumber}`) ?? [], commentId));
  }

  postReviewReply(
    _owner: string,
    _repo: string,
    prNumber: number,
    inReplyToCommentId: number,
    body: string,
  ): Promise<number> {
    this.replies.push({ prNumber, inReplyTo: inReplyToCommentId, body });
    return Promise.resolve(this.nextCommentId++);
  }

  postConversationReply(
    _owner: string,
    _repo: string,
    prNumber: number,
    body: string,
  ): Promise<number> {
    this.conversationReplies.push({ prNumber, body });
    return Promise.resolve(this.nextCommentId++);
  }

  pollReviewComments(
    _owner: string,
    _repo: string,
    options: PollCommentsOptions,
  ): Promise<PollCommentsResult> {
    const all = [...this.comments.values()].flat();
    const fresh = options.since ? all.filter((c) => c.createdAt > (options.since as string)) : all;
    // ETag derives from the comment set, so adding a comment invalidates it.
    const etag = `W/"fixture-${all.length}"`;
    if (options.etag === etag) {
      return Promise.resolve({ status: 304, etag, comments: [] });
    }
    this.rateLimitConsumed += 1;
    return Promise.resolve({ status: 200, etag, comments: fresh });
  }

  setCommentReaction(
    _owner: string,
    _repo: string,
    commentId: number,
    content: ReactionContent,
  ): Promise<void> {
    if (this.reactions.get(commentId) === content) return Promise.resolve();
    this.reactions.set(commentId, content);
    this.reactionHistory.push({ commentId, content });
    return Promise.resolve();
  }
}
