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

  setStatus(jobId: number, status: JobStatus): void {
    this.db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, jobId);
  }

  recordPreparation(attemptId: number, workspacePath: string, headShaAtPrepare: string): void {
    this.db
      .prepare(
        `UPDATE attempts
         SET workspace_path = ?, head_sha_at_prepare = ?, started_at = ?
         WHERE id = ?`,
      )
      .run(workspacePath, headShaAtPrepare, now(), attemptId);
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

  recordPublication(attemptId: number, commitSha: string): void {
    this.db
      .prepare("UPDATE attempts SET commit_sha = ?, pushed = 1 WHERE id = ?")
      .run(commitSha, attemptId);
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
      this.db
        .prepare("UPDATE jobs SET status = 'succeeded', finished_at = ? WHERE id = ?")
        .run(finishedAt, jobId);
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
      this.db
        .prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?")
        .run(finishedAt, jobId);
    })();
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
}
