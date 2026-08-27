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

export type PublicationResult =
  { kind: "blocked"; reason: PublicationBlockReason } | { kind: "published"; commitSha: string };

/** Commit and non-force push only after every independent precondition passes. */
export async function publishIfEligible(input: {
  facts: PublicationFacts;
  workspacePath: string;
  headBranch: string;
  commentId: number;
  author: CommitAuthor;
}): Promise<PublicationResult> {
  const blocked = publicationBlockReason(input.facts);
  if (blocked !== undefined) return { kind: "blocked", reason: blocked };
  const commitSha = await commitAll(
    input.workspacePath,
    resolutionCommitMessage(input.commentId),
    input.author,
  );
  if (commitSha === null) return { kind: "blocked", reason: "no-changes" };
  await pushHead(input.workspacePath, input.headBranch);
  return { kind: "published", commitSha };
}
