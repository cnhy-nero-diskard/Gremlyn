import type { LogRecord, LogSink } from "./logger.js";

/**
 * Plain presentation sink (terminal-operator-experience task 2.2).
 *
 * A single presentation owner for non-interactive plain mode: it renders
 * redacted records as bounded, sanitized one-line diagnostics. Warnings/errors
 * remain visible even when repeated; lifecycle transitions/start information
 * are deduplicated through a small bounded cache; recurring unchanged
 * polling/ingest noise and debug chatter are suppressed. Output carries no
 * cursor or color sequences and never preserves raw control, bidirectional or
 * escape characters, so a hostile repository/diagnostic string cannot inject
 * terminal control sequences (including BEL) or spoof plain output.
 *
 * Sanitization here is intentionally self-contained: this module must not
 * depend on the interactive terminal renderer.
 */

/** Hard cap on the complete single line so one record can never flood output. */
export const MAX_PLAIN_LINE = 1_024;
/** Per-component caps applied before assembling the line. */
const MAX_TIMESTAMP = 32;
const MAX_EVENT = 120;
const MAX_FIELD_KEY = 64;
const MAX_FIELD_VALUE = 512;
/** Cap on dynamic fields rendered per record; overflow is counted, not dumped. */
const MAX_FIELDS = 16;
/** Bounded cache of recently seen informational transitions. */
const INFO_DUPLICATE_CACHE = 16;

/**
 * Control characters plus the Unicode bidirectional/format controls that can
 * spoof or reorder plain output (U+061C ALM, U+200E/200F LRM/RLM,
 * U+202A-202E LRE/RLE/PDF/LRO/RLO, U+2066-2069 LRI/RLI/FSI/PDI). Replacing
 * them with spaces collapses newlines, neutralizes ESC/BEL and destroys any
 * bidi embed attempt.
 */
/* eslint-disable no-control-regex */
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
/* eslint-enable no-control-regex */

/**
 * Events that repeat with little informational value per poll/ingested event;
 * suppressed in plain mode. These are the actual recurring routine logger
 * messages (ingest/polling and per-poll sweeps), not guessed names.
 */
export const UNCHANGED_NOISE_EVENTS: ReadonlySet<string> = new Set([
  "event observed",
  "command parsed",
  "workspace reclamation sweep",
  "artifact retention sweep",
]);

/**
 * Replace control, escape and bidirectional characters (including ESC/BEL/
 * newlines) so dynamic text cannot inject terminal controls, ring the bell, or
 * reorder output.
 */
export function sanitizePlainText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function renderFieldValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Whether a record is meaningful enough for plain mode: warnings/errors always
 * are, debug chatter and recurring ingest/poll/sweep events are not, and any
 * other informational transition/start line is.
 */
export function isPlainVisible(record: LogRecord): boolean {
  if (record.level === "warn" || record.level === "error") return true;
  if (record.level === "debug") return false;
  return !UNCHANGED_NOISE_EVENTS.has(record.event);
}

function infoSignature(record: LogRecord): string {
  // Cache only bounded visible content, never a potentially huge raw field payload.
  return formatPlainRecord({ ...record, at: "" });
}

/**
 * Format one redacted record as a single sanitized, overall-bounded plain line.
 * The result contains no trailing newline, no control/bidi characters and is
 * capped component-by-component and as a whole.
 */
export function formatPlainRecord(record: LogRecord): string {
  const parts: string[] = [
    truncate(sanitizePlainText(record.at), MAX_TIMESTAMP),
    truncate(sanitizePlainText(record.level.toUpperCase()), 5),
    truncate(sanitizePlainText(record.event), MAX_EVENT),
  ];
  if (record.jobId !== undefined) parts.push(`job=${record.jobId}`);
  if (record.attemptId !== undefined) parts.push(`attempt=${record.attemptId}`);
  const entries = Object.entries(record.fields);
  for (const [key, value] of entries.slice(0, MAX_FIELDS)) {
    parts.push(
      `${truncate(sanitizePlainText(key), MAX_FIELD_KEY)}=${truncate(
        sanitizePlainText(renderFieldValue(value)),
        MAX_FIELD_VALUE,
      )}`,
    );
  }
  if (entries.length > MAX_FIELDS) parts.push(`+${entries.length - MAX_FIELDS} more`);
  const line = parts.join(" ");
  if (line.length > MAX_PLAIN_LINE) return `${line.slice(0, MAX_PLAIN_LINE - 3)}...`;
  return line;
}

/**
 * Build a plain-mode sink writing to `write`. Warnings and errors are always
 * visible, even when repeated. Informational transitions are deduplicated
 * through a bounded cache so identical routine lines cannot accumulate.
 */
export function createPlainSink(write: (line: string) => void): LogSink {
  const recentInfo = new Set<string>();
  const infoOrder: string[] = [];
  return (record: LogRecord): void => {
    if (!isPlainVisible(record)) return;
    const line = `${formatPlainRecord(record)}\n`;
    if (record.level === "warn" || record.level === "error") {
      write(line);
      return;
    }
    const signature = infoSignature(record);
    if (recentInfo.has(signature)) return;
    write(line);
    recentInfo.add(signature);
    infoOrder.push(signature);
    if (infoOrder.length > INFO_DUPLICATE_CACHE) {
      const oldest = infoOrder.shift();
      if (oldest !== undefined) recentInfo.delete(oldest);
    }
  };
}
