import type { JobDetail, ValidationRun } from "../queries.js";
import {
  agentActivity,
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

/**
 * A hunk reads as a diff, not as a wall of monospace.
 *
 * Each line keeps its own row so the added/removed tint spans the full width,
 * and the leading +/- stays in the text — the colour is a second signal, never
 * the only one.
 */
function diffHunk(text: string): string {
  const lines = text.split("\n").map((line) => {
    const kind = line.startsWith("+")
      ? "add"
      : line.startsWith("-")
        ? "del"
        : line.startsWith("@@")
          ? "meta"
          : "ctx";
    return `<span class="diff-${kind}">${escapeHtml(line)}</span>`;
  });
  return `<pre class="diff">${lines.join("")}</pre>`;
}

/** One review comment as a card; bodies keep their own line breaks. */
function threadComment(comment: unknown): string {
  const record = comment as Record<string, unknown>;
  const author = escapeHtml(record.authorLogin ?? record.author_login);
  return `<li class="thread-comment"><span class="thread-author">${author}</span><div class="thread-body">${escapeHtml(record.body)}</div></li>`;
}

function reviewContext(raw: string | null): string {
  if (!raw) return '<p class="muted">No review context recorded.</p>';
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.feedback === "string") {
      return `<pre class="review-scroll">${escapeHtml(value.feedback)}</pre>`;
    }
    const thread = Array.isArray(value.thread) ? value.thread : [];
    const facts = keyValueTable({
      "Pull request": value.prTitle ?? value.pr_title,
      Branch: value.headBranch ?? value.head_branch,
      "File path": value.filePath ?? value.file_path,
    });
    const hunk = diffHunk(String(value.diffHunk ?? value.diff_hunk ?? "No diff hunk recorded"));
    const comments = thread.length
      ? `<ol class="thread">${thread.map(threadComment).join("")}</ol>`
      : '<p class="muted">No thread comments recorded.</p>';
    // Side by side: the hunk is what changed, the thread is what was said about
    // it, and stacking them made this panel three times taller than the timeline
    // beside it.
    return `${facts}<div class="review-split"><div><h3>Diff hunk</h3>${hunk}</div><div><h3>Comment thread</h3>${comments}</div></div>`;
  } catch {
    return `<pre class="review-scroll">${escapeHtml(raw)}</pre>`;
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
    ? `latest ${String(shown)} of ${String(total)}`
    : `${String(total)} ${total === 1 ? "entry" : "entries"}`;
}

/** A metric tile, the same shape the dashboard uses for orchestrator health. */
function metric(label: string, value: string, note: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${note}</small></div>`;
}

function validationSummary(runs: ValidationRun[]): { value: string; note: string } {
  if (runs.length === 0) return { value: "—", note: "no runs recorded" };
  const failed = runs.filter((run) => run.exit_code !== 0).length;
  return {
    value: `${String(runs.length - failed)} / ${String(runs.length)}`,
    note: failed === 0 ? "all commands passed" : `${String(failed)} failing`,
  };
}

/**
 * The numbers an operator scans before reading anything: how long it has been
 * going, how many times it has been tried, how hard the agent is working, and
 * whether validation is the thing holding it up.
 */
function statStrip(model: JobDetail): string {
  const latest = model.attempts.at(-1);
  const elapsed = durationBetween(
    model.job.created_at ?? model.timeline[0]?.at,
    model.job.finished_at ?? undefined,
  );
  const validation = validationSummary(model.validation);
  const activity = latest?.activity ?? null;
  const steps = activity
    ? `${String(activity.toolCalls)} tool call${activity.toolCalls === 1 ? "" : "s"} · ${String(activity.iterations)} iteration${activity.iterations === 1 ? "" : "s"}`
    : "no transcript yet";
  return `<div class="stat-strip">${metric("Elapsed", elapsed, model.job.finished_at ? "finished" : "still running")}${metric("Attempts", String(model.attempts.length), latest ? `latest ${escapeHtml(latest.outcome ?? "in progress")}` : "none started")}${metric("Agent steps", activity ? String(activity.blocks.length) : "—", steps)}${metric("Validation", validation.value, validation.note)}${metric("Log", String(model.logTotal), logCount(model))}</div>`;
}

function actionControls(model: JobDetail): string {
  const status = model.job.status;
  const retryable = ["failed", "cancelled", "interrupted"].includes(status);
  const cancellable = LIVE_STATUSES.includes(status);
  const buttons = [
    retryable
      ? `<button class="primary" data-action="retry" data-url="/jobs/${model.job.id}/retry">Retry</button>`
      : "",
    cancellable
      ? `<button data-action="cancel" data-url="/jobs/${model.job.id}/cancel">Cancel</button>`
      : "",
  ].join("");
  const none = `<span class="muted">A ${escapeHtml(status)} job can be neither retried nor cancelled.</span>`;
  return `<div class="job-actions">${buttons || none}</div>`;
}

/**
 * Identity, state and controls in one band across the top.
 *
 * These used to be a run-on line of dot-separated links, with retry and cancel
 * stranded in a panel below the attempt tables — far from the status they act
 * on. Grouped, the whole answer to "what is this and what can I do about it"
 * fits above the fold.
 */
function jobHeader(model: JobDetail): string {
  const { owner, name, pr_number: pr, comment_id: comment } = model.job;
  const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const prUrl = `https://github.com/${repo}/pull/${String(pr)}`;
  const title = `<div class="job-title"><h1>${escapeHtml(`${owner}/${name}`)} <span class="job-pr">PR #${String(pr)}</span></h1>${statusPill(model.job.status)}<span class="chip" title="Triggering command"><code>${escapeHtml(model.job.command)}</code></span><span class="muted job-id">job ${String(model.job.id)}</span>${actionControls(model)}</div>`;
  const links = `<p class="job-links"><a href="${prUrl}">Pull request #${String(pr)} ↗</a><a href="${prUrl}#discussion_r${String(comment)}">Triggering comment discussion_r${String(comment)} ↗</a></p>`;
  return `<header class="page-head"><nav class="crumbs"><a href="/">Dashboard</a><span aria-hidden="true">/</span><span>${escapeHtml(`${owner}/${name}`)}</span><span aria-hidden="true">/</span><span>PR #${String(pr)}</span></nav>${title}${links}${statStrip(model)}<p class="sr-status" data-live-status role="status"></p></header>`;
}

/**
 * The agent's current transcript, the largest thing on the page.
 *
 * What an operator wants on opening a running job is "what is it doing right
 * now", side by side with the log that explains it. The newest attempt leads;
 * older attempts keep their own transcripts on their cards.
 */
function activityPanel(model: JobDetail): string {
  const latest = model.attempts.at(-1);
  const attempt = latest
    ? ` <span class="muted panel-note">attempt ${String(latest.attempt_number)}</span>`
    : "";
  // Default the pin to whether the agent is still writing: on a live job you
  // want the newest step, on a finished one you want to read from where you
  // left off. The operator's own choice survives every stream tick after that.
  const live = LIVE_STATUSES.includes(model.job.status);
  const follow = `<label class="follow-toggle" title="Pin to the newest step while the agent runs"><input type="checkbox" data-activity-follow${live ? " checked" : ""}> Follow</label>`;
  return `<section class="panel activity-panel" data-resizable="activity"><h2>Agent activity ${liveBadge(model.job.status)}${attempt}</h2>${agentActivity(latest?.activity ?? null, follow)}</section>`;
}

/**
 * Everything that is context rather than live state, in a card grid below.
 *
 * Paired by height, not just by topic: the timeline and the validation table
 * are both short and share the first row, while the review context and the
 * attempts both want the full width. Putting a tall panel beside a short one
 * left a column of dead space taller than either.
 */
function jobAside(model: JobDetail): string {
  const totalStart = model.job.created_at ?? model.timeline[0]?.at;
  const totalEnd = model.job.finished_at ?? undefined;
  const attempts =
    model.attempts
      .map((attempt, index) =>
        attemptCard(attempt, { showActivity: index !== model.attempts.length - 1 }),
      )
      .join("") || '<p class="muted">No attempts recorded.</p>';
  const timeline = `<section class="panel"><h2>Timeline</h2>${timelineStepper(model.timeline, model.job.finished_at)}<p class="panel-foot"><strong>Total elapsed</strong> ${durationBetween(totalStart, totalEnd)}</p></section>`;
  const review = `<section class="panel span-all"><h2>Review feedback</h2>${reviewContext(model.job.review_context)}</section>`;
  const attemptPanel = `<section class="panel span-all"><h2>Attempts <span class="muted panel-note">${String(model.attempts.length)}</span></h2><div class="attempt-grid">${attempts}</div></section>`;
  const validation = `<section class="panel span-2"><h2>Validation results</h2><div class="table-scroll">${validationTable(model.validation)}</div></section>`;
  return `<div class="job-aside">${timeline}${validation}${review}${attemptPanel}${dangerZone(model.job.repo_id, model.job.pr_number)}</div>`;
}

export function jobRegions(model: JobDetail): {
  "job-detail-region": string;
  "job-log-region": string;
} {
  const logControls = `<div class="actions log-controls"><label class="log-search">Search <input data-log-filter placeholder="Filter entries"></label><label>Level <select data-log-level><option value="">All</option><option>debug</option><option>info</option><option>warn</option><option>error</option></select></label><label class="log-follow"><input type="checkbox" data-log-follow checked> Follow</label></div>`;
  return {
    "job-detail-region": `${jobHeader(model)}${activityPanel(model)}${jobAside(model)}`,
    "job-log-region": `<section class="panel" id="log-viewer" data-resizable="log"><h2>Live log ${liveBadge(model.job.status)} <span class="muted panel-note">${logCount(model)}</span></h2>${logControls}<div class="log-stream" data-scroll-keep="log" data-log-items>${logEntries(model.logs)}</div></section>`,
  };
}

function durationBetween(start: string | null | undefined, end: string | null | undefined): string {
  return start ? duration(start, end) : "—";
}

export function jobView(model: JobDetail): string {
  const regions = jobRegions(model);
  return `<div class="job-page"><div id="job-detail-region">${regions["job-detail-region"]}</div><div id="job-log-region">${regions["job-log-region"]}</div></div>`;
}
