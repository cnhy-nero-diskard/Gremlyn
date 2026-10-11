import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Live agent activity (operator-console spec: visibility while an attempt runs).
 *
 * Cline's `--json` stream is a token feed, not a transcript: a 1m47s attempt
 * emitted 845 lines / 511KB, of which 698 were `content_start` deltas. Each
 * delta carries both the fragment (`text`) and the whole block so far
 * (`accumulated`), so keeping the newest `accumulated` per block reconstructs
 * the transcript exactly while storing tens of records instead of hundreds.
 *
 * OpenCode's `--format json` stream (design D-opencode) is the opposite
 * shape: 14 events / 9KB for a five-step tool-using run, each one terminal
 * state with nothing to de-duplicate. `ActivityRecorder` stays a single
 * shared engine — the block shape, caps, redaction, and snapshot writer are
 * one thing the console renders — with a per-agent line mapper translating
 * each stream's own event shape onto it.
 *
 * Three content types arrive interleaved and are kept apart, because they are
 * read for different reasons and carry different risk:
 *   reasoning  the model's intermediate thinking — unfiltered, and liable to
 *              quote file contents verbatim, so the console collapses it
 *   text       the narration an operator actually follows (its plan, summary)
 *   tool       the arguments a tool was invoked with
 */

export type ActivityKind = "reasoning" | "text" | "tool" | "iteration" | "usage" | "result";

/** Whether a block belongs to the invocation root or to a verified child session. */
export type ActivityRole = "parent" | "child";

/**
 * Verified session attribution for a block (design D3). Populated only by the
 * caller *after* the observer has proven ownership; a raw stream line never
 * establishes its own attribution. Every field is sanitized before it reaches a
 * block or disk, and the whole object is optional so old snapshots and ordinary
 * single-session runs stay valid.
 */
export interface ActivityAttribution {
  /** Verified session this stream's activity belongs to. */
  sessionId?: string;
  /** Verified invocation-root session for the attempt. */
  rootSessionId?: string;
  /** Verified parent session, when the attributed session is a child. */
  parentSessionId?: string;
  /** Invocation ordinal within the attempt, when known. */
  invocation?: number;
  /** Role of the attributed session within the invocation. */
  role?: ActivityRole;
}

export interface ActivityBlock {
  seq: number;
  kind: ActivityKind;
  at: string;
  text: string;
  /** Set once the agent closes the block; an open block is still growing. */
  done: boolean;
  /** Verified attribution, present only after observer verification. */
  sessionId?: string;
  rootSessionId?: string;
  parentSessionId?: string;
  invocation?: number;
  role?: ActivityRole;
}

export interface AgentActivity {
  blocks: ActivityBlock[];
  toolCalls: number;
  iterations: number;
  /** Latest token usage the stream reported, when it reported any. */
  usage: Record<string, unknown> | null;
  updatedAt: string;
}

const CLINE_CONTENT_KINDS: Record<string, ActivityKind> = {
  reasoning: "reasoning",
  text: "text",
  tool: "tool",
};

/** Cap a single block so one runaway output cannot fill the console or disk. */
const MAX_BLOCK_CHARS = 20_000;
/** Cap total retained blocks; the newest are what an operator is watching. */
const MAX_BLOCKS = 200;

function clamp(text: string): string {
  return text.length <= MAX_BLOCK_CHARS
    ? text
    : `${text.slice(0, MAX_BLOCK_CHARS)}\n… truncated (${String(text.length - MAX_BLOCK_CHARS)} more characters)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Delegation tools hand work to another session. Their arguments are the
 * operator's prompt/instructions and their results can quote the child's
 * transcript, so neither may enter the parent's persisted activity: only the
 * tool name plus safe state/session/agent references are retained (design D3).
 *
 * Names are matched exactly against the recognized task/subagent/delegation
 * spellings, plus any name that self-identifies as a subagent or delegation
 * tool. Unrelated tools (including `task_progress`-style reporting tools) keep
 * their existing rendering.
 */
const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task",
  "new_task",
  "newtask",
  "subtask",
  "sub_task",
  "task_agent",
  "subagent",
  "sub_agent",
  "sub_agents",
  "use_subagents",
  "spawn_agent",
  "spawn_subagent",
  "delegate",
  "delegate_task",
  "delegation",
  "agent",
]);

/** True when a tool name denotes spawning or handing work to another session. */
export function isDelegationToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (DELEGATION_TOOL_NAMES.has(normalized)) return true;
  return (
    normalized.includes("subagent") ||
    normalized.includes("sub_agent") ||
    normalized.includes("delegat")
  );
}

/**
 * Well-known credential shapes. Shared by the reference whitelist (which
 * rejects them outright) and the baseline snapshot scrubber (which redacts
 * them), so a credential can neither be retained as a "reference" nor survive
 * on disk when the caller configured no redactor.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/gu,
  /sk-[A-Za-z0-9_-]{16,}/gu,
  /ghp_[A-Za-z0-9]{20,}/gu,
  /gho_[A-Za-z0-9]{20,}/gu,
  /ghs_[A-Za-z0-9]{20,}/gu,
  /ghr_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{8,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
  /ASIA[0-9A-Z]{16}/gu,
  /AIza[0-9A-Za-z_-]{20,}/gu,
  /ya29\.[A-Za-z0-9_-]{8,}/gu,
  /\bBearer\s+[A-Za-z0-9._~+/_-]{8,}=*/giu,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
];

/** Credential-looking prefixes used to veto an otherwise plausible reference. */
const CREDENTIAL_LIKE =
  /(?:^|[^A-Za-z0-9])(?:sk|ghp|gho|ghs|ghr|github_pat|xox[baprs]|akia|asia|aiza|ya29|bearer)[-_A-Za-z0-9]{4,}|(?:^|[^A-Za-z0-9])eyj[A-Za-z0-9._-]{8,}|(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password)[:=\s]/iu;

/**
 * Redact well-known credential shapes from any string before it is persisted.
 * Applied after the caller's own redactor, so a credential the caller has not
 * configured still cannot reach an activity snapshot.
 */
export function redactCredentials(value: string): string {
  let out = value;
  for (const pattern of CREDENTIAL_SHAPES) out = out.replace(pattern, "[redacted]");
  return out;
}

/**
 * Accept only a verified session reference: an OpenCode `ses…` id, or a Cline
 * documented `conv_…` task id. Everything else — including credential-shaped
 * and arbitrary strings — is rejected.
 */
function openCodeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  if (CREDENTIAL_LIKE.test(trimmed)) return undefined;
  return /^ses[A-Za-z0-9_-]+$/u.test(trimmed) ? trimmed : undefined;
}

/** Accept only a Cline documented `conv_…` task id. */
function clineSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  if (CREDENTIAL_LIKE.test(trimmed)) return undefined;
  return /^conv_[A-Za-z0-9_-]+$/u.test(trimmed) ? trimmed : undefined;
}

/** Verified attribution/delegation session reference: either executor's shape. */
function sessionRef(value: unknown): string | undefined {
  return openCodeSessionId(value) ?? clineSessionId(value);
}

/** Tool lifecycle states that are recognized; anything else is dropped. */
const KNOWN_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "error",
  "cancelled",
  "canceled",
  "failed",
  "success",
]);

/** Accept only a known, lowercase tool status; arbitrary identifiers are dropped. */
function toolStatusRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return KNOWN_TOOL_STATUSES.has(normalized) ? normalized : undefined;
}

/**
 * Accept only a bounded, credential-free agent identifier. A managed agent
 * reference may be scoped with slashes (`attempt-1/reviewer`), but URL/userinfo
 * shapes are still rejected: the character set excludes `:`, `@`, `?`, `#`,
 * `=`, `&`, `%`, whitespace, leading/trailing slashes, empty segments and `.`/
 * `..` segments. The value is copied, never substituted from configuration.
 */
function agentRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(trimmed)) return undefined;
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  return CREDENTIAL_LIKE.test(trimmed) ? undefined : trimmed;
}

/** Fixed, safe stand-in when a delegation tool's own name is not safe to render. */
const DELEGATION_TOOL_FALLBACK = "delegation tool";

/** Accept only a bounded, credential-free tool name; unsafe names use the fallback. */
function toolNameRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/u.test(trimmed)) return undefined;
  return CREDENTIAL_LIKE.test(trimmed) ? undefined : trimmed;
}

/** A valid wall-clock instant, or now when the source sent nothing usable. */
function safeTimestampMillis(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

/** A valid timestamp string (kept verbatim), or now when it is missing/malformed. */
function safeTimestampText(value: unknown): string {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return new Date(value).toISOString();
  return new Date().toISOString();
}

/** Render only the whitelisted references of a delegation tool, never its input/output. */
function delegationToolText(
  name: string,
  refs: { status?: string | undefined; session?: string | undefined; agent?: string | undefined },
): string {
  const lines = [toolNameRef(name) ?? DELEGATION_TOOL_FALLBACK];
  if (refs.status !== undefined) lines.push(`state: ${refs.status}`);
  if (refs.session !== undefined) lines.push(`session: ${refs.session}`);
  if (refs.agent !== undefined) lines.push(`agent: ${refs.agent}`);
  return lines.join("\n");
}

/** Delegation references from an OpenCode `tool_use` part (structured fields only). */
function openCodeDelegationText(part: Record<string, unknown>): string {
  const name = typeof part.tool === "string" ? part.tool : "tool";
  const state = isRecord(part.state) ? part.state : {};
  const input = isRecord(state.input) ? state.input : {};
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  return delegationToolText(name, {
    status: toolStatusRef(state.status),
    session:
      sessionRef(metadata.sessionId) ??
      sessionRef(metadata.sessionID) ??
      sessionRef(input.sessionId) ??
      sessionRef(input.sessionID),
    agent:
      agentRef(input.subagent_type) ??
      agentRef(input.subagentType) ??
      agentRef(input.agent) ??
      agentRef(input.subagent),
  });
}

/** Delegation references from a Cline tool event (structured fields only). */
function clineDelegationText(payload: Record<string, unknown>): string {
  const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
  const input = isRecord(payload.input) ? payload.input : {};
  return delegationToolText(name, {
    status: toolStatusRef(payload.status) ?? toolStatusRef(input.status),
    session:
      sessionRef(input.sessionId) ?? sessionRef(input.session_id) ?? sessionRef(input.taskId),
    agent:
      agentRef(input.subagent_type) ??
      agentRef(input.subagentType) ??
      agentRef(input.agent) ??
      agentRef(input.subagent),
  });
}

/**
 * The primitives a per-agent line mapper needs, backed by the shared engine
 * inside {@link ActivityRecorder}. A mapper never touches `blocks`, caps, or
 * `dirty` directly — it only describes what one stream line means.
 */
export interface ActivityMapperContext {
  /**
   * Set the full text of the block currently open for `kind`, opening one if
   * none is open. Matches Cline's "accumulated" semantics: a later call
   * replaces the text rather than concatenating it.
   */
  setOpenBlockText(kind: ActivityKind, at: string, text: string): void;
  /** Close whichever block is open for `kind`. No-op if none is open. */
  closeOpenBlock(kind: ActivityKind): void;
  /** Push one already-complete block, for a stream with nothing to de-duplicate. */
  pushClosedBlock(kind: ActivityKind, at: string, text: string): void;
  /** Begin a new turn: increments the iteration counter and closes every open block. */
  newIteration(): void;
  /** Record the latest usage/cost snapshot the stream reported. */
  recordUsage(usage: Record<string, unknown>): void;
  /** Count one tool invocation. */
  countToolCall(): void;
}

/** Translates one stream line into calls against {@link ActivityMapperContext}. Never throws. */
export type ActivityLineMapper = (line: string, ctx: ActivityMapperContext) => void;

/**
 * Ownership of a single stream line, as far as its own event shape reveals.
 * `absent` means the line carries no session field at all; `invalid` means a
 * field is present but malformed, oversized or otherwise not a trustworthy
 * session reference. The two must not be conflated: a malformed raw session
 * must never be treated as "no session" and then stamped as the verified
 * parent.
 */
export type ActivitySessionOwnership =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly sessionId: string }
  | { readonly kind: "invalid" };

/**
 * Reads the stream session ownership a single line declares. Used only to
 * decide whether a line may be attributed to a verified session — never to
 * invent attribution.
 */
export type ActivityLineSessionReader = (line: string) => ActivitySessionOwnership;

/** Classify a present-or-absent raw session field without losing malformed ownership. */
function classifySession(
  raw: unknown,
  accept: (value: unknown) => string | undefined,
): ActivitySessionOwnership {
  if (raw === undefined || raw === null) return { kind: "absent" };
  const sessionId = accept(raw);
  return sessionId === undefined ? { kind: "invalid" } : { kind: "valid", sessionId };
}

/**
 * OpenCode carries its stream session as top-level `sessionID`. Only that value
 * is authoritative; nested tool output is never read.
 */
function openCodeStreamOwnership(line: string): ActivitySessionOwnership {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return { kind: "absent" };
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { kind: "absent" };
  }
  if (!isRecord(event)) return { kind: "absent" };
  return classifySession(event.sessionID, openCodeSessionId);
}

/** Cline carries `taskId` (and session aliases) on its hook/agent events. */
function clineStreamOwnership(line: string): ActivitySessionOwnership {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return { kind: "absent" };
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { kind: "absent" };
  }
  if (!isRecord(event)) return { kind: "absent" };
  // First present field decides ownership; a malformed value is `invalid`, not
  // a reason to fall through to another alias.
  for (const candidate of [event.taskId, event.sessionId, event.session_id, event.sessionID]) {
    if (candidate !== undefined && candidate !== null)
      return classifySession(candidate, clineSessionId);
  }
  return { kind: "absent" };
}

/**
 * Pull the readable text out of one Cline content event.
 *
 * The three content types do not share a field, which is easy to get wrong:
 * narration streams as `text` deltas alongside an `accumulated` whole, whereas
 * reasoning arrives complete in `reasoning`, and a tool call carries a name
 * plus a structured `input`. Reading only `text`/`accumulated` silently drops
 * reasoning and tool activity — the stream looks fine and two thirds of it is
 * missing.
 */
function clineContentText(
  kind: ActivityKind,
  payload: Record<string, unknown>,
  currentText: () => string,
): string | undefined {
  if (kind === "reasoning") {
    return typeof payload.reasoning === "string" ? payload.reasoning : undefined;
  }
  if (kind === "tool") {
    const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
    // Delegation tools carry prompts/instructions as arguments; retain only
    // their safe references so they can never be flattened into the transcript.
    if (isDelegationToolName(name)) return clineDelegationText(payload);
    if (payload.input === undefined) return name;
    let rendered: string;
    try {
      rendered = JSON.stringify(payload.input, null, 2) ?? String(payload.input);
    } catch {
      rendered = String(payload.input);
    }
    return `${name}\n${rendered}`;
  }
  // Narration: `accumulated` is the whole block so far, so prefer it — a
  // dropped delta cannot then corrupt the reconstruction.
  if (typeof payload.accumulated === "string") return payload.accumulated;
  return typeof payload.text === "string" ? currentText() + payload.text : undefined;
}

/**
 * Cline's `--json` line mapper (design D10). Feed it every stdout line as it
 * arrives; unparsable lines and unknown event shapes are ignored rather than
 * throwing, because the stream is a diagnostic surface and must never be able
 * to fail the attempt it is describing.
 */
export function clineLineMapper(line: string, ctx: ActivityMapperContext): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const at = safeTimestampText(event.ts);

  if (event.type === "hook_event" && event.hookEventName === "tool_call") {
    ctx.countToolCall();
    return;
  }
  if (event.type !== "agent_event") return;
  const inner = event.event;
  if (inner === null || typeof inner !== "object") return;
  const payload = inner as Record<string, unknown>;

  switch (payload.type) {
    case "iteration_start": {
      ctx.newIteration();
      return;
    }
    case "usage": {
      ctx.recordUsage(payload);
      return;
    }
    case "content_start":
    case "content_update": {
      const kind = CLINE_CONTENT_KINDS[String(payload.contentType)];
      if (!kind) return;
      // currentText() is approximate here (always "") since the mapper does
      // not read recorder state back; Cline always sends `accumulated` for
      // narration in practice, so the token-delta fallback is never exercised.
      const text = clineContentText(kind, payload, () => "");
      if (text === undefined) return;
      ctx.setOpenBlockText(kind, at, text);
      return;
    }
    case "content_end": {
      const kind = CLINE_CONTENT_KINDS[String(payload.contentType)];
      if (!kind) return;
      ctx.closeOpenBlock(kind);
      return;
    }
    default:
      return;
  }
}

/** Render an OpenCode `tool_use` part the same way Cline's tool block reads: name, then input. */
function openCodeToolText(part: Record<string, unknown>): string {
  const name = typeof part.tool === "string" ? part.tool : "tool";
  const state = (part.state ?? {}) as Record<string, unknown>;
  const lines = [name];
  if (state.input !== undefined) {
    try {
      lines.push(JSON.stringify(state.input, null, 2) ?? String(state.input));
    } catch {
      lines.push(String(state.input));
    }
  }
  // Unlike Cline's tool block, OpenCode's state carries the outcome too — surface
  // it on failure, since that is exactly when an operator needs to see it.
  if (state.status === "error" && typeof state.output === "string") {
    lines.push(`error: ${state.output}`);
  }
  return lines.join("\n");
}

/**
 * OpenCode's `--format json` line mapper (design D-opencode), verified
 * against opencode 1.18.27. Every event carries terminal state — nothing
 * needs de-duplicating the way Cline's token deltas do — so `text`,
 * `reasoning`, and `tool_use` each become one already-complete block.
 */
export function opencodeLineMapper(line: string, ctx: ActivityMapperContext): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const at = safeTimestampMillis(event.timestamp);

  switch (event.type) {
    case "text": {
      const part = event.part as Record<string, unknown> | undefined;
      if (typeof part?.text === "string") ctx.pushClosedBlock("text", at, part.text);
      return;
    }
    case "reasoning": {
      const part = event.part as Record<string, unknown> | undefined;
      if (typeof part?.text === "string") ctx.pushClosedBlock("reasoning", at, part.text);
      return;
    }
    case "tool_use": {
      const part = event.part as Record<string, unknown> | undefined;
      if (!part) return;
      const name = typeof part.tool === "string" ? part.tool : "tool";
      // Delegation tools carry prompts/instructions and outputs; retain only
      // their safe references, never the arbitrary input or output.
      const text = isDelegationToolName(name)
        ? openCodeDelegationText(part)
        : openCodeToolText(part);
      ctx.pushClosedBlock("tool", at, text);
      ctx.countToolCall();
      return;
    }
    case "step_start": {
      ctx.newIteration();
      return;
    }
    case "step_finish": {
      const part = event.part as Record<string, unknown> | undefined;
      if (part?.tokens !== undefined || event.cost !== undefined) {
        ctx.recordUsage({
          tokens: part?.tokens ?? null,
          cost: (part as { cost?: unknown })?.cost ?? null,
        });
      }
      return;
    }
    case "error": {
      const error = event.error as Record<string, unknown> | undefined;
      const name = typeof error?.name === "string" ? error.name : "error";
      const message =
        typeof (error?.data as Record<string, unknown> | undefined)?.message === "string"
          ? ((error?.data as Record<string, unknown>).message as string)
          : "";
      ctx.pushClosedBlock("result", at, message ? `${name}: ${message}` : name);
      return;
    }
    default:
      return;
  }
}

/** Per-executor-kind mapper selection; keyed by `AgentExecutor.id` (design D-opencode). */
export const ACTIVITY_LINE_MAPPERS: Record<string, ActivityLineMapper> = {
  cline: clineLineMapper,
  opencode: opencodeLineMapper,
};

/** Per-executor-kind stream-session readers, matched to {@link ACTIVITY_LINE_MAPPERS}. */
export const ACTIVITY_LINE_SESSIONS: Record<string, ActivityLineSessionReader> = {
  cline: clineStreamOwnership,
  opencode: openCodeStreamOwnership,
};

/** Resolve the session reader that belongs to a mapper, by identity. */
function lineSessionReaderFor(mapper: ActivityLineMapper): ActivityLineSessionReader | undefined {
  for (const [id, candidate] of Object.entries(ACTIVITY_LINE_MAPPERS)) {
    if (candidate === mapper) return ACTIVITY_LINE_SESSIONS[id];
  }
  return undefined;
}

/** Sanitize caller-supplied attribution; reject anything not a safe, bounded reference. */
function normalizeAttribution(input: ActivityAttribution): ActivityAttribution {
  const sessionId = sessionRef(input.sessionId);
  const rootSessionId = sessionRef(input.rootSessionId);
  const parentSessionId = sessionRef(input.parentSessionId);
  const invocation =
    typeof input.invocation === "number" &&
    Number.isInteger(input.invocation) &&
    input.invocation >= 0
      ? input.invocation
      : undefined;
  const role = input.role === "parent" || input.role === "child" ? input.role : undefined;
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(rootSessionId === undefined ? {} : { rootSessionId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(invocation === undefined ? {} : { invocation }),
    ...(role === undefined ? {} : { role }),
  };
}

/**
 * Folds an agent's structured stdout stream into an ordered transcript, via a
 * per-agent {@link ActivityLineMapper}. The block shape, caps, and snapshot
 * writer are shared; only the meaning of one stream line is agent-specific.
 */
export class ActivityRecorder implements ActivityMapperContext {
  private readonly blocks: ActivityBlock[] = [];
  private open = new Map<ActivityKind, ActivityBlock>();
  private seq = 0;
  private toolCalls = 0;
  private iterations = 0;
  private usage: Record<string, unknown> | null = null;
  private dirty = false;
  /**
   * Verified attribution applied to every subsequent block. Set only through
   * {@link push}; an absent line attribution preserves the last verified value,
   * and an empty object clears it.
   */
  private attributed: ActivityAttribution = {};

  private readonly sessionReader: ActivityLineSessionReader | undefined;

  constructor(
    private readonly mapper: ActivityLineMapper = clineLineMapper,
    sessionReader?: ActivityLineSessionReader,
  ) {
    this.sessionReader = sessionReader ?? lineSessionReaderFor(mapper);
  }

  /** True when something changed since the last {@link snapshot} was taken. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  /**
   * Fold one stream line in, optionally under verified attribution. With a
   * verified session, only lines whose own stream ownership matches it are
   * kept: absent, malformed or different ownership is dropped, so an ambiguous
   * raw session can never be stamped as the verified parent and a child event
   * can never be flattened into the parent's transcript. Without attribution
   * the legacy unbounded behavior is unchanged.
   */
  push(line: string, attribution?: ActivityAttribution): void {
    if (attribution !== undefined) {
      const next = normalizeAttribution(attribution);
      if (JSON.stringify(next) !== JSON.stringify(this.attributed)) {
        // Never update an open block created under another invocation/session,
        // including the transition from unverified to verified attribution.
        this.finish();
      }
      this.attributed = next;
    }
    if (!this.acceptsLine(line)) return;
    try {
      this.mapper(line, this);
    } catch {
      // The stream is a diagnostic surface; a malformed line or mapper defect
      // must never be able to fail the attempt it is describing.
    }
  }

  /**
   * Decide whether a line may carry the verified session attribution. Unbound
   * streams (no verified session) accept everything. A verified session only
   * accepts an exact, valid ownership match — anything else, including a
   * missing reader or absent/malformed ownership, is dropped rather than
   * mis-attributed.
   */
  private acceptsLine(line: string): boolean {
    const expected = this.attributed.sessionId;
    if (expected === undefined) return true;
    const ownership = this.sessionReader?.(line);
    return ownership?.kind === "valid" && ownership.sessionId === expected;
  }

  /** The verified attribution fields to stamp onto a new block, if any. */
  private attributionFields(): Partial<ActivityBlock> {
    const a = this.attributed;
    return {
      ...(a.sessionId === undefined ? {} : { sessionId: a.sessionId }),
      ...(a.rootSessionId === undefined ? {} : { rootSessionId: a.rootSessionId }),
      ...(a.parentSessionId === undefined ? {} : { parentSessionId: a.parentSessionId }),
      ...(a.invocation === undefined ? {} : { invocation: a.invocation }),
      ...(a.role === undefined ? {} : { role: a.role }),
    };
  }

  setOpenBlockText(kind: ActivityKind, at: string, text: string): void {
    const existing = this.open.get(kind);
    if (existing) {
      existing.text = clamp(text);
      existing.at = at;
    } else {
      const block: ActivityBlock = {
        seq: ++this.seq,
        kind,
        at,
        text: clamp(text),
        done: false,
        ...this.attributionFields(),
      };
      this.blocks.push(block);
      this.open.set(kind, block);
      this.trimBlocks();
    }
    this.dirty = true;
  }

  closeOpenBlock(kind: ActivityKind): void {
    const block = this.open.get(kind);
    if (!block) return;
    block.done = true;
    this.open.delete(kind);
    this.dirty = true;
  }

  pushClosedBlock(kind: ActivityKind, at: string, text: string): void {
    this.blocks.push({
      seq: ++this.seq,
      kind,
      at,
      text: clamp(text),
      done: true,
      ...this.attributionFields(),
    });
    this.trimBlocks();
    this.dirty = true;
  }

  newIteration(): void {
    this.iterations += 1;
    // A new turn ends every open block: the next content belongs to it.
    this.open.clear();
    this.dirty = true;
  }

  recordUsage(usage: Record<string, unknown>): void {
    this.usage = usage;
    this.dirty = true;
  }

  countToolCall(): void {
    this.toolCalls += 1;
    this.dirty = true;
  }

  private trimBlocks(): void {
    if (this.blocks.length > MAX_BLOCKS) this.blocks.splice(0, this.blocks.length - MAX_BLOCKS);
  }

  /** Close every open block; call when the agent process has exited. */
  finish(): void {
    for (const block of this.open.values()) block.done = true;
    this.open.clear();
    this.dirty = true;
  }

  snapshot(): AgentActivity {
    this.dirty = false;
    return {
      blocks: this.blocks.map((block) => ({ ...block })),
      toolCalls: this.toolCalls,
      iterations: this.iterations,
      usage: this.usage,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Deterministic path for an attempt's activity, mirroring `writeAgentOutput`. */
export function activityPath(dataDir: string, attemptId: number): string {
  return join(dataDir, "output", `attempt-${attemptId}.activity.json`);
}

/**
 * Persist a snapshot for the console to read.
 *
 * Written as a whole file rather than appended: the console reads it while the
 * agent is still running, and a partial line would break the parse. Redaction
 * runs here because reasoning text can echo file contents verbatim.
 */
export function writeActivity(
  dataDir: string,
  attemptId: number,
  activity: AgentActivity,
  redact: (value: string) => string = (value) => value,
): string {
  const path = activityPath(dataDir, attemptId);
  mkdirSync(join(dataDir, "output"), { recursive: true });
  // The caller's redactor knows project-specific secrets; the baseline scrubber
  // removes well-known credential shapes the caller may not have configured.
  const scrub = (value: string): string => redactCredentials(redact(value));
  const safe: AgentActivity = {
    ...activity,
    blocks: activity.blocks.map((block) => ({
      ...block,
      text: scrub(block.text),
      // Attribution references are whitelisted at creation, and redacted again
      // here so a credential that happened to survive is never persisted.
      ...(block.sessionId === undefined ? {} : { sessionId: scrub(block.sessionId) }),
      ...(block.rootSessionId === undefined ? {} : { rootSessionId: scrub(block.rootSessionId) }),
      ...(block.parentSessionId === undefined
        ? {}
        : { parentSessionId: scrub(block.parentSessionId) }),
    })),
  };
  writeFileSync(path, JSON.stringify(safe), "utf8");
  return path;
}
