import type { JobDetail } from "../queries.js";
import {
  attemptCard,
  dangerZone,
  duration,
  escapeHtml,
  keyValueTable,
  logEntries,
  statusPill,
  timelineStepper,
  validationTable,
} from "./components.js";

function reviewContext(raw: string | null): string {
  if (!raw) return '<p class="muted">No review context recorded.</p>';
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.feedback === "string") {
      return `<h3>Review feedback</h3><pre>${escapeHtml(value.feedback)}</pre>`;
    }
    const thread = Array.isArray(value.thread) ? value.thread : [];
    return `${keyValueTable({ "Pull request": value.prTitle ?? value.pr_title, Branch: value.headBranch ?? value.head_branch, "File path": value.filePath ?? value.file_path })}<h3>Diff hunk</h3><pre>${escapeHtml(value.diffHunk ?? value.diff_hunk ?? "No diff hunk recorded")}</pre><h3>Comment thread</h3>${thread.length ? `<ul>${thread.map((comment) => `<li><strong>${escapeHtml((comment as Record<string, unknown>).authorLogin ?? (comment as Record<string, unknown>).author_login)}</strong>: ${escapeHtml((comment as Record<string, unknown>).body)}</li>`).join("")}</ul>` : '<p class="muted">No thread comments recorded.</p>'}`;
  } catch {
    return `<pre>${escapeHtml(raw)}</pre>`;
  }
}

const LIVE_STATUSES = ["queued", "preparing", "running", "validating", "publishing", "reporting"];

/** Mark the log as streaming, so a still panel is not mistaken for a stalled one. */
function liveBadge(status: string): string {
  return LIVE_STATUSES.includes(status)
    ? '<span class="live-badge" title="Streaming while this job runs">live</span>'
    : '<span class="muted live-badge-off">ended</span>';
}

function logCount(model: JobDetail): string {
  const shown = model.logs.length;
  const total = model.logTotal;
  return total > shown
    ? `Showing the latest ${String(shown)} of ${String(total)} entries.`
    : `${String(total)} ${total === 1 ? "entry" : "entries"}.`;
}

function actionControls(model: JobDetail): string {
  const status = model.job.status;
  const retryable = ["failed", "cancelled", "interrupted"].includes(status);
  const cancellable =
    status === "queued" ||
    ["preparing", "running", "validating", "publishing", "reporting"].includes(status);
  return `<section class="panel"><h2>Routine actions</h2><div class="actions">${retryable ? `<button data-action="retry" data-url="/jobs/${model.job.id}/retry">Retry</button>` : '<span class="muted">Retry unavailable: only failed, cancelled or interrupted jobs can be retried.</span>'}${cancellable ? `<button data-action="cancel" data-url="/jobs/${model.job.id}/cancel">Cancel</button>` : '<span class="muted">Cancel unavailable: this job is not queued or running.</span>'}</div><p class="sr-status" data-live-status role="status"></p></section>`;
}

export function jobRegions(model: JobDetail): {
  "job-detail-region": string;
  "job-log-region": string;
} {
  const firstEvent = model.timeline[0]?.at;
  const totalStart = model.job.created_at ?? firstEvent;
  const totalEnd = model.job.finished_at ?? undefined;
  return {
    "job-detail-region": `<h1>Job ${model.job.id}: ${escapeHtml(`${model.job.owner}/${model.job.name} PR #${model.job.pr_number}`)} ${statusPill(model.job.status)}</h1><p><a href="/">← Dashboard</a> · Command <code>${escapeHtml(model.job.command)}</code> · <a href="https://github.com/${encodeURIComponent(model.job.owner)}/${encodeURIComponent(model.job.name)}/pull/${model.job.pr_number}">Pull request #${model.job.pr_number}</a> · <a href="https://github.com/${encodeURIComponent(model.job.owner)}/${encodeURIComponent(model.job.name)}/pull/${model.job.pr_number}#discussion_r${model.job.comment_id}">Triggering comment discussion_r${model.job.comment_id}</a></p><section class="panel"><h2>Review feedback</h2>${reviewContext(model.job.review_context)}</section><section class="panel"><h2>Timeline</h2>${timelineStepper(model.timeline, model.job.finished_at)}<p><strong>Total elapsed:</strong> ${durationBetween(totalStart, totalEnd)}</p></section>${model.attempts.map(attemptCard).join("") || '<p class="muted">No attempts recorded.</p>'}<section class="panel"><h2>Validation results</h2>${validationTable(model.validation)}</section>${actionControls(model)}${dangerZone(model.job.repo_id, model.job.pr_number)}`,
    "job-log-region": `<section class="panel" id="log-viewer"><h2>Live log ${liveBadge(model.job.status)}</h2><div class="actions"><label>Level <select data-log-level><option value="">All</option><option>debug</option><option>info</option><option>warn</option><option>error</option></select></label><label>Search <input data-log-filter placeholder="Search entries"></label><label class="log-follow"><input type="checkbox" data-log-follow checked> Follow</label></div><p class="muted log-count">${logCount(model)}</p><div class="log-stream" data-scroll-keep="log" data-log-items>${logEntries(model.logs)}</div></section>`,
  };
}

function durationBetween(start: string | null | undefined, end: string | null | undefined): string {
  return start ? duration(start, end) : "—";
}

export function jobView(model: JobDetail): string {
  const regions = jobRegions(model);
  return `<div id="job-detail-region">${regions["job-detail-region"]}</div><div id="job-log-region">${regions["job-log-region"]}</div>`;
}
