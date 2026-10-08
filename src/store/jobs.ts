import type Database from "better-sqlite3";
import type {
  AgentResult,
  CommandOutcome,
  FailureStage,
  JobStatus,
  ReasoningEffort,
} from "../types.js";
import type { OpenCodePrimarySource } from "../config/opencode-selection.js";

/**
 * Job, attempt, and processed-command persistence (design D6/D7).
 *
 * `processed_commands` is written in the same transaction that creates the
 * job; its unique constraint — not application logic — is what makes
 * at-most-once true across a crash (command-ingestion spec).
 */

export interface JobRow {
  id: number;
  repo_id: number;
  pr_number: number;
  comment_id: number;
  command: string;
  thread_id: string | null;
  status: JobStatus;
  created_at: string;
  finished_at: string | null;
  current_attempt: number;
  review_context: string | null;
  /**
   * OpenCode primary source captured when the job was created (design D2,
   * migration 0008). `null` for legacy jobs created before selection tracking
   * and for non-OpenCode jobs; readers derive managed/default from the captured
   * profile in that case. Queued jobs and retries keep this capture.
   */
  opencode_source: string | null;
  /** Captured native agent id; non-null only for captured native source. */
  opencode_native_agent_id: string | null;
  /** Revision of the repository selection captured with the job. */
  opencode_selection_revision: number | null;
  /**
   * OpenCode profile captured when the job was created (design D2, migration
   * 0006). Null when the repository had no dashboard-managed profile at
   * creation time; queued jobs and retries keep their captured snapshot.
   */
  opencode_profile_json: string | null;
  opencode_profile_revision: number | null;
}

export interface AttemptRow {
  id: number;
  job_id: number;
  attempt_number: number;
  agent: string;
  model: string;
  provider: string;
  effort: string;
  workspace_path: string | null;
  head_sha_at_prepare: string | null;
  adopted: number;
  started_at: string | null;
  ended_at: string | null;
  agent_exit_code: number | null;
  agent_session_id: string | null;
  outcome: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
  commit_sha: string | null;
  pushed: number;
  report_status: string | null;
  has_uncommitted_changes: number;
  output_ref: string | null;
}

export interface StatusEventRow {
  id: number;
  job_id: number;
  attempt_id: number | null;
  status: JobStatus;
  at: string;
}

/**
 * One generic OpenCode parent invocation's durable ownership/identity evidence
 * (design D4, migration 0008). Safe identifiers and states only — never a
 * prompt, instruction or credential. A row is journaled before launch and then
 * updated as the parent session and actual runtime identity become known.
 */
export interface OpenCodeInvocationRow {
  id: number;
  attempt_id: number;
  invocation_ordinal: number;
  status: string;
  ownership_state: string;
  requested_source: string;
  requested_native_agent_id: string | null;
  requested_profile_revision: number | null;
  binary: string | null;
  workspace_path: string | null;
  parent_session_id: string | null;
  actual_primary_agent: string | null;
  actual_model: string | null;
  launched_at: string | null;
  settled_at: string | null;
  detail: string | null;
}

/**
 * The requested selection captured with a job, resolved from the job's own
 * row. This is deliberately independent of current repository settings so a
 * queued job, a retry and a reopened database all agree (task 2.5).
 */
export type CapturedOpenCodeSelection =
  | { source: "default" }
  | { source: "native"; agentId: string }
  | { source: "managed"; profileRevision: number | null };

/**
 * Resolve the captured primary selection from a job row. Jobs that captured a
 * source use it verbatim. Legacy jobs (NULL source) derive managed source from
 * their own captured profile and default source otherwise — never from a later
 * repository selection. A corrupt native capture (source without an id) throws
 * rather than silently substituting another agent.
 */
export function resolveCapturedOpenCodeSelection(job: JobRow): CapturedOpenCodeSelection {
  switch (job.opencode_source) {
    case "managed":
      return { source: "managed", profileRevision: job.opencode_profile_revision };
    case "native": {
      const agentId = job.opencode_native_agent_id;
      if (agentId === null || agentId.length === 0) {
        throw new Error(`job ${job.id} captured native source without an agent id`);
      }
      return { source: "native", agentId };
    }
    case "default":
      return { source: "default" };
    case null:
      // Legacy job: a captured managed profile means managed; otherwise default.
      if (job.opencode_profile_json !== null) {
        return { source: "managed", profileRevision: job.opencode_profile_revision };
      }
      return { source: "default" };
    default:
      throw new Error(
        `job ${job.id} has unknown captured OpenCode source ${JSON.stringify(job.opencode_source)}`,
      );
  }
}

/** A journaled invocation's already-known safe context. */
export interface JournalOpenCodeInvocationInput {
  attemptId: number;
  requestedSource: OpenCodePrimarySource;
  requestedNativeAgentId?: string | null;
  requestedProfileRevision?: number | null;
  binary?: string | null;
  workspacePath?: string | null;
}

/** Early launch evidence persisted as soon as it is available. */
export interface OpenCodeInvocationLaunchInput {
  invocationId: number;
  parentSessionId?: string | null;
  actualPrimaryAgent?: string | null;
  actualModel?: string | null;
  binary?: string | null;
  workspacePath?: string | null;
  /** Overrides the default `launched` status when the caller needs another. */
  status?: string;
  detail?: string | null;
}

/** Identity evidence that may arrive after launch. */
export interface OpenCodeInvocationIdentityInput {
  invocationId: number;
  parentSessionId?: string | null;
  actualPrimaryAgent?: string | null;
  actualModel?: string | null;
}

/** Terminal settlement of one invocation. */
export interface SettleOpenCodeInvocationInput {
  invocationId: number;
  status: string;
  ownershipState?: string;
  detail?: string | null;
}

export interface NewJob {
  repoId: number;
  /** Resolved executor kind for a configured agent alias; defaults to the stored agent id. */
  executorKind?: string;
  prNumber: number;
  commentId: number;
  command: string;
  threadId?: string;
  authorLogin: string;
  observedAt: string;
}

export type CreateJobResult = { kind: "created"; jobId: number } | { kind: "duplicate" };

function now(): string {
  return new Date().toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * Resolve a write-once ownership/identity field. A null/undefined incoming
 * value leaves the recorded value alone; a new value fills an empty slot; a
 * different value than one already recorded is a safety failure and throws
 * before the caller performs any write. The error names the field and
 * invocation only — never the values — so it stays safe to surface.
 */
function mergeWriteOnceIdentity(
  current: string | null,
  incoming: string | null | undefined,
  field: string,
  invocationId: number,
): string | null {
  if (incoming === undefined || incoming === null) return current;
  if (current === null) return incoming;
  if (current !== incoming) {
    throw new Error(
      `opencode invocation ${invocationId} already recorded a different ${field}; ` +
        "known ownership and runtime identity values are write-once",
    );
  }
  return current;
}

export interface NewAttempt {
  jobId: number;
  agent: string;
  model: string;
  provider: string;
  effort: ReasoningEffort;
}

/**
 * Persistence operations used by the walking skeleton. The deliberately small
 * API keeps transaction ownership in the store rather than spreading SQL
 * through orchestration code.
 */
export class JobStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Atomically claim a command occurrence and create its job. The stable
   * command identity is inserted first; a duplicate therefore rolls the whole
   * transaction back before a second job can exist.
   */
  createJob(input: NewJob): CreateJobResult {
    const create = this.db.transaction((): CreateJobResult => {
      const processed = this.db
        .prepare(
          `INSERT INTO processed_commands
             (repo_id, pr_number, comment_id, command, author_login,
              observed_at, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.repoId,
          input.prNumber,
          input.commentId,
          input.command,
          input.authorLogin,
          input.observedAt,
          "executed" satisfies CommandOutcome,
        );

      const createdAt = now();
      // D2: capture the current OpenCode primary selection and — only when the
      // source is managed — the active profile snapshot, in the same
      // transaction that claims the command, so a concurrent dashboard save or
      // source switch cannot split one job between revisions. Queued jobs and
      // their retries keep this capture; a later change affects new jobs only.
      // See {@link opencodeSelectionSnapshot}.
      const snapshot = this.opencodeSelectionSnapshot(input.repoId, input.executorKind);
      const job = this.db
        .prepare(
          `INSERT INTO jobs
             (repo_id, pr_number, comment_id, command, thread_id, status, created_at,
              opencode_source, opencode_native_agent_id, opencode_selection_revision,
              opencode_profile_json, opencode_profile_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.repoId,
          input.prNumber,
          input.commentId,
          input.command,
          input.threadId ?? null,
          "queued" satisfies JobStatus,
          createdAt,
          snapshot.source,
          snapshot.nativeAgentId,
          snapshot.selectionRevision,
          snapshot.profileJson,
          snapshot.profileRevision,
        );
      const jobId = Number(job.lastInsertRowid);
      this.db
        .prepare("UPDATE processed_commands SET job_id = ? WHERE id = ?")
        .run(jobId, processed.lastInsertRowid);
      this.insertStatusEvent(jobId, null, "queued", createdAt);
      return { kind: "created", jobId };
    });

    try {
      return create();
    } catch (err) {
      if (isUniqueViolation(err)) return { kind: "duplicate" };
      throw err;
    }
  }

  /**
   * The current OpenCode primary selection snapshot for a repository, read
   * inside the job-creation transaction (design D2, task 2.4).
   *
   * For a non-OpenCode executor all captures are null. For an OpenCode
   * executor the source decides which, if any, managed snapshot is copied:
   * - `managed`: the active profile JSON and revision are captured.
   * - `native`: the native id is captured and no profile is materialized.
   * - `default`: nothing beyond the source is captured.
   *
   * A missing selection row always means `default`. The source alone is
   * authoritative: a saved profile is captured only when the repository
   * explicitly selects managed, so a retained dormant profile is never
   * silently activated and never materialized for a default/native job. The
   * runtime seeds an explicit default row when a repository is inserted, so
   * this case only covers state predating that seed.
   */
  private opencodeSelectionSnapshot(
    repoId: number,
    executorKind?: string,
  ): {
    source: string | null;
    nativeAgentId: string | null;
    selectionRevision: number | null;
    profileJson: string | null;
    profileRevision: number | null;
  } {
    const empty = {
      source: null,
      nativeAgentId: null,
      selectionRevision: null,
      profileJson: null,
      profileRevision: null,
    };
    const repository = this.db
      .prepare("SELECT agent FROM repositories WHERE id = ?")
      .get(repoId) as { agent: string } | undefined;
    if ((executorKind ?? repository?.agent) !== "opencode") return empty;

    const selection = this.db
      .prepare(
        "SELECT source, native_agent_id, revision FROM opencode_primary_selections WHERE repo_id = ?",
      )
      .get(repoId) as
      { source: string; native_agent_id: string | null; revision: number } | undefined;
    if (selection === undefined) {
      return { ...empty, source: "default", selectionRevision: 0 };
    }

    if (selection.source === "managed") {
      const profile = this.db
        .prepare("SELECT profile_json, revision FROM opencode_agent_profiles WHERE repo_id = ?")
        .get(repoId) as { profile_json: string | null; revision: number } | undefined;
      if (profile === undefined || profile.profile_json === null) {
        // Fail closed at capture: a managed source without a saved profile
        // would otherwise create a job that cannot materialize its team. The
        // throw rolls back the command claim, so no incoherent job exists.
        throw new Error(
          `repository ${repoId} selects managed OpenCode source but has no saved profile; ` +
            "refusing to create an unresolvable job",
        );
      }
      return {
        source: "managed",
        nativeAgentId: null,
        selectionRevision: selection.revision,
        profileJson: profile.profile_json,
        profileRevision: profile.revision,
      };
    }
    if (selection.source === "native") {
      return {
        source: "native",
        nativeAgentId: selection.native_agent_id,
        selectionRevision: selection.revision,
        profileJson: null,
        profileRevision: null,
      };
    }
    return {
      source: "default",
      nativeAgentId: null,
      selectionRevision: selection.revision,
      profileJson: null,
      profileRevision: null,
    };
  }

  createAttempt(input: NewAttempt): { attemptId: number; attemptNumber: number } {
    return this.db.transaction(() => {
      const job = this.getJob(input.jobId);
      const attemptNumber = job.current_attempt + 1;
      const result = this.db
        .prepare(
          `INSERT INTO attempts
             (job_id, attempt_number, agent, model, provider, effort)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.jobId, attemptNumber, input.agent, input.model, input.provider, input.effort);
      this.db
        .prepare("UPDATE jobs SET current_attempt = ? WHERE id = ?")
        .run(attemptNumber, input.jobId);
      return { attemptId: Number(result.lastInsertRowid), attemptNumber };
    })();
  }

  setStatus(jobId: number, status: JobStatus, attemptId?: number): void {
    this.db.transaction(() => this.transition(jobId, status, attemptId ?? null))();
  }

  recordPreparation(
    attemptId: number,
    workspacePath: string,
    headShaAtPrepare: string,
    adopted = false,
  ): void {
    this.db
      .prepare(
        `UPDATE attempts
         SET workspace_path = ?, head_sha_at_prepare = ?, adopted = ?, started_at = ?
         WHERE id = ?`,
      )
      .run(workspacePath, headShaAtPrepare, adopted ? 1 : 0, now(), attemptId);
  }

  recordAgentResult(attemptId: number, result: AgentResult): void {
    this.db
      .prepare(
        `UPDATE attempts
         SET ended_at = ?, agent_exit_code = ?, agent_session_id = ?, outcome = ?
         WHERE id = ?`,
      )
      .run(
        result.endedAt,
        result.exitCode,
        result.sessionId ?? null,
        result.exitCode === 0 && !result.timedOut ? "agent-succeeded" : "agent-failed",
        attemptId,
      );
  }

  /**
   * Record the commit as soon as it exists, before any push is attempted, so a
   * commit that never leaves the machine is still named in the record — one
   * cancelled between commit and push, or one whose push failed. `pushed`
   * stays 0 until {@link recordPush}, which makes
   * `commit_sha != null AND pushed = 0` the representation of a workspace
   * holding an unpushed commit. Readers that treat a recorded sha as proof of
   * publication must consult `pushed`.
   */
  recordCommit(attemptId: number, commitSha: string): void {
    this.db
      .prepare("UPDATE attempts SET commit_sha = ?, pushed = 0 WHERE id = ?")
      .run(commitSha, attemptId);
  }

  /** The recorded commit left the machine. */
  recordPush(attemptId: number): void {
    this.db.prepare("UPDATE attempts SET pushed = 1 WHERE id = ?").run(attemptId);
  }

  recordReportStatus(attemptId: number, status: "posted" | "failed"): void {
    this.db.prepare("UPDATE attempts SET report_status = ? WHERE id = ?").run(status, attemptId);
  }

  recordFailureDetail(
    attemptId: number,
    input: {
      stage: FailureStage;
      reason: string;
      hasUncommittedChanges: boolean;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE attempts
         SET failure_stage = ?, failure_reason = ?, has_uncommitted_changes = ?
         WHERE id = ?`,
      )
      .run(input.stage, input.reason, input.hasUncommittedChanges ? 1 : 0, attemptId);
  }

  finishSuccess(jobId: number, attemptId: number): void {
    const finishedAt = now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE attempts
           SET outcome = 'succeeded', report_status = 'posted', ended_at = COALESCE(ended_at, ?)
           WHERE id = ?`,
        )
        .run(finishedAt, attemptId);
      this.transition(jobId, "succeeded", attemptId, finishedAt);
    })();
  }

  finishFailure(jobId: number, attemptId: number, stage: FailureStage, reason: string): void {
    const finishedAt = now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE attempts
           SET outcome = 'failed', failure_stage = ?, failure_reason = ?,
               ended_at = COALESCE(ended_at, ?)
           WHERE id = ?`,
        )
        .run(stage, reason, finishedAt, attemptId);
      this.transition(jobId, "failed", attemptId, finishedAt);
    })();
  }

  cancelJob(jobId: number, attemptId: number | null, hasUncommittedChanges: boolean): void {
    const finishedAt = now();
    this.db.transaction(() => {
      if (attemptId !== null) {
        this.db
          .prepare(
            `UPDATE attempts
             SET outcome = 'cancelled', ended_at = COALESCE(ended_at, ?),
                 has_uncommitted_changes = ?
             WHERE id = ?`,
          )
          .run(finishedAt, hasUncommittedChanges ? 1 : 0, attemptId);
      }
      this.transition(jobId, "cancelled", attemptId, finishedAt);
    })();
  }

  interruptIncompleteJobs(): number[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, current_attempt FROM jobs
           WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
           ORDER BY id`,
        )
        .all() as { id: number; current_attempt: number }[];
      const interruptedAt = now();
      for (const row of rows) {
        const attempt = this.db
          .prepare("SELECT id FROM attempts WHERE job_id = ? AND attempt_number = ?")
          .get(row.id, row.current_attempt) as { id: number } | undefined;
        if (attempt) {
          this.db
            .prepare(
              `UPDATE attempts
               SET outcome = 'interrupted', ended_at = COALESCE(ended_at, ?)
               WHERE id = ?`,
            )
            .run(interruptedAt, attempt.id);
        }
        this.transition(row.id, "interrupted", attempt?.id ?? null, interruptedAt);
      }
      return rows.map((row) => row.id);
    })();
  }

  retryJob(input: NewAttempt): { attemptId: number; attemptNumber: number } {
    return this.db.transaction(() => {
      const job = this.getJob(input.jobId);
      if (!TERMINAL_RETRY_STATUSES.includes(job.status)) {
        throw new Error(`job ${input.jobId} cannot be retried from ${job.status}`);
      }
      const queuedAt = now();
      this.db
        .prepare("UPDATE jobs SET status = 'queued', finished_at = NULL WHERE id = ?")
        .run(input.jobId);
      this.insertStatusEvent(input.jobId, null, "queued", queuedAt);
      return this.createAttempt(input);
    })();
  }

  setAttemptOutputRef(attemptId: number, outputRef: string): void {
    this.db.prepare("UPDATE attempts SET output_ref = ? WHERE id = ?").run(outputRef, attemptId);
  }

  /**
   * Journal a generic OpenCode invocation before it launches (design D4, task
   * 2.3). Assigns the next per-attempt ordinal so a second parent invocation
   * in one attempt never overwrites the first invocation's evidence. Safe
   * context only — requested source/id/revision, binary and workspace — with no
   * prompt or credential content.
   */
  journalOpenCodeInvocation(input: JournalOpenCodeInvocationInput): {
    invocationId: number;
    ordinal: number;
  } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(invocation_ordinal), 0) AS max_ordinal FROM opencode_invocations WHERE attempt_id = ?",
        )
        .get(input.attemptId) as { max_ordinal: number };
      const ordinal = row.max_ordinal + 1;
      const result = this.db
        .prepare(
          `INSERT INTO opencode_invocations
             (attempt_id, invocation_ordinal, status, ownership_state, requested_source,
              requested_native_agent_id, requested_profile_revision, binary, workspace_path)
           VALUES (?, ?, 'journaled', 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.attemptId,
          ordinal,
          input.requestedSource,
          input.requestedNativeAgentId ?? null,
          input.requestedProfileRevision ?? null,
          input.binary ?? null,
          input.workspacePath ?? null,
        );
      return { invocationId: Number(result.lastInsertRowid), ordinal };
    })();
  }

  /**
   * Persist early launch evidence as soon as it is available: status, the
   * attributed parent session, and the actual primary/model when the runtime
   * exposes them. Known identity is write-once: a contradicting parent session
   * or observed primary/model is rejected with a safe error before any write,
   * so nothing can retarget a non-null identity. Missing identity is never
   * overwritten by later absence, a launched invocation without a parent keeps
   * the explicit `missing` ownership marker, and `launched_at` is stamped only
   * by a write that records the `launched` status.
   */
  recordOpenCodeInvocationLaunch(input: OpenCodeInvocationLaunchInput): void {
    this.db.transaction(() => {
      const row = this.getOpenCodeInvocation(input.invocationId);
      if (row === undefined) {
        throw new Error(`opencode invocation ${input.invocationId} not found`);
      }
      const parentSessionId = mergeWriteOnceIdentity(
        row.parent_session_id,
        input.parentSessionId,
        "parent session id",
        input.invocationId,
      );
      const actualPrimaryAgent = mergeWriteOnceIdentity(
        row.actual_primary_agent,
        input.actualPrimaryAgent,
        "actual primary agent",
        input.invocationId,
      );
      const actualModel = mergeWriteOnceIdentity(
        row.actual_model,
        input.actualModel,
        "actual model",
        input.invocationId,
      );
      const status = input.status ?? "launched";
      const ownershipState =
        parentSessionId !== null
          ? "captured"
          : row.ownership_state === "pending"
            ? "missing"
            : row.ownership_state;
      // D5: launched_at records a launch, so only a launched-status write may
      // stamp it. A failed/other status override leaves it untouched.
      const launchedAt = status === "launched" ? (row.launched_at ?? now()) : row.launched_at;
      this.db
        .prepare(
          `UPDATE opencode_invocations
           SET status = ?, ownership_state = ?, parent_session_id = ?,
               actual_primary_agent = ?, actual_model = ?, binary = ?, workspace_path = ?,
               launched_at = ?, detail = COALESCE(?, detail)
           WHERE id = ?`,
        )
        .run(
          status,
          ownershipState,
          parentSessionId,
          actualPrimaryAgent,
          actualModel,
          row.binary ?? input.binary ?? null,
          row.workspace_path ?? input.workspacePath ?? null,
          launchedAt,
          input.detail ?? null,
          input.invocationId,
        );
    })();
  }

  /**
   * Attach identity evidence that arrives after launch without changing the
   * invocation's status or recorded launch time. Identity is write-once: a
   * contradicting parent session or observed primary/model throws a safe error
   * before any write, and existing non-null identity is never cleared. Learning
   * a parent session upgrades a `missing` marker to `captured`.
   */
  recordOpenCodeInvocationIdentity(input: OpenCodeInvocationIdentityInput): void {
    this.db.transaction(() => {
      const row = this.getOpenCodeInvocation(input.invocationId);
      if (row === undefined) {
        throw new Error(`opencode invocation ${input.invocationId} not found`);
      }
      const parentSessionId = mergeWriteOnceIdentity(
        row.parent_session_id,
        input.parentSessionId,
        "parent session id",
        input.invocationId,
      );
      const actualPrimaryAgent = mergeWriteOnceIdentity(
        row.actual_primary_agent,
        input.actualPrimaryAgent,
        "actual primary agent",
        input.invocationId,
      );
      const actualModel = mergeWriteOnceIdentity(
        row.actual_model,
        input.actualModel,
        "actual model",
        input.invocationId,
      );
      const ownershipState = parentSessionId !== null ? "captured" : row.ownership_state;
      this.db
        .prepare(
          `UPDATE opencode_invocations
           SET parent_session_id = ?, actual_primary_agent = ?, actual_model = ?,
               ownership_state = ?
           WHERE id = ?`,
        )
        .run(parentSessionId, actualPrimaryAgent, actualModel, ownershipState, input.invocationId);
    })();
  }

  /**
   * Record the terminal settlement of one invocation. `ownershipState` records
   * whether quiescence was proven (`settled`/`proven`) or remains unresolved
   * (`unresolved`/`quarantined`); it is left unchanged when omitted. An unknown
   * invocation id is a programming/ownership failure and throws rather than
   * silently no-op, so a settlement can never be lost.
   */
  settleOpenCodeInvocation(input: SettleOpenCodeInvocationInput): void {
    const result = this.db
      .prepare(
        `UPDATE opencode_invocations
         SET status = ?, ownership_state = COALESCE(?, ownership_state),
             detail = COALESCE(?, detail), settled_at = COALESCE(settled_at, ?)
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.ownershipState ?? null,
        input.detail ?? null,
        now(),
        input.invocationId,
      );
    if (result.changes !== 1) {
      throw new Error(`opencode invocation ${input.invocationId} not found`);
    }
  }

  listOpenCodeInvocations(attemptId: number): OpenCodeInvocationRow[] {
    return this.db
      .prepare(
        "SELECT * FROM opencode_invocations WHERE attempt_id = ? ORDER BY invocation_ordinal",
      )
      .all(attemptId) as OpenCodeInvocationRow[];
  }

  getOpenCodeInvocation(invocationId: number): OpenCodeInvocationRow | undefined {
    return this.db.prepare("SELECT * FROM opencode_invocations WHERE id = ?").get(invocationId) as
      OpenCodeInvocationRow | undefined;
  }

  /**
   * Resolve the primary selection captured with a job, independently of any
   * later repository change, for explicit retries and internal invocations
   * (task 2.5). See {@link resolveCapturedOpenCodeSelection}.
   */
  resolveCapturedSelection(jobId: number): CapturedOpenCodeSelection {
    return resolveCapturedOpenCodeSelection(this.getJob(jobId));
  }

  setReviewContext(jobId: number, context: unknown): void {
    this.db
      .prepare("UPDATE jobs SET review_context = ? WHERE id = ?")
      .run(JSON.stringify(context), jobId);
  }

  getTimeline(jobId: number): StatusEventRow[] {
    return this.db
      .prepare("SELECT * FROM status_events WHERE job_id = ? ORDER BY id")
      .all(jobId) as StatusEventRow[];
  }

  listAttempts(jobId: number): AttemptRow[] {
    return this.db
      .prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number")
      .all(jobId) as AttemptRow[];
  }

  getJob(jobId: number): JobRow {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!row) throw new Error(`job ${jobId} not found`);
    return row;
  }

  getAttempt(attemptId: number): AttemptRow {
    const row = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as
      AttemptRow | undefined;
    if (!row) throw new Error(`attempt ${attemptId} not found`);
    return row;
  }

  private transition(jobId: number, status: JobStatus, attemptId: number | null, at = now()): void {
    const job = this.getJob(jobId);
    if (!ALLOWED_TRANSITIONS[job.status].includes(status)) {
      throw new Error(`invalid job transition: ${job.status} -> ${status}`);
    }
    const terminal = TERMINAL_JOB_STATUSES.includes(status);
    this.db
      .prepare("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?")
      .run(status, terminal ? at : null, jobId);
    this.insertStatusEvent(jobId, attemptId, status, at);
  }

  private insertStatusEvent(
    jobId: number,
    attemptId: number | null,
    status: JobStatus,
    at: string,
  ): void {
    this.db
      .prepare("INSERT INTO status_events (job_id, attempt_id, status, at) VALUES (?, ?, ?, ?)")
      .run(jobId, attemptId, status, at);
  }
}

const TERMINAL_JOB_STATUSES: JobStatus[] = ["succeeded", "failed", "cancelled", "interrupted"];
const TERMINAL_RETRY_STATUSES: JobStatus[] = ["failed", "cancelled", "interrupted"];

const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ["preparing", "failed", "cancelled", "interrupted"],
  preparing: ["running", "failed", "cancelled", "interrupted"],
  running: ["validating", "failed", "cancelled", "interrupted"],
  validating: ["publishing", "failed", "cancelled", "interrupted"],
  publishing: ["reporting", "failed", "cancelled", "interrupted"],
  reporting: ["succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};
