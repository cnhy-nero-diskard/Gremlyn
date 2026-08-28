import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config/loader.js";
import { extractSupportedEfforts } from "../agent/cline.js";
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
import { JobStore } from "../store/jobs.js";
import type { AgentExecutor, FailureStage, NormalizedEvent, ParsedCommand } from "../types.js";
import { inspectWorkspace } from "../validate/inspection.js";
import { runValidationCommands } from "../validate/runner.js";
import { statusEntries } from "../workspace/gitops.js";
import { prepareWorkspace } from "../workspace/worktree.js";
import { StageFailure, classifyFailure } from "./failures.js";
import { JobQueue, type QueueResult } from "./queue.js";

export interface RuntimeRepository extends RepoConfig {
  id: number;
}

export interface ResolutionOrchestratorOptions {
  db: Database.Database;
  dataDir: string;
  allowedAuthors: string[];
  orchestratorLogin: string;
  timeoutSec: number;
  retries: number;
  github: GitHubClient;
  registry: CommandRegistry;
  executors: ReadonlyMap<string, AgentExecutor>;
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
  ): Promise<QueueResult<{ commitSha?: string }>[]> {
    this.options.logger.info("event observed", { repository: repository.id, pr: event.prNumber });
    const commands = this.options.registry.detect(event.body);
    const results: QueueResult<{ commitSha?: string }>[] = [];
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
      results.push(
        await this.enqueueAttempt(
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
    return results;
  }

  cancel(jobId: number): boolean {
    return this.queue.cancel(jobId);
  }

  async retry(jobId: number): Promise<QueueResult<{ commitSha?: string }>> {
    const job = this.jobs.getJob(jobId);
    const repository = this.repositories.get(job.repo_id);
    if (!repository) throw new Error(`repository ${job.repo_id} is not registered at runtime`);
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
  ): Promise<QueueResult<{ commitSha?: string }>> {
    return this.queue.enqueue({
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
          signal,
        }),
      onRejected: (reason) => this.jobs.finishFailure(jobId, attemptId, "preparing", reason),
      onCancelled: async () => {
        const attempt = this.jobs.getAttempt(attemptId);
        const hasChanges = attempt.workspace_path
          ? (await statusEntries(attempt.workspace_path)).length > 0
          : false;
        this.jobs.cancelJob(jobId, attemptId, hasChanges);
      },
    });
  }

  private async runAttempt(input: {
    jobId: number;
    attemptId: number;
    repository: RuntimeRepository;
    prNumber: number;
    commentId: number;
    model: string;
    command: ParsedCommand;
    signal: AbortSignal;
  }): Promise<{ commitSha?: string }> {
    const { jobId, attemptId, repository, prNumber, commentId, signal } = input;
    let stage: FailureStage = "preparing";
    let workspacePath: string | undefined;
    try {
      this.jobs.setStatus(jobId, stage, attemptId);
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
      });
      workspacePath = workspace.path;
      this.jobs.recordPreparation(attemptId, workspace.path, workspace.headSha);
      this.options.logger.info("workspace prepared", { jobId, attemptId, path: workspace.path });

      stage = "running";
      this.jobs.setStatus(jobId, stage, attemptId);
      const executor = this.options.executors.get(repository.agent);
      if (!executor) throw new StageFailure(stage, "agent-cli-missing");
      const attemptDataDir = join(this.options.dataDir, "attempts", String(attemptId));
      mkdirSync(attemptDataDir, { recursive: true });
      this.options.logger.info("agent launched", { jobId, attemptId, agent: executor.id });
      const agentResult = await executor.run({
        cwd: workspace.path,
        model: input.model,
        provider: repository.provider,
        effort: repository.effort,
        prompt: buildResolutionPrompt(context),
        env: buildAgentEnvironment(),
        timeoutSec: this.options.timeoutSec,
        retries: this.options.retries,
        dataDir: attemptDataDir,
        signal,
      });
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
      if (agentResult.exitCode !== 0) throw new StageFailure(stage, "agent-nonzero-exit");

      stage = "validating";
      this.jobs.setStatus(jobId, stage, attemptId);
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
      this.options.logger.info("job completed", { jobId, attemptId });
      return { commitSha: publication.commitSha };
    } catch (error) {
      if (signal.aborted) throw error;
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
      throw failure;
    }
  }
}
