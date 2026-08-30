import type { AgentActivity } from "../../agent/activity.js";
import type { AttemptDetail, LogRow, StatusTimelineEntry, ValidationRun } from "../queries.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function statusPill(status: string): string {
  const safe = escapeHtml(status);
  const className = status.replace(/[^a-z0-9_-]/gi, "-");
  return `<span class="status-pill status-${className}" aria-label="Status: ${safe}">${safe}</span>`;
}

export function duration(
  start: string | null | undefined,
  end: string | null | undefined,
  now = Date.now(),
): string {
  if (!start) return "—";
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "—";
  const ms = Math.max(0, to - from);
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function relativeTimestamp(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "never";
  const ms = now - Date.parse(value);
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `2026-08-28T18:05:44.524Z` → `18:05:44`, the part that varies while watching. */
export function clockTime(at: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/u.exec(at);
  return match ? (match[1] ?? at) : at;
}

export function keyValueTable(values: Record<string, unknown>): string {
  return `<dl class="kv">${Object.entries(values)
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(key)}</dt><dd>${value === null || value === undefined || value === "" ? '<span class="muted">—</span>' : escapeHtml(value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

export function dangerZone(repoId: number, defaultPr: number): string {
  const controls = `<div class="actions danger-controls"><label>Pull request <input name="reset-pr" type="number" min="1" value="${defaultPr}"></label><label>Confirmation <input data-reset-confirm name="reset-confirm" autocomplete="off" placeholder="RESET"></label><button class="danger" data-action="reset" data-reset-submit data-url="/workspaces/${repoId}/reset" data-body="{&quot;confirm&quot;:&quot;RESET&quot;,&quot;prNumber&quot;:${defaultPr}}" disabled>Reset workspace</button></div>`;
  return `<section class="panel danger-zone span-all" id="danger-zone"><h2>Destructive actions</h2><p class="muted">Workspace reset discards local work. Type RESET to arm the button.</p>${controls}</section>`;
}

export function timelineStepper(
  entries: StatusTimelineEntry[],
  finishedAt?: string | null,
): string {
  return `<ol class="timeline">${
    entries
      .map((entry, index) => {
        const next = entries[index + 1];
        const at = escapeHtml(entry.at);
        // The date repeats on every row; the clock is the part that varies.
        return `<li>${statusPill(entry.status)}<time datetime="${at}" title="${at}">${escapeHtml(clockTime(entry.at))}</time><span class="muted">${duration(entry.at, next?.at ?? finishedAt)}</span></li>`;
      })
      .join("") || '<li class="muted">No status events recorded.</li>'
  }</ol>`;
}

/** A zero and a one look alike in a column of numbers; say which one passed. */
function exitCode(code: number | null): string {
  if (code === null) return '<span class="muted">—</span>';
  return `<span class="exit exit-${code === 0 ? "ok" : "bad"}">${String(code)}</span>`;
}

export function validationTable(runs: ValidationRun[]): string {
  const rows =
    runs
      .map(
        (run) =>
          `<tr><td><code>${escapeHtml(displayCommand(run.command))}</code></td><td>${exitCode(run.exit_code)}</td><td class="num">${run.duration_ms === null ? "—" : `${String(run.duration_ms)}ms`}</td><td><details><summary>Show output</summary><pre>${escapeHtml(run.output)}</pre></details></td></tr>`,
      )
      .join("") || '<tr><td colspan="4" class="muted">No validation runs recorded.</td></tr>';
  return `<table class="validation-table"><thead><tr><th>Command</th><th>Exit code</th><th>Duration</th><th>Output</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function displayCommand(command: string): string {
  try {
    const parsed: unknown = JSON.parse(command);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === "string")
      ? parsed.join(" ")
      : command;
  } catch {
    return command;
  }
}

/**
 * One attempt as a card rather than a fourteen-row key/value dump.
 *
 * The outcome, how long it took and why it failed are what an operator reads;
 * the rest — workspace paths, SHAs, exit codes — is forensic detail that only
 * matters once the summary has already pointed at this attempt, so it sits in
 * a quiet grid underneath and the two output streams stay folded away.
 */
export function attemptCard(
  attempt: AttemptDetail,
  options: { showActivity?: boolean } = {},
): string {
  const head = `<div class="attempt-head"><h3>Attempt ${attempt.attempt_number}</h3>${statusPill(attempt.outcome ?? "pending")}<span class="muted attempt-elapsed">${duration(attempt.started_at, attempt.ended_at)}</span></div>`;
  const spec = `<p class="attempt-spec"><span class="chip">${escapeHtml(attempt.agent)}</span><span class="chip">${escapeHtml(attempt.model)}</span><span class="chip">${escapeHtml(attempt.effort)}</span></p>`;
  const failure = attempt.failure_reason
    ? `<p class="attempt-failure"><strong>${escapeHtml(attempt.failure_stage ?? "failed")}</strong> ${escapeHtml(attempt.failure_reason)}</p>`
    : "";
  const facts = keyValueTable({
    Workspace: attempt.workspace_path ?? "not prepared",
    Commit: attempt.commit_sha ?? "none",
    Reporting: attempt.report_status ?? "pending",
    "Exit code": attempt.agent_exit_code,
    Pushed: attempt.pushed === 1 ? "yes" : "no",
    Uncommitted: attempt.has_uncommitted_changes === 1 ? "yes" : "no",
    Started: attempt.started_at,
    Ended: attempt.ended_at,
    "Head SHA at prepare": attempt.head_sha_at_prepare,
  });
  const transcript =
    options.showActivity === false
      ? ""
      : `<details class="activity-fold"><summary>Agent transcript</summary>${agentActivity(attempt.activity)}</details>`;
  const output = `<details><summary>Raw agent output</summary><pre>${escapeHtml(attempt.output)}</pre></details>`;
  return `<article class="attempt">${head}${spec}${failure}${facts}<div class="attempt-folds">${transcript}${output}</div></article>`;
}

/** `2026-08-28T17:53:05.254Z` → `17:53:05.254`, the part that varies while watching. */
function logClock(at: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?/u.exec(at);
  return match ? `${match[1]}${match[2] ?? ""}` : at;
}

/** Render one field value compactly; objects and arrays stay on a single line. */
function logValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  return JSON.stringify(value) ?? String(value);
}

/**
 * Structured fields as `key=value` chips rather than a raw JSON blob.
 *
 * The persisted shape is a JSON object, and dumping it verbatim into a <pre>
 * gave every line a second, wider line of braces and quotes — the reason the
 * log read as a wall. The chips carry the same data at a glance, and a value
 * long enough to matter (a git error, a stack) keeps its own full-width row so
 * it stays readable instead of being clipped.
 */
function logFields(raw: string | null): string {
  if (!raw || raw === "{}") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: show it verbatim rather than dropping information.
    return `<pre class="log-detail">${escapeHtml(raw)}</pre>`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `<pre class="log-detail">${escapeHtml(raw)}</pre>`;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return "";
  const chips: string[] = [];
  const details: string[] = [];
  for (const [key, value] of entries) {
    const text = logValue(value);
    if (text.length > 80 || text.includes("\n")) {
      details.push(
        `<pre class="log-detail"><span class="log-key">${escapeHtml(key)}</span> ${escapeHtml(text)}</pre>`,
      );
    } else {
      chips.push(
        `<span class="log-chip"><span class="log-key">${escapeHtml(key)}</span>${escapeHtml(text)}</span>`,
      );
    }
  }
  return `${chips.length > 0 ? `<span class="log-chips">${chips.join("")}</span>` : ""}${details.join("")}`;
}

const ACTIVITY_LABELS: Record<string, string> = {
  reasoning: "Thinking",
  text: "Narration",
  tool: "Tool call",
};

/**
 * A tool block is stored as `name` then its JSON input on following lines.
 * The name is the part worth showing at a glance; the arguments can be long
 * enough to bury the rest of the transcript, so they stay behind a toggle.
 */
function toolParts(text: string): { name: string; input: string } {
  const newline = text.indexOf("\n");
  return newline === -1
    ? { name: text, input: "" }
    : { name: text.slice(0, newline), input: text.slice(newline + 1) };
}

/**
 * The agent's own transcript for an attempt.
 *
 * Reasoning is collapsed by default and narration is not: reasoning is the
 * model's unfiltered intermediate output and can quote file contents verbatim,
 * so it should be opened deliberately rather than sprayed across the page.
 * An unfinished block is marked as still being written, because a transcript
 * that simply stops is indistinguishable from a stalled agent.
 */
export function agentActivity(activity: AgentActivity | null, controls = ""): string {
  const bar = (inner: string): string =>
    `<div class="activity-summary"><span class="muted">${inner}</span>${controls}</div>`;
  if (!activity || activity.blocks.length === 0) {
    return `${bar("No agent activity captured yet.")}`;
  }
  const summary = bar(
    `<span class="activity-stat">${String(activity.iterations)}</span> iteration${activity.iterations === 1 ? "" : "s"} · <span class="activity-stat">${String(activity.toolCalls)}</span> tool call${activity.toolCalls === 1 ? "" : "s"} · <span class="activity-stat">${String(activity.blocks.length)}</span> step${activity.blocks.length === 1 ? "" : "s"} · updated ${escapeHtml(clockTime(activity.updatedAt))}`,
  );
  const lastSeq = activity.blocks[activity.blocks.length - 1]?.seq;
  const blocks = activity.blocks
    .map((block) => {
      const label = ACTIVITY_LABELS[block.kind] ?? block.kind;
      const open = block.done ? "" : " is-open";
      const pending = block.done ? "" : '<span class="activity-open">writing…</span>';
      // The newest step opens by default so the operator sees what the agent
      // is doing right now without a click; older steps stay as the operator
      // left them (a live update never re-collapses a step once expanded).
      const latest = block.seq === lastSeq ? " open" : "";
      const head =
        `<span class="activity-kind">${escapeHtml(label)}</span>` +
        `<time class="activity-time" datetime="${escapeHtml(block.at)}">${escapeHtml(clockTime(block.at))}</time>` +
        pending;
      const shell = (inner: string): string =>
        `<li class="activity-block activity-${escapeHtml(block.kind)}${open}"><span class="activity-dot" aria-hidden="true"></span>${inner}</li>`;

      if (block.kind === "tool") {
        const { name, input } = toolParts(block.text);
        const args = input
          ? `<details class="activity-args" data-details-key="activity-args-${String(block.seq)}"${latest}><summary>arguments</summary><pre class="activity-text">${escapeHtml(input)}</pre></details>`
          : "";
        return shell(
          `<div class="activity-head">${head}</div><p class="activity-tool-name"><code>${escapeHtml(name)}</code></p>${args}`,
        );
      }
      if (block.kind === "reasoning") {
        return shell(
          `<details class="activity-fold" data-details-key="activity-${String(block.seq)}"${latest}><summary><span class="activity-head">${head}</span></summary><pre class="activity-text">${escapeHtml(block.text)}</pre></details>`,
        );
      }
      return shell(
        `<div class="activity-head">${head}</div><pre class="activity-text">${escapeHtml(block.text)}</pre>`,
      );
    })
    .join("");
  return `${summary}<ol class="activity-stream" data-scroll-keep="activity">${blocks}</ol>`;
}

export function logEntries(logs: LogRow[]): string {
  return (
    logs
      .map((log) => {
        const level = log.level.toLowerCase();
        return `<article class="log-line log-${escapeHtml(level.replace(/[^a-z]/gu, ""))}" data-log-entry data-level="${escapeHtml(log.level)}"><time class="log-time" datetime="${escapeHtml(log.at)}" title="${escapeHtml(log.at)}">${escapeHtml(logClock(log.at))}</time><span class="log-level">${escapeHtml(level)}</span><span class="log-body"><span class="log-event">${escapeHtml(log.event)}</span>${logFields(log.fields)}</span></article>`;
      })
      .join("") || '<p class="muted">No structured log entries.</p>'
  );
}
