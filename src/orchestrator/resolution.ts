import type Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RepoConfig } from "../config/loader.js";
import { extractSupportedEfforts } from "../agent/cline.js";
import { serializeOpenCodeAgents, type SerializedOpenCodeAgents } from "../agent/materialize.js";
import {
  cleanupManagedOpencodeFiles,
  ManagedFilesError,
  materializeManagedOpencodeFiles,
  managedOpencodeManifestPath,
  readManagedOpencodeManifest,
} from "../agent/managed-files.js";
import {
  OpenCodeAgentPreflightError,
  preflightManagedOpenCodeAgents,
  type AgentInventoryReader,
  type ManagedAgentPreflightResult,
} from "../agent/managed-preflight.js";
import {
  createCliManagedSessionHttp,
  OpenCodeSessionDiscoveryError,
  OpenCodeSessionSettleError,
  settleAttemptChildren,
  type ManagedAttemptSettlement,
  type ManagedSessionHttp,
} from "../agent/managed-sessions.js";
import { defaultRunner, type ProcessRunner } from "../agent/launcher.js";
import { resolveOpenCodeWorker, type OpenCodeWorker } from "../agent/opencode-worker.js";
import { preflightNativeAgent } from "../agent/native-discovery.js";
import {
  openCodeStreamParentId,
  readOpenCodeInitialIdentity,
  type OpenCodeInitialIdentity,
} from "../agent/opencode-identity.js";
import {
  beginOpenCodeInvocation,
  recordOpenCodeInvocation as recordOpenCodeOwnershipInvocation,
  settleOpenCodeInvocation as settleOpenCodeOwnershipInvocation,
  type OpenCodeOwnershipDescriptor,
} from "../agent/opencode-ownership.js";
import {
  DELEGATION_OBSERVER_CALL_TIMEOUT_MS,
  DELEGATION_OBSERVER_GLOBAL_CONCURRENCY,
  DelegationConcurrencyLimiter,
  DelegationObserver,
  type DelegationCoverageRecord,
  type DelegationGapReason,
  type DelegationInvocationEnd,
  type DelegationInvocationRecord,
  type DelegationObservedNode,
  type DelegationObservationSink,
} from "../agent/delegation-observer.js";
import {
  reconcileDelegationGaps,
  recordDelegationCoverage,
  recordDelegationObservation,
  reportDelegationGap,
} from "../store/delegation-observations.js";
import {
  parseOpenCodeAgentProfile,
  type OpenCodeAgentProfile,
} from "../config/opencode-profile.js";
import {
  persistRotatedCredentials,
  removeAttemptDataDir,
  seedAgentCredentials,
} from "../agent/credentials.js";
import {
  ACTIVITY_LINE_MAPPERS,
  ActivityRecorder,
  writeActivity,
  type ActivityAttribution,
} from "../agent/activity.js";
import { buildAgentEnvironment } from "../agent/environment.js";
import {
  bundledProviderCatalog,
  providerSupportsAgentKind,
  type ProviderCatalogSnapshot,
} from "../agent/provider-catalog.js";
import { writeAgentOutput } from "../agent/output.js";
import { buildResolutionPrompt, type InheritedValidationFailure } from "../agent/prompt.js";
import { reconstructReviewContext } from "../context/review.js";
import { authorizeCommand } from "../gate/authorize.js";
import type { GitHubClient } from "../github/client.js";
import type { CommandRegistry } from "../ingest/commands.js";
import type { Logger } from "../log/logger.js";
import { createRedactor } from "../log/redact.js";
import type { OperatorActionStore } from "../store/actions.js";
import { publishIfEligible } from "../publish/policy.js";
import { reportAttemptOutcome } from "../publish/report.js";
import { JobStore, type AttemptRow, type CapturedOpenCodeSelection } from "../store/jobs.js";
import {
  attemptDataDirFor,
  isAttemptQuarantined,
  quarantineRecordsForWorkspace,
  workspaceHasUnresolvedAttemptOwnership,
} from "./attempt-recovery.js";
import type {
  AgentExecutor,
  AgentResult,
  FailureStage,
  JobStatus,
  NormalizedEvent,
  OpenCodeInvocationSelection,
  ParsedCommand,
} from "../types.js";
import { inspectWorkspace } from "../validate/inspection.js";
import { runValidationCommands } from "../validate/runner.js";
import {
  currentBranch,
  git,
  mergeInProgress,
  statusEntries,
  unmergedEntries,
  workspaceSnapshot,
  type WorkspaceSnapshot,
} from "../workspace/gitops.js";
import { refreshWorkspaceTree } from "../workspace/reset.js";
import {
  collectStrandedDiff,
  prepareWorkspace,
  workspacePathFor,
  WorkspaceError,
  type AdoptionClaimHandle,
  type PreparedWorkspace,
} from "../workspace/worktree.js";
import {
  agentFailureReason,
  isAgentAuthenticationFailure,
  isAgentBillingFailure,
  isAgentModelUnavailable,
  StageFailure,
  classifyFailure,
} from "./failures.js";
import { JobQueue, type QueueResult } from "./queue.js";
import { reactionForStatus } from "./reactions.js";

/** Snapshot cadence for live agent activity: responsive without thrashing disk. */
const ACTIVITY_FLUSH_MS = 400;

/**
 * Fallback bound for child-session settlement when the attempt has no
 * configured timeout. With a configured timeout the parent run and the
 * settlement share that budget ("bounded parent+child total timeout"); with
 * none, the parent can run indefinitely, but settlement must still be bounded
 * so a wedged `opencode api` transport cannot stall the queue forever.
 */
const MANAGED_SETTLE_FALLBACK_BUDGET_MS = 60_000;

/** The per-attempt namespace for generated OpenCode agents, derived from the attempt id. */
function managedAttemptNamespace(attemptId: number): string {
  return `attempt-${attemptId}`;
}

/** The remaining share of the configured attempt timeout, read at settlement time. */
function managedRemainingBudgetMs(
  configuredTimeoutSec: number | undefined,
  runStartedAt: number,
): number {
  if (configuredTimeoutSec === undefined) return MANAGED_SETTLE_FALLBACK_BUDGET_MS;
  return Math.max(0, configuredTimeoutSec * 1000 - (Date.now() - runStartedAt));
}

/**
 * Billing, authentication, and model-route failures are terminal for an
 * invocation: another identical launch cannot repair them, so only transient
 * agent failures consume the retry allowance.
 */
function isTerminalAgentResult(result: AgentResult): boolean {
  return (
    isAgentBillingFailure(result) ||
    isAgentAuthenticationFailure(result) ||
    isAgentModelUnavailable(result)
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * A retry may inherit edits whose provenance is this job's own agent: made by a
 * previous attempt, in this workspace, against this recorded head. That is the
 * admission criterion, not how badly the previous attempt went — the rule the
 * carve-out sits inside exists to stop the orchestrator discarding uncommitted
 * work it cannot vouch for, and work it *can* vouch for is exactly what these
 * cases are.
 *
 * Two shapes qualify. A run that stopped abruptly rather than completing its own
 * cleanup — interrupted, cancelled, timed out, or the agent process exiting
 * nonzero mid-run. And a run that finished cleanly but was blocked at publication
 * because its validation commands failed: its edits are intact and fixing them is
 * precisely what the retry is for. Without that second case every retry of a
 * validation failure dies at `workspace-dirty` before an agent launches, and the
 * only way forward is to throw the work away by hand.
 *
 * No other publication block is admitted. `no-changes` retained nothing;
 * `head-changed` fails the head guard below anyway and its edits were made
 * against a base that has moved; `workspace-conflicted` and `workspace-invalid`
 * are the states the rule protects; `pull-request-closed` has nowhere to publish
 * to. They are excluded by enumerating the one admitted reason, so a reason added
 * later must be admitted deliberately.
 *
 * The deterministic path and recorded head are checked again after GitHub context
 * reconstruction, so a force-push or a manually supplied path cannot turn this
 * into a general dirty-workspace bypass.
 *
 * This is about *uncommitted* edits, which is why an attempt cancelled between
 * its commit and its push is not a case here: it leaves a clean workspace whose
 * head is one commit ahead of origin, and `prepareWorkspace` already recognises
 * that and fast-forward pushes the existing commit. The retry therefore
 * finishes the commit that exists instead of creating a second one, without
 * needing to be admitted as a dirty-workspace resume.
 */
function canResumeRetainedWorkspace(
  attempt: AttemptRow | undefined,
  workspaceRoot: string,
  prNumber: number,
  dataDir: string,
): boolean {
  if (!attempt) return false;
  // A managed attempt that start-up recovery could not prove quiescent for is
  // quarantined: its workspace may still hold generated agent files (private
  // instructions) and a later run must never resume over them. Its durable
  // recovery record is the admission gate (task 3.6).
  if (isAttemptQuarantined(attemptDataDirFor(dataDir, attempt.id))) return false;
  if (!attempt.workspace_path || !attempt.head_sha_at_prepare) return false;
  if (!samePath(attempt.workspace_path, workspacePathFor(workspaceRoot, prNumber))) return false;
  if (attempt.outcome === "interrupted") return true;
  if (attempt.has_uncommitted_changes !== 1) return false;
  if (attempt.outcome === "cancelled") return true;
  if (attempt.outcome !== "failed") return false;
  if (attempt.failure_stage === "running") {
    return (
      attempt.failure_reason === "agent-timeout" || attempt.failure_reason === "agent-nonzero-exit"
    );
  }
  return attempt.failure_stage === "publishing" && attempt.failure_reason === "validation-failed";
}

/**
 * The workspace a retry is permitted to inherit, and the attempt that left it.
 * `attemptId` is carried so a resumed retry can read that attempt's failing
 * validation run: the agent has to be told what its predecessor's edits failed.
 */
interface RetainedWorkspace {
  attemptId: number;
  workspacePath: string;
  headSha: string;
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
  dataDir: string,
): AttemptRow | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (!attempt) continue;
    if (!attempt.workspace_path) continue;
    return canResumeRetainedWorkspace(attempt, workspaceRoot, prNumber, dataDir)
      ? attempt
      : undefined;
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
  /** Durable operator-selected provider, alongside model and effort. */
  provider: string;
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
  operatorActions?: Pick<OperatorActionStore, "record">;
  /** Provider/executor pairing reference; defaults to the bundled catalog. */
  providerCatalog?: ProviderCatalogSnapshot;
  /**
   * Managed-OpenCode seams (tasks 3.2-3.5 integration). Every field defaults
   * to the pinned production path — the `opencode api` CLI under the
   * attempt's exact cwd and environment for child-session settlement, and
   * the `opencode debug agents` probe for the preflight — so only tests have
   * reason to inject fakes.
   */
  managedOpenCode?: {
    /**
     * Session transport for settlement; receives the resolved
     * {@link OpenCodeWorker} (alias, binary, pinned version, cwd, sanitized
     * environment and launcher) the attempt's parent run used, so native,
     * default and managed trees all talk to the same OpenCode service.
     * Defaults to {@link createCliManagedSessionHttp}.
     */
    sessionHttp?: (worker: OpenCodeWorker) => ManagedSessionHttp;
    /** Agent-inventory source for the preflight; defaults to the CLI reader. */
    preflightInventory?: AgentInventoryReader;
    preflightPollIntervalMs?: number;
    preflightPollBudgetMs?: number;
    settlePollIntervalMs?: number;
    settleInterruptGraceMs?: number;
    /** Overall bound for a native-agent workspace preflight (tests). */
    nativePreflightBudgetMs?: number;
    nativePreflightPollIntervalMs?: number;
    /**
     * Resolve the exact worker context (binary/pinned version/launcher) for a
     * configured executor alias. Defaults to the binary/launcher the executor
     * itself exposes, else the alias id and the common launcher. Production
     * startup supplies the configured alias binary here.
     */
    resolveWorker?: (input: { executorId: string; cwd: string; env: Record<string, string> }) => {
      binary?: string;
      version?: string;
      runner?: ProcessRunner;
    };
  };
  /**
   * Live delegation-observation seam (tasks 3.1-3.4; design D1/D2/D4). Absent
   * disables live observation entirely — no timers, no transport reads, no store
   * writes — so existing behavior is unchanged. The parent supplies the sink
   * factory once the durable store is wired; {@link createStoreDelegationSink}
   * adapts the observation store for that purpose.
   *
   * Observation is strictly failure-isolated: a sink or transport fault is
   * caught inside the observer and can never change an attempt's outcome,
   * safety proofs, cancellation, or publication gates.
   */
  delegationObservation?: {
    createSink: (input: {
      attemptId: number;
      ordinal: number;
      workspacePath: string;
    }) => DelegationObservationSink;
    pollIntervalMs?: number;
    perCallTimeoutMs?: number;
    /** Process-wide cap on concurrent observation reads; defaults to 4. */
    globalConcurrencyLimit?: number;
  };
}

/**
 * The running state of a managed OpenCode attempt (tasks 3.2-3.5): the
 * serialized agent contract, the journaled manifest location, and the captured
 * profile revision. Only ever present when the resolved executor is the
 * `opencode` one AND the job carried a dashboard profile snapshot.
 */
interface ManagedAttemptContext {
  readonly namespace: string;
  readonly revision: number | null;
  readonly serialized: SerializedOpenCodeAgents;
  readonly primaryRuntimeId: string;
  readonly manifestPath: string;
}

/**
 * Whether a failure path finished a managed attempt's finalization. `clean`
 * means child sessions were provably quiescent (or nothing had been spawned)
 * and the generated files were removed; `uncertain` means quiescence could not
 * be proven, so no validation or publication may begin, the manifest and data
 * dir must survive for recovery, and the recorded failure must be the managed
 * quiescence/cleanup reason rather than a retriable agent failure.
 */
type ManagedRemediation =
  { readonly status: "clean" } | { readonly status: "uncertain"; readonly failure: StageFailure };

/**
 * The per-attempt OpenCode lifecycle state for any executor whose actual id is
 * `opencode` — managed, native, or default (tasks 3.2/3.3/4.2/4.3). Unlike the
 * managed-only {@link ManagedAttemptContext}, this exists for EVERY OpenCode
 * launch, because the child-quiescence boundary now applies to native and
 * default runs too: a parent CLI exiting proves nothing about its service-owned
 * descendants.
 */
interface OpenCodeAttemptContext {
  readonly attemptId: number;
  readonly selection: CapturedOpenCodeSelection;
  /** The managed contract, only when the captured source is managed. */
  readonly managed: ManagedAttemptContext | undefined;
  /** The captured native id, only when the captured source is native. */
  readonly nativeId: string | undefined;
  readonly worker: OpenCodeWorker;
  /** The registered executor kind (`opencode`), as recovery reconciles it. */
  readonly executorKind: string;
  readonly attemptDataDir: string;
  /** True once a journaled parent invocation has been attempted. */
  launched: boolean;
  /** True once managed generated files have been cleaned for this attempt. */
  managedFinalized: boolean;
  /** Set when quiescence, settlement persistence, or managed cleanup is unproven. */
  unproven: StageFailure | undefined;
}

/** One tracked parent invocation within an OpenCode attempt. */
interface OpenCodeInvocationState {
  readonly invocationId: number;
  readonly ordinal: number;
  parentSessionId: string | undefined;
  /** A synchronous ownership-persistence failure observed in the run stream. */
  persistenceFailure: Error | undefined;
  identity: OpenCodeInitialIdentity;
  /**
   * The invocation-scoped live observer (tasks 3.1-3.4), or `undefined` when
   * observation is not configured. It is read-only and failure-isolated: it can
   * never contribute to `persistenceFailure`, cancel the run, or alter any
   * safety proof. A retry receives a NEW invocation with its own observer, so
   * an earlier root's tree is never reused or overwritten.
   */
  observer: DelegationObserver | undefined;
  /**
   * Removes the cancellation listener wired to this observer. A cancel request
   * sets an observation flag only — it never stops observation or interrupts a
   * session — so the confirmed runtime interruption can still be observed.
   */
  observerCleanup: (() => void) | undefined;
}

export class ResolutionOrchestrator {
  private readonly jobs: JobStore;
  private readonly queue: JobQueue<{ commitSha?: string }>;
  private readonly repositories = new Map<number, RuntimeRepository>();
  private readonly redact: (value: string) => string;
  /** Lazily created, shared by every observer so reads stay globally bounded. */
  private delegationLimiterInstance: DelegationConcurrencyLimiter | undefined;
  /** Every live observer, so daemon teardown can dispose them all. */
  private readonly delegationObservers = new Set<DelegationObserver>();

  constructor(private readonly options: ResolutionOrchestratorOptions) {
    this.jobs = new JobStore(options.db);
    this.queue = new JobQueue(options.concurrency);
    this.redact = createRedactor(options.secrets);
  }

  registerRepository(repository: RuntimeRepository): void {
    this.repositories.set(repository.id, repository);
  }

  async handleEvent(repository: RuntimeRepository, event: NormalizedEvent): Promise<QueuedJob[]> {
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
      const executorKind = this.options.executors.get(repository.agent)?.id;
      const claimed = this.jobs.createJob({
        repoId: repository.id,
        ...(executorKind === undefined ? {} : { executorKind }),
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
      this.options.dataDir,
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
      { name: job.command },
      canResumeRetainedWorkspace(
        priorAttempt,
        repository.workspaceRoot,
        job.pr_number,
        this.options.dataDir,
      )
        ? {
            attemptId: priorAttempt!.id,
            workspacePath: priorAttempt!.workspace_path!,
            headSha: priorAttempt!.head_sha_at_prepare!,
          }
        : undefined,
    );
  }

  /**
   * The validation command that blocked a previous attempt, with its captured
   * output, for a retry resuming that attempt's edits.
   *
   * The runner stops at the first failure and records at most one nonzero row,
   * so the newest one is the command the retry has to make pass. Output was
   * redacted when it was captured; nothing here reads a raw stream.
   *
   * Every failure to reconstruct it is swallowed. Retained artifacts are
   * reclaimed on a schedule, so an output file that has aged out is an ordinary
   * state, not a fault — the attempt runs with a thinner prompt rather than
   * failing over a file the agent only needed for context.
   */
  private inheritedValidationFailure(attemptId: number): InheritedValidationFailure | undefined {
    const row = this.options.db
      .prepare(
        `SELECT command, exit_code, output_ref FROM validation_runs
           WHERE attempt_id = ? AND exit_code != 0
           ORDER BY seq DESC LIMIT 1`,
      )
      .get(attemptId) as { command: string; exit_code: number; output_ref: string } | undefined;
    if (row === undefined) return undefined;
    let command: string[];
    try {
      const parsed: unknown = JSON.parse(row.command);
      if (!Array.isArray(parsed)) return undefined;
      command = parsed.map(String);
    } catch {
      return undefined;
    }
    let output = "";
    try {
      const captured = JSON.parse(readFileSync(row.output_ref, "utf8")) as {
        stdout?: string;
        stderr?: string;
      };
      output = [captured.stdout ?? "", captured.stderr ?? ""]
        .filter((part) => part.length > 0)
        .join("\n");
    } catch (error) {
      this.options.logger.debug("inherited validation output unavailable", {
        attemptId,
        outputRef: row.output_ref,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { command, exitCode: row.exit_code, output };
  }

  /**
   * Prepare the workspace, pulling remote state first on every path.
   *
   * `prepareWorkspace` already fetches before reasoning, but a retry wedged by
   * the fail-and-retry sequence needs more: a prior attempt blocked by
   * `head-changed` — or by `validation-failed` on a head the pull request no
   * longer has — leaves uncommitted work against a superseded head, so the
   * next preparation fails as `workspace-dirty` forever.
   * When that exact wedge is detected the stranded work is quarantined to a
   * patch artifact, the workspace is reset to the current head through the
   * guarded reset path, and preparation continues clean. Anything else —
   * conflicted state, wrong branch, a head that did not move, or a prior
   * failure that is not `head-changed` — keeps the classic halt so uncommitted
   * work is never reinterpreted.
   */
  private async prepareWorkspaceForAttempt(input: {
    jobId: number;
    attemptId: number;
    repository: RuntimeRepository;
    prNumber: number;
    headBranch: string;
    headSha: string;
    seedFiles: readonly string[] | undefined;
    resumeDirtyWorkspace: boolean;
    adoptExistingCheckout: boolean | undefined;
  }): Promise<PreparedWorkspace> {
    const {
      jobId,
      attemptId,
      repository,
      prNumber,
      headBranch,
      headSha: expectedSha,
      seedFiles,
      resumeDirtyWorkspace,
      adoptExistingCheckout,
    } = input;
    // A workspace quarantined by startup recovery (task 3.6) may still hold the
    // crashed attempt's generated agent files — including paths git ignores, so
    // a clean-tree check would never see them. Every admission is gated BEFORE
    // preparation so the stale old profile can never be discovered or published
    // by a later run, whether that run is a fresh job or a retry.
    const quarantineRecords = quarantineRecordsForWorkspace(
      this.options.dataDir,
      workspacePathFor(repository.workspaceRoot, prNumber),
    );
    if (quarantineRecords.length > 0) {
      const record = quarantineRecords[0]!;
      throw new StageFailure(
        "preparing",
        "workspace-quarantined",
        `workspace ${workspacePathFor(repository.workspaceRoot, prNumber)} is quarantined by ` +
          `start-up recovery (attempt ${record.attemptId}, ${record.reason}); its owned ` +
          "generated files cannot be accounted for safely, so this attempt is refused",
      );
    }
    // Generic OpenCode ownership (tasks 3.3/4.2): a workspace named by an
    // attempt whose invocation tree has NOT been proven quiescent stays
    // unavailable even before start-up recovery has journaled a quarantine
    // record. The unresolved ownership journal is the durable gate, so a
    // native/default tree that may still be running can never be reused,
    // resumed or published over — including under a workspace alias that
    // predates the recovery record.
    const ownershipWorkspace = workspacePathFor(repository.workspaceRoot, prNumber);
    if (workspaceHasUnresolvedAttemptOwnership(this.options.dataDir, ownershipWorkspace)) {
      throw new StageFailure(
        "preparing",
        "workspace-quarantined",
        `workspace ${ownershipWorkspace} is owned by an attempt whose OpenCode invocation tree ` +
          "has not been proven quiescent; it cannot be reused, resumed or published over",
      );
    }
    try {
      return await prepareWorkspace({
        sourcePath: repository.sourcePath,
        workspaceRoot: repository.workspaceRoot,
        prNumber,
        headBranch,
        headSha: expectedSha,
        ...(seedFiles === undefined ? {} : { seedFiles }),
        resumeDirtyWorkspace,
        ...(adoptExistingCheckout === undefined ? {} : { adoptExistingCheckout }),
        attemptId,
        ...(this.options.operatorActions === undefined
          ? {}
          : { actions: this.options.operatorActions }),
      });
    } catch (error) {
      const refreshed = await this.refreshStaleWorkspaceForRetry({
        jobId,
        repository,
        prNumber,
        headBranch,
        expectedSha,
        seedFiles,
        workspaceError: error,
        resumeRetained: resumeDirtyWorkspace,
      });
      if (refreshed === undefined) throw error;
      this.options.logger.info("retry continues on a refreshed workspace", {
        jobId,
        attemptId,
        path: refreshed.path,
      });
      return refreshed;
    }
  }

  /**
   * Quarantine stranded publishing-block work and reset to the moved head.
   *
   * Returns the freshly prepared workspace, or `undefined` when this wedge
   * does not apply and the original `workspace-dirty` must stand.
   */
  private async refreshStaleWorkspaceForRetry(input: {
    jobId: number;
    repository: RuntimeRepository;
    prNumber: number;
    headBranch: string;
    expectedSha: string;
    seedFiles: readonly string[] | undefined;
    workspaceError: unknown;
    resumeRetained: boolean;
  }): Promise<PreparedWorkspace | undefined> {
    const actions = this.options.operatorActions;
    if (actions === undefined) return undefined;
    if (
      !(input.workspaceError instanceof WorkspaceError) ||
      input.workspaceError.reason !== "workspace-dirty" ||
      input.resumeRetained
    ) {
      return undefined;
    }
    const workspacePath = workspacePathFor(input.repository.workspaceRoot, input.prNumber);
    if (!existsSync(workspacePath)) return undefined;
    // A managed attempt that start-up recovery could not prove quiescent for is
    // quarantined. Its workspace may still hold generated agent files that are
    // evidence; the guarded reset path must never discard them (task 3.6).
    if (quarantineRecordsForWorkspace(this.options.dataDir, workspacePath).length > 0) {
      return undefined;
    }
    try {
      if ((await currentBranch(workspacePath)) !== input.headBranch) return undefined;
      if ((await unmergedEntries(workspacePath)).length > 0) return undefined;
      if (await mergeInProgress(workspacePath)) return undefined;
    } catch {
      return undefined;
    }
    // Only a prior attempt of this job that retained uncommitted work after a
    // publishing block qualifies: `head-changed`, or `validation-failed`
    // whose recorded head no longer matches (a same-head validation failure
    // resumes instead and never reaches here with the head unmoved). Any other
    // publishing failure keeps the halt.
    const attempts = this.jobs.listAttempts(input.jobId);
    let prior: AttemptRow | undefined;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      if (!attempt?.workspace_path || !samePath(attempt.workspace_path, workspacePath)) continue;
      if (
        attempt.has_uncommitted_changes === 1 &&
        attempt.outcome === "failed" &&
        attempt.failure_stage === "publishing" &&
        (attempt.failure_reason === "head-changed" ||
          attempt.failure_reason === "validation-failed") &&
        attempt.head_sha_at_prepare
      ) {
        prior = attempt;
      }
      break;
    }
    if (!prior?.head_sha_at_prepare) return undefined;
    // A prior attempt quarantined by start-up recovery must not be reset into:
    // generated content it owned is evidence, and this reset would discard it.
    if (isAttemptQuarantined(attemptDataDirFor(this.options.dataDir, prior.id))) return undefined;
    let workspaceSnapshotAtCollection: WorkspaceSnapshot;
    try {
      workspaceSnapshotAtCollection = await workspaceSnapshot(workspacePath);
    } catch {
      return undefined;
    }
    if (
      workspaceSnapshotAtCollection.headSha === input.expectedSha ||
      workspaceSnapshotAtCollection.headSha !== prior.head_sha_at_prepare
    ) {
      return undefined;
    }

    // Pull remote state first (inside the collector), then preserve the
    // stranded work non-destructively before anything is reset.
    let diff: { files: string[]; patch: string; stashSha: string | null };
    try {
      diff = await collectStrandedDiff(workspacePath);
      const afterCollection = await workspaceSnapshot(workspacePath);
      if (
        afterCollection.headSha !== workspaceSnapshotAtCollection.headSha ||
        afterCollection.status !== workspaceSnapshotAtCollection.status ||
        afterCollection.fingerprint !== workspaceSnapshotAtCollection.fingerprint
      ) {
        this.options.logger.warn("stranded workspace changed during collection; keeping halt", {
          jobId: input.jobId,
          path: workspacePath,
        });
        return undefined;
      }
    } catch (error) {
      this.options.logger.warn("stranded workspace collection failed; keeping halt", {
        jobId: input.jobId,
        path: workspacePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    const outputDir = join(this.options.dataDir, "output");
    mkdirSync(outputDir, { recursive: true });
    const patchRef = join(outputDir, `stranded-job-${input.jobId}-attempt-${prior.id}.patch`);
    const header = [
      "# stranded work quarantined before retry (pull request head moved)",
      `# job: ${input.jobId} prior attempt: ${prior.id}`,
      `# prior head: ${prior.head_sha_at_prepare} workspace head: ${workspaceSnapshotAtCollection.headSha}`,
      `# current head: ${input.expectedSha}`,
      `# files: ${diff.files.length > 0 ? diff.files.join(", ") : "(none listed)"}`,
      `# stash: ${diff.stashSha ?? "(none)"}`,
      `# restore with: git apply ${`stranded-job-${input.jobId}-attempt-${prior.id}.patch`}`,
      "",
    ].join("\n");
    try {
      writeFileSync(patchRef, `${header}${diff.patch}`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.options.logger.warn("stranded workspace patch write failed; keeping halt", {
        jobId: input.jobId,
        path: workspacePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    const patchCheckRoot = mkdtempSync(join(tmpdir(), "gremlyn-patch-check-"));
    const patchCheckPath = join(patchCheckRoot, "workspace");
    try {
      await git(
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.eol=lf",
          "worktree",
          "add",
          "--detach",
          patchCheckPath,
          prior.head_sha_at_prepare,
        ],
        { cwd: workspacePath },
      );
      await git(["-c", "core.autocrlf=false", "apply", patchRef], { cwd: patchCheckPath });
    } catch (error) {
      this.options.logger.warn("stranded workspace patch validation failed; keeping halt", {
        jobId: input.jobId,
        path: workspacePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      try {
        await git(["worktree", "remove", "--force", patchCheckPath], { cwd: workspacePath });
      } catch {
        // Best-effort cleanup; the original workspace remains untouched.
      }
      rmSync(patchCheckRoot, { recursive: true, force: true });
    }
    this.options.logger.info(
      "stranded workspace quarantine validated; refreshing to current head",
      {
        jobId: input.jobId,
        priorAttemptId: prior.id,
        workspaceHead: workspaceSnapshotAtCollection.headSha,
        expectedHead: input.expectedSha,
        patchRef,
      },
    );
    // In-place refresh, not remove-and-recreate: `git clean -fd` keeps ignored
    // files, so an installed node_modules survives and the refreshed workspace
    // can still validate. A final preparation re-verifies the state and seeds
    // ignored files.
    try {
      await refreshWorkspaceTree({
        workspaceRoot: input.repository.workspaceRoot,
        prNumber: input.prNumber,
        headSha: input.expectedSha,
        expectedSnapshot: workspaceSnapshotAtCollection,
        actions,
        auditContext: {
          jobId: input.jobId,
          priorAttemptId: prior.id,
          priorHead: prior.head_sha_at_prepare,
          expectedHead: input.expectedSha,
          priorFailureReason: prior.failure_reason,
          patchRef,
        },
        refreshContext: {
          workspaceHead: workspaceSnapshotAtCollection.headSha,
          files: diff.files,
          stashSha: diff.stashSha,
        },
      });
    } catch (error) {
      this.options.logger.warn("stranded workspace changed before refresh; keeping halt", {
        jobId: input.jobId,
        path: workspacePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    return prepareWorkspace({
      sourcePath: input.repository.sourcePath,
      workspaceRoot: input.repository.workspaceRoot,
      prNumber: input.prNumber,
      headBranch: input.headBranch,
      headSha: input.expectedSha,
      ...(input.seedFiles === undefined ? {} : { seedFiles: input.seedFiles }),
      ...(actions === undefined ? {} : { actions }),
    });
  }

  private enqueueAttempt(
    jobId: number,
    attemptId: number,
    repository: RuntimeRepository,
    prNumber: number,
    commentId: number,
    model: string,
    command: ParsedCommand,
    retainedWorkspace?: RetainedWorkspace,
  ): QueuedJob {
    // Shared with the running attempt: when OpenCode ownership or managed
    // cleanup is unresolved, both failure and cancellation must leave the
    // manifest and data dir in place for recovery.
    const preserveDataDir: { value: boolean; failure?: StageFailure } = { value: false };
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
          preserveDataDir,
        }),
      onRejected: async (reason) => {
        this.jobs.finishFailure(jobId, attemptId, "preparing", reason);
        await this.reactToStatus(repository, commentId, "failed");
      },
      onCancelled: async () => {
        if (preserveDataDir.failure !== undefined) {
          const failure = preserveDataDir.failure;
          this.jobs.recordFailureDetail(attemptId, {
            stage: failure.stage,
            reason: failure.reason,
            hasUncommittedChanges: true,
          });
          // Task 4.4: an OpenCode attempt cancelled with unresolved ownership or
          // cleanup persists the specific failure detail alongside its reason.
          if (failure.message.length > 0 && failure.message !== failure.reason) {
            this.recordManagedFailureDetail(attemptId, failure.message);
          }
          this.jobs.finishFailure(jobId, attemptId, failure.stage, failure.reason);
          await this.reactToStatus(repository, commentId, "failed");
          return;
        }
        const attempt = this.jobs.getAttempt(attemptId);
        const hasChanges = attempt.workspace_path
          ? (await statusEntries(attempt.workspace_path)).length > 0
          : false;
        this.jobs.cancelJob(jobId, attemptId, hasChanges);
        await this.reactToStatus(repository, commentId, "cancelled");
        // 4.3: seeded credential must be removed even on cancellation. An
        // OpenCode attempt with unresolved ownership or cleanup keeps its
        // manifest and data dir instead so recovery can account for its state.
        const attemptDataDir = join(this.options.dataDir, "attempts", String(attemptId));
        if (!preserveDataDir.value) removeAttemptDataDir(attemptDataDir);
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

  /**
   * Resolve and validate the attempt's managed OpenCode contract from the job's
   * captured profile snapshot (task 3.2). Runs only when the actual executor is
   * the `opencode` one, per the snapshot gate; a repository whose agent maps to
   * any other executor never consults the snapshot. Fails closed when the
   * snapshot is present but unusable: a stored profile that no longer parses
   * must not silently degrade to an unmanaged run.
   */
  private resolveManagedContract(input: {
    jobId: number;
    attemptId: number;
    stage: FailureStage;
  }): ManagedAttemptContext | undefined {
    const job = this.jobs.getJob(input.jobId);
    const profileJson = job.opencode_profile_json;
    if (profileJson === null) return undefined;
    let profile: OpenCodeAgentProfile;
    try {
      profile = parseOpenCodeAgentProfile(JSON.parse(profileJson) as unknown);
    } catch (error) {
      throw new StageFailure(
        input.stage,
        "managed-profile-corrupt",
        `the captured OpenCode profile for job ${input.jobId} is unusable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const namespace = managedAttemptNamespace(input.attemptId);
    let serialized: SerializedOpenCodeAgents;
    try {
      serialized = serializeOpenCodeAgents({ profile, namespace });
    } catch (error) {
      throw new StageFailure(
        input.stage,
        "managed-profile-corrupt",
        `the captured OpenCode profile for job ${input.jobId} cannot be serialized for ` +
          `attempt ${input.attemptId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      namespace,
      revision: job.opencode_profile_revision,
      serialized,
      primaryRuntimeId: serialized.primaryRuntimeId,
      manifestPath: managedOpencodeManifestPath(
        join(this.options.dataDir, "attempts", String(input.attemptId)),
      ),
    };
  }

  /**
   * Materialize the serialized agent files into the prepared worktree (task
   * 3.2) and prove the generated team is effective for the attempt location
   * under the exact cwd and environment the run will receive (task 3.3). The
   * manifest is journaled outside the worktree, inside the attempt data dir,
   * before a single generated byte lands in the worktree.
   *
   * Materialization and preflight failures are configuration failures: the
   * operator's team is what is wrong, and no amount of retrying the available
   * agent helps. They are mapped to distinct reasons and thrown here so the
   * attempt records them before any agent work runs.
   */
  private async configureManagedAttempt(input: {
    managed: ManagedAttemptContext;
    jobId: number;
    attemptId: number;
    workspacePath: string;
    agentEnv: Record<string, string>;
    worker: OpenCodeWorker;
    signal: AbortSignal;
    stage: FailureStage;
  }): Promise<void> {
    const { managed } = input;
    try {
      await materializeManagedOpencodeFiles({
        workspacePath: input.workspacePath,
        manifestPath: managed.manifestPath,
        serialized: managed.serialized,
        ...(managed.revision === null ? {} : { profileFingerprint: `v${managed.revision}` }),
      });
    } catch (error) {
      if (error instanceof ManagedFilesError) {
        throw new StageFailure(input.stage, "managed-materialize-failed", error.message);
      }
      throw error;
    }
    let preflight: ManagedAgentPreflightResult;
    try {
      preflight = await preflightManagedOpenCodeAgents({
        agents: managed.serialized,
        cwd: input.workspacePath,
        env: input.agentEnv,
        binary: input.worker.binary,
        runner: input.worker.runner,
        signal: input.signal,
        ...(this.options.managedOpenCode?.preflightInventory === undefined
          ? {}
          : { inventory: this.options.managedOpenCode.preflightInventory }),
        ...(this.options.managedOpenCode?.preflightPollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: this.options.managedOpenCode.preflightPollIntervalMs }),
        ...(this.options.managedOpenCode?.preflightPollBudgetMs === undefined
          ? {}
          : { pollBudgetMs: this.options.managedOpenCode.preflightPollBudgetMs }),
      });
    } catch (error) {
      if (error instanceof OpenCodeAgentPreflightError) {
        throw new StageFailure(input.stage, "managed-preflight-failed", error.message);
      }
      throw error;
    }
    this.options.logger.info("managed attempt configured", {
      jobId: input.jobId,
      attemptId: input.attemptId,
      namespace: managed.namespace,
      revision: managed.revision,
      primary: managed.primaryRuntimeId,
      files: managed.serialized.files.length,
      verifiedChildren: preflight.verifiedChildren.length,
      preflightPolls: preflight.polls,
    });
  }

  /* ------------------------------------------------------------------ *
   * Generic OpenCode attempt lifecycle (tasks 3.2/3.3/4.2/4.3)
   * ------------------------------------------------------------------ */

  /**
   * Resolve the exact worker descriptor for an executor alias: the configured
   * binary/pinned version/launcher plus the attempt workspace and sanitized
   * environment. One descriptor is shared by preflight, execution, session
   * transport, ownership journaling and recovery, so an alias can never drift
   * to the default `opencode` binary mid-attempt (design D3).
   */
  private openCodeWorkerFor(
    executor: AgentExecutor,
    executorId: string,
    cwd: string,
    env: Record<string, string>,
  ): OpenCodeWorker {
    // The executor's own descriptor is authoritative: it carries the actual
    // configured binary and process runner, so production never falls back to
    // a default `opencode`.
    const fromExecutor = executor.resolveWorker?.({ executorId, cwd, env });
    if (fromExecutor !== undefined) return fromExecutor;
    const resolved = this.options.managedOpenCode?.resolveWorker?.({ executorId, cwd, env });
    const binary = resolved?.binary;
    const runner = resolved?.runner ?? defaultRunner;
    return resolveOpenCodeWorker({
      executorId,
      ...(binary === undefined ? {} : { binary }),
      cwd,
      env,
      runner,
    });
  }

  /**
   * Resolve the job's captured primary source into the attempt's OpenCode
   * context. Only a managed source materializes generated files or runs the
   * managed permission/model preflight; a native source is validated against
   * the actual prepared workspace by {@link preflightNativeAttempt}; default
   * carries no explicit selection. A corrupt capture fails closed with a
   * distinct configuration reason rather than silently substituting an agent.
   */
  private resolveOpenCodeContext(input: {
    executor: AgentExecutor;
    executorAlias: string;
    jobId: number;
    attemptId: number;
    workspacePath: string;
    agentEnv: Record<string, string>;
    stage: FailureStage;
  }): OpenCodeAttemptContext {
    const worker = this.openCodeWorkerFor(
      input.executor,
      input.executorAlias,
      input.workspacePath,
      input.agentEnv,
    );
    const attemptDataDir = join(this.options.dataDir, "attempts", String(input.attemptId));
    let selection: CapturedOpenCodeSelection;
    try {
      selection = this.jobs.resolveCapturedSelection(input.jobId);
    } catch (error) {
      throw new StageFailure(
        input.stage,
        "managed-profile-corrupt",
        `the OpenCode primary selection captured for job ${input.jobId} is unusable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let managed: ManagedAttemptContext | undefined;
    let nativeId: string | undefined;
    if (selection.source === "managed") {
      managed = this.resolveManagedContract({
        jobId: input.jobId,
        attemptId: input.attemptId,
        stage: input.stage,
      });
      if (managed === undefined) {
        throw new StageFailure(
          input.stage,
          "managed-profile-corrupt",
          `job ${input.jobId} captured the managed OpenCode source but its captured profile ` +
            "is missing or unusable; no agent may run",
        );
      }
    } else if (selection.source === "native") {
      nativeId = selection.agentId;
    }
    return {
      attemptId: input.attemptId,
      selection,
      managed,
      nativeId,
      worker,
      executorKind: input.executor.id,
      attemptDataDir,
      launched: false,
      managedFinalized: false,
      unproven: undefined,
    };
  }

  /**
   * Materialize/verify a managed team in the actual prepared attempt workspace
   * (task 3.2) before any agent work. Because it runs with the same worker
   * execution will use, a generated agent that cannot be applied fails with a
   * configuration reason instead of spawning or falling back. Native/default
   * sources have no initial configure step; their per-invocation validation is
   * {@link preflightNativeAttempt}.
   */
  private async configureOpenCodeAttempt(input: {
    context: OpenCodeAttemptContext;
    jobId: number;
    attemptId: number;
    agentEnv: Record<string, string>;
    signal: AbortSignal;
    stage: FailureStage;
  }): Promise<void> {
    const { context } = input;
    if (context.managed === undefined) return;
    await this.configureManagedAttempt({
      managed: context.managed,
      jobId: input.jobId,
      attemptId: input.attemptId,
      workspacePath: context.worker.cwd,
      agentEnv: input.agentEnv,
      worker: context.worker,
      signal: input.signal,
      stage: input.stage,
    });
  }

  /** Validate a captured native id against the attempt workspace inventory. */
  private async preflightNativeAttempt(input: {
    context: OpenCodeAttemptContext;
    agentId: string;
    signal: AbortSignal;
    stage: FailureStage;
  }): Promise<void> {
    const outcome = await preflightNativeAgent({
      worker: input.context.worker,
      agentId: input.agentId,
      signal: input.signal,
      ...(this.options.managedOpenCode?.preflightInventory === undefined
        ? {}
        : { inventory: this.options.managedOpenCode.preflightInventory }),
      ...(this.options.managedOpenCode?.nativePreflightBudgetMs === undefined
        ? {}
        : { budgetMs: this.options.managedOpenCode.nativePreflightBudgetMs }),
      ...(this.options.managedOpenCode?.nativePreflightPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.options.managedOpenCode.nativePreflightPollIntervalMs }),
    });
    if (outcome.status === "ok") {
      this.options.logger.info("native OpenCode agent verified", {
        attemptId: input.context.attemptId,
        agentId: input.agentId,
        directory: input.context.worker.cwd,
        polls: outcome.polls,
      });
      return;
    }
    throw new StageFailure(
      input.stage,
      "managed-preflight-failed",
      `native OpenCode agent ${JSON.stringify(input.agentId)} cannot be applied in the attempt ` +
        `workspace ${input.context.worker.cwd}: ${outcome.reason}`,
    );
  }

  /** The discriminated intent the executor receives for an OpenCode launch. */
  private selectionForRun(context: OpenCodeAttemptContext): OpenCodeInvocationSelection {
    switch (context.selection.source) {
      case "managed":
        return { source: "managed", agentId: context.managed!.primaryRuntimeId };
      case "native":
        return { source: "native", agentId: context.nativeId! };
      default:
        return { source: "default" };
    }
  }

  /**
   * Journal a new invocation's launch uncertainty BEFORE the process spawns:
   * the durable filesystem ownership record first (the artifact recovery and
   * workspace admission read), then the database invocation row. Either write
   * failing aborts the launch — an unjournaled OpenCode invocation has no
   * recoverable ownership evidence. The ordinal is strictly increasing, so a
   * later invocation never overwrites an earlier one's evidence.
   */
  private beginOpenCodeInvocation(input: {
    context: OpenCodeAttemptContext;
    stage: FailureStage;
  }): OpenCodeInvocationState {
    const { context } = input;
    const descriptor: OpenCodeOwnershipDescriptor = {
      executor: context.executorKind,
      binary: context.worker.binary,
      version: context.worker.version,
      workspacePath: context.worker.cwd,
      source: context.selection.source,
      nativeId: context.selection.source === "native" ? context.selection.agentId : null,
    };
    beginOpenCodeInvocation({
      attemptDataDir: context.attemptDataDir,
      attemptId: context.attemptId,
      descriptor,
    });
    const journaled = this.jobs.journalOpenCodeInvocation({
      attemptId: context.attemptId,
      requestedSource: context.selection.source,
      requestedNativeAgentId:
        context.selection.source === "native" ? context.selection.agentId : null,
      requestedProfileRevision:
        context.selection.source === "managed" ? context.selection.profileRevision : null,
      binary: context.worker.binary,
      workspacePath: context.worker.cwd,
    });
    return {
      invocationId: journaled.invocationId,
      ordinal: journaled.ordinal,
      parentSessionId: undefined,
      persistenceFailure: undefined,
      identity: {},
      observer: undefined,
      observerCleanup: undefined,
    };
  }

  /* ------------------------------------------------------------------ *
   * Live delegation observation (tasks 3.1-3.4)
   * ------------------------------------------------------------------ *
   *
   * Observation is a strictly read-only, failure-isolated companion to the
   * safety settlement. It starts with the invocation (before the parent is
   * spawned), attaches the root as soon as the run stream exposes it, keeps
   * reconciling through settlement, then finalizes. Nothing here may throw into
   * the attempt: a failure to start, poll, persist or finalize is logged and
   * otherwise ignored.
   */

  /** Lazily create the process-wide observation read limiter. */
  private delegationLimiter(limit: number | undefined): DelegationConcurrencyLimiter {
    if (this.delegationLimiterInstance === undefined) {
      this.delegationLimiterInstance = new DelegationConcurrencyLimiter(
        limit ?? DELEGATION_OBSERVER_GLOBAL_CONCURRENCY,
      );
    }
    return this.delegationLimiterInstance;
  }

  /**
   * Start the invocation-scoped observer with the EXACT worker descriptor the
   * run uses (same binary/cwd/env/runner → same OpenCode service). A sink
   * factory or observer construction failure disables observation for this
   * invocation only, records a best-effort unavailable coverage/gap where a
   * sink is available, and never affects the run.
   */
  private beginDelegationObservation(input: {
    context: OpenCodeAttemptContext;
    invocation: OpenCodeInvocationState;
    attemptId: number;
    signal: AbortSignal;
  }): DelegationObserver | undefined {
    const seam = this.options.delegationObservation;
    if (seam === undefined) return undefined;
    const factoryInput = {
      attemptId: input.attemptId,
      ordinal: input.invocation.ordinal,
      workspacePath: input.context.worker.cwd,
    };
    let sink: DelegationObservationSink;
    try {
      sink = seam.createSink(factoryInput);
    } catch {
      // No sink to write coverage through; a safe diagnostic only.
      this.options.logger.warn("delegation observation sink factory failed; observation disabled", {
        attemptId: input.attemptId,
        invocation: input.invocation.ordinal,
      });
      return undefined;
    }
    let observer: DelegationObserver;
    try {
      observer = new DelegationObserver({
        attemptId: input.attemptId,
        ordinal: input.invocation.ordinal,
        workspacePath: input.context.worker.cwd,
        http: this.openCodeSessionHttp(input.context.worker),
        sink,
        limiter: this.delegationLimiter(seam.globalConcurrencyLimit),
        ...(seam.pollIntervalMs === undefined ? {} : { pollIntervalMs: seam.pollIntervalMs }),
        ...(seam.perCallTimeoutMs === undefined ? {} : { perCallTimeoutMs: seam.perCallTimeoutMs }),
        warn: (event, fields) => this.options.logger.warn(event, fields),
      });
    } catch {
      this.options.logger.warn("delegation observer failed to start; observation disabled", {
        attemptId: input.attemptId,
        invocation: input.invocation.ordinal,
      });
      void this.reportObservationUnavailable(sink, factoryInput);
      return undefined;
    }
    this.delegationObservers.add(observer);
    // A cancellation REQUEST is only a flag: observation must keep running so a
    // later confirmed interruption can be observed. The listener is removed in
    // `endDelegationObservation`, never at request time.
    const onAbort = (): void => observer.requestCancellation();
    if (input.signal.aborted) observer.requestCancellation();
    else input.signal.addEventListener("abort", onAbort, { once: true });
    input.invocation.observerCleanup = () => input.signal.removeEventListener("abort", onAbort);
    try {
      observer.start();
    } catch {
      input.invocation.observerCleanup();
      this.delegationObservers.delete(observer);
      observer.dispose();
      void this.reportObservationUnavailable(sink, factoryInput);
      return undefined;
    }
    return observer;
  }

  /**
   * Final-reconcile and tear down one invocation's observer. Runs on EVERY
   * completion path (success, failure, cancellation, throw) and never throws:
   * a broken sink or transport cannot mask or change the attempt's outcome.
   */
  private async endDelegationObservation(
    attemptId: number,
    invocation: OpenCodeInvocationState,
    signal: AbortSignal,
  ): Promise<void> {
    const observer = invocation.observer;
    const cleanup = invocation.observerCleanup;
    invocation.observerCleanup = undefined;
    if (observer === undefined) return;
    try {
      // A queue cancellation is a REQUEST; it is carried separately from any
      // observed outcome and never fabricated into an interruption.
      if (signal.aborted) observer.requestCancellation();
      await observer.finalize();
    } catch {
      this.options.logger.warn("delegation observer finalization failed", {
        attemptId,
        invocation: invocation.ordinal,
      });
    } finally {
      // Guarantees no timer, waiter or signal listener outlives the attempt,
      // even if finalize misbehaved.
      cleanup?.();
      this.delegationObservers.delete(observer);
      observer.dispose();
    }
  }

  /**
   * Dispose every live observer (daemon/attempt teardown). Public so the
   * process owner can stop observation without touching the safety lifecycle;
   * it clears timers and queued waiters only and never interrupts a session.
   */
  disposeDelegationObservation(): void {
    for (const observer of this.delegationObservers) {
      try {
        observer.dispose();
      } catch {
        // Teardown is best-effort; a broken observer must not block shutdown.
      }
    }
    this.delegationObservers.clear();
  }

  /**
   * Best-effort "observation unavailable" coverage when the observer could not
   * be constructed. Each sink call is bounded and swallowed, so a hung or
   * broken store cannot stall attempt startup.
   */
  private async reportObservationUnavailable(
    sink: DelegationObservationSink,
    input: { attemptId: number; ordinal: number; workspacePath: string },
  ): Promise<void> {
    const at = Date.now();
    const bounded = (action: () => void | Promise<void>): Promise<void> =>
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, DELEGATION_OBSERVER_CALL_TIMEOUT_MS);
        Promise.resolve()
          .then(action)
          .then(
            () => {
              clearTimeout(timer);
              resolvePromise();
            },
            () => {
              clearTimeout(timer);
              resolvePromise();
            },
          );
      });
    await bounded(() =>
      sink.begin({
        attemptId: input.attemptId,
        ordinal: input.ordinal,
        workspacePath: input.workspacePath,
        startedAt: at,
      }),
    );
    await bounded(() =>
      sink.coverage({
        attemptId: input.attemptId,
        ordinal: input.ordinal,
        observedAt: at,
        status: "unavailable",
        partial: true,
        gaps: ["transport-error"],
        currentGaps: ["transport-error"],
        nodeCount: 0,
        truncated: false,
        transport: "polling",
      }),
    );
    await bounded(() =>
      sink.end({
        attemptId: input.attemptId,
        ordinal: input.ordinal,
        endedAt: at,
        status: "unavailable",
        gaps: ["transport-error"],
      }),
    );
  }

  /**
   * Capture an attributable parent session id from one run-stream line as soon
   * as it appears (task 3.3). The runner swallows exceptions thrown by
   * `onLine`, so a durable-persistence failure is recorded on the invocation
   * and the caller aborts the run; the evidence already written is retained.
   */
  private captureOpenCodeParentFromLine(input: {
    context: OpenCodeAttemptContext;
    invocation: OpenCodeInvocationState;
    line: string;
  }): void {
    const parentSessionId = openCodeStreamParentId(input.line);
    if (parentSessionId === undefined) return;
    // Hand the root to the observer before ANY ownership persistence: a
    // repeated id is idempotent, and a contradictory second id is recorded as a
    // gap while the first root is retained. Observation never blocks the run.
    input.invocation.observer?.attachRoot(parentSessionId);
    if (input.invocation.parentSessionId !== undefined) return;
    try {
      this.jobs.recordOpenCodeInvocationLaunch({
        invocationId: input.invocation.invocationId,
        parentSessionId,
        status: "launched",
      });
      recordOpenCodeOwnershipInvocation({
        attemptDataDir: input.context.attemptDataDir,
        attemptId: input.context.attemptId,
        ordinal: input.invocation.ordinal,
        parentSessionId,
        launchState: "launched",
      });
      input.invocation.parentSessionId = parentSessionId;
    } catch (error) {
      input.invocation.persistenceFailure =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Persist the result-derived parent session id if the stream did not. */
  private recordOpenCodeInvocationSession(input: {
    context: OpenCodeAttemptContext;
    invocation: OpenCodeInvocationState;
    sessionId: string | undefined;
  }): void {
    if (input.sessionId === undefined) return;
    // The result-derived id is an equally valid early root when the run stream
    // did not expose one; idempotent when both agree.
    input.invocation.observer?.attachRoot(input.sessionId);
    if (input.invocation.parentSessionId === undefined) {
      input.invocation.parentSessionId = input.sessionId;
    }
    try {
      this.jobs.recordOpenCodeInvocationIdentity({
        invocationId: input.invocation.invocationId,
        parentSessionId: input.sessionId,
      });
      recordOpenCodeOwnershipInvocation({
        attemptDataDir: input.context.attemptDataDir,
        attemptId: input.context.attemptId,
        ordinal: input.invocation.ordinal,
        parentSessionId: input.sessionId,
      });
    } catch (error) {
      input.invocation.persistenceFailure ??=
        error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Read the attempt's observed initial primary identity through the pinned
   * session surface. Unavailable evidence stays unknown — the requested
   * selection is never overwritten by the observation, and a missing read is
   * not a failure. Best-effort persistence mirrors the launch evidence.
   */
  private async readOpenCodeInvocationIdentity(input: {
    context: OpenCodeAttemptContext;
    invocation: OpenCodeInvocationState;
  }): Promise<OpenCodeInitialIdentity> {
    const parentSessionId = input.invocation.parentSessionId;
    if (parentSessionId === undefined) return {};
    let identity: OpenCodeInitialIdentity = {};
    try {
      identity = await readOpenCodeInitialIdentity({
        http: this.openCodeSessionHttp(input.context.worker),
        parentSessionId,
        cwd: input.context.worker.cwd,
      });
    } catch {
      identity = {};
    }
    if (identity.agentId !== undefined || identity.model !== undefined) {
      try {
        this.jobs.recordOpenCodeInvocationIdentity({
          invocationId: input.invocation.invocationId,
          parentSessionId,
          actualPrimaryAgent: identity.agentId ?? null,
          actualModel: identity.model ?? null,
        });
        recordOpenCodeOwnershipInvocation({
          attemptDataDir: input.context.attemptDataDir,
          attemptId: input.context.attemptId,
          ordinal: input.invocation.ordinal,
          observedPrimaryId: identity.agentId ?? null,
        });
      } catch (error) {
        input.invocation.persistenceFailure ??=
          error instanceof Error ? error : new Error(String(error));
      }
    }
    return identity;
  }

  /**
   * A known observed primary that contradicts the requested selection is an
   * execution-configuration failure. It is only reported AFTER the launched
   * tree is settled, so a contradiction never leaves a live descendant behind.
   */
  private openCodeIdentityContradiction(
    context: OpenCodeAttemptContext,
    identity: OpenCodeInitialIdentity,
    stage: FailureStage,
  ): StageFailure | undefined {
    if (identity.agentId === undefined) return undefined;
    const expected =
      context.selection.source === "managed"
        ? context.managed?.primaryRuntimeId
        : context.selection.source === "native"
          ? context.nativeId
          : undefined;
    if (expected === undefined || identity.agentId === expected) return undefined;
    return new StageFailure(
      stage,
      "managed-preflight-failed",
      `OpenCode reported initial primary ${JSON.stringify(identity.agentId)} for a job that ` +
        `requested ${JSON.stringify(expected)}; the explicit selection did not take effect`,
    );
  }

  /** The session transport for an attempt, sharing the exact worker context. */
  private openCodeSessionHttp(worker: OpenCodeWorker): ManagedSessionHttp {
    const injected = this.options.managedOpenCode?.sessionHttp;
    if (injected !== undefined) return injected(worker);
    return createCliManagedSessionHttp({
      binary: worker.binary,
      cwd: worker.cwd,
      env: worker.env,
      runner: worker.runner,
    });
  }

  /**
   * Prove one parent invocation's complete descendant tree quiescent before any
   * retry, validation, commit, push or success report (task 4.2), carrying the
   * remaining attempt budget and cancellation through settlement (task 4.3).
   * A missing parent id, unreadable surface, non-terminal descendant or
   * contradiction fails closed: the invocation is left unresolved on disk (the
   * durable quarantine), no generated managed file is cleaned, and the attempt
   * records a distinct quiescence reason.
   */
  private async settleOpenCodeInvocation(input: {
    context: OpenCodeAttemptContext;
    invocation: OpenCodeInvocationState;
    remainingBudgetMs: number;
    signal: AbortSignal;
    jobId: number;
    stage: FailureStage;
  }): Promise<void> {
    const { context, invocation } = input;
    const parentSessionId = invocation.parentSessionId;
    if (parentSessionId === undefined) {
      this.markOpenCodeInvocationUnproven(invocation, "no attributable parent session id");
      context.unproven = new StageFailure(
        input.stage,
        "managed-session-discovery-failed",
        `invocation ${String(invocation.ordinal)} of the OpenCode run captured no parent ` +
          "session id, so its child sessions cannot be enumerated; quiescence cannot be proven " +
          "and no validation or publication may begin",
      );
      throw context.unproven;
    }
    let settlement: ManagedAttemptSettlement;
    try {
      settlement = await settleAttemptChildren({
        parentSessionId,
        attemptDirectory: context.worker.cwd,
        http: this.openCodeSessionHttp(context.worker),
        timeoutMs: input.remainingBudgetMs,
        signal: input.signal,
        ...(this.options.managedOpenCode?.settlePollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: this.options.managedOpenCode.settlePollIntervalMs }),
        ...(this.options.managedOpenCode?.settleInterruptGraceMs === undefined
          ? {}
          : { interruptGraceMs: this.options.managedOpenCode.settleInterruptGraceMs }),
      });
    } catch (error) {
      if (error instanceof OpenCodeSessionDiscoveryError) {
        this.markOpenCodeInvocationUnproven(invocation, "session discovery failed");
        context.unproven = new StageFailure(
          input.stage,
          "managed-session-discovery-failed",
          error.message,
        );
        throw context.unproven;
      }
      if (error instanceof OpenCodeSessionSettleError) {
        this.recordManagedChildrenUnproven({
          attemptId: context.attemptId,
          unsettled: error.unsettledSessionIds,
          unknown: error.unknownSessionIds,
        });
        this.markOpenCodeInvocationUnproven(invocation, "child sessions unproven");
        context.unproven = new StageFailure(input.stage, "managed-child-unsettled", error.message);
        throw context.unproven;
      }
      this.markOpenCodeInvocationUnproven(invocation, "settlement error");
      context.unproven =
        error instanceof StageFailure
          ? error
          : new StageFailure(
              input.stage,
              "agent-process-crash",
              error instanceof Error ? error.message : String(error),
            );
      throw context.unproven;
    }
    this.recordManagedChildrenSettled({ attemptId: context.attemptId, settlement });
    if (context.managed !== undefined) {
      try {
        await this.cleanupManagedAttempt({
          managed: context.managed,
          workspacePath: context.worker.cwd,
          jobId: input.jobId,
          attemptId: context.attemptId,
          stage: input.stage,
        });
      } catch (error) {
        this.markOpenCodeInvocationUnproven(invocation, "managed cleanup failed");
        context.unproven =
          error instanceof StageFailure ? error : classifyFailure(error, input.stage);
        throw context.unproven;
      }
      context.managedFinalized = true;
    }
    try {
      this.markOpenCodeInvocationSettled(context, invocation);
    } catch (error) {
      this.markOpenCodeInvocationUnproven(invocation, "settlement persistence failed");
      context.unproven = new StageFailure(
        input.stage,
        "managed-session-discovery-failed",
        `the OpenCode invocation ${String(invocation.ordinal)} was quiescent, but its settlement ` +
          `could not be durably recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw context.unproven;
    }
    this.options.logger.info("opencode invocation tree settled", {
      jobId: input.jobId,
      attemptId: context.attemptId,
      invocation: invocation.ordinal,
      parentSessionId,
      children: settlement.children.length,
      interrupted: settlement.interruptedSessionIds.length,
      rounds: settlement.rounds,
    });
  }

  /**
   * Durably mark one invocation's tree quiescent: the database projection first,
   * then the filesystem ownership journal that gates workspace reuse. If either
   * write fails, the filesystem journal stays unresolved and recovery must
   * re-prove the tree before admitting the workspace.
   */
  private markOpenCodeInvocationSettled(
    context: OpenCodeAttemptContext,
    invocation: OpenCodeInvocationState,
  ): void {
    this.jobs.settleOpenCodeInvocation({
      invocationId: invocation.invocationId,
      status: "settled",
      ownershipState: "proven",
    });
    settleOpenCodeOwnershipInvocation({
      attemptDataDir: context.attemptDataDir,
      attemptId: context.attemptId,
      ordinal: invocation.ordinal,
    });
  }

  /**
   * Mark one invocation's tree unresolved. The filesystem journal is left
   * unsettled — that is the durable quarantine that bars workspace reuse even
   * before start-up recovery journals its record. The database marker is
   * best-effort diagnostic detail.
   */
  private markOpenCodeInvocationUnproven(
    invocation: OpenCodeInvocationState,
    detail: string,
  ): void {
    try {
      this.jobs.settleOpenCodeInvocation({
        invocationId: invocation.invocationId,
        status: "failed",
        ownershipState: "quarantined",
        detail,
      });
    } catch (error) {
      this.options.logger.warn("unproven OpenCode invocation evidence was not persisted", {
        invocationId: invocation.invocationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Run every permitted parent invocation of an OpenCode attempt, settling the
   * complete descendant tree after EACH exit and before any retry or result
   * classification (tasks 3.3/4.2/4.3). Managed stays single-invocation; a
   * native/default retry gets a distinct ownership ordinal only after the
   * previous tree is proven quiescent, so no parent is relaunched over a
   * possibly-live descendant and no invocation's evidence is overwritten. The
   * remaining configured timeout, cancellation and the 60-second fallback all
   * flow through settlement.
   */
  private async runTrackedOpenCodeInvocations(input: {
    context: OpenCodeAttemptContext;
    stage: FailureStage;
    jobId: number;
    attemptId: number;
    configuredTimeoutSec: number | undefined;
    runStartedAt: number;
    signal: AbortSignal;
    runOnce: (invocation: OpenCodeInvocationState) => Promise<AgentResult>;
    /**
     * Revalidate the captured primary against the actual attempt workspace
     * before EVERY parent invocation (task 3.2). A source-checkout choice that
     * is unavailable in the worktree — or a cold inventory that never
     * converges — fails configuration before the retry can spawn.
     */
    beforeInvocation?: () => Promise<void>;
  }): Promise<AgentResult> {
    const { context } = input;
    const maxInvocations = context.managed !== undefined ? 1 : Math.max(1, this.options.retries);
    let invocationNumber = 1;
    let result: AgentResult | undefined;
    for (;;) {
      await input.beforeInvocation?.();
      const invocation = this.beginOpenCodeInvocation({ context, stage: input.stage });
      // Start live observation before the parent spawns; it attaches the root
      // from the run stream and keeps reconciling through settlement below.
      invocation.observer = this.beginDelegationObservation({
        context,
        invocation,
        attemptId: input.attemptId,
        signal: input.signal,
      });
      context.launched = true;
      try {
        try {
          result = await input.runOnce(invocation);
        } catch {
          // A rejected executor promise has no trustworthy terminal process
          // result. Even if a parent id was observed, the executor may have
          // stopped reporting while its service-owned tree remains live. Preserve
          // the pre-launch journal as unresolved and refuse every publication or
          // retry path rather than treating a thrown run as a settled failure.
          this.markOpenCodeInvocationUnproven(invocation, "executor returned no terminal result");
          context.unproven = new StageFailure(
            input.stage,
            "managed-session-discovery-failed",
            `OpenCode invocation ${String(invocation.ordinal)} did not return a terminal process ` +
              "result; its session tree cannot be proven quiescent and no validation or publication may begin",
          );
          throw context.unproven;
        }
        this.recordOpenCodeInvocationSession({
          context,
          invocation,
          sessionId: result.sessionId,
        });
        if (invocation.persistenceFailure !== undefined) {
          this.markOpenCodeInvocationUnproven(invocation, "ownership persistence failed");
          context.unproven = new StageFailure(
            input.stage,
            "managed-session-discovery-failed",
            `the OpenCode ownership record for invocation ${String(invocation.ordinal)} could not ` +
              `be persisted: ${invocation.persistenceFailure.message}`,
          );
          throw context.unproven;
        }
        invocation.identity = await this.readOpenCodeInvocationIdentity({ context, invocation });
        await this.settleOpenCodeInvocation({
          context,
          invocation,
          remainingBudgetMs: managedRemainingBudgetMs(
            input.configuredTimeoutSec,
            input.runStartedAt,
          ),
          signal: input.signal,
          jobId: input.jobId,
          stage: input.stage,
        });
        const identityPersistenceFailure = invocation.persistenceFailure as Error | undefined;
        if (identityPersistenceFailure !== undefined) {
          throw new StageFailure(
            input.stage,
            "managed-session-discovery-failed",
            `the initial identity for OpenCode invocation ${String(invocation.ordinal)} could not ` +
              `be persisted: ${identityPersistenceFailure.message}`,
          );
        }
        const contradiction = this.openCodeIdentityContradiction(
          context,
          invocation.identity,
          input.stage,
        );
        if (contradiction !== undefined) throw contradiction;
        if (input.signal.aborted) break;
        if (invocationNumber >= maxInvocations) break;
        if (result.timedOut) break;
        if (result.exitCode === 0) break;
        if (isTerminalAgentResult(result)) break;
        invocationNumber += 1;
        this.options.logger.warn(
          "agent invocation failed, retrying after a fresh quiescence proof",
          {
            jobId: input.jobId,
            attemptId: input.attemptId,
            invocation: invocationNumber,
            maxInvocations,
            exitCode: result.exitCode,
          },
        );
      } finally {
        // Final reconcile after settlement, then dispose this invocation's
        // observer. Runs on success, failure, cancellation and throw; it never
        // throws, so it cannot alter the attempt outcome. Each invocation has
        // its own observer, so a retry's tree is never merged with the prior one.
        await this.endDelegationObservation(input.attemptId, invocation, input.signal);
      }
    }
    return result;
  }

  /**
   * Persist the attempt's settled child-session outcomes (task 4.4). Job
   * detail is a database projection that must survive restart, so the
   * delegated agent outcomes are written durably here: session ids, terminal
   * outcomes, and whether each child had to be interrupted — never instruction
   * text. Best-effort: a diagnostic write failure is logged, not thrown, so it
   * can never change the attempt's own outcome.
   */
  private recordManagedChildrenSettled(input: {
    attemptId: number;
    settlement: ManagedAttemptSettlement;
  }): void {
    try {
      const upsert = this.options.db.prepare(`
        INSERT INTO managed_child_sessions (attempt_id, session_id, outcome, state, interrupted)
        VALUES (?, ?, ?, 'settled', ?)
        ON CONFLICT(attempt_id, session_id) DO UPDATE SET
          outcome = excluded.outcome,
          state = 'settled',
          interrupted = excluded.interrupted
      `);
      for (const child of input.settlement.children) {
        upsert.run(input.attemptId, child.id, child.outcome, child.interrupted ? 1 : 0);
      }
    } catch (error) {
      this.options.logger.warn("managed child outcomes were not persisted", {
        attemptId: input.attemptId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist child sessions whose quiescence could not be proven (task 4.4).
   * An unsettled or unknown child carries its id and no terminal outcome, so
   * job detail can show, specific and fail-closed, exactly which child stopped
   * the attempt. Best-effort, like {@link recordManagedChildrenSettled}.
   */
  private recordManagedChildrenUnproven(input: {
    attemptId: number;
    unsettled: readonly string[];
    unknown: readonly string[];
  }): void {
    try {
      const upsert = this.options.db.prepare(`
        INSERT INTO managed_child_sessions (attempt_id, session_id, outcome, state, interrupted)
        VALUES (?, ?, NULL, ?, 0)
        ON CONFLICT(attempt_id, session_id) DO UPDATE SET state = excluded.state
      `);
      for (const sessionId of input.unsettled) upsert.run(input.attemptId, sessionId, "unsettled");
      for (const sessionId of input.unknown) upsert.run(input.attemptId, sessionId, "unknown");
    } catch (error) {
      this.options.logger.warn("managed unproven-child evidence was not persisted", {
        attemptId: input.attemptId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist the specific failure detail of a managed attempt (task 4.4): the
   * configuration or quiescence message naming agent labels, session ids, or
   * paths. The redactor at the console boundary treats it like any other
   * string; only the message text is stored, never the operator's private
   * instruction content. Best-effort, like the child evidence writers.
   */
  private recordManagedFailureDetail(attemptId: number, detail: string): void {
    try {
      this.options.db
        .prepare("UPDATE attempts SET failure_detail = ? WHERE id = ?")
        .run(detail, attemptId);
    } catch (error) {
      this.options.logger.warn("managed failure detail was not persisted", {
        attemptId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove the attempt's generated agent files (task 3.2 cleanup). Runs only
   * after child-session quiescence is proven — or trivially, when nothing was
   * ever spawned — and always before validation and publication. The manifest
   * is retained by the cleanup module when generated content remains, so a
   * callback that cannot prove the workspace clean fails the attempt instead
   * of letting it publish.
   */
  private async cleanupManagedAttempt(input: {
    managed: ManagedAttemptContext;
    workspacePath: string;
    jobId: number;
    attemptId: number;
    stage: FailureStage;
  }): Promise<void> {
    try {
      const report = await cleanupManagedOpencodeFiles({
        workspacePath: input.workspacePath,
        manifestPath: input.managed.manifestPath,
      });
      this.options.logger.info("managed agent files cleaned", {
        jobId: input.jobId,
        attemptId: input.attemptId,
        removed: report.removed.length,
        edited: report.edited.length,
      });
      // Content that was edited away is never restored or logged inline: the
      // possibly-private instruction text went to a content-addressed evidence
      // sidecar, and only that path is surfaced.
      for (const edited of report.edited) {
        this.options.logger.warn(
          "generated agent file was modified by the agent; edited bytes preserved outside the worktree",
          {
            jobId: input.jobId,
            attemptId: input.attemptId,
            path: edited.path,
            evidencePath: edited.evidencePath,
          },
        );
      }
    } catch (error) {
      if (error instanceof ManagedFilesError) {
        throw new StageFailure(input.stage, "managed-cleanup-failed", error.message);
      }
      throw error;
    }
  }

  /**
   * Settle the attempt's child sessions through the pinned session surface
   * (task 3.5), then clean up the generated files. Runs before any validation
   * or publication and on every failure path: the parent CLI exiting — even
   * cleanly — does not prove background children have stopped, so nothing that
   * reads or publishes the workspace may begin until every child is provably
   * quiescent. The transport is the `opencode api` CLI under the exact cwd and
   * environment the parent run received, with queries encoded into the request
   * path (the CLI's `--param` flag silently drops filters on 2.0.16).
   */
  private async settleAndCleanupManagedAttempt(input: {
    managed: ManagedAttemptContext;
    parentSessionId: string;
    worker: OpenCodeWorker;
    remainingBudgetMs: number;
    signal: AbortSignal;
    jobId: number;
    attemptId: number;
    stage: FailureStage;
  }): Promise<void> {
    let settlement: ManagedAttemptSettlement;
    try {
      settlement = await settleAttemptChildren({
        parentSessionId: input.parentSessionId,
        attemptDirectory: input.worker.cwd,
        http:
          this.options.managedOpenCode?.sessionHttp === undefined
            ? createCliManagedSessionHttp({ cwd: input.worker.cwd, env: input.worker.env })
            : this.options.managedOpenCode.sessionHttp(input.worker),
        timeoutMs: input.remainingBudgetMs,
        signal: input.signal,
        ...(this.options.managedOpenCode?.settlePollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: this.options.managedOpenCode.settlePollIntervalMs }),
        ...(this.options.managedOpenCode?.settleInterruptGraceMs === undefined
          ? {}
          : { interruptGraceMs: this.options.managedOpenCode.settleInterruptGraceMs }),
      });
    } catch (error) {
      if (error instanceof OpenCodeSessionDiscoveryError) {
        throw new StageFailure(input.stage, "managed-session-discovery-failed", error.message);
      }
      if (error instanceof OpenCodeSessionSettleError) {
        // Task 4.4: make the fail-closed stop durable — the specific child ids
        // that could not be proven stopped must survive for job detail, even
        // though the wrapped StageFailure below only carries them in its text.
        this.recordManagedChildrenUnproven({
          attemptId: input.attemptId,
          unsettled: error.unsettledSessionIds,
          unknown: error.unknownSessionIds,
        });
        throw new StageFailure(input.stage, "managed-child-unsettled", error.message);
      }
      throw error;
    }
    this.options.logger.info("managed child sessions settled", {
      jobId: input.jobId,
      attemptId: input.attemptId,
      parentSessionId: input.parentSessionId,
      children: settlement.children.length,
      interrupted: settlement.interruptedSessionIds.length,
      rounds: settlement.rounds,
    });
    // Task 4.4: the settled child outcomes are durable evidence for job detail.
    this.recordManagedChildrenSettled({ attemptId: input.attemptId, settlement });
    await this.cleanupManagedAttempt({
      managed: input.managed,
      workspacePath: input.worker.cwd,
      jobId: input.jobId,
      attemptId: input.attemptId,
      stage: input.stage,
    });
  }

  /**
   * Finalize a managed attempt in the exact required order: child sessions
   * first (interrupting them when the attempt boundary is reached), generated
   * files only after quiescence is proven, and never any validation or
   * publication on an unproven tree. Throws a {@link StageFailure} naming the
   * config or quiescence failure when the attempt cannot be completed safely.
   */
  private async finalizeManagedAttempt(input: {
    managed: ManagedAttemptContext;
    launched: boolean;
    parentSessionId: string | undefined;
    worker: OpenCodeWorker;
    remainingBudgetMs: number;
    signal: AbortSignal;
    jobId: number;
    attemptId: number;
    stage: FailureStage;
  }): Promise<void> {
    const { managed, launched, parentSessionId } = input;
    if (!launched) {
      // Nothing was ever spawned, so no child session can exist: quiescence is
      // trivially proven and only the generated files must be removed. A
      // retained manifest that can no longer be read could still own files, so
      // that state fails closed rather than being treated as clean.
      const manifest = readManagedOpencodeManifest(managed.manifestPath);
      if (manifest === undefined && existsSync(managed.manifestPath)) {
        throw new StageFailure(
          input.stage,
          "managed-cleanup-failed",
          `the attempt manifest at ${managed.manifestPath} is unreadable; generated content cannot be proven absent from the workspace`,
        );
      }
      if (manifest !== undefined) {
        await this.cleanupManagedAttempt({
          managed,
          workspacePath: input.worker.cwd,
          jobId: input.jobId,
          attemptId: input.attemptId,
          stage: input.stage,
        });
      }
      return;
    }
    if (parentSessionId === undefined) {
      // The run began but the parent session id was never captured. Children
      // cannot be enumerated from an unknown parent, so the tree could contain
      // a still-running child: fail closed, never validate or publish.
      throw new StageFailure(
        input.stage,
        "managed-session-discovery-failed",
        "the managed OpenCode run captured no session id, so the attempt's child sessions cannot be enumerated; quiescence cannot be proven and no validation or publication may begin",
      );
    }
    await this.settleAndCleanupManagedAttempt({
      managed,
      parentSessionId,
      worker: input.worker,
      remainingBudgetMs: input.remainingBudgetMs,
      signal: input.signal,
      jobId: input.jobId,
      attemptId: input.attemptId,
      stage: input.stage,
    });
  }

  /**
   * The failure-path mirror of {@link finalizeManagedAttempt}. A managed
   * attempt that has not already finished its settlement and cleanup must
   * still attempt it once the run is over — timeout, cancel, nonzero exit, and
   * thrown errors included — interrupting children and removing generated
   * files only when quiescence is proven. When quiescence cannot be proven,
   * the returned remediation is `uncertain`: the recorded failure must be the
   * managed reason, and the manifest and data dir must survive for recovery.
   */
  private async remediateManagedOnFailure(input: {
    managed: ManagedAttemptContext;
    managedFinalized: boolean;
    launched: boolean;
    parentSessionId: string | undefined;
    worker: OpenCodeWorker | undefined;
    remainingBudgetMs: number;
    signal: AbortSignal;
    jobId: number;
    attemptId: number;
    stage: FailureStage;
  }): Promise<ManagedRemediation> {
    if (input.managedFinalized || input.worker === undefined) return { status: "clean" };
    try {
      await this.finalizeManagedAttempt({
        managed: input.managed,
        launched: input.launched,
        parentSessionId: input.parentSessionId,
        worker: input.worker,
        remainingBudgetMs: input.remainingBudgetMs,
        signal: input.signal,
        jobId: input.jobId,
        attemptId: input.attemptId,
        stage: input.stage,
      });
      return { status: "clean" };
    } catch (error) {
      const failure = error instanceof StageFailure ? error : classifyFailure(error, input.stage);
      return { status: "uncertain", failure };
    }
  }

  private async runAttempt(input: {
    jobId: number;
    attemptId: number;
    repository: RuntimeRepository;
    prNumber: number;
    commentId: number;
    model: string;
    command: ParsedCommand;
    retainedWorkspace?: RetainedWorkspace;
    signal: AbortSignal;
    /**
     * Per-attempt flag shared with the queue's cancellation handler: when a
     * OpenCode ownership or managed cleanup is unresolved, its manifest and
     * data dir must survive for recovery, and neither path may erase them.
     */
    preserveDataDir: { value: boolean; failure?: StageFailure };
  }): Promise<{ commitSha?: string }> {
    const { jobId, attemptId, repository, prNumber, commentId, signal, preserveDataDir } = input;
    let stage: FailureStage = "preparing";
    let workspacePath: string | undefined;
    let attemptDataDir: string | undefined;
    let adoptionClaim: AdoptionClaimHandle | undefined;
    let openCode: OpenCodeAttemptContext | undefined;
    let agentEnv: Record<string, string> | undefined;
    const configuredTimeoutSec = repository.timeoutSec ?? this.options.timeoutSec;
    let runStartedAt = 0;
    try {
      this.jobs.setStatus(jobId, stage, attemptId);
      await this.reactToStatus(repository, commentId, stage);
      // A provider its executor cannot drive is not merely an authentication
      // problem. Cline's `opencode` provider executes tools server-side, inside
      // a long-lived `opencode serve` process whose working directory is fixed
      // when *that server* starts — so `-c <workspace>` is ignored and every
      // edit lands in whatever checkout the server happened to be launched in,
      // outside this attempt's workspace. The run then looks successful while
      // the workspace stays untouched, and the attempt fails as `no-changes`
      // with the real work stranded in another repository.
      //
      // Startup only warns about the pairing
      // (reportRepositoryProviderMismatches); refuse it here, where the run
      // would otherwise write outside its own workspace. An unknown provider id
      // is operator-supplied and stays usable — the catalog makes no claim
      // about it — as does an agent with no registered executor, which the
      // `agent-cli-missing` check below still reports.
      const configuredExecutor = this.options.executors.get(repository.agent);
      if (
        configuredExecutor !== undefined &&
        !providerSupportsAgentKind(
          this.options.providerCatalog ?? bundledProviderCatalog(),
          repository.provider,
          configuredExecutor.id,
        )
      ) {
        throw new StageFailure(
          stage,
          "provider-executor-mismatch",
          `provider ${repository.provider} cannot be driven by the ${configuredExecutor.id} agent; ` +
            `tool execution would not be confined to this attempt's workspace`,
        );
      }
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
      // Re-checked here rather than trusted from the retry: the recorded head is
      // reconciled against the pull request only now, so a force-push between the
      // two attempts must still close the resume off.
      const resumeRetained =
        input.retainedWorkspace !== undefined &&
        samePath(
          input.retainedWorkspace.workspacePath,
          workspacePathFor(repository.workspaceRoot, prNumber),
        ) &&
        input.retainedWorkspace.headSha === context.headSha;
      const workspace = await this.prepareWorkspaceForAttempt({
        jobId,
        attemptId,
        repository,
        prNumber,
        headBranch: context.headBranch,
        headSha: context.headSha,
        seedFiles: repository.workspaceSeedFiles,
        resumeDirtyWorkspace: resumeRetained,
        adoptExistingCheckout: repository.adoptWorktree,
      });
      workspacePath = workspace.path;
      adoptionClaim = workspace.adoptionClaim;
      this.jobs.recordPreparation(attemptId, workspace.path, workspace.headSha, workspace.adopted);
      this.options.logger.info("workspace prepared", {
        jobId,
        attemptId,
        path: workspace.path,
        adopted: workspace.adopted,
      });

      // Only a workspace that actually still holds edits carries an inherited
      // failure. A resume was *permitted* above; whether anything was resumed is
      // a question about the working tree, and telling an agent it inherited
      // edits that are not there would describe code it cannot find.
      const inheritedFailure =
        resumeRetained && (await statusEntries(workspace.path)).length > 0
          ? this.inheritedValidationFailure(input.retainedWorkspace!.attemptId)
          : undefined;
      if (inheritedFailure !== undefined) {
        this.options.logger.info("resuming retained edits after validation failure", {
          jobId,
          attemptId,
          priorAttemptId: input.retainedWorkspace!.attemptId,
          command: inheritedFailure.command.join(" "),
        });
      }

      stage = "running";
      this.jobs.setStatus(jobId, stage, attemptId);
      await this.reactToStatus(repository, commentId, stage);
      const executor = this.options.executors.get(repository.agent);
      if (!executor) throw new StageFailure(stage, "agent-cli-missing");
      attemptDataDir = join(this.options.dataDir, "attempts", String(attemptId));
      mkdirSync(attemptDataDir, { recursive: true });
      // 4.1: seed credentials only for executors that use per-attempt state.
      // The source is read-only; the destination is the per-attempt ephemeral dir.
      const credentialSource = this.options.credentialSources?.get(repository.agent);
      if (credentialSource && !executor.usesSharedCredentials) {
        // Seeding failures are a configuration/environment fault, not the
        // agent rejecting a credential. They must not fall through to the
        // generic classifier, which reads any "unauthorized" wording as a
        // provider auth failure and hides the real cause.
        try {
          seedAgentCredentials(
            credentialSource,
            attemptDataDir,
            this.options.credentialFiles?.get(repository.agent),
            // The executor's kind decides where inside the attempt dir each
            // seeded file must land.
            executor.id,
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
      } else if (credentialSource) {
        this.options.logger.info("using shared agent credentials", {
          jobId,
          attemptId,
          agent: repository.agent,
          source: credentialSource,
        });
      }
      // Tasks 3.2/3.3/4.2/4.3: the shared environment the run, the native or
      // managed preflight probe, and the child-session transport all receive —
      // identical cwd and env, so an OpenCode run, its inventory check and its
      // settlement talk to the same project and data store. For OpenCode the
      // captured source decides whether generated managed files are
      // materialized and verified, a native id is revalidated against the
      // actual prepared workspace, or no explicit primary is selected.
      agentEnv = buildAgentEnvironment(
        process.env,
        executor.additionalEnvironment(attemptDataDir, credentialSource),
      );
      if (executor.id === "opencode") {
        openCode = this.resolveOpenCodeContext({
          executor,
          executorAlias: repository.agent,
          jobId,
          attemptId,
          workspacePath: workspace.path,
          agentEnv,
          stage,
        });
        await this.configureOpenCodeAttempt({
          context: openCode,
          jobId,
          attemptId,
          agentEnv,
          signal,
          stage,
        });
      }
      this.options.logger.info("agent launched", {
        jobId,
        attemptId,
        agent: executor.id,
        ...(openCode === undefined ? {} : { source: openCode.selection.source }),
      });
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
      // The attempt-wide abort mirrors the queue's cancellation, and is also
      // tripped if an early ownership-persistence write fails mid-stream: the
      // parent process stops while the evidence already written survives.
      const runAbort = new AbortController();
      if (signal.aborted) runAbort.abort();
      else signal.addEventListener("abort", () => runAbort.abort(), { once: true });
      const selectionForRun = openCode === undefined ? undefined : this.selectionForRun(openCode);
      const runOnce = (invocation?: OpenCodeInvocationState): Promise<AgentResult> =>
        executor.run({
          cwd: workspace.path,
          model: input.model,
          provider: repository.provider,
          effort: repository.effort,
          prompt: buildResolutionPrompt(context, this.options.orchestratorLogin, inheritedFailure),
          env: agentEnv!,
          ...(configuredTimeoutSec === undefined ? {} : { timeoutSec: configuredTimeoutSec }),
          retries: this.options.retries,
          dataDir: attemptDataDir!,
          signal: runAbort.signal,
          // A native/default/managed source travels as one discriminated intent;
          // the legacy `primaryAgentId` option is never combined with it. The
          // shared worker descriptor is passed so the run uses the exact same
          // binary/cwd/env/runner as preflight and settlement.
          ...(openCode === undefined ? {} : { openCodeSelection: selectionForRun! }),
          ...(openCode === undefined ? {} : { openCodeWorker: openCode.worker }),
          onLine: (line) => {
            if (openCode !== undefined && invocation !== undefined) {
              // Capture the root BEFORE recording the line, so an already
              // verified root can attribute the block. Verification itself is
              // asynchronous; the getter is the ONLY attribution source — never
              // the raw journal id.
              this.captureOpenCodeParentFromLine({ context: openCode, invocation, line });
              if (invocation.persistenceFailure !== undefined) runAbort.abort();
            }
            const verifiedRoot = invocation?.observer?.verifiedRootSessionId;
            const attribution: ActivityAttribution | undefined =
              invocation === undefined
                ? undefined
                : verifiedRoot === undefined
                  ? {} // clear any prior invocation's attribution
                  : {
                      sessionId: verifiedRoot,
                      rootSessionId: verifiedRoot,
                      invocation: invocation.ordinal,
                      role: "parent",
                    };
            if (attribution === undefined) recorder.push(line);
            else recorder.push(line, attribution);
            // The stream arrives token by token; rewriting the snapshot on every
            // line would mean hundreds of writes a second for no visible gain.
            const now = Date.now();
            if (now - lastFlush < ACTIVITY_FLUSH_MS) return;
            lastFlush = now;
            flush();
          },
        });
      runStartedAt = Date.now();
      let agentResult: AgentResult;
      if (openCode !== undefined) {
        agentResult = await this.runTrackedOpenCodeInvocations({
          context: openCode,
          stage,
          jobId,
          attemptId,
          configuredTimeoutSec,
          runStartedAt,
          signal: runAbort.signal,
          runOnce,
          beforeInvocation: async () => {
            if (openCode!.nativeId !== undefined) {
              await this.preflightNativeAttempt({
                context: openCode!,
                agentId: openCode!.nativeId,
                signal,
                stage,
              });
            }
          },
        });
      } else {
        // Cline bounds retries itself (--retries counts consecutive mistakes
        // within one session); an executor that cannot do that is bounded here
        // instead, by re-running the whole invocation up to the same allowance.
        agentResult = await runOnce();
        let invocation = 1;
        const maxInvocations = executor.honorsRetries ? 1 : Math.max(1, this.options.retries);
        while (
          invocation < maxInvocations &&
          !signal.aborted &&
          !agentResult.timedOut &&
          agentResult.exitCode !== 0 &&
          !isTerminalAgentResult(agentResult)
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
      // Every OpenCode parent exit — managed, native, default, timed-out,
      // cancelled, nonzero — already settled its complete descendant tree
      // BEFORE this result is judged (see runTrackedOpenCodeInvocations), and
      // managed generated files were only removed once quiescence was proven.
      // Nothing here may validate or publish on an unproven tree.
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
        // Publishing is the one stage whose consequences leave the machine, so
        // the operator's stop has to reach inside it rather than only up to it.
        signal,
        onCommitted: (commitSha) => {
          // Recorded before the push is attempted: `commit_sha` set with
          // `pushed = 0` is a commit still private to the workspace.
          this.jobs.recordCommit(attemptId, commitSha);
          this.options.logger.info("commit created", { jobId, attemptId, commitSha });
        },
      });
      // A cancel is not a judgement about the work, so it must not travel the
      // StageFailure path — that names a publication precondition as the cause
      // and reports it to the pull request. Converge on the same
      // `job-cancelled` error the pre-validation check raises and let the
      // queue's cancellation handler record the outcome.
      if (publication.kind === "cancelled") throw new Error("job-cancelled");
      if (publication.kind === "blocked") {
        throw new StageFailure(stage, publication.reason);
      }
      this.jobs.recordPush(attemptId);
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
      // Every post-launch OpenCode settlement/cleanup failure is recorded as
      // unresolved on disk by runTrackedOpenCodeInvocations, the durable
      // quarantine that bars reuse. Here we only finish a managed attempt whose
      // generated files were materialized but never launched, and preserve any
      // unresolved evidence instead of releasing it.
      if (openCode !== undefined) {
        if (openCode.managed !== undefined && !openCode.launched && !openCode.managedFinalized) {
          try {
            await this.finalizeManagedAttempt({
              managed: openCode.managed,
              launched: false,
              parentSessionId: undefined,
              worker: openCode.worker,
              remainingBudgetMs: managedRemainingBudgetMs(configuredTimeoutSec, runStartedAt),
              signal,
              jobId,
              attemptId,
              stage,
            });
            openCode.managedFinalized = true;
          } catch (cleanupError) {
            openCode.unproven =
              cleanupError instanceof StageFailure
                ? cleanupError
                : classifyFailure(cleanupError, stage);
          }
        }
        if (openCode.unproven !== undefined) {
          preserveDataDir.value = true;
          preserveDataDir.failure = openCode.unproven;
          this.options.logger.error(
            "OpenCode attempt ended with unresolved ownership or cleanup; evidence and data dir preserved",
            {
              jobId,
              attemptId,
              reason: openCode.unproven.reason,
              error: openCode.unproven.message,
            },
          );
        }
      }
      if (signal.aborted) {
        this.releaseAttemptDataDir(
          repository.agent,
          attemptDataDir,
          jobId,
          attemptId,
          preserveDataDir.value,
        );
        throw error;
      }
      const failure = classifyFailure(openCode?.unproven ?? error, stage);
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
      // Keep the specific OpenCode failure detail (which agent id, which child
      // session stayed unproven) durable for job detail, without persisting
      // redundant reason codes as detail.
      if (
        openCode !== undefined &&
        failure.message.length > 0 &&
        failure.message !== failure.reason
      ) {
        this.recordManagedFailureDetail(attemptId, failure.message);
      }
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
      this.releaseAttemptDataDir(
        repository.agent,
        attemptDataDir,
        jobId,
        attemptId,
        preserveDataDir.value,
      );
      throw failure;
    } finally {
      this.releaseAdoptionClaim(adoptionClaim, jobId, attemptId);
    }
  }

  private releaseAdoptionClaim(
    claim: AdoptionClaimHandle | undefined,
    jobId: number,
    attemptId: number,
  ): void {
    if (!claim) return;
    try {
      claim.release();
    } catch (error) {
      this.options.logger.warn("adoption claim release failed", {
        jobId,
        attemptId,
        path: claim.path,
        message: error instanceof Error ? error.message : String(error),
      });
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
   *
   * `preserveDir` keeps the directory (and the managed manifest inside it) after
   * the credential write-back, so an attempt whose quiescence could not be
   * proven leaves recovery the evidence it owns (tasks 3.2-3.5).
   */
  private releaseAttemptDataDir(
    agent: string,
    attemptDataDir: string | undefined,
    jobId: number,
    attemptId: number,
    preserveDir = false,
  ): void {
    if (!attemptDataDir) return;
    const credentialSource = this.options.credentialSources?.get(agent);
    if (credentialSource && !this.options.executors.get(agent)?.usesSharedCredentials) {
      try {
        const rotated = persistRotatedCredentials(
          credentialSource,
          attemptDataDir,
          this.options.credentialFiles?.get(agent),
          // Same kind-relative layout the seed used; see seedAgentCredentials.
          this.options.executors.get(agent)?.id,
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
    if (preserveDir) return;
    removeAttemptDataDir(attemptDataDir);
  }
}

/* ------------------------------------------------------------------ *
 * Durable-store sink adapter (tasks 2.x ↔ 3.x, best effort)
 * ------------------------------------------------------------------ */

/**
 * Adapt the durable delegation-observation store to the observer's
 * `begin`/`upsert`/`coverage`/`end` sink contract.
 *
 * The store owns persistence, caps, transitions and state projection; the
 * observer owns transport, attribution and bounds. This adapter is the seam:
 *
 * - `begin` opens coverage with `transport: "polling"`, state `unknown`.
 * - `upsert` forwards only whitelisted fields (`sourceKind: "session-poll"`)
 *   with epoch bounds converted to ISO strings, and preserves the node's
 *   explicit `presence`: a failed refresh or vanished session is written as
 *   `missing` with a null active value, so it can never resurrect a stale
 *   running/succeeded display.
 * - `coverage` writes transport/freshness and opens each NEW gap from the
 *   round's own `currentGaps` (never the cumulative historical `gaps`, which
 *   would reopen already-reconciled gaps on every healthy poll); a healthy,
 *   non-partial round closes the outstanding gaps.
 * - `end` writes the final coverage.
 *
 * Every store function is already failure-isolated (it returns a result rather
 * than throwing); this adapter additionally swallows any unexpected fault so a
 * broken store can never affect a job. It never writes a safety record.
 */
export function createStoreDelegationSink(
  db: Database.Database,
  identity: { attemptId: number; ordinal: number },
): DelegationObservationSink {
  const reportedGaps = new Set<DelegationGapReason>();
  const iso = (ms: number): string => new Date(ms).toISOString();
  const settle = (action: () => unknown): void => {
    try {
      action();
    } catch {
      // Store writes are best-effort; observation must never affect a job.
    }
  };
  const coverageState = (status: DelegationCoverageRecord["status"]): string =>
    status === "healthy" ? "ok" : status === "partial" ? "degraded" : "unavailable";

  return {
    begin(record: DelegationInvocationRecord): void {
      settle(() =>
        recordDelegationCoverage(db, {
          attemptId: identity.attemptId,
          invocationOrdinal: identity.ordinal,
          at: iso(record.startedAt),
          transport: "polling",
          transportState: "unknown",
        }),
      );
    },
    upsert(node: DelegationObservedNode): void {
      settle(() =>
        recordDelegationObservation(db, {
          attemptId: identity.attemptId,
          invocationOrdinal: identity.ordinal,
          sessionId: node.sessionId,
          rootSessionId: node.rootSessionId,
          ...(node.parentSessionId === undefined ? {} : { parentSessionId: node.parentSessionId }),
          depth: node.depth,
          sourceKind: "session-poll",
          ...(node.identity.agentId === undefined ? {} : { agent: node.identity.agentId }),
          ...(node.identity.model === undefined ? {} : { model: node.identity.model }),
          ...(node.sourceCreatedAt === undefined
            ? {}
            : { sourceCreatedAt: iso(node.sourceCreatedAt) }),
          ...(node.sourceUpdatedAt === undefined
            ? {}
            : { sourceUpdatedAt: iso(node.sourceUpdatedAt) }),
          ...(node.sourceIdleAt === undefined ? {} : { sourceIdleAt: iso(node.sourceIdleAt) }),
          observedAt: iso(node.lastObservedAt),
          // A node whose refresh failed or that vanished is persisted as
          // MISSING current evidence with a null active value, so the store
          // cannot resurrect a stale running/succeeded state. Identity/outcome
          // history is retained by the store's merge, not re-asserted here.
          presence: node.presence,
          active: node.presence === "observed" ? (node.active ?? null) : null,
          outcome: node.presence === "observed" ? (node.outcome ?? null) : null,
          cancellationRequested: node.cancellationRequested,
        }),
      );
    },
    coverage(record: DelegationCoverageRecord): void {
      settle(() =>
        recordDelegationCoverage(db, {
          attemptId: identity.attemptId,
          invocationOrdinal: identity.ordinal,
          at: iso(record.observedAt),
          transport: "polling",
          transportState: coverageState(record.status),
          lastAttemptAt: iso(record.observedAt),
          ...(record.status === "healthy" ? { lastSuccessAt: iso(record.observedAt) } : {}),
          truncated: record.truncated,
          nodeLimitReached: record.gaps.includes("node-cap"),
        }),
      );
      // Open only THIS round's gaps. `record.gaps` is cumulative history, so
      // iterating it here would reopen a gap that a later healthy round already
      // reconciled on every subsequent healthy poll; `currentGaps` is the round's
      // own subset and is empty on a healthy round.
      for (const gap of record.currentGaps) {
        if (reportedGaps.has(gap)) continue;
        reportedGaps.add(gap);
        settle(() =>
          reportDelegationGap(db, {
            attemptId: identity.attemptId,
            invocationOrdinal: identity.ordinal,
            signature: gap,
            detail: `delegation observation gap: ${gap}`,
            at: iso(record.observedAt),
          }),
        );
      }
      if (record.status === "healthy" && !record.partial) {
        settle(() =>
          reconcileDelegationGaps(db, {
            attemptId: identity.attemptId,
            invocationOrdinal: identity.ordinal,
            at: iso(record.observedAt),
          }),
        );
        reportedGaps.clear();
      }
    },
    end(record: DelegationInvocationEnd): void {
      settle(() =>
        recordDelegationCoverage(db, {
          attemptId: identity.attemptId,
          invocationOrdinal: identity.ordinal,
          at: iso(record.endedAt),
          transport: "polling",
          transportState: coverageState(record.status),
          lastAttemptAt: iso(record.endedAt),
          ...(record.status === "healthy" ? { lastSuccessAt: iso(record.endedAt) } : {}),
        }),
      );
    },
  };
}
