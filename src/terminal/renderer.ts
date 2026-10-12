import { sanitizeTerminalText } from "./projection.js";

export interface PresentationStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Owns a small region above an empty anchor line, never the alternate screen. */
export class AnchoredRenderer {
  private lines: string[] = [];
  private stopped = false;
  private lastWrite = -Infinity;
  private force = false;
  private readonly resize = (): void => {
    this.force = true;
  };
  private readonly error = (): void => {
    this.fail();
  };

  constructor(
    private readonly stream: PresentationStream,
    private readonly onFailure: () => void,
    private readonly now: () => number = Date.now,
  ) {
    stream.on?.("resize", this.resize);
    stream.on?.("error", this.error);
  }

  get dimensions(): { columns: number; rows: number } {
    return {
      columns: Math.max(2, Math.min(240, this.stream.columns ?? 80)),
      rows: Math.max(3, Math.min(40, this.stream.rows ?? 24)),
    };
  }

  render(content: readonly string[], color = false): void {
    if (this.stopped || this.now() - this.lastWrite < 250) return;
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
      return color && index === 0 ? `\x1b[1m${safe}\x1b[0m` : safe;
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
      this.lastWrite = this.now();
    }
  }

  diagnostic(text: string): void {
    if (this.stopped) return;
    const previous = this.lines;
    const output = this.clearRegion() + sanitizeTerminalText(text, 500) + "\n";
    this.lines = [];
    if (this.write(output)) {
      this.lastWrite = -Infinity;
      // Strings were sanitized on entry; strip optional style before rebuilding.
      this.render(previous.map((line) => sanitizeTerminalText(line, 500)));
    }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.detach();
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
      if (!this.stream.write(output)) {
        this.fail();
        return false;
      }
      return true;
    } catch {
      this.fail();
      return false;
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
  }
}
