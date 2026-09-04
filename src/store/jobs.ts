import type Database from "better-sqlite3";
import type {
  AgentResult,
  CommandOutcome,
  FailureStage,
  JobStatus,
  ReasoningEffort,
} from "../types.js";

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

export interface NewJob {
  repoId: number;
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
      const job = this.db
        .prepare(
          `INSERT INTO jobs
             (repo_id, pr_number, comment_id, command, thread_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.repoId,
          input.prNumber,
          input.commentId,
          input.command,
          input.threadId ?? null,
          "queued" satisfies JobStatus,
          createdAt,
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
