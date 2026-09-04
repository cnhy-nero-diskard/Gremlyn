import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RepoConfig } from "../config/loader.js";
import { extractSupportedEfforts } from "../agent/cline.js";
import {
  persistRotatedCredentials,
  removeAttemptDataDir,
  seedAgentCredentials,
} from "../agent/credentials.js";
import { ACTIVITY_LINE_MAPPERS, ActivityRecorder, writeActivity } from "../agent/activity.js";
import { buildAgentEnvironment } from "../agent/environment.js";
import { writeAgentOutput } from "../agent/output.js";
import { buildResolutionPrompt } from "../agent/prompt.js";
import { reconstructReviewContext } from "../context/review.js";
import { authorizeCommand } from "../gate/authorize.js";
import type { GitHubClient } from "../github/client.js";
import type { CommandRegistry } from "../ingest/commands.js";
import type { Logger } from "../log/logger.js";
import { createRedactor } from "../log/redact.js";
import { publishIfEligible } from "../publish/policy.js";
import { reportAttemptOutcome } from "../publish/report.js";
import { JobStore, type AttemptRow } from "../store/jobs.js";
import type {
  AgentExecutor,
  AgentResult,
  FailureStage,
  JobStatus,
  NormalizedEvent,
  ParsedCommand,
} from "../types.js";
import { inspectWorkspace } from "../validate/inspection.js";
import { runValidationCommands } from "../validate/runner.js";
import { statusEntries } from "../workspace/gitops.js";
import { prepareWorkspace, workspacePathFor } from "../workspace/worktree.js";
import {
  agentFailureReason,
  isAgentAuthenticationFailure,
  isAgentBillingFailure,
  StageFailure,
  classifyFailure,
} from "./failures.js";
import { JobQueue, type QueueResult } from "./queue.js";
import { reactionForStatus } from "./reactions.js";

/** Snapshot cadence for live agent activity: responsive without thrashing disk. */
const ACTIVITY_FLUSH_MS = 400;

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * A retry may inherit edits only from a run that stopped abruptly rather than
 * completing its own cleanup — interrupted, cancelled, timed out, or the agent
 * process itself exiting nonzero mid-run. The deterministic path and recorded
 * head are checked again after GitHub context reconstruction, so a force-push
 * or a manually supplied path cannot turn this into a general dirty-workspace
 * bypass.
 */
function canResumeRetainedWorkspace(
  attempt: AttemptRow | undefined,
  workspaceRoot: string,
  prNumber: number,
): boolean {
  if (!attempt?.workspace_path || !attempt.head_sha_at_prepare) return false;
  if (!samePath(attempt.workspace_path, workspacePathFor(workspaceRoot, prNumber))) return false;
  if (attempt.outcome === "interrupted") return true;
  if (attempt.has_uncommitted_changes !== 1) return false;
  if (attempt.outcome === "cancelled") return true;
  return (
    attempt.outcome === "failed" &&
    attempt.failure_stage === "running" &&
    (attempt.failure_reason === "agent-timeout" ||
      attempt.failure_reason === "agent-nonzero-exit")
  );
}

/**
 * Find the newest resumable workspace, ignoring retries that failed before a
 * workspace was prepared. A later attempt that did touch the workspace is a
 * hard boundary: older provenance must never override it.
 */
function retainedWorkspaceAttempt(
  attempts: readonly AttemptRow[],
  workspaceRoot: string,
  prNumber: number,
): AttemptRow | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (!attempt) continue;
    if (!attempt.workspace_path) continue;
    return canResumeRetainedWorkspace(attempt, workspaceRoot, prNumber) ? attempt : undefined;
  }
  return undefined;
}

/**
 * A job accepted into the queue. `completed` settles when the attempt itself
 * finishes; ingestion deliberately does not await it. The orchestrator already
 * observes its rejection, so awaiting it is optional.
 */
export interface QueuedJob {
  jobId: number;
  attemptId: number;
  completed: Promise<QueueResult<{ commitSha?: string }>>;
}

export interface RuntimeRepository extends RepoConfig {
  id: number;
  /** Undefined means the agent may run until it exits or is cancelled. */
  timeoutSec?: number;
}

export interface ResolutionOrchestratorOptions {
  db: Database.Database;
  dataDir: string;
  allowedAuthors: string[];
  orchestratorLogin: string;
  /** Test/legacy fallback; repository settings take precedence. */
  timeoutSec?: number;
  retries: number;
  github: GitHubClient;
  registry: CommandRegistry;
  executors: ReadonlyMap<string, AgentExecutor>;
  credentialSources?: ReadonlyMap<string, string>;
  /** Per-agent credential file set; falls back to Cline's default when unset. */
  credentialFiles?: ReadonlyMap<string, readonly string[]>;
  logger: Logger;
  secrets: readonly string[];
  concurrency: number;
  commitAuthor: { name: string; email: string };
}

export class ResolutionOrchestrator {
  private readonly jobs: JobStore;
  private readonly queue: JobQueue<{ commitSha?: string }>;
  private readonly repositories = new Map<number, RuntimeRepository>();
  private readonly redact: (value: string) => string;

  constructor(private readonly options: ResolutionOrchestratorOptions) {
    this.jobs = new JobStore(options.db);
    this.queue = new JobQueue(options.concurrency);
    this.redact = createRedactor(options.secrets);
  }

  registerRepository(repository: RuntimeRepository): void {
    this.repositories.set(repository.id, repository);
  }

  async handleEvent(
    repository: RuntimeRepository,
    event: NormalizedEvent,
  ): Promise<QueuedJob[]> {
    this.options.logger.info("event observed", { repository: repository.id, pr: event.prNumber });
    const commands = this.options.registry.detect(event.body);
    const queued: QueuedJob[] = [];
    for (const command of commands) {
      this.options.logger.info("command parsed", { command: command.name, pr: event.prNumber });
      const authorization = await authorizeCommand({
        event,
        command,
        repository: {
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          enabled: repository.enabled,
          allowedModels: repository.allowedModels,
          defaultModel: repository.model,
        },
        allowedAuthors: this.options.allowedAuthors,
        orchestratorLogin: this.options.orchestratorLogin,
        registry: this.options.registry,
        github: this.options.github,
        db: this.options.db,
      });
      this.options.logger.info("authorization outcome", {
        outcome: authorization.kind,
        ...(authorization.kind === "authorized" ? {} : { reason: authorization.reason }),
      });
      if (authorization.kind !== "authorized") continue;
      const claimed = this.jobs.createJob({
        repoId: repository.id,
        prNumber: event.prNumber,
        commentId: event.commentId,
        command: command.name,
        threadId: String(event.commentId),
        authorLogin: event.authorLogin,
        observedAt: event.observedAt,
      });
      if (claimed.kind === "duplicate") continue;
      await this.reactToStatus(repository, event.commentId, "queued");
      const attempt = this.jobs.createAttempt({
        jobId: claimed.jobId,
        agent: repository.agent,
        model: authorization.model,
        provider: repository.provider,
        effort: repository.effort,
      });
      this.options.logger.info("job queued", {
        jobId: claimed.jobId,
        attemptId: attempt.attemptId,
      });
      queued.push(
        this.enqueueAttempt(
          claimed.jobId,
          attempt.attemptId,
          repository,
          event.prNumber,
          event.commentId,
          authorization.model,
          command,
        ),
      );
    }
    return queued;
  }

  cancel(jobId: number): boolean {
    return this.queue.cancel(jobId);
  }

  /**
   * Best-effort: the triggering comment's reaction is a status mirror, not a
   * source of truth. A GitHub hiccup here must never fail or retry the job.
   */
  private async reactToStatus(
    repository: Pick<RuntimeRepository, "owner" | "name">,
    commentId: number,
    status: JobStatus,
  ): Promise<void> {
    try {
      await this.options.github.setCommentReaction(
        repository.owner,
        repository.name,
        commentId,
        reactionForStatus(status),
      );
    } catch (error) {
      this.options.logger.warn("status reaction failed", {
        commentId,
        status,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async retry(jobId: number): Promise<QueuedJob> {
    const job = this.jobs.getJob(jobId);
    const repository = this.repositories.get(job.repo_id);
    if (!repository) throw new Error(`repository ${job.repo_id} is not registered at runtime`);
    const priorAttempt = retainedWorkspaceAttempt(
      this.jobs.listAttempts(jobId),
      repository.workspaceRoot,
      job.pr_number,
    );
    const attempt = this.jobs.retryJob({
      jobId,
      agent: repository.agent,
      model: repository.model,
      provider: repository.provider,
      effort: repository.effort,
    });
    return this.enqueueAttempt(
      jobId,
      attempt.attemptId,
      repository,
      job.pr_number,
      job.comment_id,
      repository.model,
      { name: job.command, args: [] },
      canResumeRetainedWorkspace(priorAttempt, repository.workspaceRoot, job.pr_number)
        ? {
            workspacePath: priorAttempt!.workspace_path!,
            headSha: priorAttempt!.head_sha_at_prepare!,
          }
        : undefined,
    );
  }

  private enqueueAttempt(
    jobId: number,
    attemptId: number,
    repository: RuntimeRepository,
    prNumber: number,
    commentId: number,
    model: string,
    command: ParsedCommand,
    retainedWorkspace?: { workspacePath: string; headSha: string },
  ): QueuedJob {
    const completed = this.queue.enqueue({
      jobId,
      repoId: repository.id,
      prNumber,
      verify: async () => {
        const pr = await this.options.github.getPullRequest(
          repository.owner,
          repository.name,
          prNumber,
        );
        if (pr.state !== "open" || pr.merged) return { ok: false, reason: "pull-request-closed" };
        return { ok: true };
      },
      run: (signal) =>
        this.runAttempt({
          jobId,
          attemptId,
          repository,
          prNumber,
          commentId,
          model,
          command,
          ...(retainedWorkspace === undefined ? {} : { retainedWorkspace }),
          signal,
        }),
      onRejected: async (reason) => {
        this.jobs.finishFailure(jobId, attemptId, "preparing", reason);
        await this.reactToStatus(repository, commentId, "failed");
      },
      onCancelled: async () => {
        const attempt = this.jobs.getAttempt(attemptId);
        const hasChanges = attempt.workspace_path
          ? (await statusEntries(attempt.workspace_path)).length > 0
          : false;
        this.jobs.cancelJob(jobId, attemptId, hasChanges);
        await this.reactToStatus(repository, commentId, "cancelled");
        // 4.3: seeded credential must be removed even on cancellation.
        const attemptDataDir = join(this.options.dataDir, "attempts", String(attemptId));
        removeAttemptDataDir(attemptDataDir);
      },
    });
    // Ingestion must never await a run. The poll loop is single-flight, so
    // awaiting here stalled every repository for the lifetime of one job and
    // put `concurrency` out of reach: the loop could not enqueue a second job
    // while parked on the first. Observe the rejection now, because callers
    // are free to drop `completed` and an unhandled rejection would end the
    // process.
    completed.catch((error: unknown) => {
      this.options.logger.error("job failed", {
        jobId,
        attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { jobId, attemptId, completed };
  }

  private async runAttempt(input: {
    jobId: number;
    attemptId: number;
    repository: RuntimeRepository;
    prNumber: number;
    commentId: number;
    model: string;
    command: ParsedCommand;
    retainedWorkspace?: { workspacePath: string; headSha: string };
    signal: AbortSignal;
  }): Promise<{ commitSha?: string }> {
    const { jobId, attemptId, repository, prNumber, commentId, signal } = input;
    let stage: FailureStage = "preparing";
    let workspacePath: string | undefined;
    let attemptDataDir: string | undefined;
    try {
      this.jobs.setStatus(jobId, stage, attemptId);
      await this.reactToStatus(repository, commentId, stage);
      const context = await reconstructReviewContext(this.options.github, {
        owner: repository.owner,
        repo: repository.name,
        prNumber,
        triggeringCommentId: commentId,
        ...(repository.agentInstructions === undefined
          ? {}
          : { agentInstructions: repository.agentInstructions }),
      });
      this.jobs.setReviewContext(jobId, context);
      const workspace = await prepareWorkspace({
        sourcePath: repository.sourcePath,
        workspaceRoot: repository.workspaceRoot,
        prNumber,
        headBranch: context.headBranch,
        headSha: context.headSha,
        seedFiles: repository.workspaceSeedFiles,
        resumeDirtyWorkspace:
          input.retainedWorkspace !== undefined &&
          samePath(
            input.retainedWorkspace.workspacePath,
            workspacePathFor(repository.workspaceRoot, prNumber),
          ) &&
          input.retainedWorkspace.headSha === context.headSha,
      });
      workspacePath = workspace.path;
      this.jobs.recordPreparation(attemptId, workspace.path, workspace.headSha);
      this.options.logger.info("workspace prepared", { jobId, attemptId, path: workspace.path });

      stage = "running";
      this.jobs.setStatus(jobId, stage, attemptId);
      await this.reactToStatus(repository, commentId, stage);
      const executor = this.options.executors.get(repository.agent);
      if (!executor) throw new StageFailure(stage, "agent-cli-missing");
      attemptDataDir = join(this.options.dataDir, "attempts", String(attemptId));
      mkdirSync(attemptDataDir, { recursive: true });
      // 4.1: seed credential source into the isolated data dir with owner-only perms.
      // The source is read-only; the destination is the per-attempt ephemeral dir.
      const credentialSource = this.options.credentialSources?.get(repository.agent);
      if (credentialSource) {
        // Seeding failures are a configuration/environment fault, not the
        // agent rejecting a credential. They must not fall through to the
        // generic classifier, which reads any "unauthorized" wording as a
        // provider auth failure and hides the real cause.
        try {
          seedAgentCredentials(
            credentialSource,
            attemptDataDir,
            this.options.credentialFiles?.get(repository.agent),
          );
        } catch (error) {
          throw new StageFailure(
            stage,
            "credential-seed-failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        this.options.logger.info("credential seeded", {
          jobId,
          attemptId,
          agent: repository.agent,
          source: credentialSource,
        });
      }
      this.options.logger.info("agent launched", { jobId, attemptId, agent: executor.id });
      // Follow the agent while it works. Nothing here may fail the attempt:
      // the recorder swallows unparsable lines, and a failed snapshot write is
      // logged rather than thrown — losing visibility is not losing the run.
      const recorder = new ActivityRecorder(ACTIVITY_LINE_MAPPERS[executor.id]);
      let lastFlush = 0;
      const flush = (): void => {
        if (!recorder.hasChanges) return;
        try {
          writeActivity(this.options.dataDir, attemptId, recorder.snapshot(), this.redact);
        } catch (error) {
          this.options.logger.warn("activity snapshot failed", {
            jobId,
            attemptId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };
      const runOnce = (): Promise<AgentResult> =>
        executor.run({
          cwd: workspace.path,
          model: input.model,
          provider: repository.provider,
          effort: repository.effort,
          prompt: buildResolutionPrompt(context, this.options.orchestratorLogin),
          env: buildAgentEnvironment(process.env, executor.additionalEnvironment(attemptDataDir!)),
          ...((repository.timeoutSec ?? this.options.timeoutSec) === undefined
            ? {}
            : { timeoutSec: repository.timeoutSec ?? this.options.timeoutSec }),
          retries: this.options.retries,
          dataDir: attemptDataDir!,
          signal,
          onLine: (line) => {
            recorder.push(line);
            // The stream arrives token by token; rewriting the snapshot on every
            // line would mean hundreds of writes a second for no visible gain.
            const now = Date.now();
            if (now - lastFlush < ACTIVITY_FLUSH_MS) return;
            lastFlush = now;
            flush();
          },
        });
      // Cline bounds retries itself (--retries counts consecutive mistakes
      // within one session); an executor that cannot do that is bounded here
      // instead, by re-running the whole invocation up to the same allowance.
      // The units differ deliberately — this counts whole invocations.
      const maxInvocations = executor.honorsRetries ? 1 : Math.max(1, this.options.retries);
      // A billing or auth failure is a terminal account condition, not the
      // transient "mistake" a retry allowance exists to recover from — the
      // same reason Cline's own internal retry would not run through one.
      // Retrying it would only spend more of a budget that is already spent.
      const isTerminalFailure = (result: AgentResult): boolean =>
        isAgentBillingFailure(result) || isAgentAuthenticationFailure(result);
      let agentResult = await runOnce();
      let invocation = 1;
      while (
        invocation < maxInvocations &&
        !signal.aborted &&
        !agentResult.timedOut &&
        agentResult.exitCode !== 0 &&
        !isTerminalFailure(agentResult)
      ) {
        invocation += 1;
        this.options.logger.warn("agent invocation failed, retrying", {
          jobId,
          attemptId,
          invocation,
          maxInvocations,
          exitCode: agentResult.exitCode,
        });
        agentResult = await runOnce();
      }
      recorder.finish();
      flush();
      // Reasoning effort is validated per agent at startup, but the CLI enforces
      // it per *model* and accepts an unsupported tier silently. The model's own
      // metadata on the result stream is the only signal, so surface a mismatch
      // rather than let the configured effort quietly not apply.
      const supportedEfforts = extractSupportedEfforts(agentResult.stdout);
      if (supportedEfforts && !supportedEfforts.includes(repository.effort)) {
        this.options.logger.warn("configured effort is unsupported by the model", {
          jobId,
          attemptId,
          model: input.model,
          configured: repository.effort,
          supported: supportedEfforts.join(", "),
        });
      }
      const outputRef = writeAgentOutput(this.options.dataDir, attemptId, agentResult, this.redact);
      this.jobs.recordAgentResult(attemptId, agentResult);
      this.jobs.setAttemptOutputRef(attemptId, outputRef);
      this.options.logger.info("agent exited", {
        jobId,
        attemptId,
        exitCode: agentResult.exitCode,
        timedOut: agentResult.timedOut,
      });
      if (signal.aborted) throw new Error("job-cancelled");
      if (agentResult.timedOut) throw new StageFailure(stage, "agent-timeout");
      // Ordering matters: a billing refusal's payload also matches the
      // unauthorized wording the auth check looks for, so it must be checked
      // first or a billing failure is misreported as an auth failure.
      if (isAgentBillingFailure(agentResult)) {
        throw new StageFailure(stage, "agent-billing-failed");
      }
      if (isAgentAuthenticationFailure(agentResult)) {
        throw new StageFailure(stage, "agent-auth-failed");
      }
      if (agentResult.exitCode !== 0) {
        throw new StageFailure(stage, agentFailureReason(agentResult));
      }

      stage = "validating";
      this.jobs.setStatus(jobId, stage, attemptId);
      await this.reactToStatus(repository, commentId, stage);
      this.options.logger.info("validation started", { jobId, attemptId });
      const inspection = await inspectWorkspace(workspace.path, context.headBranch);
      const validation = await runValidationCommands({
        commands: repository.validationCommands,
        cwd: workspace.path,
        dataDir: this.options.dataDir,
        attemptId,
        db: this.options.db,
        redact: this.redact,
      });
      this.options.logger.info("validation completed", {
        jobId,
        attemptId,
        succeeded: validation.succeeded,
      });

      stage = "publishing";
      this.jobs.setStatus(jobId, stage, attemptId);
      await this.reactToStatus(repository, commentId, stage);
      const currentPr = await this.options.github.getPullRequest(
        repository.owner,
        repository.name,
        prNumber,
      );
      const publication = await publishIfEligible({
        facts: {
          agent: agentResult,
          inspection,
          validation,
          expectedHeadSha: context.headSha,
          currentHeadSha: currentPr.headSha,
          prOpen: currentPr.state === "open" && !currentPr.merged,
        },
        workspacePath: workspace.path,
        headBranch: context.headBranch,
        commentId,
        author: this.options.commitAuthor,
      });
      if (publication.kind === "blocked") {
        throw new StageFailure(stage, publication.reason);
      }
      this.jobs.recordPublication(attemptId, publication.commitSha);
      this.options.logger.info("commit created", {
        jobId,
        attemptId,
        commitSha: publication.commitSha,
      });
      this.options.logger.info("push completed", {
        jobId,
        attemptId,
        commitSha: publication.commitSha,
      });

      stage = "reporting";
      this.jobs.setStatus(jobId, stage, attemptId);
      await this.reactToStatus(repository, commentId, stage);
      const report = await reportAttemptOutcome({
        github: this.options.github,
        jobs: this.jobs,
        attemptId,
        owner: repository.owner,
        repo: repository.name,
        prNumber,
        commentId,
        outcome: {
          kind: "success",
          commitSha: publication.commitSha,
          summary: "Applied the requested review fix.",
          validationSummary: validation.configured
            ? "configured commands passed"
            : "inspection passed",
        },
        redact: this.redact,
      });
      if (!report.posted) throw new StageFailure(stage, "comment-post-failed");
      this.options.logger.info("GitHub reply posted", { jobId, attemptId });
      this.jobs.finishSuccess(jobId, attemptId);
      await this.reactToStatus(repository, commentId, "succeeded");
      this.options.logger.info("job completed", { jobId, attemptId });
      this.releaseAttemptDataDir(repository.agent, attemptDataDir, jobId, attemptId);
      return { commitSha: publication.commitSha };
    } catch (error) {
      if (signal.aborted) {
        this.releaseAttemptDataDir(repository.agent, attemptDataDir, jobId, attemptId);
        throw error;
      }
      const failure = classifyFailure(error, stage);
      const hasChanges = workspacePath
        ? await statusEntries(workspacePath)
            .then((entries) => entries.length > 0)
            .catch(() => false)
        : false;
      this.jobs.recordFailureDetail(attemptId, {
        stage: failure.stage,
        reason: failure.reason,
        hasUncommittedChanges: hasChanges,
      });
      this.jobs.finishFailure(jobId, attemptId, failure.stage, failure.reason);
      await this.reactToStatus(repository, commentId, "failed");
      if (failure.stage !== "reporting") {
        await reportAttemptOutcome({
          github: this.options.github,
          jobs: this.jobs,
          attemptId,
          owner: repository.owner,
          repo: repository.name,
          prNumber,
          commentId,
          outcome: { kind: "failure", stage: failure.stage, reason: failure.reason },
          redact: this.redact,
        });
      }
      this.options.logger.error("job failed", {
        jobId,
        attemptId,
        stage: failure.stage,
        reason: failure.reason,
        filesChanged: hasChanges,
        commitExists: this.jobs.getAttempt(attemptId).commit_sha !== null,
        pushed: this.jobs.getAttempt(attemptId).pushed === 1,
      });
      this.releaseAttemptDataDir(repository.agent, attemptDataDir, jobId, attemptId);
      throw failure;
    }
  }

  /**
   * Retire an attempt's isolated data dir, rescuing any credential the agent
   * rotated before the dir is deleted.
   *
   * Ordering is the whole point: an OAuth refresh token redeemed during the
   * attempt exists *only* inside this directory, so it must reach the source
   * before `removeAttemptDataDir` destroys it. This runs on the failure paths
   * as well as the success path — an agent can rotate its token and then fail
   * validation, and dropping the new token there would poison every later job
   * exactly as if it had never been saved.
   *
   * Write-back is best-effort: losing a rotated token is bad, but throwing
   * here would mask the real outcome the caller is in the middle of reporting.
   */
  private releaseAttemptDataDir(
    agent: string,
    attemptDataDir: string | undefined,
    jobId: number,
    attemptId: number,
  ): void {
    if (!attemptDataDir) return;
    const credentialSource = this.options.credentialSources?.get(agent);
    if (credentialSource) {
      try {
        const rotated = persistRotatedCredentials(
          credentialSource,
          attemptDataDir,
          this.options.credentialFiles?.get(agent),
        );
        if (rotated.length > 0) {
          this.options.logger.info("credential rotated", {
            jobId,
            attemptId,
            agent,
            files: rotated.join(", "),
          });
        }
      } catch (error) {
        this.options.logger.error("credential write-back failed", {
          jobId,
          attemptId,
          agent,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    removeAttemptDataDir(attemptDataDir);
  }
}
