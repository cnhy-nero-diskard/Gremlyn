import type { ReviewCommentPayload } from "../github/client.js";
import type { NormalizedEvent } from "../types.js";

export function normalizeReviewComment(
  owner: string,
  repo: string,
  comment: ReviewCommentPayload,
): NormalizedEvent {
  return {
    owner,
    repo,
    kind: "review-comment",
    commentId: comment.id,
    authorLogin: comment.authorLogin,
    body: comment.body,
    prNumber: comment.prNumber,
    observedAt: comment.createdAt,
  };
}
