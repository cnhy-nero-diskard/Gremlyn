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

export interface ActivityBlock {
  seq: number;
  kind: ActivityKind;
  at: string;
  text: string;
  /** Set once the agent closes the block; an open block is still growing. */
  done: boolean;
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
  const at = typeof event.ts === "string" ? event.ts : new Date().toISOString();

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
  const at =
    typeof event.timestamp === "number"
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString();

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
      ctx.pushClosedBlock("tool", at, openCodeToolText(part));
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
        ctx.recordUsage({ tokens: part?.tokens ?? null, cost: (part as { cost?: unknown })?.cost ?? null });
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

  constructor(private readonly mapper: ActivityLineMapper = clineLineMapper) {}

  /** True when something changed since the last {@link snapshot} was taken. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  push(line: string): void {
    try {
      this.mapper(line, this);
    } catch {
      // The stream is a diagnostic surface; a malformed line or mapper defect
      // must never be able to fail the attempt it is describing.
    }
  }

  setOpenBlockText(kind: ActivityKind, at: string, text: string): void {
    const existing = this.open.get(kind);
    if (existing) {
      existing.text = clamp(text);
      existing.at = at;
    } else {
      const block: ActivityBlock = { seq: ++this.seq, kind, at, text: clamp(text), done: false };
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
    this.blocks.push({ seq: ++this.seq, kind, at, text: clamp(text), done: true });
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
  const safe: AgentActivity = {
    ...activity,
    blocks: activity.blocks.map((block) => ({ ...block, text: redact(block.text) })),
  };
  writeFileSync(path, JSON.stringify(safe), "utf8");
  return path;
}
