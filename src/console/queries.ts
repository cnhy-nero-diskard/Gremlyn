import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { activityPath, type AgentActivity } from "../agent/activity.js";
import { type OpenCodePermission, parseOpenCodeAgentProfile } from "../config/opencode-profile.js";
import { createRedactor, type Redactor } from "../log/redact.js";
import {
  projectDelegationState,
  reportDelegationObservations,
  safeReadDelegationObservations,
  type DelegationAttemptObservations,
  type DelegationInvocationCoverage,
  type DelegationObservationGap,
  type DelegationObservationNode,
  type DelegationObservationReport,
  type DelegationProjectedState,
} from "../store/delegation-observations.js";
import type { CommandOutcome, JobStatus } from "../types.js";

/**
 * Read-only projections used by the operator console.
 *
 * The console deliberately does not expose persistence rows directly.  These
 * models are the boundary between SQLite and the presentation layer: paths
 * referenced by an output row are used only while reading, and every string
 * that leaves this module has gone through the configured redactor.
 */

export type Redaction = Redactor | readonly string[];

/** The executor kind that owns OpenCode primary-source semantics. */
const OPENCODE_EXECUTOR_ID = "opencode";

/**
 * Resolve a configured agent alias id to the executor kind that runs it
 * (`agents[agent].kind ?? agent`). The server supplies the agents map; the
 * identity default matches the config loader for a repository whose alias is
 * already the kind. Never assume an alias literally equals `opencode`.
 */
export type ExecutorKindResolver = (agentId: string | undefined) => string | undefined;

export interface RepositorySummary {
  id: number;
  owner: string;
  name: string;
  enabled: number;
  source_path?: string;
  workspace_root?: string;
  agent?: string;
  model?: string;
  provider?: string;
  effort?: string;
  timeout_seconds?: number | null;
  validation_commands?: string;
  agent_instructions?: string | null;
  allowed_models?: string;
  /** Parsed validation commands for views that do not want to parse JSON. */
  validationCommands?: string[][];
  /** Parsed allowed-models list for views that do not want to parse JSON. */
  allowedModels?: string[];
  /**
   * The repository's dashboard-managed OpenCode agent team, or null when no
   * profile is saved. Only OpenCode-executor repositories project one at the
   * presentation layer; instructions never appear in this projection.
   */
  opencodeProfile?: OpenCodeProfileSummary | null;
  /**
   * The durable OpenCode primary source configured for this repository
   * (default / native / managed). Projected for every repository and rendered
   * only for OpenCode-executor repositories; a retained native id is shown even
   * when it is no longer discoverable so the saved choice stays authoritative.
   */
  opencodeSelection?: OpenCodeSelectionSummary | null;
}

/** The three mutually exclusive OpenCode primary sources (design D1). */
export type OpenCodePrimarySourceName = "default" | "native" | "managed";

/**
 * Privacy-safe repository projection of the durable primary source. It carries
 * only the source, optimistic revision, whether the row is explicit, the
 * retained native id and the controlling managed-profile revision — never any
 * agent instructions, permissions or raw inventory.
 */
export interface OpenCodeSelectionSummary {
  source: OpenCodePrimarySourceName;
  revision: number;
  /** True when a durable selection row exists (deliberate or migration-seeded). */
  explicit: boolean;
  /** The retained native agent id, non-null only for native source. */
  nativeAgentId: string | null;
  /** The saved managed profile revision controlling the team, or null. */
  profileRevision: number | null;
}

/**
 * The OpenCode primary source a job captured at creation (design D2). A
 * capture is immutable: retries and queued invocations read this, never the
 * repository's current selection. A legacy job with no recorded source is
 * resolved from its own captured profile (managed) or default otherwise.
 */
export interface CapturedOpenCodeSelectionSummary {
  source: OpenCodePrimarySourceName;
  nativeAgentId: string | null;
  selectionRevision: number | null;
  /** The captured managed profile revision, non-null only for managed source. */
  profileRevision: number | null;
}

/**
 * One OpenCode parent invocation's durable ownership/identity evidence (design
 * D4). Requested source and the actual runtime primary/model are kept separate:
 * an unobserved runtime identity stays explicitly unknown rather than echoing
 * the requested selection. Contains no prompt or credential content.
 */
export interface OpenCodeInvocationSummary {
  ordinal: number;
  requestedSource: string;
  requestedNativeAgentId: string | null;
  requestedProfileRevision: number | null;
  /** The attributed parent session, or null when ownership was not captured. */
  parentSessionId: string | null;
  /** The actual runtime primary identity, or null when it was not observed. */
  actualPrimaryAgent: string | null;
  actualModel: string | null;
  status: string;
  ownershipState: string;
  launchedAt: string | null;
  settledAt: string | null;
}

/**
 * One dashboard-managed subagent in the readable OpenCode projection.
 * Identifiers, purpose, model data, and tool preset only — the child's private
 * instructions are deliberately never projected here.
 */
export interface OpenCodeSubagentSummary {
  id: string;
  /** Whether the managed primary may invoke this child. */
  enabled: boolean;
  /** The child's purpose; never its private instructions. */
  description: string;
  /** Explicit `provider/model[#variant]` override, or null to inherit the primary session model. */
  model: string | null;
  /** Supported tool permissions; an empty list means read-only. */
  permissions: OpenCodePermission[];
  /** Optional positive step limit. */
  stepLimit: number | null;
}

/**
 * Privacy-safe dashboard projection of a saved OpenCode agent profile. The
 * active primary, its permission preset, model resolution data, and the
 * ordered subagents with their callable state — never the operators' private
 * instruction text. The full profile is read separately by the dedicated edit
 * route when the operator opens the editor.
 */
export interface OpenCodeProfileSummary {
  revision: number;
  primaryId: string;
  /** The primary's purpose; never its private instructions. */
  primaryDescription: string;
  primaryPermissions: OpenCodePermission[];
  primaryStepLimit: number | null;
  /** Ordered subagent projections; enabled children are callable. */
  subagents: OpenCodeSubagentSummary[];
}

export interface JobSummary {
  id: number;
  repo_id: number;
  pr_number: number;
  comment_id: number;
  command: string;
  status: JobStatus | string;
  owner: string;
  name: string;
  thread_id?: string | null;
  created_at?: string;
  finished_at?: string | null;
  current_attempt?: number;
  review_context?: string | null;
  /**
   * Observed delegation counts for this job, or absent when the job has no
   * attempts to attribute. Never treats configured agents as executed.
   */
  delegation?: DelegationSummary;
}

export interface AttemptDetail {
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
  /**
   * The specific managed configuration or quiescence failure message, or null
   * when no managed failure detail was recorded. Never instruction text.
   */
  failure_detail: string | null;
  commit_sha: string | null;
  pushed: number;
  report_status: string | null;
  has_uncommitted_changes: number;
  output_ref: string | null;
  /** Whether the attempt ran in a clean foreign checkout adopted by Gremlyn. */
  adopted: boolean;
  output: string;
  /** Whether the referenced captured output file is still present. */
  outputRetained: boolean;
  /** Live transcript for this attempt, when the agent produced one. */
  activity: AgentActivity | null;
  /**
   * Delegated child sessions captured for a managed OpenCode attempt, in
   * discovery order. Empty when the attempt was not managed (or recorded none).
   */
  childSessions: ManagedChildSessionSummary[];
  /**
   * Generic OpenCode parent invocations journaled for this attempt, in ordinal
   * order. Each entry keeps the requested source separate from the actual,
   * possibly-unknown runtime primary. Empty for non-OpenCode attempts.
   */
  invocations: OpenCodeInvocationSummary[];
  /**
   * Observed delegation evidence for this attempt, or absent when nothing was
   * observed / the attempt predates observation. Independent of
   * {@link childSessions} safety settlement.
   */
  delegation?: DelegationAttemptDetail;
}

/**
 * One durable delegated child-session record for a managed OpenCode attempt.
 * Session id and state only — child outcomes never surface instruction text.
 */
export interface ManagedChildSessionSummary {
  /** The child session id (`ses…`). */
  sessionId: string;
  /**
   * Terminal pinned outcome (`succeeded`/`failed`/`interrupted`), or null
   * while the child was never confirmed stopped (unsettled/unknown).
   */
  outcome: string | null;
  /** `settled`, `unsettled`, or `unknown`. */
  state: string;
  /** Whether Gremlyn had to interrupt this child to reach quiescence. */
  interrupted: boolean;
}

/**
 * Truthful delegation observability projected for the console (design D4/D5;
 * capability `agent-delegation-observability`). `availability` keeps a
 * supported-but-empty observation distinct from an executor that cannot expose
 * attributed child sessions at all, so Cline is never rendered as "no
 * subagents" and a lost OpenCode source is never rendered as an empty tree.
 */
export type DelegationAvailability = "observed" | "partial" | "unavailable" | "unsupported";

/** Reuse the store's coverage vocabulary verbatim. */
export type DelegationCoverage = "known" | "partial" | "unavailable" | "none";

/** Observed child counts. Unknown is never folded into completed. */
export interface DelegationCounts {
  observed: number;
  /** Verified records whose current execution has not been resolved yet. */
  invoked: number;
  running: number;
  idle: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  unknown: number;
  cancellationRequested: number;
}

/** One subdued dashboard/attempt summary of actually observed execution. */
export interface DelegationSummary extends DelegationCounts {
  /** The executor kind that ran (resolved alias-aware), or null when unknown. */
  executorKind: string | null;
  availability: DelegationAvailability;
  coverage: DelegationCoverage;
  /** True when retained history/evidence is explicitly incomplete. */
  limited: boolean;
  /**
   * The bounded scope this dashboard summary was computed over. Latest attempt
   * only, so a job with many retries never projects an unbounded aggregate.
   */
  scope: "latest-attempt";
}

/**
 * One configured, dashboard-managed callable definition. Kept strictly
 * separate from observed session nodes: a configured child that was never
 * observed never appears as having run.
 */
export interface DelegationConfiguredAgent {
  id: string;
  /** The exact runtime id the managed attempt generated for this definition. */
  runtimeId: string;
  callable: boolean;
  primary: boolean;
  model: string | null;
}

/** One observed session node as projected for the drilldown tree. */
export interface DelegationNodeView {
  id: number;
  sessionId: string;
  parentSessionId: string | null;
  rootSessionId: string | null;
  depth: number | null;
  /**
   * True when this node is a root invocation session (`sessionId ===
   * rootSessionId` or `depth === 0`) rather than a delegated child. Roots stay
   * visible in the tree but are excluded from every delegation count.
   */
  isRoot: boolean;
  /** The raw runtime agent id when observed; never a configured label. */
  agentId: string | null;
  /** A friendly captured-definition id, only on an exact generated-id match. */
  agentLabel: string | null;
  /** True only when `agentLabel` came from an exact generated runtime-id match. */
  agentFriendly: boolean;
  model: string | null;
  state: DelegationProjectedState;
  outcome: string | null;
  cancellationRequested: boolean;
  cancellationRequestedAt: string | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceIdleAt: string | null;
  limitedUncertainty: boolean;
  historyPartial: boolean;
}

/** One root invocation's bounded, attributed child tree. */
export interface DelegationInvocationView {
  ordinal: number;
  rootSessionId: string | null;
  nodes: DelegationNodeView[];
  coverage: DelegationCoverage;
  transport: string | null;
  transportState: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  gapCount: number;
  truncated: boolean;
  historyPartial: boolean;
  nodeLimitReached: boolean;
  /** Redacted open-gap details; empty when coverage is healthy. */
  openGaps: string[];
  /** Count of earlier gaps that were reconciled, retained as history. */
  reconciledGaps: number;
}

/** One attempt's observed delegation tree plus configured callable agents. */
export interface DelegationAttemptDetail extends DelegationCounts {
  attemptId: number;
  executorKind: string | null;
  availability: DelegationAvailability;
  coverage: DelegationCoverage;
  /** Configured managed definitions, separate from observed nodes. */
  configured: DelegationConfiguredAgent[];
  invocations: DelegationInvocationView[];
  openGaps: string[];
  limited: boolean;
}

export interface StatusTimelineEntry {
  id: number;
  job_id: number;
  attempt_id: number | null;
  status: JobStatus | string;
  at: string;
}

export interface ValidationRun {
  id: number;
  attempt_id: number;
  seq: number;
  command: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_ref: string | null;
  output: string;
  /** Whether the referenced validation output file is still present. */
  outputRetained: boolean;
}

export interface LogRow {
  id: number;
  at: string;
  level: string;
  event: string;
  job_id: number | null;
  attempt_id: number | null;
  fields: string | null;
}

export interface JobDetail {
  job: JobSummary & {
    review_context: string | null;
    thread_id: string | null;
    /**
     * The dashboard-managed OpenCode agent team captured when this job was
     * created, or null when the job carried no profile snapshot (or the
     * snapshot no longer parses). Identifiers and purposes only — the raw
     * snapshot JSON and its private instruction text are never projected.
     */
    opencodeProfile?: OpenCodeProfileSummary | null;
    /**
     * The OpenCode primary source captured with this job, or null for a
     * non-OpenCode job (and a legacy OpenCode job that recorded neither source
     * nor profile). The captured source is never rewritten from current
     * repository settings.
     */
    opencodeSelection?: CapturedOpenCodeSelectionSummary | null;
  };
  attempts: AttemptDetail[];
  timeline: StatusTimelineEntry[];
  validation: ValidationRun[];
  logs: LogRow[];
  /** Total entries for this job; `logs` holds only the newest JOB_LOG_TAIL. */
  logTotal: number;
}

export interface HealthModel {
  /** Latest poll observed across all configured repositories. */
  lastPolledAt: string | null;
  /** Alias retained for views using the shorter name. */
  lastPollAt: string | null;
  /** Age of the latest poll in seconds, or null when no poll exists. */
  pollAgeSec: number | null;
  queueDepth: number;
  /** Alias useful to queue-oriented dashboard components. */
  queuedCount: number;
  inFlight: number;
  /** Alias useful to concurrency-oriented dashboard components. */
  activeCount: number;
  concurrency: number;
  pollIntervalSec: number;
  stale: boolean;
  status: "running" | "stale" | "unknown";
}

export interface DashboardModel {
  repositories: RepositorySummary[];
  jobs: JobSummary[];
  running: JobSummary[];
  queued: JobSummary[];
  recent: JobSummary[];
  health: HealthModel;
}

export interface ProcessedCommandModel {
  id: number;
  repo_id: number;
  owner: string;
  name: string;
  repository: string;
  pr_number: number;
  comment_id: number;
  command: string;
  author_login: string;
  observed_at: string;
  outcome: CommandOutcome | string;
  reason: string | null;
  job_id: number | null;
}

export interface OperatorActionModel {
  id: number;
  at: string;
  action: string;
  target: string;
  effect: string | null;
  detail: string | null;
}

export interface DashboardReadOptions {
  pollIntervalSec?: number;
  concurrency?: number;
  now?: Date | number | string;
}

export interface ConsoleQueries {
  readDashboard(options?: DashboardReadOptions): DashboardModel;
  readHealth(now?: Date | number | string): HealthModel;
  readJobDetail(jobId: number): JobDetail | undefined;
  readJobLog(jobId: number): LogRow[];
  readProcessedCommands(limit?: number): ProcessedCommandModel[];
  readOperatorActions(limit?: number): OperatorActionModel[];
}

const RUNNING_STATUSES = new Set(["preparing", "running", "validating", "publishing", "reporting"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function asRedactor(input: Redaction): Redactor {
  return typeof input === "function" ? input : createRedactor(input);
}

/** Redact every string property in a persistence row without mutating it. */
function redactRow<T extends Record<string, unknown>>(row: T, redact: Redactor): T {
  const result = { ...row } as T;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string") {
      (result as Record<string, unknown>)[key] = redact(value);
    }
  }
  return result;
}

function parseAllowedModels(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseValidationCommands(value: string | null | undefined): string[][] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) =>
      Array.isArray(entry) && entry.every((part) => typeof part === "string")
        ? [entry as string[]]
        : [],
    );
  } catch {
    return [];
  }
}

/** Read an attempt's activity snapshot; absent or unreadable means "none yet". */
function readActivity(dataDir: string, attemptId: number): AgentActivity | null {
  try {
    const path = activityPath(dataDir, attemptId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as AgentActivity;
  } catch {
    // A snapshot caught mid-write is transient; the next tick reads a whole one.
    return null;
  }
}

/** Read a captured artifact while preserving whether its reference still resolves. */
function readArtifact(path: string | null): { text: string; retained: boolean } {
  if (!path) return { text: "", retained: false };
  try {
    if (!existsSync(path)) return { text: "", retained: false };
    return { text: readFileSync(path, "utf8"), retained: true };
  } catch {
    return { text: "", retained: false };
  }
}

function toMillis(value: Date | number | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Date.now();
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

/**
 * Attach one batched delegation summary to every dashboard job. Only the latest
 * attempt per job is considered (bounded to one row per job regardless of retry
 * count) and its observations are read in one batched query, never a session
 * query per row. The full attempt history remains available in job detail. A
 * storage failure leaves every row without a delegation summary rather than
 * failing the dashboard.
 */
function attachDashboardDelegation(
  db: Database.Database,
  jobs: JobSummary[],
  repositoryAgents: ReadonlyMap<number, string | undefined>,
  resolveExecutorKind: ExecutorKindResolver,
  now: Date | number | string | undefined,
): void {
  if (jobs.length === 0) return;
  const jobIds = jobs.map((job) => job.id);
  const attemptsByJob = new Map<number, Array<{ id: number; agent: string | undefined }>>();
  try {
    const rows = db
      .prepare(
        `SELECT id, job_id, agent FROM (
           SELECT id, job_id, agent,
                  ROW_NUMBER() OVER (
                    PARTITION BY job_id ORDER BY attempt_number DESC, id DESC
                  ) AS rn
           FROM attempts
           WHERE job_id IN (${jobIds.map(() => "?").join(",")})
         ) WHERE rn = 1`,
      )
      .all(...jobIds) as Array<{ id: number; job_id: number; agent: string | null }>;
    for (const row of rows) {
      const entry = { id: row.id, agent: row.agent === null ? undefined : row.agent };
      const list = attemptsByJob.get(row.job_id);
      if (list === undefined) attemptsByJob.set(row.job_id, [entry]);
      else list.push(entry);
    }
  } catch {
    return;
  }
  const attemptIds = [...attemptsByJob.values()].flat().map((attempt) => attempt.id);
  const observationResult = safeReadDelegationObservations(db, attemptIds);
  const observationsByAttempt = observationResult.ok
    ? observationResult.value
    : new Map<number, DelegationAttemptObservations>();
  const nowMs = toMillis(now);
  for (const job of jobs) {
    const jobAttempts = attemptsByJob.get(job.id) ?? [];
    const executorKind = jobExecutorKind(
      jobAttempts
        .map((attempt) => attempt.agent)
        .filter((agent): agent is string => agent !== undefined),
      repositoryAgents.get(job.id),
      resolveExecutorKind,
    );
    const observations = jobAttempts
      .map((attempt) => observationsByAttempt.get(attempt.id))
      .filter((value): value is DelegationAttemptObservations => value !== undefined);
    job.delegation = summarizeJobDelegation({
      executorKind,
      observations,
      now: nowMs,
    });
  }
}

/**
 * Read the dashboard's repository and job lanes.  The legacy shape (separate
 * `running`, `queued`, and `recent` arrays) is retained so existing routes can
 * adopt the query without changing their rendering contract.
 */
export function readDashboard(
  db: Database.Database,
  redaction: Redaction,
  options: DashboardReadOptions = {},
  resolveExecutorKind: ExecutorKindResolver = (agentId) => agentId,
): DashboardModel {
  const redact = asRedactor(redaction);
  const opencodeProfiles = new Map<number, { revision: number; profileJson: string | null }>();
  for (const row of db
    .prepare("SELECT repo_id, revision, profile_json FROM opencode_agent_profiles")
    .all() as Array<{ repo_id: number; revision: number; profile_json: string | null }>) {
    opencodeProfiles.set(row.repo_id, { revision: row.revision, profileJson: row.profile_json });
  }
  const opencodeSelections = new Map<
    number,
    { source: string; nativeAgentId: string | null; revision: number }
  >();
  for (const row of db
    .prepare("SELECT repo_id, source, native_agent_id, revision FROM opencode_primary_selections")
    .all() as Array<{
    repo_id: number;
    source: string;
    native_agent_id: string | null;
    revision: number;
  }>) {
    opencodeSelections.set(row.repo_id, {
      source: row.source,
      nativeAgentId: row.native_agent_id,
      revision: row.revision,
    });
  }
  const repositories = db
    .prepare(
      `SELECT id, owner, name, enabled, source_path, workspace_root, agent,
              model, provider, effort, validation_commands, agent_instructions,
              allowed_models, timeout_seconds
       FROM repositories ORDER BY owner, name`,
    )
    .all()
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      const safe = redactRow(row, redact) as unknown as RepositorySummary;
      const profile = opencodeProfiles.get(row.id as number);
      return {
        ...safe,
        // A corrupt stored profile must never take down the whole dashboard or
        // an SSE fragment: it fails closed to *no* projected team rather than
        // throwing out of the render.
        opencodeProfile: safeSummarizeOpenCodeProfile(profile, redact),
        opencodeSelection: summarizeOpenCodeSelection(
          opencodeSelections.get(row.id as number),
          profile,
          redact,
        ),
        validationCommands: parseValidationCommands(safe.validation_commands),
        allowedModels: parseAllowedModels(safe.allowed_models),
      };
    });
  const repositoryAgents = new Map<number, string | undefined>();
  const jobs = db
    .prepare(
      `SELECT jobs.*, repositories.owner, repositories.name,
              repositories.agent AS repository_agent
       FROM jobs JOIN repositories ON repositories.id = jobs.repo_id
       ORDER BY jobs.id DESC LIMIT 50`,
    )
    .all()
    .map((row) => {
      // The captured snapshot JSON carries the operator's private instruction
      // text; the status lanes must never project it, even redacted. Only the
      // dedicated job-detail projection derives a purpose-summary from it.
      const {
        opencode_profile_json: _profileJson,
        opencode_profile_revision: _revision,
        repository_agent: repositoryAgent,
        ...safeRow
      } = row as Record<string, unknown>;
      const job = redactRow(safeRow, redact) as unknown as JobSummary;
      repositoryAgents.set(
        job.id,
        typeof repositoryAgent === "string" ? repositoryAgent : undefined,
      );
      return job;
    });
  attachDashboardDelegation(db, jobs, repositoryAgents, resolveExecutorKind, options.now);
  const running = jobs.filter((job) => RUNNING_STATUSES.has(job.status));
  const queued = jobs.filter((job) => job.status === "queued");
  const recent = jobs.filter((job) => TERMINAL_STATUSES.has(job.status));
  const health = readHealth(
    db,
    options.pollIntervalSec ?? 60,
    options.concurrency ?? 1,
    options.now,
  );
  return { repositories, jobs, running, queued, recent, health };
}

/**
 * Build the privacy-safe dashboard projection of a saved OpenCode profile.
 * Identifiers, purposes, model data, and permission presets only; instruction
 * text is deliberately never read out here — the dedicated edit route
 * retrieves the full profile when the operator opens the editor.
 */
/**
 * Summarize a stored profile fail-closed: a payload that no longer parses (or
 * no stored payload at all) projects `null`, so one corrupt row cannot throw
 * out of the dashboard or an SSE fragment. The dedicated editor route remains
 * the surface that reports the corruption explicitly.
 */
function safeSummarizeOpenCodeProfile(
  profile: { revision: number; profileJson: string | null } | undefined,
  redact: Redactor,
): OpenCodeProfileSummary | null {
  if (profile === undefined || profile.profileJson === null) return null;
  try {
    return summarizeOpenCodeProfile(profile.profileJson, profile.revision, redact);
  } catch {
    return null;
  }
}

function summarizeOpenCodeProfile(
  profileJson: string,
  revision: number,
  redact: Redactor,
): OpenCodeProfileSummary {
  const profile = parseOpenCodeAgentProfile(JSON.parse(profileJson));
  return {
    revision,
    primaryId: profile.primary.id,
    primaryDescription: redact(profile.primary.description),
    primaryPermissions: [...profile.primary.permissions],
    primaryStepLimit: profile.primary.stepLimit ?? null,
    subagents: profile.subagents.map((agent) => ({
      id: agent.id,
      enabled: agent.enabled,
      description: redact(agent.description),
      model: agent.model === undefined ? null : redact(agent.model),
      permissions: [...agent.permissions],
      stepLimit: agent.stepLimit ?? null,
    })),
  };
}

/**
 * Project the durable primary source read as a privacy-safe summary. A missing
 * row reads as default at revision 0 with `explicit: false`, matching the
 * store's backward-compatible read so an untracked repository is distinguishable
 * from a deliberate default. Only the source, revision and retained id are
 * projected — never a native agent's definition.
 */
function summarizeOpenCodeSelection(
  selection: { source: string; nativeAgentId: string | null; revision: number } | undefined,
  profile: { revision: number; profileJson: string | null } | undefined,
  redact: Redactor,
): OpenCodeSelectionSummary {
  const savedRevision =
    profile !== undefined && profile.profileJson !== null ? profile.revision : null;
  if (selection === undefined) {
    return {
      source: "default",
      revision: 0,
      explicit: false,
      nativeAgentId: null,
      profileRevision: savedRevision,
    };
  }
  const source: OpenCodePrimarySourceName =
    selection.source === "native"
      ? "native"
      : selection.source === "managed"
        ? "managed"
        : "default";
  return {
    source,
    revision: selection.revision,
    explicit: true,
    nativeAgentId:
      source === "native" && selection.nativeAgentId !== null
        ? redact(selection.nativeAgentId)
        : null,
    // The saved profile revision is exposed whether the team is active or
    // dormant so the picker can CAS a deliberate managed activation. The source
    // still says whether that team currently controls new jobs.
    profileRevision: savedRevision,
  };
}

/**
 * Resolve the primary source captured with a job from its own row. Jobs that
 * recorded a source use it verbatim; a legacy OpenCode job with a captured
 * managed profile resolves managed and any other legacy job resolves nothing
 * (never a fabricated default, and never a later repository selection). An
 * unknown or corrupt recorded source projects nothing rather than guessing.
 */
function readCapturedOpenCodeSelection(
  jobRow: Record<string, unknown>,
  redact: Redactor,
  isOpenCodeJob: boolean,
): CapturedOpenCodeSelectionSummary | null {
  const profileRevision =
    typeof jobRow.opencode_profile_revision === "number" ? jobRow.opencode_profile_revision : null;
  const selectionRevision =
    typeof jobRow.opencode_selection_revision === "number"
      ? jobRow.opencode_selection_revision
      : null;
  const source = jobRow.opencode_source;
  if (source === "native") {
    const nativeAgentId =
      typeof jobRow.opencode_native_agent_id === "string" &&
      jobRow.opencode_native_agent_id.length > 0
        ? redact(jobRow.opencode_native_agent_id)
        : null;
    return { source: "native", nativeAgentId, selectionRevision, profileRevision: null };
  }
  if (source === "managed") {
    return { source: "managed", nativeAgentId: null, selectionRevision, profileRevision };
  }
  if (source === "default") {
    return { source: "default", nativeAgentId: null, selectionRevision, profileRevision: null };
  }
  if (source === null || source === undefined) {
    // Legacy job: a captured managed profile means managed. A job that recorded
    // neither source nor profile is only OpenCode's implicit default when the
    // recorded execution (attempt agents, else the configured agent) is
    // OpenCode; otherwise it stays unprojected so Cline jobs are not mislabeled.
    if (typeof jobRow.opencode_profile_json === "string") {
      return { source: "managed", nativeAgentId: null, selectionRevision: null, profileRevision };
    }
    if (isOpenCodeJob) {
      return {
        source: "default",
        nativeAgentId: null,
        selectionRevision: null,
        profileRevision: null,
      };
    }
    return null;
  }
  return null;
}

/**
 * Whether a job's recorded execution belongs to the OpenCode executor. The
 * agents recorded on the job's attempts are the historical evidence and win
 * over the repository's current (mutable) agent; only a job with no recorded
 * attempt falls back to the configured repository agent. Kinds are resolved
 * through the configured definitions, never by assuming an alias equals the
 * kind.
 */
function isOpenCodeExecution(
  attemptAgents: readonly (string | undefined)[],
  repositoryAgent: string | undefined,
  resolveKind: ExecutorKindResolver,
): boolean {
  for (const agent of attemptAgents) {
    if (agent !== undefined && resolveKind(agent) === OPENCODE_EXECUTOR_ID) return true;
  }
  if (attemptAgents.some((agent) => agent !== undefined)) return false;
  return repositoryAgent !== undefined && resolveKind(repositoryAgent) === OPENCODE_EXECUTOR_ID;
}

/**
 * Read the generic per-invocation ownership/identity evidence for one set of
 * attempts, grouped by attempt id. Requested and actual identity stay separate;
 * a missing actual identity stays null ("unknown") rather than echoing the
 * request. Every string is redacted like the rest of this module.
 */
function readOpenCodeInvocations(
  db: Database.Database,
  attemptIds: readonly number[],
  redact: Redactor,
): Map<number, OpenCodeInvocationSummary[]> {
  const result = new Map<number, OpenCodeInvocationSummary[]>();
  if (attemptIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT attempt_id, invocation_ordinal, status, ownership_state, requested_source,
              requested_native_agent_id, requested_profile_revision, parent_session_id,
              actual_primary_agent, actual_model, launched_at, settled_at
       FROM opencode_invocations
       WHERE attempt_id IN (${attemptIds.map(() => "?").join(",")})
       ORDER BY attempt_id, invocation_ordinal`,
    )
    .all(...attemptIds) as Array<{
    attempt_id: number;
    invocation_ordinal: number;
    status: string;
    ownership_state: string;
    requested_source: string;
    requested_native_agent_id: string | null;
    requested_profile_revision: number | null;
    parent_session_id: string | null;
    actual_primary_agent: string | null;
    actual_model: string | null;
    launched_at: string | null;
    settled_at: string | null;
  }>;
  for (const row of rows) {
    const entry: OpenCodeInvocationSummary = {
      ordinal: row.invocation_ordinal,
      requestedSource: redact(row.requested_source),
      requestedNativeAgentId:
        row.requested_native_agent_id === null ? null : redact(row.requested_native_agent_id),
      requestedProfileRevision: row.requested_profile_revision,
      parentSessionId: row.parent_session_id === null ? null : redact(row.parent_session_id),
      actualPrimaryAgent:
        row.actual_primary_agent === null ? null : redact(row.actual_primary_agent),
      actualModel: row.actual_model === null ? null : redact(row.actual_model),
      status: redact(row.status),
      ownershipState: redact(row.ownership_state),
      launchedAt: row.launched_at === null ? null : redact(row.launched_at),
      settledAt: row.settled_at === null ? null : redact(row.settled_at),
    };
    const list = result.get(row.attempt_id);
    if (list === undefined) result.set(row.attempt_id, [entry]);
    else list.push(entry);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Delegation observation projection (design D4/D5)
 * ------------------------------------------------------------------ */

/**
 * The per-attempt namespace the managed runner generates runtime agent ids
 * under. Reconstructed here so a friendly configured label is shown only when
 * an observed runtime id matches a captured generated definition exactly.
 */
function delegationAttemptNamespace(attemptId: number): string {
  return `attempt-${String(attemptId)}`;
}

/**
 * The configured callable managed definitions for one attempt, with the exact
 * generated runtime id each would carry. This list is configuration, never
 * evidence of execution; only an exact runtime-id match may borrow a label.
 */
function delegationConfiguredAgents(
  profile: OpenCodeProfileSummary | null,
  attemptId: number,
): DelegationConfiguredAgent[] {
  if (profile === null) return [];
  const namespace = delegationAttemptNamespace(attemptId);
  return [
    {
      id: profile.primaryId,
      runtimeId: `${namespace}/${profile.primaryId}`,
      callable: true,
      primary: true,
      model: null,
    },
    ...profile.subagents.map((subagent) => ({
      id: subagent.id,
      runtimeId: `${namespace}/${subagent.id}`,
      callable: subagent.enabled,
      primary: false,
      model: subagent.model,
    })),
  ];
}

/**
 * Resolve a display label for an observed runtime agent id: the captured
 * definition id only on an exact generated runtime-id match, otherwise the raw
 * (redacted) runtime id, or null for unknown identity. Only callable (generated)
 * definitions may lend a label — a disabled definition was never materialized,
 * so a runtime id matching one is not trusted. Never substitutes a configured
 * definition for an unmatched runtime id.
 */
function delegationAgentLabel(
  agentId: string | null,
  configured: readonly DelegationConfiguredAgent[],
): { label: string | null; friendly: boolean } {
  if (agentId === null) return { label: null, friendly: false };
  const match = configured.find(
    (candidate) => candidate.callable && candidate.runtimeId === agentId,
  );
  return match === undefined
    ? { label: agentId, friendly: false }
    : { label: match.id, friendly: true };
}

function countsFromReport(report: DelegationObservationReport): DelegationCounts {
  return {
    observed: report.total,
    invoked: report.invoked,
    running: report.running,
    idle: report.idle,
    succeeded: report.succeeded,
    failed: report.failed,
    interrupted: report.interrupted,
    unknown: report.unknown,
    cancellationRequested: report.cancellationRequested,
  };
}

/**
 * An executor that does not own attributed session telemetry is explicitly
 * unsupported (limited data), not an empty tree: Cline must never read as "no
 * subagents". An OpenCode executor with no coverage record is unavailable until
 * the observer attributes a root, matching design D2.
 */
function delegationAvailability(input: {
  executorKind: string | undefined;
  coverageRows: readonly DelegationInvocationCoverage[];
  report: DelegationObservationReport | undefined;
  limitedEvidence: boolean;
}): { availability: DelegationAvailability; coverage: DelegationCoverage; limited: boolean } {
  if (input.executorKind !== OPENCODE_EXECUTOR_ID) {
    return { availability: "unsupported", coverage: "none", limited: true };
  }
  if (input.coverageRows.length === 0 || input.report === undefined) {
    return { availability: "unavailable", coverage: "none", limited: true };
  }
  const limited = input.report.coverage === "partial" || input.limitedEvidence;
  const availability: DelegationAvailability =
    input.report.coverage === "unavailable" ? "unavailable" : limited ? "partial" : "observed";
  return { availability, coverage: input.report.coverage, limited };
}

/**
 * True when an observation node is a root invocation session rather than a
 * delegated child. Roots are kept in the tree for legibility but never counted
 * as delegations. Legacy imported children carry an unambiguous root id and a
 * null immediate parent, so they stay children.
 */
function isDelegationRootNode(
  node: Pick<DelegationObservationNode, "sessionId" | "rootSessionId" | "depth">,
): boolean {
  if (node.rootSessionId !== null && node.rootSessionId === node.sessionId) return true;
  return node.depth === 0;
}

function delegationNodeView(
  node: DelegationObservationNode,
  configured: readonly DelegationConfiguredAgent[],
  redact: Redactor,
  now: number,
): DelegationNodeView {
  const label = delegationAgentLabel(node.agent, configured);
  return {
    id: node.id,
    sessionId: redact(node.sessionId),
    parentSessionId: node.parentSessionId === null ? null : redact(node.parentSessionId),
    rootSessionId: node.rootSessionId === null ? null : redact(node.rootSessionId),
    depth: node.depth,
    isRoot: isDelegationRootNode(node),
    agentId: node.agent === null ? null : redact(node.agent),
    agentLabel: label.label === null ? null : redact(label.label),
    agentFriendly: label.friendly,
    model: node.model === null ? null : redact(node.model),
    state: projectDelegationState(node, { now }),
    outcome: node.lastOutcome,
    cancellationRequested: node.cancellationRequested,
    cancellationRequestedAt:
      node.cancellationRequestedAt === null ? null : redact(node.cancellationRequestedAt),
    firstObservedAt: node.firstObservedAt === null ? null : redact(node.firstObservedAt),
    lastObservedAt: node.lastObservedAt === null ? null : redact(node.lastObservedAt),
    sourceCreatedAt: node.sourceCreatedAt === null ? null : redact(node.sourceCreatedAt),
    sourceUpdatedAt: node.sourceUpdatedAt === null ? null : redact(node.sourceUpdatedAt),
    sourceIdleAt: node.sourceIdleAt === null ? null : redact(node.sourceIdleAt),
    limitedUncertainty: node.limitedUncertainty,
    historyPartial: node.historyPartial,
  };
}

/**
 * Group one attempt's observations into root-invocation trees. Multiple
 * invocation ordinals stay separate (internal retries), each node keeps its own
 * session identity, and coverage/gaps are reported per ordinal.
 */
function delegationInvocations(
  observations: DelegationAttemptObservations,
  configured: readonly DelegationConfiguredAgent[],
  redact: Redactor,
  now: number,
): DelegationInvocationView[] {
  const nodesByOrdinal = new Map<number, DelegationObservationNode[]>();
  for (const node of observations.nodes) {
    const list = nodesByOrdinal.get(node.invocationOrdinal);
    if (list === undefined) nodesByOrdinal.set(node.invocationOrdinal, [node]);
    else list.push(node);
  }
  const ordinals = new Set<number>([
    ...nodesByOrdinal.keys(),
    ...observations.coverage.map((row) => row.invocationOrdinal),
    ...observations.gaps.map((gap) => gap.invocationOrdinal),
  ]);
  return [...ordinals]
    .sort((left, right) => left - right)
    .map((ordinal) => {
      const nodes = (nodesByOrdinal.get(ordinal) ?? [])
        .slice()
        .sort((left, right) => (left.depth ?? 0) - (right.depth ?? 0) || left.id - right.id);
      const coverageRows = observations.coverage.filter((row) => row.invocationOrdinal === ordinal);
      const gapRows = observations.gaps.filter((gap) => gap.invocationOrdinal === ordinal);
      const openGaps = gapRows
        .filter((gap) => gap.closedAt === null)
        .map((gap) => redact(gap.detail));
      // Counts are child-only: a healthy root with no children reads "no
      // delegations observed yet", never one active delegation.
      const childNodes = nodes.filter((node) => !isDelegationRootNode(node));
      const report = reportDelegationObservations(
        {
          attemptId: observations.attemptId,
          nodes: childNodes,
          coverage: coverageRows,
          gaps: gapRows,
        },
        { now },
      );
      const row = coverageRows[0];
      const rootSessionId =
        nodes.find((node) => node.rootSessionId !== null)?.rootSessionId ?? null;
      return {
        ordinal,
        rootSessionId: rootSessionId === null ? null : redact(rootSessionId),
        nodes: nodes.map((node) => delegationNodeView(node, configured, redact, now)),
        coverage: report.coverage,
        transport: row?.transport ?? null,
        transportState: row?.transportState ?? null,
        lastSuccessAt: row?.lastSuccessAt ?? null,
        lastAttemptAt: row?.lastAttemptAt ?? null,
        gapCount: row?.gapCount ?? openGaps.length,
        truncated: report.truncated,
        historyPartial: coverageRows.some((entry) => entry.historyPartial),
        nodeLimitReached: coverageRows.some((entry) => entry.nodeLimitReached),
        openGaps,
        reconciledGaps: gapRows.filter((gap) => gap.closedAt !== null).length,
      };
    });
}

function buildDelegationAttemptDetail(input: {
  attemptId: number;
  executorKind: string | undefined;
  profile: OpenCodeProfileSummary | null;
  observations: DelegationAttemptObservations | undefined;
  redact: Redactor;
  now: number;
}): DelegationAttemptDetail {
  const configured = delegationConfiguredAgents(input.profile, input.attemptId);
  const observations = input.observations;
  const nodes = observations?.nodes ?? [];
  const coverageRows = observations?.coverage ?? [];
  const gaps = observations?.gaps ?? [];
  const childNodes = nodes.filter((node) => !isDelegationRootNode(node));
  const report =
    observations === undefined
      ? undefined
      : reportDelegationObservations(
          { attemptId: observations.attemptId, nodes: childNodes, coverage: coverageRows, gaps },
          { now: input.now },
        );
  const limitedEvidence =
    nodes.some((node) => node.limitedUncertainty) ||
    coverageRows.some((row) => row.historyPartial || row.truncated || row.nodeLimitReached);
  const availability = delegationAvailability({
    executorKind: input.executorKind,
    coverageRows,
    report,
    limitedEvidence,
  });
  return {
    attemptId: input.attemptId,
    executorKind: input.executorKind ?? null,
    availability: availability.availability,
    coverage: availability.coverage,
    configured,
    invocations:
      observations === undefined
        ? []
        : delegationInvocations(observations, configured, input.redact, input.now),
    openGaps: gaps.filter((gap) => gap.closedAt === null).map((gap) => input.redact(gap.detail)),
    limited: availability.limited,
    ...(report === undefined
      ? {
          observed: 0,
          invoked: 0,
          running: 0,
          idle: 0,
          succeeded: 0,
          failed: 0,
          interrupted: 0,
          unknown: 0,
          cancellationRequested: 0,
        }
      : countsFromReport(report)),
  };
}

/**
 * Aggregate one job's attempt observations into a single dashboard summary.
 * Batched read, no per-row session query; unknown is never counted as
 * completed.
 */
function summarizeJobDelegation(input: {
  executorKind: string | undefined;
  observations: readonly DelegationAttemptObservations[];
  now: number;
}): DelegationSummary {
  const nodes: DelegationObservationNode[] = [];
  const coverage: DelegationInvocationCoverage[] = [];
  const gaps: DelegationObservationGap[] = [];
  for (const observation of input.observations) {
    for (const node of observation.nodes) {
      if (!isDelegationRootNode(node)) nodes.push(node);
    }
    coverage.push(...observation.coverage);
    gaps.push(...observation.gaps);
  }
  const report = reportDelegationObservations(
    { attemptId: 0, nodes, coverage, gaps },
    { now: input.now },
  );
  const limitedEvidence =
    nodes.some((node) => node.limitedUncertainty) ||
    coverage.some((row) => row.historyPartial || row.truncated || row.nodeLimitReached);
  const availability = delegationAvailability({
    executorKind: input.executorKind,
    coverageRows: coverage,
    report,
    limitedEvidence,
  });
  return {
    executorKind: input.executorKind ?? null,
    availability: availability.availability,
    coverage: availability.coverage,
    limited: availability.limited,
    scope: "latest-attempt",
    ...countsFromReport(report),
  };
}

/**
 * The executor kind for a job's recorded work, resolved alias-aware from the
 * configured definitions. Attempts are historical evidence and win over the
 * repository's current (mutable) agent.
 */
function jobExecutorKind(
  attemptAgents: readonly string[],
  repositoryAgent: string | undefined,
  resolveKind: ExecutorKindResolver,
): string | undefined {
  for (const agent of attemptAgents) {
    const kind = resolveKind(agent);
    if (kind !== undefined) return kind;
  }
  return repositoryAgent === undefined ? undefined : resolveKind(repositoryAgent);
}

/** Read and redact a complete job diagnostic projection. */
export function readJobDetail(
  db: Database.Database,
  jobId: number,
  redaction: Redaction,
  dataDir = ".gremlyn",
  resolveExecutorKind: ExecutorKindResolver = (agentId) => agentId,
  now?: Date | number | string,
): JobDetail | undefined {
  const baseRedact = asRedactor(redaction);
  const jobRow = db
    .prepare(
      `SELECT jobs.*, repositories.owner, repositories.name, repositories.agent AS repository_agent
       FROM jobs JOIN repositories ON repositories.id = jobs.repo_id
       WHERE jobs.id = ?`,
    )
    .get(jobId) as Record<string, unknown> | undefined;
  if (!jobRow) return undefined;
  // A provider or configuration error can echo an agent's instruction body in
  // its diagnostic text. Treat captured instructions as job-local secrets on
  // ordinary job projections, in addition to the console's configured secret
  // redactor. The editor GET remains the only place that returns them in full.
  const privateInstructions: string[] = [];
  if (typeof jobRow.opencode_profile_json === "string") {
    try {
      const profile = parseOpenCodeAgentProfile(JSON.parse(jobRow.opencode_profile_json));
      for (const agent of [profile.primary, ...profile.subagents]) {
        if (agent.instructions) privateInstructions.push(agent.instructions);
      }
    } catch {
      // A corrupt snapshot is refused by the runner; never project its raw JSON.
    }
  }
  const instructionRedact = createRedactor(privateInstructions);
  const redact: Redactor = (value) => baseRedact(instructionRedact(value));

  const attemptRows = db
    .prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number")
    .all(jobId) as Record<string, unknown>[];
  const mappedAttempts = attemptRows.map((row) => {
    const raw = row as Record<string, unknown>;
    const outputRef = typeof raw.output_ref === "string" ? raw.output_ref : null;
    const safe = redactRow(raw, redact) as unknown as AttemptDetail;
    const artifact = readArtifact(outputRef);
    // Activity is written by the running attempt and already redacted at the
    // source; re-reading it here keeps a live attempt visible before its
    // final output file exists.
    return {
      ...safe,
      output: redact(artifact.text),
      outputRetained: artifact.retained,
      adopted: raw.adopted === 1,
      activity: readActivity(dataDir, safe.id),
    };
  });
  const attemptIds = mappedAttempts.map((attempt) => attempt.id);
  const childSessions = readManagedChildSessions(db, attemptIds, redact);
  const invocations = readOpenCodeInvocations(db, attemptIds, redact);
  // Observation is a separate, failure-isolated read: a broken observation
  // store degrades the delegation panel to unavailable telemetry and never
  // takes down the job view or its safety evidence.
  const observationResult = safeReadDelegationObservations(db, attemptIds);
  const observationsByAttempt = observationResult.ok
    ? observationResult.value
    : new Map<number, DelegationAttemptObservations>();
  const capturedProfile = readJobOpenCodeProfile(jobRow, redact);
  const nowMs = now === undefined ? Date.now() : toMillis(now);
  const attempts = mappedAttempts.map((attempt) => ({
    ...attempt,
    childSessions: childSessions.get(attempt.id) ?? [],
    invocations: invocations.get(attempt.id) ?? [],
    delegation: buildDelegationAttemptDetail({
      attemptId: attempt.id,
      executorKind: resolveExecutorKind(attempt.agent),
      profile: capturedProfile,
      observations: observationsByAttempt.get(attempt.id),
      redact,
      now: nowMs,
    }),
  }));
  const timeline = db
    .prepare(
      "SELECT id, job_id, attempt_id, status, at FROM status_events WHERE job_id = ? ORDER BY id",
    )
    .all(jobId)
    .map(
      (row) => redactRow(row as Record<string, unknown>, redact) as unknown as StatusTimelineEntry,
    );
  const validation = db
    .prepare(
      `SELECT validation_runs.* FROM validation_runs
       JOIN attempts ON attempts.id = validation_runs.attempt_id
       WHERE attempts.job_id = ? ORDER BY attempts.attempt_number, validation_runs.seq`,
    )
    .all(jobId)
    .map((row) => {
      const raw = row as Record<string, unknown>;
      const outputRef = typeof raw.output_ref === "string" ? raw.output_ref : null;
      const safe = redactRow(raw, redact) as unknown as ValidationRun;
      const artifact = readArtifact(outputRef);
      return { ...safe, output: redact(artifact.text), outputRetained: artifact.retained };
    });
  const logs = readJobLog(db, jobId, redact);
  const logTotal = (
    db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE job_id = ?").get(jobId) as {
      n: number;
    }
  ).n;
  // The captured snapshot JSON (which contains the operator's private
  // instruction text) must never reach the projection. It is replaced by the
  // redacted summary, and the revision rides along only as that summary's key.
  const {
    opencode_profile_json: _profileJson,
    opencode_profile_revision: _revision,
    ...jobRowSafe
  } = jobRow;
  const safeJob = redactRow(jobRowSafe, redact) as unknown as JobDetail["job"];
  const isOpenCodeJob = isOpenCodeExecution(
    attemptRows.map((row) => (typeof row.agent === "string" ? row.agent : undefined)),
    typeof jobRow.repository_agent === "string" ? jobRow.repository_agent : undefined,
    resolveExecutorKind,
  );
  return {
    job: {
      ...safeJob,
      opencodeProfile: capturedProfile,
      opencodeSelection: readCapturedOpenCodeSelection(jobRow, redact, isOpenCodeJob),
    },
    attempts,
    timeline,
    validation,
    logs,
    logTotal,
  };
}

/**
 * Read the delegated child-session evidence for one set of attempts, grouped
 * by attempt id. Session ids and states are redacted like every string that
 * leaves this module; outcomes and ids represent diagnostic facts, never
 * profile instruction content.
 */
function readManagedChildSessions(
  db: Database.Database,
  attemptIds: readonly number[],
  redact: Redactor,
): Map<number, ManagedChildSessionSummary[]> {
  const result = new Map<number, ManagedChildSessionSummary[]>();
  if (attemptIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT attempt_id, session_id, outcome, state, interrupted
       FROM managed_child_sessions
       WHERE attempt_id IN (${attemptIds.map(() => "?").join(",")})
       ORDER BY attempt_id, id`,
    )
    .all(...attemptIds) as Array<{
    attempt_id: number;
    session_id: string;
    outcome: string | null;
    state: string;
    interrupted: number;
  }>;
  for (const row of rows) {
    const entry: ManagedChildSessionSummary = {
      sessionId: redact(row.session_id),
      outcome: row.outcome === null ? null : redact(row.outcome),
      state: redact(row.state),
      interrupted: row.interrupted === 1,
    };
    const list = result.get(row.attempt_id);
    if (list === undefined) result.set(row.attempt_id, [entry]);
    else list.push(entry);
  }
  return result;
}

/**
 * Build the privacy-safe summary of the profile a job captured at creation,
 * or null when the job has no snapshot. The raw snapshot JSON is read only
 * long enough to parse the identifier/purpose projection, and never leaves
 * this function: instruction text is deliberately absent from job detail.
 * A snapshot that no longer parses projects nothing (fail closed) rather than
 * claiming an agent team that cannot be proven.
 */
function readJobOpenCodeProfile(
  jobRow: Record<string, unknown>,
  redact: Redactor,
): OpenCodeProfileSummary | null {
  const profileJson = jobRow.opencode_profile_json;
  const revision = jobRow.opencode_profile_revision;
  if (typeof profileJson !== "string" || typeof revision !== "number") return null;
  try {
    return summarizeOpenCodeProfile(profileJson, revision, redact);
  } catch {
    return null;
  }
}

/** Read only the selected job's structured lifecycle log. */
/**
 * How many log lines the job view tails by default.
 *
 * The console is the only window into a headless orchestrator, so the log has
 * to stay readable while a job is live. Every stream tick re-renders the whole
 * region; without a bound, a long-running attempt re-serialises its entire
 * history several times a second and the newest line — the only one anyone is
 * watching — sits at the bottom of an ever-growing wall.
 */
export const JOB_LOG_TAIL = 200;

export function readJobLog(
  db: Database.Database,
  jobId: number,
  redaction: Redaction,
  limit: number = JOB_LOG_TAIL,
): LogRow[] {
  const redact = asRedactor(redaction);
  // Take the newest rows, then restore chronological order for display.
  return db
    .prepare("SELECT * FROM log_entries WHERE job_id = ? ORDER BY id DESC LIMIT ?")
    .all(jobId, Math.max(1, Math.trunc(limit)))
    .reverse()
    .map((row) => {
      const safe = redactRow(row as Record<string, unknown>, redact) as unknown as LogRow;
      // Keep the endpoint's historical contract: absent structured fields are
      // represented by an empty JSON object rather than null.
      return { ...safe, fields: safe.fields ?? "{}" };
    });
}

/**
 * Derive process health from persisted activity and the configured limits.
 * Missing ingestion activity is intentionally not reported as healthy.
 */
export function readHealth(
  db: Database.Database,
  pollIntervalSec: number,
  concurrency: number,
  now?: Date | number | string,
): HealthModel {
  const latest = db
    .prepare("SELECT MAX(last_polled_at) AS last_polled_at FROM ingestion_state")
    .get() as { last_polled_at: string | null };
  const queue = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'").get() as {
    count: number;
  };
  const active = db
    .prepare(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE status IN ('preparing', 'running', 'validating', 'publishing', 'reporting')`,
    )
    .get() as { count: number };
  const lastPolledAt = latest.last_polled_at ?? null;
  const pollTime = lastPolledAt === null ? Number.NaN : Date.parse(lastPolledAt);
  const ageMs = Number.isFinite(pollTime) ? Math.max(0, toMillis(now) - pollTime) : Number.NaN;
  const intervalMs = Math.max(0, pollIntervalSec * 1_000);
  const stale = !Number.isFinite(pollTime) || ageMs > intervalMs;
  const pollAgeSec = Number.isFinite(ageMs) ? Math.floor(ageMs / 1_000) : null;
  return {
    lastPolledAt,
    lastPollAt: lastPolledAt,
    pollAgeSec,
    queueDepth: Number(queue.count),
    queuedCount: Number(queue.count),
    inFlight: Number(active.count),
    activeCount: Number(active.count),
    concurrency,
    pollIntervalSec,
    stale,
    status: lastPolledAt === null ? "unknown" : stale ? "stale" : "running",
  };
}

/** Read observed command outcomes, including refused commands that made no job. */
export function readProcessedCommands(
  db: Database.Database,
  redaction: Redaction,
  limit = 50,
): ProcessedCommandModel[] {
  const redact = asRedactor(redaction);
  return db
    .prepare(
      `SELECT processed_commands.*, repositories.owner, repositories.name
       FROM processed_commands JOIN repositories ON repositories.id = processed_commands.repo_id
       ORDER BY processed_commands.id DESC LIMIT ?`,
    )
    .all(boundedLimit(limit))
    .map((row) => {
      const safe = redactRow(
        row as Record<string, unknown>,
        redact,
      ) as unknown as ProcessedCommandModel;
      return { ...safe, repository: `${safe.owner}/${safe.name}` };
    });
}

/** Read the operator audit trail, redacting free-form detail before return. */
export function readOperatorActions(
  db: Database.Database,
  redaction: Redaction,
  limit = 50,
): OperatorActionModel[] {
  const redact = asRedactor(redaction);
  return db
    .prepare(
      "SELECT id, at, action, target, effect, detail FROM operator_actions ORDER BY id DESC LIMIT ?",
    )
    .all(boundedLimit(limit))
    .map(
      (row) => redactRow(row as Record<string, unknown>, redact) as unknown as OperatorActionModel,
    );
}

/** Build a query facade for route handlers and stream renderers. */
export function createConsoleQueries(input: {
  db: Database.Database;
  secrets: readonly string[];
  pollIntervalSec?: number;
  concurrency?: number;
  dataDir?: string;
  /** Resolve an agent alias to its executor kind for legacy job projection. */
  resolveExecutorKind?: ExecutorKindResolver;
}): ConsoleQueries;
export function createConsoleQueries(
  db: Database.Database,
  secrets: readonly string[],
  options?: Pick<DashboardReadOptions, "pollIntervalSec" | "concurrency">,
): ConsoleQueries;
export function createConsoleQueries(
  inputOrDb:
    | {
        db: Database.Database;
        secrets: readonly string[];
        pollIntervalSec?: number;
        concurrency?: number;
        dataDir?: string;
        resolveExecutorKind?: ExecutorKindResolver;
      }
    | Database.Database,
  secretsOrUndefined?: readonly string[],
  options: Pick<DashboardReadOptions, "pollIntervalSec" | "concurrency"> = {},
): ConsoleQueries {
  const input =
    typeof inputOrDb === "object" && "prepare" in inputOrDb
      ? {
          db: inputOrDb,
          secrets: secretsOrUndefined ?? [],
          ...options,
        }
      : inputOrDb;
  const redact = createRedactor(input.secrets);
  const pollIntervalSec = input.pollIntervalSec ?? 60;
  const concurrency = input.concurrency ?? 1;
  const resolveExecutorKind = input.resolveExecutorKind ?? ((agentId) => agentId);
  return {
    readDashboard: (readOptions = {}) =>
      readDashboard(
        input.db,
        redact,
        {
          pollIntervalSec,
          concurrency,
          ...readOptions,
        },
        resolveExecutorKind,
      ),
    readHealth: (now) => readHealth(input.db, pollIntervalSec, concurrency, now),
    readJobDetail: (jobId) =>
      readJobDetail(input.db, jobId, redact, input.dataDir ?? ".gremlyn", resolveExecutorKind),
    readJobLog: (jobId) => readJobLog(input.db, jobId, redact),
    readProcessedCommands: (limit) => readProcessedCommands(input.db, redact, limit),
    readOperatorActions: (limit) => readOperatorActions(input.db, redact, limit),
  };
}
