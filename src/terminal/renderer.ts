import { sanitizeTerminalText } from "./projection.js";

const MAX_PENDING_DIAGNOSTICS = 8;

export interface PresentationStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

function colorForLine(index: number, line: string): string | undefined {
  if (index === 0) return "\x1b[1m";
  if (line.startsWith("Health: ")) {
    const state = line.slice("Health: ".length).toLowerCase();
    if (state === "healthy") return "\x1b[32m";
    if (state === "failed") return "\x1b[31m";
    if (state === "stale" || state === "unknown") return "\x1b[33m";
  }
  if (line.startsWith("Latest outcome:") || line.startsWith("Result #") || /^#\d+\s/.test(line)) {
    if (/\bfailed\b/i.test(line)) return "\x1b[31m";
    if (/\b(?:cancelled|interrupted)\b/i.test(line)) return "\x1b[33m";
    if (/\bsucceeded\b/i.test(line)) return "\x1b[32m";
    if (/\|\s*succeeded(?:\s|\||\()/i.test(line)) return "\x1b[32m";
    if (/\|\s*failed(?:\s|\||\()/i.test(line)) return "\x1b[31m";
    if (/\|\s*(?:cancelled|interrupted)(?:\s|\||\()/i.test(line)) return "\x1b[33m";
  }
  return undefined;
}

/** Owns a small region above an empty anchor line, never the alternate screen. */
export class AnchoredRenderer {
  private lines: string[] = [];
  private stopped = false;
  private waitingForDrain = false;
  private pendingRender: { content: readonly string[]; color: boolean } | undefined;
  private readonly pendingDiagnostics: string[] = [];
  private omittedDiagnostics = 0;
  private lastColor = false;
  private lastWrite = -Infinity;
  private force = false;
  private readonly resize = (): void => {
    this.force = true;
  };
  private readonly error = (): void => {
    this.fail();
  };
  private readonly drain = (): void => {
    if (this.stopped) return;
    this.waitingForDrain = false;
    this.flushPendingOutput();
  };

  constructor(
    private readonly stream: PresentationStream,
    private readonly onFailure: () => void,
    private readonly now: () => number = Date.now,
  ) {
    stream.on?.("resize", this.resize);
    stream.on?.("error", this.error);
    stream.on?.("drain", this.drain);
  }

  get dimensions(): { columns: number; rows: number } {
    return {
      columns: Math.max(2, Math.min(240, this.stream.columns ?? 80)),
      rows: Math.max(3, Math.min(40, this.stream.rows ?? 24)),
    };
  }

  render(content: readonly string[], color = false): void {
    if (this.stopped) return;
    if (this.waitingForDrain) {
      // Writable.write(false) accepted its chunk. Coalesce only later refreshes
      // until the accepted bytes have drained; never turn backpressure into a
      // terminal failure or queue every intermediate dashboard snapshot.
      this.pendingRender = { content: [...content], color };
      return;
    }
    if (this.now() - this.lastWrite < 250) return;
    if (!this.stream.isTTY || (this.stream.columns ?? 80) < 2) {
      this.fail();
      return;
    }
    const { columns, rows } = this.dimensions;
    const next = content.slice(0, rows - 2).map((line, index) => {
      const clean = sanitizeTerminalText(line, 1_000);
      const width = columns - 1;
      const safe =
        clean.length > width && width > 3
          ? clean.slice(0, width - 3) + "..."
          : clean.slice(0, width);
      const style = color ? colorForLine(index, safe) : undefined;
      return style === undefined ? safe : `${style}${safe}\x1b[0m`;
    });
    if (!this.force && JSON.stringify(next) === JSON.stringify(this.lines)) return;
    this.force = false;
    let output = "";
    if (this.lines.length === 0) {
      output = next.map((line) => `${line}\n`).join("");
    } else {
      const oldLength = this.lines.length;
      const size = Math.max(oldLength, next.length);
      // Extend from the anchor before updating existing lines.
      if (next.length > oldLength) output += "\n".repeat(next.length - oldLength);
      for (let i = 0; i < size; i++) {
        if (!this.force && this.lines[i] === next[i]) continue;
        const distance = size - i;
        output += `\x1b[${distance}A\r\x1b[2K${next[i] ?? ""}\r\x1b[${distance}B`;
      }
      if (next.length < oldLength) output += `\x1b[${oldLength - next.length}A\r`;
    }
    if (this.write(output)) {
      this.lines = next;
      this.lastColor = color;
      this.lastWrite = this.now();
    }
  }

  diagnostic(text: string): void {
    if (this.stopped) return;
    this.rememberRender();
    this.enqueueDiagnostic(sanitizeTerminalText(text, 500));
    this.flushPendingOutput();
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.detach();
    this.pendingRender = undefined;
    this.pendingDiagnostics.length = 0;
    this.omittedDiagnostics = 0;
    // Leave the final display in scrollback; the cursor is already at its anchor.
    this.lines = [];
  }

  private clearRegion(): string {
    const size = this.lines.length;
    if (!size) return "";
    return `\x1b[${size}A\r` + "\x1b[2K\n".repeat(size) + `\x1b[${size}A\r`;
  }

  private write(output: string): boolean {
    try {
      // Writable.write(false) still enqueues this chunk. Wait for drain before
      // issuing another dashboard refresh, and keep rendering after it fires.
      if (!this.stream.write(output)) this.waitingForDrain = true;
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  private rememberRender(): void {
    if (this.pendingRender !== undefined) return;
    this.pendingRender = {
      content: this.lines.map((line) => sanitizeTerminalText(line, 500)),
      color: this.lastColor,
    };
  }

  private enqueueDiagnostic(text: string): void {
    if (this.pendingDiagnostics.length >= MAX_PENDING_DIAGNOSTICS) {
      // Keep at least one queued error when warnings are flooding a blocked
      // stream; otherwise discard the oldest item and preserve recent context.
      const oldestNonError = this.pendingDiagnostics.findIndex(
        (diagnostic) => !/\bERROR\b/.test(diagnostic),
      );
      this.pendingDiagnostics.splice(oldestNonError >= 0 ? oldestNonError : 0, 1);
      this.omittedDiagnostics += 1;
    }
    this.pendingDiagnostics.push(text);
  }

  private flushPendingOutput(): void {
    if (this.stopped || this.waitingForDrain) return;
    while (!this.stopped && !this.waitingForDrain) {
      const diagnostic = this.pendingDiagnostics.shift();
      const nextDiagnostic =
        diagnostic ??
        (this.omittedDiagnostics > 0
          ? `WARN ${this.omittedDiagnostics} additional terminal diagnostics omitted during backpressure`
          : undefined);
      if (diagnostic === undefined && nextDiagnostic !== undefined) this.omittedDiagnostics = 0;

      if (nextDiagnostic !== undefined) {
        const output = this.clearRegion() + nextDiagnostic + "\n";
        this.lines = [];
        if (!this.write(output)) return;
        if (this.waitingForDrain) return;
        this.lastWrite = -Infinity;
        continue;
      }

      const pending = this.pendingRender;
      this.pendingRender = undefined;
      if (pending !== undefined) {
        this.force = true;
        this.lastWrite = -Infinity;
        this.render(pending.content, pending.color);
      }
      return;
    }
  }

  private fail(): void {
    if (this.stopped) return;
    this.stopped = true;
    // A failed stream may recover for append-only output. Cleanup is best effort.
    try {
      this.stream.write(this.clearRegion());
    } catch {
      /* Unwritable stream. */
    }
    this.detach();
    this.pendingRender = undefined;
    this.pendingDiagnostics.length = 0;
    this.omittedDiagnostics = 0;
    this.lines = [];
    try {
      this.onFailure();
    } catch {
      /* Presentation must never own execution. */
    }
  }

  private detach(): void {
    this.stream.removeListener?.("resize", this.resize);
    this.stream.removeListener?.("error", this.error);
    this.stream.removeListener?.("drain", this.drain);
  }
}
