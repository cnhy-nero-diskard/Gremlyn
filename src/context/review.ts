import type { GitHubClient } from "../github/client.js";
import type { ReviewContext, ReviewThreadComment } from "../types.js";

/** Reconstruct the narrow review context needed by the agent (design D11). */
export async function reconstructReviewContext(
  github: GitHubClient,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    triggeringCommentId: number;
    agentInstructions?: string;
  },
): Promise<ReviewContext> {
  const [pr, reviewThread] = await Promise.all([
    github.getPullRequest(input.owner, input.repo, input.prNumber),
    github.getReviewThread(input.owner, input.repo, input.prNumber, input.triggeringCommentId),
  ]);

  const thread: ReviewThreadComment[] = reviewThread.comments
    .map((comment) => ({
      id: comment.id,
      authorLogin: comment.authorLogin,
      body: comment.body,
      createdAt: comment.createdAt,
    }))
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id - right.id
        : left.createdAt.localeCompare(right.createdAt),
    );

  if (!thread.some((comment) => comment.id === input.triggeringCommentId)) {
    throw new Error(`triggering comment ${input.triggeringCommentId} is absent from review thread`);
  }

  return {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    prTitle: pr.title,
    prUrl: pr.htmlUrl,
    headBranch: pr.headBranch,
    headSha: pr.headSha,
    threadId: String(reviewThread.rootCommentId),
    filePath: reviewThread.path,
    diffHunk: reviewThread.diffHunk,
    thread,
    triggeringCommentId: input.triggeringCommentId,
    ...(input.agentInstructions === undefined
      ? {}
      : { agentInstructions: input.agentInstructions }),
  };
}
