import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentExecutor, FailureStage, NormalizedEvent, ReasoningEffort } from "../types.js";
import type { GitHubClient } from "../github/client.js";
import { commitAll, pushHead, type CommitAuthor } from "../publish/gitops.js";
import { JobStore } from "../store/jobs.js";
import { statusEntries } from "../workspace/gitops.js";
import { prepareWorkspace, verifyRemoteHead, WorkspaceError } from "../workspace/worktree.js";

export interface WalkingSkeletonRepository {
  id: number;
  sourcePath: string;
  workspaceRoot: string;
  agent: string;
  model: string;
  provider: string;
  effort: ReasoningEffort;
}

export interface WalkingSkeletonOptions {
  event: NormalizedEvent;
  command: string;
  threadId: string;
  repository: WalkingSkeletonRepository;
  db: Database.Database;
  github: GitHubClient;
  executor: AgentExecutor;
  dataDir: string;
  commitAuthor: CommitAuthor;
  timeoutSec?: number;
  retries?: number;
  signal?: AbortSignal;
}

export type WalkingSkeletonResult =
  | { kind: "duplicate" }
  | { kind: "cancelled"; jobId: number; attemptId: number }
  | { kind: "succeeded"; jobId: number; attemptId: number; commitSha: string };

/**
 * Thin vertical slice from a normalized review event to a pushed fix and a
 * fixture-observable GitHub reply (design D18). Later task groups thicken each
 * stage without changing this dependency direction.
 */
export async function runWalkingSkeleton(
  options: WalkingSkeletonOptions,
): Promise<WalkingSkeletonResult> {
  const jobs = new JobStore(options.db);
  const claimed = jobs.createJob({
    repoId: options.repository.id,
    prNumber: options.event.prNumber,
    commentId: options.event.commentId,
    command: options.command,
    threadId: options.threadId,
    authorLogin: options.event.authorLogin,
    observedAt: options.event.observedAt,
  });
  if (claimed.kind === "duplicate") return claimed;

  const jobId = claimed.jobId;
  const { attemptId } = jobs.createAttempt({
    jobId,
    agent: options.repository.agent,
    model: options.repository.model,
    provider: options.repository.provider,
    effort: options.repository.effort,
  });
  let stage: FailureStage = "preparing";
  let workspacePath: string | null = null;
  const signal = options.signal ?? new AbortController().signal;

  try {
    throwIfAborted(signal);
    jobs.setStatus(jobId, stage, attemptId);
    const pr = await options.github.getPullRequest(
      options.event.owner,
      options.event.repo,
      options.event.prNumber,
    );
    const workspace = await prepareWorkspace({
      sourcePath: options.repository.sourcePath,
      workspaceRoot: options.repository.workspaceRoot,
      prNumber: options.event.prNumber,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
    });
    workspacePath = workspace.path;
    jobs.recordPreparation(attemptId, workspace.path, workspace.headSha);

    stage = "running";
    jobs.setStatus(jobId, stage, attemptId);
    const attemptDataDir = join(options.dataDir, "attempts", String(attemptId));
    mkdirSync(attemptDataDir, { recursive: true });
    const agentResult = await options.executor.run({
      cwd: workspace.path,
      model: options.repository.model,
      provider: options.repository.provider,
      effort: options.repository.effort,
      prompt: walkingSkeletonPrompt(options.event),
      env: {},
      timeoutSec: options.timeoutSec ?? 300,
      retries: options.retries ?? 0,
      dataDir: attemptDataDir,
      signal,
    });
    jobs.recordAgentResult(attemptId, agentResult);
    throwIfAborted(signal);
    if (agentResult.timedOut) throw new Error("agent-timeout");
    if (agentResult.exitCode !== 0) throw new Error("agent-nonzero-exit");

    stage = "validating";
    jobs.setStatus(jobId, stage, attemptId);
    throwIfAborted(signal);

    stage = "publishing";
    jobs.setStatus(jobId, stage, attemptId);
    await verifyRemoteHead({
      workspacePath: workspace.path,
      headBranch: pr.headBranch,
      expectedSha: workspace.headSha,
    });
    const commitSha = await commitAll(
      workspace.path,
      `Resolve review feedback (comment ${options.event.commentId})`,
      options.commitAuthor,
    );
    if (commitSha === null) throw new Error("no-changes");
    throwIfAborted(signal);
    await pushHead(workspace.path, pr.headBranch);
    jobs.recordPublication(attemptId, commitSha);

    stage = "reporting";
    jobs.setStatus(jobId, stage, attemptId);
    await options.github.postReviewReply(
      options.event.owner,
      options.event.repo,
      options.event.prNumber,
      options.event.commentId,
      `Resolved in commit ${commitSha}. Fake-agent validation passed.`,
    );
    jobs.finishSuccess(jobId, attemptId);
    return { kind: "succeeded", jobId, attemptId, commitSha };
  } catch (err) {
    if (signal.aborted) {
      const hasChanges =
        workspacePath === null ? false : (await statusEntries(workspacePath)).length > 0;
      jobs.cancelJob(jobId, attemptId, hasChanges);
      return { kind: "cancelled", jobId, attemptId };
    }
    jobs.finishFailure(jobId, attemptId, stage, failureReason(err));
    throw err;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("job-cancelled");
}

function walkingSkeletonPrompt(event: NormalizedEvent): string {
  return [
    `Resolve review feedback for ${event.owner}/${event.repo}#${event.prNumber}.`,
    `Triggering comment ${event.commentId}:`,
    event.body,
    "Make the smallest correct change, validate it, and do not merge the pull request.",
  ].join("\n\n");
}

function failureReason(err: unknown): string {
  if (err instanceof WorkspaceError) return err.reason;
  if (err instanceof Error && err.message.length > 0) return err.message;
  return "unknown-error";
}
