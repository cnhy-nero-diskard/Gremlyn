/**
 * Shared domain types for Gremlyn.
 *
 * These types are the internal vocabulary of the orchestrator. GitHub-facing
 * shapes live in `github/client.ts`; persistence rows live in `store/`.
 */

/**
 * Reasoning-effort tiers, ordered ascending.
 *
 * `max` is real: gpt-5.6-luna advertises
 * `reasoningOptions: ["none","low","medium","high","xhigh","max"]`. Cline's
 * ceiling is per *model*, not global — deepseek-v4-flash advertises only
 * `["high","xhigh"]`. A repository's configured tier is still validated against
 * its agent's declared `efforts` list, so widening this enum permits `max`
 * without granting it to an agent that does not declare it.
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const JOB_STATUSES = [
  "queued",
  "preparing",
  "running",
  "validating",
  "publishing",
  "reporting",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

/** Statuses in which a failure can occur; doubles as the failure stage vocabulary. */
export type FailureStage = Extract<
  JobStatus,
  "preparing" | "running" | "validating" | "publishing" | "reporting"
>;

export type CommandOutcome = "executed" | "rejected" | "ignored" | "duplicate";

/**
 * The transport-independent event every downstream component consumes
 * (command-ingestion spec: transport-independent event normalization).
 */
export interface NormalizedEvent {
  owner: string;
  repo: string;
  kind: "review-comment" | "issue-comment";
  commentId: number;
  authorLogin: string;
  body: string;
  prNumber: number;
  /** ISO-8601 timestamp reported by GitHub. */
  observedAt: string;
}

/** A command parsed from a normalized event's comment body. */
export interface ParsedCommand {
  /** Command name without the leading `!`, e.g. `RESOLVE`. */
  name: string;
  /** Whitespace-separated arguments following the command token. */
  args: string[];
}

export interface ReviewThreadComment {
  id: number;
  authorLogin: string;
  body: string;
  createdAt: string;
}

/** Review-thread context reconstructed for the agent prompt (design D11). */
export interface ReviewContext {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headBranch: string;
  headSha: string;
  threadId: string;
  filePath: string;
  diffHunk: string;
  thread: ReviewThreadComment[];
  triggeringCommentId: number;
  agentInstructions?: string;
}

export interface AgentResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
  startedAt: string;
  endedAt: string;
  /** True when the run was ended by the configured timeout or cancellation. */
  timedOut: boolean;
}

export interface AgentRunOptions {
  cwd: string;
  model: string;
  provider: string;
  effort: ReasoningEffort;
  prompt: string;
  env: Record<string, string>;
  timeoutSec: number;
  retries: number;
  dataDir: string;
  signal: AbortSignal;
  /** Observe the agent's stdout lines as they arrive, for live reporting. */
  onLine?: (line: string) => void;
}

/** The replaceable executor seam (design D10). */
export interface AgentExecutor {
  readonly id: string;
  run(opts: AgentRunOptions): Promise<AgentResult>;
}
