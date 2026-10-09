import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { activityPath, type AgentActivity } from "../agent/activity.js";
import { type OpenCodePermission, parseOpenCodeAgentProfile } from "../config/opencode-profile.js";
import { createRedactor, type Redactor } from "../log/redact.js";
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
 * Read the dashboard's repository and job lanes.  The legacy shape (separate
 * `running`, `queued`, and `recent` arrays) is retained so existing routes can
 * adopt the query without changing their rendering contract.
 */
export function readDashboard(
  db: Database.Database,
  redaction: Redaction,
  options: DashboardReadOptions = {},
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
  const jobs = db
    .prepare(
      `SELECT jobs.*, repositories.owner, repositories.name
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
        ...safeRow
      } = row as Record<string, unknown>;
      return redactRow(safeRow, redact) as unknown as JobSummary;
    });
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

/** Read and redact a complete job diagnostic projection. */
export function readJobDetail(
  db: Database.Database,
  jobId: number,
  redaction: Redaction,
  dataDir = ".gremlyn",
  resolveExecutorKind: ExecutorKindResolver = (agentId) => agentId,
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
  const attempts = mappedAttempts.map((attempt) => ({
    ...attempt,
    childSessions: childSessions.get(attempt.id) ?? [],
    invocations: invocations.get(attempt.id) ?? [],
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
      opencodeProfile: readJobOpenCodeProfile(jobRow, redact),
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
      readDashboard(input.db, redact, {
        pollIntervalSec,
        concurrency,
        ...readOptions,
      }),
    readHealth: (now) => readHealth(input.db, pollIntervalSec, concurrency, now),
    readJobDetail: (jobId) =>
      readJobDetail(input.db, jobId, redact, input.dataDir ?? ".gremlyn", resolveExecutorKind),
    readJobLog: (jobId) => readJobLog(input.db, jobId, redact),
    readProcessedCommands: (limit) => readProcessedCommands(input.db, redact, limit),
    readOperatorActions: (limit) => readOperatorActions(input.db, redact, limit),
  };
}
