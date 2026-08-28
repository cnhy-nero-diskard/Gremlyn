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
  return `<article><h2>Attempt ${attempt.attempt_number}</h2>${keyValueTable({ Agent: `${attempt.agent} / ${attempt.model} / ${attempt.effort}`, Workspace: attempt.workspace_path ?? "not prepared", Outcome: attempt.outcome ?? "pending", "Failure stage": attempt.failure_stage ?? "none", "Failure reason": attempt.failure_reason ?? "none", Commit: attempt.commit_sha ?? "none", Reporting: attempt.report_status ?? "pending", Started: attempt.started_at ?? null, Ended: attempt.ended_at ?? null, Duration: duration(attempt.started_at, attempt.ended_at), "Agent exit code": attempt.agent_exit_code, Pushed: attempt.pushed === 1 ? "yes" : "no", "Uncommitted changes": attempt.has_uncommitted_changes === 1 ? "yes" : "no", "Head SHA at prepare": attempt.head_sha_at_prepare })}<h3>Agent output</h3><pre>${escapeHtml(attempt.output)}</pre></article>`;
}

export function logEntries(logs: LogRow[]): string {
  return (
    logs
      .map(
        (log) =>
          `<article data-log-entry data-level="${escapeHtml(log.level)}"><time>${escapeHtml(log.at)}</time> <strong>${escapeHtml(log.level)}</strong> <b>${escapeHtml(log.event)}</b><pre>${escapeHtml(log.fields ?? "{}")}</pre></article>`,
      )
      .join("") || '<p class="muted">No structured log entries.</p>'
  );
}
