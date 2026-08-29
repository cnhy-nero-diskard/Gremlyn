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

const CONTENT_KINDS: Record<string, ActivityKind> = {
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
 * Pull the readable text out of one content event.
 *
 * The three content types do not share a field, which is easy to get wrong:
 * narration streams as `text` deltas alongside an `accumulated` whole, whereas
 * reasoning arrives complete in `reasoning`, and a tool call carries a name
 * plus a structured `input`. Reading only `text`/`accumulated` silently drops
 * reasoning and tool activity — the stream looks fine and two thirds of it is
 * missing.
 */
function contentText(
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
 * Fold Cline's `--json` lines into an ordered transcript.
 *
 * Feed it every stdout line as it arrives; unparsable lines and unknown event
 * shapes are ignored rather than throwing, because the stream is a diagnostic
 * surface and must never be able to fail the attempt it is describing.
 */
export class ActivityRecorder {
  private readonly blocks: ActivityBlock[] = [];
  private open = new Map<ActivityKind, ActivityBlock>();
  private seq = 0;
  private toolCalls = 0;
  private iterations = 0;
  private usage: Record<string, unknown> | null = null;
  private dirty = false;

  /** True when something changed since the last {@link snapshot} was taken. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  push(line: string): void {
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
      this.toolCalls += 1;
      this.dirty = true;
      return;
    }
    if (event.type !== "agent_event") return;
    const inner = event.event;
    if (inner === null || typeof inner !== "object") return;
    const payload = inner as Record<string, unknown>;

    switch (payload.type) {
      case "iteration_start": {
        this.iterations += 1;
        // A new turn ends every open block: the next content belongs to it.
        this.open.clear();
        this.dirty = true;
        return;
      }
      case "usage": {
        this.usage = payload;
        this.dirty = true;
        return;
      }
      case "content_start":
      case "content_update": {
        const kind = CONTENT_KINDS[String(payload.contentType)];
        if (!kind) return;
        const text = contentText(kind, payload, () => this.open.get(kind)?.text ?? "");
        if (text === undefined) return;
        this.appendTo(kind, at, text);
        return;
      }
      case "content_end": {
        const kind = CONTENT_KINDS[String(payload.contentType)];
        if (!kind) return;
        const block = this.open.get(kind);
        if (block) {
          block.done = true;
          this.open.delete(kind);
          this.dirty = true;
        }
        return;
      }
      default:
        return;
    }
  }

  private appendTo(kind: ActivityKind, at: string, text: string): void {
    const existing = this.open.get(kind);
    if (existing) {
      existing.text = clamp(text);
      existing.at = at;
    } else {
      const block: ActivityBlock = { seq: ++this.seq, kind, at, text: clamp(text), done: false };
      this.blocks.push(block);
      this.open.set(kind, block);
      if (this.blocks.length > MAX_BLOCKS) this.blocks.splice(0, this.blocks.length - MAX_BLOCKS);
    }
    this.dirty = true;
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
