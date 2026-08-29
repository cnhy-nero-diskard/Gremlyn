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

export function keyValueTable(values: Record<string, unknown>): string {
  return `<dl class="kv">${Object.entries(values)
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(key)}</dt><dd>${value === null || value === undefined || value === "" ? '<span class="muted">—</span>' : escapeHtml(value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

export function dangerZone(repoId: number, defaultPr: number): string {
  return `<section class="panel danger-zone" id="danger-zone"><h2>Destructive actions</h2><p>Workspace reset discards local work. Confirm by typing RESET (the required confirmation) before the action becomes available.</p><label>Pull request <input name="reset-pr" type="number" min="1" value="${defaultPr}"></label> <label>Confirmation <input data-reset-confirm name="reset-confirm" autocomplete="off" placeholder="RESET"></label> <button class="danger" data-action="reset" data-reset-submit data-url="/workspaces/${repoId}/reset" data-body="{&quot;confirm&quot;:&quot;RESET&quot;,&quot;prNumber&quot;:${defaultPr}}" disabled>Reset workspace</button></section>`;
}

export function timelineStepper(
  entries: StatusTimelineEntry[],
  finishedAt?: string | null,
): string {
  return `<ol class="timeline">${
    entries
      .map((entry, index) => {
        const next = entries[index + 1];
        return `<li>${statusPill(entry.status)} <time datetime="${escapeHtml(entry.at)}">${escapeHtml(entry.at)}</time> <span class="muted">(${duration(entry.at, next?.at ?? finishedAt)})</span></li>`;
      })
      .join("") || '<li class="muted">No status events recorded.</li>'
  }</ol>`;
}

export function validationTable(runs: ValidationRun[]): string {
  return `<table><thead><tr><th>Command</th><th>Exit code</th><th>Duration</th><th>Output</th></tr></thead><tbody>${runs.map((run) => `<tr><td><code>${escapeHtml(displayCommand(run.command))}</code></td><td>${run.exit_code ?? "—"}</td><td>${run.duration_ms === null ? "—" : `${run.duration_ms}ms`}</td><td><details><summary>Show output</summary><pre>${escapeHtml(run.output)}</pre></details></td></tr>`).join("") || '<tr><td colspan="4" class="muted">No validation runs recorded.</td></tr>'}</tbody></table>`;
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

export function attemptCard(attempt: AttemptDetail): string {
  return `<article><h2>Attempt ${attempt.attempt_number}</h2>${keyValueTable({ Agent: `${attempt.agent} / ${attempt.model} / ${attempt.effort}`, Workspace: attempt.workspace_path ?? "not prepared", Outcome: attempt.outcome ?? "pending", "Failure stage": attempt.failure_stage ?? "none", "Failure reason": attempt.failure_reason ?? "none", Commit: attempt.commit_sha ?? "none", Reporting: attempt.report_status ?? "pending", Started: attempt.started_at ?? null, Ended: attempt.ended_at ?? null, Duration: duration(attempt.started_at, attempt.ended_at), "Agent exit code": attempt.agent_exit_code, Pushed: attempt.pushed === 1 ? "yes" : "no", "Uncommitted changes": attempt.has_uncommitted_changes === 1 ? "yes" : "no", "Head SHA at prepare": attempt.head_sha_at_prepare })}<h3>Agent activity</h3>${agentActivity(attempt.activity)}<h3>Agent output</h3><details><summary>Raw stream</summary><pre>${escapeHtml(attempt.output)}</pre></details></article>`;
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
  tool: "Tool input",
};

/**
 * The agent's own transcript for an attempt.
 *
 * Reasoning is collapsed by default and narration is not: reasoning is the
 * model's unfiltered intermediate output and can quote file contents verbatim,
 * so it should be opened deliberately rather than sprayed across the page.
 * An open block is still being written, and says so, because a transcript that
 * simply stops is indistinguishable from a stalled agent.
 */
export function agentActivity(activity: AgentActivity | null): string {
  if (!activity || activity.blocks.length === 0) {
    return '<p class="muted">No agent activity captured yet.</p>';
  }
  const summary = `<p class="muted activity-summary">${String(activity.iterations)} iteration${activity.iterations === 1 ? "" : "s"} · ${String(activity.toolCalls)} tool call${activity.toolCalls === 1 ? "" : "s"} · updated ${escapeHtml(activity.updatedAt)}</p>`;
  const blocks = activity.blocks
    .map((block) => {
      const label = ACTIVITY_LABELS[block.kind] ?? block.kind;
      const pending = block.done ? "" : '<span class="activity-open">writing…</span>';
      const body = `<pre class="activity-text">${escapeHtml(block.text)}</pre>`;
      const head = `<span class="activity-kind activity-${escapeHtml(block.kind)}">${escapeHtml(label)}</span>${pending}`;
      return block.kind === "reasoning"
        ? `<details class="activity-block" data-details-key="activity-${String(block.seq)}"><summary>${head}</summary>${body}</details>`
        : `<div class="activity-block"><div class="activity-head">${head}</div>${body}</div>`;
    })
    .join("");
  return `${summary}<div class="activity-stream" data-scroll-keep="activity">${blocks}</div>`;
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
