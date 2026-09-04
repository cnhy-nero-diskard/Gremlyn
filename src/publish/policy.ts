import type { AgentResult } from "../types.js";
import type { ValidationOutcome } from "../validate/runner.js";
import type { WorkspaceInspection } from "../validate/inspection.js";
import { commitAll, pushHead, type CommitAuthor } from "./gitops.js";

export type PublicationBlockReason =
  | "agent-timeout"
  | "agent-nonzero-exit"
  | "no-changes"
  | "workspace-invalid"
  | "wrong-branch"
  | "workspace-conflicted"
  | "validation-failed"
  | "head-changed"
  | "pull-request-closed";

export interface PublicationFacts {
  agent: Pick<AgentResult, "exitCode" | "timedOut">;
  inspection: WorkspaceInspection;
  validation: Pick<ValidationOutcome, "succeeded">;
  expectedHeadSha: string;
  currentHeadSha: string;
  prOpen: boolean;
}

/** Evaluate all six publication preconditions in stable order. */
export function publicationBlockReason(
  facts: PublicationFacts,
): PublicationBlockReason | undefined {
  if (facts.agent.timedOut) return "agent-timeout";
  if (facts.agent.exitCode !== 0) return "agent-nonzero-exit";
  if (!facts.inspection.modified) return "no-changes";
  if (!facts.inspection.ok) return facts.inspection.reason;
  if (!facts.validation.succeeded) return "validation-failed";
  if (facts.expectedHeadSha !== facts.currentHeadSha) return "head-changed";
  if (!facts.prOpen) return "pull-request-closed";
  return undefined;
}

export function resolutionCommitMessage(commentId: number): string {
  return `Resolve review feedback (comment ${commentId})`;
}

/**
 * The three things publication can do. `cancelled` is deliberately not a
 * `blocked` reason: a cancel is an operator decision, not a judgement about the
 * work, and the two must stay distinguishable in the attempt record and in
 * anything reported to the pull request. `commitSha` is present exactly when
 * the cancel landed after the commit was created.
 */
export type PublicationResult =
  | { kind: "blocked"; reason: PublicationBlockReason }
  | { kind: "cancelled"; commitSha?: string }
  | { kind: "published"; commitSha: string };

/**
 * Commit and non-force push only after every independent precondition passes.
 *
 * Cancellation is observed independently of those preconditions, at the two
 * boundaries between operations: before the commit exists, and after it exists
 * but before it leaves the machine. That second checkpoint is the reason the
 * signal is threaded in here rather than checked around this call — the
 * commit→push boundary exists only inside this function, and by the time the
 * call returns the push has already happened.
 *
 * The guarantee is about boundaries, not instants: no push *begins* once
 * cancellation has been observed. A cancel arriving while `commitAll` or
 * `pushHead` is already running is not pre-empted; killing a git subprocess
 * mid-operation is a separate question about subprocess lifetimes.
 *
 * `onCommitted` fires the moment the commit exists, before any push is
 * attempted, so the caller can record a commit that may never leave the
 * workspace — cancelled here, or lost to a failing push.
 */
export async function publishIfEligible(input: {
  facts: PublicationFacts;
  workspacePath: string;
  headBranch: string;
  commentId: number;
  author: CommitAuthor;
  signal: AbortSignal;
  onCommitted?: (commitSha: string) => void;
}): Promise<PublicationResult> {
  const blocked = publicationBlockReason(input.facts);
  if (blocked !== undefined) return { kind: "blocked", reason: blocked };
  if (input.signal.aborted) return { kind: "cancelled" };
  const commitSha = await commitAll(
    input.workspacePath,
    resolutionCommitMessage(input.commentId),
    input.author,
  );
  if (commitSha === null) return { kind: "blocked", reason: "no-changes" };
  input.onCommitted?.(commitSha);
  // Last point at which the commit is still private to this workspace.
  if (input.signal.aborted) return { kind: "cancelled", commitSha };
  await pushHead(input.workspacePath, input.headBranch);
  return { kind: "published", commitSha };
}
