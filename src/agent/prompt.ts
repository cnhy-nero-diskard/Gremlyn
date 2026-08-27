import type { ReviewContext } from "../types.js";

export const CONTEXT_START = "----- BEGIN UNTRUSTED REVIEW CONTEXT -----";
export const CONTEXT_END = "----- END UNTRUSTED REVIEW CONTEXT -----";

/** Fixed, trusted instruction block. GitHub text never changes this constant. */
export const RESOLUTION_INSTRUCTIONS = `Resolve the review feedback in the prepared workspace.

- Inspect the surrounding implementation before modifying code.
- Make the smallest correct change consistent with existing conventions.
- Leave unrelated functionality alone and do not merge the pull request.
- Run relevant validation for the affected area.
- If the feedback is incorrect, obsolete, ambiguous, or cannot be implemented safely, explain the problem instead of inventing a change.
- Report what changed, which files were touched, what validation ran, and whether the feedback is resolved.`;

/** Assemble the bounded prompt in a deterministic order (design D11). */
export function buildResolutionPrompt(context: ReviewContext): string {
  const thread = context.thread.map(
    (comment) =>
      `[${comment.createdAt}] ${comment.authorLogin} (comment ${comment.id}):\n${comment.body}`,
  );
  const untrusted = [
    `Repository: ${context.owner}/${context.repo}`,
    `Pull request: #${context.prNumber} ${context.prTitle}`,
    `Head branch: ${context.headBranch}`,
    `Head commit: ${context.headSha}`,
    `Triggering comment: ${context.triggeringCommentId}`,
    `Anchored file: ${context.filePath}`,
    "Review thread (chronological):",
    ...thread,
    "Relevant diff hunk:",
    context.diffHunk,
  ].join("\n\n");

  return [
    CONTEXT_START,
    untrusted,
    CONTEXT_END,
    context.agentInstructions
      ? `Repository-specific instructions:\n${context.agentInstructions}`
      : undefined,
    RESOLUTION_INSTRUCTIONS,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}
