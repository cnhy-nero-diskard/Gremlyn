import type {
  AttemptDetail,
  CapturedOpenCodeSelectionSummary,
  CurrentOpenCodeWorkflowSummary,
  DelegationAttemptDetail,
  DelegationConfiguredAgent,
  DelegationInvocationView,
  DelegationNodeView,
  JobDetail,
  JobWorkflowSummary,
  ManagedChildSessionSummary,
  OpenCodeInvocationSummary,
  ValidationRun,
} from "../queries.js";
import {
  agentActivity,
  attemptCard,
  clockTime,
  dangerZone,
  elapsedTimeElement,
  escapeHtml,
  keyValueTable,
  logEntries,
  relativeTimeElement,
  statusPill,
  timeElement,
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

/**
 * The managed OpenCode failure reasons whose specific detail is worth showing
 * in job detail: a configuration fault (profile/materialize/preflight) or an
 * unproven child tree (discovery/unsettled/cleanup). These are the reasons
 * whose detail message names the failing agent id or the child session ids.
 */
const MANAGED_FAILURE_REASONS = new Set([
  "managed-profile-corrupt",
  "managed-materialize-failed",
  "managed-preflight-failed",
  "managed-session-discovery-failed",
  "managed-child-unsettled",
  "managed-cleanup-failed",
]);

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
  return `<div class="job-actions" data-action-scope="job-${String(model.job.id)}">${buttons || none}<p class="action-feedback" data-action-feedback data-action-announcement role="status" aria-live="polite" aria-atomic="true"></p></div>`;
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
  const outcomeClass = model.job.status === "succeeded" ? " job-outcome-success" : "";
  const title = `<div class="job-title"><h1 data-focus-fallback tabindex="-1">${escapeHtml(`${owner}/${name}`)} <span class="job-pr">PR #${String(pr)}</span></h1>${statusPill(model.job.status)}<span class="chip" title="Triggering command"><code>${escapeHtml(model.job.command)}</code></span>${capturedAgentChip(model)}<span class="muted job-id">job ${String(model.job.id)}</span>${actionControls(model)}</div>`;
  const workflow = jobWorkflowBand(model);
  const links = `<p class="job-links"><a href="${prUrl}">Pull request #${String(pr)} ↗</a><a href="${prUrl}#discussion_r${String(comment)}">Triggering comment discussion_r${String(comment)} ↗</a></p>`;
  return `<header class="page-head presentation-peak${outcomeClass}" data-presentation="peak" data-job-outcome="${escapeHtml(model.job.status)}"><div class="crumbs"><a href="/">Dashboard</a><span aria-hidden="true">/</span><span>${escapeHtml(`${owner}/${name}`)}</span><span aria-hidden="true">/</span><span>PR #${String(pr)}</span></div>${title}${workflow}${links}${statStrip(model)}</header>`;
}

/**
 * The captured OpenCode agent profile as a compact chip beside the triggering
 * command. Names the primary agent and the exact revision the job froze at
 * creation; the private instruction text is never projected.
 */
function capturedAgentChip(model: JobDetail): string {
  const profile = model.job.opencodeProfile ?? null;
  if (profile !== null) {
    return `<span class="chip" title="Captured OpenCode agent profile at job creation">agent <code>${escapeHtml(profile.primaryId)}</code> · revision ${escapeHtml(String(profile.revision))}</span>`;
  }
  const captured = model.job.opencodeSelection ?? null;
  if (captured?.source === "native" && captured.nativeAgentId) {
    return `<span class="chip" title="Captured OpenCode primary source at job creation">agent <code>${escapeHtml(captured.nativeAgentId)}</code> · native</span>`;
  }
  return "";
}

/** One readable phrase for a job's captured primary source. */
function capturedSelectionSentence(captured: CapturedOpenCodeSelectionSummary): string {
  if (captured.source === "native") {
    return captured.nativeAgentId
      ? `native agent <code>${escapeHtml(captured.nativeAgentId)}</code>`
      : "native agent (the captured id is missing)";
  }
  if (captured.source === "managed") {
    return captured.profileRevision === null
      ? "managed team"
      : `managed team revision ${escapeHtml(String(captured.profileRevision))}`;
  }
  return "OpenCode default";
}

/* ------------------------------------------------------------------ *
 * Job workflow identity (tasks 4.1/4.2; design D4/D5)
 * ------------------------------------------------------------------ */

/**
 * The prominent captured-versus-actual identity near the job title: what this
 * job requested at creation, what the current attempt's newest launched
 * invocation actually ran as, and how today's repository settings differ for
 * new jobs and retries. The facts come from the authoritative `workflow`
 * projection (`JobDetail.workflow`, task 1.3) so history is never decorated
 * with the current team roster; the view only names the states and explains
 * the boundary.
 */

/** One readable sentence naming the repository's current primary source. */
function currentSettingsSentence(current: CurrentOpenCodeWorkflowSummary): string {
  if (current.source === "managed" && current.teamUnavailable) {
    // Managed source points at a missing or unreadable saved team: naming a
    // revision would imply a usable workflow. Say it is unavailable instead.
    return "the selected Gremlyn-managed team, which is currently unavailable";
  }
  if (current.source === "native") {
    return current.nativeAgentId
      ? `Existing OpenCode agent <code>${escapeHtml(current.nativeAgentId)}</code>`
      : "an existing OpenCode agent";
  }
  if (current.source === "managed") {
    return current.profileRevision === null
      ? "the Gremlyn-managed team"
      : `the Gremlyn-managed team at revision ${escapeHtml(String(current.profileRevision))}`;
  }
  return "OpenCode default";
}

/** A short phrase for the job's captured selection, used inside explanations. */
function jobWorkflowCapturedPhrase(workflow: JobWorkflowSummary): string {
  const captured = workflow.captured;
  if (captured === null) return "no captured primary source";
  if (captured.source === "native") {
    return captured.nativeAgentId
      ? `native agent <code>${escapeHtml(captured.nativeAgentId)}</code>`
      : "native agent (the captured id is missing)";
  }
  if (captured.source === "managed") {
    return captured.profileRevision === null
      ? "managed team"
      : `managed team revision ${escapeHtml(String(captured.profileRevision))}`;
  }
  return "OpenCode default";
}

/**
 * The requested-runner cell: the immutable captured source, named with the
 * captured managed primary id when the job's own snapshot identifies one. A
 * default/native capture never borrows the current team.
 */
function jobWorkflowCapturedCell(workflow: JobWorkflowSummary): string {
  const captured = workflow.captured;
  if (captured === null) {
    return '<span class="muted">No captured primary source recorded for this job.</span>';
  }
  if (captured.source === "native") {
    return captured.nativeAgentId
      ? `Existing OpenCode agent <code>${escapeHtml(captured.nativeAgentId)}</code>`
      : "Existing OpenCode agent (the captured id is missing)";
  }
  if (captured.source === "managed") {
    const primary = workflow.capturedTeam?.primaryId ?? null;
    const named = primary === null ? "" : ` <code>${escapeHtml(primary)}</code>`;
    const revision =
      captured.profileRevision === null
        ? ""
        : ` · revision ${escapeHtml(String(captured.profileRevision))}`;
    return `Gremlyn-managed team${named}${revision}`;
  }
  return "OpenCode default";
}

type JobActualState = "not-started" | "not-observed" | "observed";

/** How the current attempt's runtime identity reads, explicitly when unproven. */
function jobActualState(workflow: JobWorkflowSummary): JobActualState {
  const current = workflow.currentAttempt;
  if (current === null || !current.launched) return "not-started";
  return current.actualPrimaryAgent === null ? "not-observed" : "observed";
}

/** The actual-primary cell: identity, explicit not-started/not-observed, or model. */
function jobWorkflowActualCell(workflow: JobWorkflowSummary): {
  state: JobActualState;
  html: string;
} {
  const current = workflow.currentAttempt;
  const state = jobActualState(workflow);
  if (state === "not-started") {
    return { state, html: '<span data-job-actual-state="not-started">Not started</span>' };
  }
  if (state === "not-observed") {
    return {
      state,
      html: '<span class="muted" data-job-actual-state="not-observed">Not observed</span>',
    };
  }
  const primary = current?.actualPrimaryAgent ?? "unknown";
  const model = current?.actualModel ?? null;
  const modelHtml = model === null ? "" : ` · model <code>${escapeHtml(model)}</code>`;
  return {
    state,
    html: `<code data-job-actual-state="observed" data-job-actual-primary="${escapeHtml(primary)}">${escapeHtml(primary)}</code>${modelHtml}`,
  };
}

/**
 * The new-jobs/retry explanation, or null when current settings still match
 * the job's capture. Stated only when the projection proves they differ —
 * never inferred from the current team roster. An unavailable selected team
 * cannot be described as the workflow new jobs will use; the historical
 * capture stays valid either way.
 */
function jobWorkflowDifferenceNote(workflow: JobWorkflowSummary): string | null {
  if (!workflow.settingsDiffer || workflow.captured === null) return null;
  const current = workflow.currentSettings;
  if (current === null) return null;
  const consequence =
    workflow.difference === "managed-team-unavailable"
      ? "New jobs cannot safely use the selected team until it is repaired or the source is changed"
      : "New jobs use the current settings";
  return `Current repository settings now select ${currentSettingsSentence(
    current,
  )}; this job keeps its captured ${jobWorkflowCapturedPhrase(
    workflow,
  )}. ${consequence}; retrying this job keeps its recorded selection.`;
}

/**
 * A visible discrepancy note when an explicitly requested native/managed
 * primary ran as something else. Default resolution is never a discrepancy.
 */
function jobWorkflowDiscrepancyNote(workflow: JobWorkflowSummary): string | null {
  const current = workflow.currentAttempt;
  if (current === null || !current.discrepancy) return null;
  if (current.requestedPrimaryId === null || current.actualPrimaryAgent === null) return null;
  return `The observed primary <code>${escapeHtml(current.actualPrimaryAgent)}</code> differs from the requested <code>${escapeHtml(current.requestedPrimaryId)}</code>.`;
}

/** The concise observed-delegation cell beside the workflow identity (task 4.2). */
function jobWorkflowDelegationCell(model: JobDetail): string {
  const latest = model.attempts.at(-1);
  const delegation = latest?.delegation;
  if (delegation === undefined) return "";
  const headline = delegationAttemptHeadline(delegation);
  return `<div><dt>Delegation</dt><dd class="job-delegation-status" data-delegation-availability="${escapeHtml(delegation.availability)}">${escapeHtml(headline)}</dd></div>`;
}

/** Whether a job has any OpenCode workflow evidence worth the prominent band. */
function jobWorkflowHasEvidence(model: JobDetail): boolean {
  const workflow = model.workflow;
  if (workflow !== undefined && workflow.captured !== null) return true;
  return model.attempts.some((attempt) => (attempt.invocations?.length ?? 0) > 0);
}

/**
 * The prominent identity band under the job title: requested runner, the
 * current attempt's actual primary (not started / not observed / identity),
 * and the concise delegation status, plus the new-jobs/retry and discrepancy
 * notes. Absent for jobs without OpenCode workflow evidence so non-OpenCode
 * jobs are unchanged. Never substitutes the current team for a historical
 * capture, and never represents activation as evidence a child ran.
 */
function jobWorkflowBand(model: JobDetail): string {
  const workflow = model.workflow;
  if (workflow === undefined) return "";
  if (!jobWorkflowHasEvidence(model)) return "";
  const current = workflow.currentAttempt;
  const provenance =
    current === null || current.latestInvocation === null
      ? ""
      : ` <span class="muted">attempt ${String(current.attemptNumber)} · invocation ${String(current.latestInvocation.ordinal)}</span>`;
  const actual = jobWorkflowActualCell(workflow);
  const notes: string[] = [];
  const difference = jobWorkflowDifferenceNote(workflow);
  if (difference !== null) {
    notes.push(
      `<p class="agent-notice job-workflow-differs" data-job-settings-differ>${difference}</p>`,
    );
  }
  const discrepancy = jobWorkflowDiscrepancyNote(workflow);
  if (discrepancy !== null) {
    notes.push(`<p class="muted job-workflow-discrepancy" data-job-discrepancy>${discrepancy}</p>`);
  }
  const identity =
    `<dl class="kv job-workflow-identity">` +
    `<div><dt>Requested runner</dt><dd>${jobWorkflowCapturedCell(workflow)}</dd></div>` +
    `<div><dt>Actual primary${provenance}</dt><dd>${actual.html}</dd></div>` +
    `${jobWorkflowDelegationCell(model)}</dl>`;
  return `<div class="job-workflow" data-job-workflow data-live-key="job-workflow">${identity}${notes.join("")}</div>`;
}

/**
 * One OpenCode parent invocation's requested-versus-effective evidence. The
 * requested source is the captured policy; the effective primary is the actual
 * runtime identity when observed, or an explicit "unknown" when it was not.
 */
function invocationRow(invocation: OpenCodeInvocationSummary, attemptNumber: number): string {
  const requested =
    invocation.requestedSource === "native" && invocation.requestedNativeAgentId
      ? `native <code>${escapeHtml(invocation.requestedNativeAgentId)}</code>`
      : invocation.requestedSource === "managed"
        ? `managed${invocation.requestedProfileRevision === null ? "" : ` revision ${escapeHtml(String(invocation.requestedProfileRevision))}`}`
        : escapeHtml(invocation.requestedSource);
  const actual =
    invocation.actualPrimaryAgent === null
      ? '<span class="muted" data-invocation-actual-unknown>unknown</span>'
      : `<code>${escapeHtml(invocation.actualPrimaryAgent)}</code>`;
  const model =
    invocation.actualModel === null
      ? ""
      : ` · model <code>${escapeHtml(invocation.actualModel)}</code>`;
  const parent =
    invocation.parentSessionId === null
      ? '<span class="muted">no parent session captured</span>'
      : `<code class="session-id">${escapeHtml(invocation.parentSessionId)}</code>`;
  return `<li class="opencode-invocation" data-invocation-ordinal="${String(invocation.ordinal)}"><span class="chip">attempt ${String(attemptNumber)}</span><span class="chip">invocation ${String(invocation.ordinal)}</span><span class="chip">requested ${requested}</span><span class="opencode-invocation-effective">effective ${actual}${model}</span><span class="muted">${parent} · ${escapeHtml(invocation.status)}/${escapeHtml(invocation.ownershipState)}</span></li>`;
}

/**
 * The captured primary source and the per-invocation requested-versus-effective
 * identity. Native/default diagnostics state that external definitions are not
 * snapshotted. Rendered only when the job recorded a source or invocation
 * evidence, so non-OpenCode jobs are unchanged and no private instructions are
 * ever read out.
 */
function opencodeSelectionPanel(model: JobDetail): string {
  const captured = model.job.opencodeSelection ?? null;
  const invocations = model.attempts.flatMap((attempt) =>
    (attempt.invocations ?? []).map((invocation) => ({
      attemptNumber: attempt.attempt_number,
      invocation,
    })),
  );
  if (captured === null && invocations.length === 0) return "";
  const capturedLine =
    captured === null
      ? '<p class="muted">No captured primary source recorded for this job.</p>'
      : `<p class="opencode-captured">Requested runner: ${capturedSelectionSentence(captured)}${captured.selectionRevision === null ? "" : ` <span class="muted">(selection revision ${escapeHtml(String(captured.selectionRevision))})</span>`}.</p>`;
  const note =
    captured !== null && captured.source !== "managed"
      ? '<p class="muted">Default and native sources snapshot the selection policy, not a copy of external instruction files; the effective definition is resolved when the job runs.</p>'
      : "";
  const rows =
    invocations.length > 0
      ? `<ul class="opencode-invocations">${invocations
          .map((entry) => invocationRow(entry.invocation, entry.attemptNumber))
          .join("")}</ul>`
      : '<p class="muted">No OpenCode invocation evidence recorded; effective identity is unknown.</p>';
  return `<section class="panel presentation-inset span-all" data-presentation="inset" aria-label="OpenCode primary source and invocation identity"><h2>OpenCode primary source</h2>${capturedLine}${note}${rows}</section>`;
}

/**
 * The agent's current transcript, the largest thing on the page.
 *
 * What an operator wants on opening a running job is "what is it doing right
 * now", side by side with the log that explains it. The newest attempt leads;
 * older attempts keep their own transcripts on their cards.
 */
function activityPanel(model: JobDetail, timeZone?: string): string {
  const latest = model.attempts.at(-1);
  const attempt = latest
    ? ` <span class="muted panel-note">attempt ${String(latest.attempt_number)}</span>`
    : "";
  // Default the pin to whether the agent is still writing: on a live job you
  // want the newest step, on a finished one you want to read from where you
  // left off. The operator's own choice survives every stream tick after that.
  const live = LIVE_STATUSES.includes(model.job.status);
  const follow = `<label class="follow-toggle" title="Pin to the newest step while the agent runs"><input type="checkbox" data-activity-follow${live ? " checked" : ""}> Follow</label>`;
  return `<section class="panel presentation-panel activity-panel" data-presentation="panel" data-resizable="activity"><h2>Agent activity ${liveBadge(model.job.status)}${attempt}</h2>${agentActivity(latest?.activity ?? null, follow, timeZone)}</section>`;
}

/**
 * One delegated child session as a readable row: text first, colour second.
 * A settled child shows its terminal pinned outcome; a child whose quiescence
 * could not be proven shows that state explicitly with the mechanism spelled
 * out — unsettled means never confirmed stopped, unknown means its state could
 * not be verified. Both fail closed with the id in view.
 */
function childSessionEvidence(child: ManagedChildSessionSummary): string {
  const label = child.outcome ?? child.state;
  const note =
    child.state === "unsettled"
      ? " could not be confirmed stopped"
      : child.state === "unknown"
        ? " state could not be verified"
        : child.interrupted
          ? " interrupted by Gremlyn"
          : "";
  return `<li><code class="session-id">${escapeHtml(child.sessionId)}</code>${statusPill(label)}<span class="muted">${escapeHtml(note)}</span></li>`;
}

/**
 * Managed OpenCode evidence for one attempt: its parent session, every child's
 * terminal outcome (or unproven state), and the specific configuration or
 * quiescence failure detail. Renders nothing for attempts without managed
 * evidence, so ordinary Cline/legacy jobs are unchanged.
 */
function managedEvidenceForAttempt(attempt: AttemptDetail, capturedProfile: boolean): string {
  const childSessions = attempt.childSessions ?? [];
  const failureDetail = attempt.failure_detail ?? null;
  const managedFailure =
    failureDetail !== null ||
    (attempt.failure_reason !== null && MANAGED_FAILURE_REASONS.has(attempt.failure_reason));
  if (
    (!capturedProfile && childSessions.length === 0 && !managedFailure) ||
    (attempt.agent_session_id === null && childSessions.length === 0 && !managedFailure)
  ) {
    return "";
  }
  const parent = attempt.agent_session_id
    ? `<code class="session-id">${escapeHtml(attempt.agent_session_id)}</code>`
    : '<span class="muted">no parent session captured</span>';
  const children =
    childSessions.length > 0
      ? `<ul class="child-sessions">${childSessions.map(childSessionEvidence).join("")}</ul>`
      : '<p class="muted">No child sessions recorded.</p>';
  const failure =
    failureDetail !== null
      ? `<p class="managed-failure-detail"><strong>Specific failure detail:</strong> ${escapeHtml(failureDetail)}</p>`
      : "";
  return `<article class="managed-attempt" data-live-key="managed-attempt-${String(attempt.id)}"><h3>Attempt ${String(attempt.attempt_number)}</h3><p class="delegated-parent">Parent session ${parent}</p>${children}${failure}</article>`;
}

/**
 * The managed OpenCode evidence panel: the captured profile (primary + exact
 * revision + enabled subagent count) and, per attempt, its delegated child
 * outcomes and specific configuration/quiescence failures. Absent entirely for
 * jobs without a captured profile or managed attempt evidence.
 */
function managedOpenCodePanel(model: JobDetail): string {
  const profile = model.job.opencodeProfile ?? null;
  const evidence = model.attempts
    .map((attempt) => managedEvidenceForAttempt(attempt, profile !== null))
    .filter((html) => html.length > 0);
  if (profile === null && evidence.length === 0) return "";
  const enabledChildren = profile?.subagents.filter((subagent) => subagent.enabled).length ?? 0;
  const profileHtml =
    profile === null
      ? ""
      : `<p class="managed-agent-summary">Captured agent profile: primary <code>${escapeHtml(profile.primaryId)}</code> · revision ${escapeHtml(String(profile.revision))} · ${String(enabledChildren)} enabled subagent${enabledChildren === 1 ? "" : "s"}</p>`;
  const body =
    profileHtml +
    (evidence.length > 0
      ? evidence.join("")
      : '<p class="muted">No managed OpenCode attempt evidence recorded.</p>');
  return `<section class="panel presentation-inset span-all" data-presentation="inset" aria-label="Managed OpenCode agent and delegated sessions"><h2>Managed OpenCode agent</h2>${body}</section>`;
}

/* ------------------------------------------------------------------ *
 * Delegated execution (design D5; capability agent-delegation-observability)
 * ------------------------------------------------------------------ */

/**
 * A bounded observed-state tally for one attempt/invocation. Root invocation
 * sessions are excluded: they are the parent, not delegated children.
 */
function observedCounts(nodes: readonly DelegationNodeView[]): string {
  const children = nodes.filter((node) => !node.isRoot);
  const tally = (state: string): number => children.filter((node) => node.state === state).length;
  const parts: string[] = [];
  const invoked = tally("invoked");
  const running = tally("running");
  const idle = tally("idle");
  const succeeded = tally("succeeded");
  const failed = tally("failed");
  const interrupted = tally("interrupted");
  const unknown = tally("unknown");
  if (invoked > 0) parts.push(`${String(invoked)} invoked`);
  if (running > 0) parts.push(`${String(running)} active`);
  if (idle > 0) parts.push(`${String(idle)} idle`);
  if (succeeded > 0) parts.push(`${String(succeeded)} completed`);
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (interrupted > 0) parts.push(`${String(interrupted)} interrupted`);
  if (unknown > 0) parts.push(`${String(unknown)} unknown`);
  return parts.length > 0 ? parts.join(" · ") : "none observed";
}

/**
 * Honest durations. The observed span is first/last observation reads; a
 * supported source record span is shown only when both source-created and
 * source-updated are available and is explicitly labeled not-execution-end.
 * `time.updated` is never used as an execution end instant.
 */
function delegationDuration(node: DelegationNodeView, timeZone?: string): string {
  const parts: string[] = [];
  if (node.firstObservedAt !== null && node.lastObservedAt !== null) {
    parts.push(
      `<span class="delegation-observed-duration">${elapsedTimeElement(node.firstObservedAt, node.lastObservedAt)} <span class="muted">observed span</span></span>`,
    );
  }
  if (node.sourceCreatedAt !== null && node.sourceUpdatedAt !== null) {
    parts.push(
      `<span class="delegation-source-duration">${elapsedTimeElement(node.sourceCreatedAt, node.sourceUpdatedAt)} <span class="muted">source record span (not execution end)</span></span>`,
    );
  } else if (node.sourceCreatedAt !== null) {
    parts.push(
      `${timeElement(node.sourceCreatedAt, "clock", clockTime(node.sourceCreatedAt, timeZone), { timeZone })} <span class="muted">source created</span>`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : '<span class="muted">not established</span>';
}

/** The observed state plus its separate cancellation-request note. */
function delegationNodeState(node: DelegationNodeView): string {
  const cancelled = node.cancellationRequested
    ? '<span class="chip" data-cancellation-request>cancellation requested</span>'
    : "";
  const limited = node.limitedUncertainty
    ? '<span class="chip" data-limited-evidence>limited evidence</span>'
    : "";
  return `${statusPill(node.state)}${cancelled}${limited}`;
}

/**
 * How the identity reads. A friendly configured label appears only on an exact
 * generated runtime-id match; otherwise the raw safe runtime id or explicit
 * unknown identity is shown, never a borrowed configured definition.
 */
function delegationIdentity(node: DelegationNodeView): string {
  if (node.agentLabel === null) {
    return '<span class="muted" data-delegation-identity-unknown>unknown identity</span>';
  }
  if (node.agentFriendly) {
    return `<code data-delegation-identity="${escapeHtml(node.agentLabel)}">${escapeHtml(node.agentLabel)}</code> <span class="muted">configured definition</span>`;
  }
  return `<code data-delegation-identity-raw>${escapeHtml(node.agentLabel)}</code>`;
}

/**
 * A stable, state/poll/time-free announcement label for one node. The parent's
 * semantic hook can announce it verbatim when a meaningful state changes and
 * deduplicate repeated status pills by this identity.
 */
function delegationAnnouncementLabel(
  node: DelegationNodeView,
  attemptNumber: number,
  ordinal: number,
): string {
  const agent = node.agentLabel ?? "unknown";
  return `Attempt ${String(attemptNumber)}, invocation ${String(ordinal)}, agent ${agent}, session ${node.sessionId}`;
}

/** One observed session as a self-keyed expandable node. */
function delegationNode(
  node: DelegationNodeView,
  attemptNumber: number,
  attemptId: number,
  ordinal: number,
  timeZone?: string,
): string {
  const key = `delegation-session-${String(attemptId)}-${String(ordinal)}-${node.sessionId}`;
  const rootChip = node.isRoot
    ? '<span class="chip" data-delegation-root>invocation root</span>'
    : "";
  const model = node.model === null ? "" : ` · model <code>${escapeHtml(node.model)}</code>`;
  const modelFact =
    node.model === null
      ? '<span class="muted" data-delegation-model-unknown>unknown model</span>'
      : `<code>${escapeHtml(node.model)}</code>`;
  const parent =
    node.parentSessionId === null
      ? '<span class="muted">not captured</span>'
      : `parent <code class="session-id">${escapeHtml(node.parentSessionId)}</code>`;
  const lastObserved =
    node.lastObservedAt === null
      ? '<span class="muted">never observed</span>'
      : relativeTimeElement(node.lastObservedAt);
  const sourceUpdated =
    node.sourceUpdatedAt === null
      ? '<span class="muted">not exposed by the source</span>'
      : timeElement(node.sourceUpdatedAt, "clock", clockTime(node.sourceUpdatedAt, timeZone), {
          timeZone,
        });
  // `time.updated` is a verified record update, never a heartbeat or an
  // execution end. The retained outcome is always presented as last observed.
  const outcome =
    node.outcome === null
      ? ""
      : ` <span class="muted">last observed outcome ${escapeHtml(node.outcome)}</span>`;
  const contradiction =
    node.outcome !== null && node.state !== node.outcome
      ? `<p class="delegation-note muted">Current state is unknown; retained evidence records a last observed outcome of ${escapeHtml(node.outcome)}.</p>`
      : "";
  const history = node.historyPartial
    ? '<p class="delegation-note muted">Retained state history is partial; older transitions were trimmed.</p>'
    : "";
  const label = delegationAnnouncementLabel(node, attemptNumber, ordinal);
  return `<details class="delegation-session" data-live-key="${escapeHtml(key)}" data-details-key="${escapeHtml(key)}" data-observed-session="${escapeHtml(node.sessionId)}" data-observed-state="${escapeHtml(node.state)}" data-announcement-label="${escapeHtml(label)}"><summary><span class="delegation-session-head">${delegationNodeState(node)}${rootChip}${delegationIdentity(node)}${model} <code class="session-id">${escapeHtml(node.sessionId)}</code></span></summary><dl class="kv delegation-facts"><div><dt>State</dt><dd>${statusPill(node.state)}${outcome}</dd></div><div><dt>Model</dt><dd>${modelFact}</dd></div><div><dt>Duration</dt><dd>${delegationDuration(node, timeZone)}</dd></div><div><dt>Last observed</dt><dd>${lastObserved}</dd></div><div><dt>Source updated</dt><dd>${sourceUpdated}</dd></div><div><dt>Parent</dt><dd>${parent}</dd></div></dl>${contradiction}${history}</details>`;
}

interface DelegationTreeNode {
  node: DelegationNodeView;
  children: DelegationTreeNode[];
}

/**
 * Build the bounded parent/child tree for one invocation from verified parent
 * edges. A node whose parent was not observed is a top-level entry (a present
 * root node is a real parent, so its children nest under it); a cycle guard
 * keeps a malformed edge from recursing.
 */
function delegationTree(nodes: readonly DelegationNodeView[]): DelegationTreeNode[] {
  const present = new Set(nodes.map((node) => node.sessionId));
  const childrenByParent = new Map<string, DelegationNodeView[]>();
  const roots: DelegationNodeView[] = [];
  for (const node of nodes) {
    const parent = node.parentSessionId;
    if (parent === null || parent === node.sessionId || !present.has(parent)) {
      roots.push(node);
    } else {
      const list = childrenByParent.get(parent);
      if (list === undefined) childrenByParent.set(parent, [node]);
      else list.push(node);
    }
  }
  const visited = new Set<string>();
  const build = (node: DelegationNodeView): DelegationTreeNode => {
    visited.add(node.sessionId);
    const children = (childrenByParent.get(node.sessionId) ?? [])
      .filter((child) => !visited.has(child.sessionId))
      .map(build);
    return { node, children };
  };
  const tree = roots.map(build);
  for (const node of nodes) {
    if (!visited.has(node.sessionId)) tree.push(build(node));
  }
  return tree;
}

function delegationTreeList(
  tree: readonly DelegationTreeNode[],
  attemptNumber: number,
  attemptId: number,
  ordinal: number,
  timeZone?: string,
): string {
  return `<ul class="child-sessions delegation-tree">${tree
    .map(
      (entry) =>
        `<li>${delegationNode(entry.node, attemptNumber, attemptId, ordinal, timeZone)}${
          entry.children.length > 0
            ? delegationTreeList(entry.children, attemptNumber, attemptId, ordinal, timeZone)
            : ""
        }</li>`,
    )
    .join("")}</ul>`;
}

/** Coverage/gap copy for one invocation, never a completion percentage. */
function delegationInvocationNotes(invocation: DelegationInvocationView): string {
  const notes: string[] = [];
  if (invocation.coverage === "unavailable") {
    notes.push(
      '<p class="delegation-note muted">Observation source is unavailable for this invocation.</p>',
    );
  } else if (invocation.coverage === "partial") {
    notes.push(
      '<p class="delegation-note muted">Coverage is partial; the tree may be incomplete.</p>',
    );
  } else if (invocation.coverage === "none") {
    notes.push('<p class="delegation-note muted">No observation coverage recorded.</p>');
  }
  if (invocation.nodeLimitReached) {
    notes.push(
      '<p class="delegation-note muted">The observation node bound was reached; deeper nodes are not shown.</p>',
    );
  } else if (invocation.truncated) {
    notes.push('<p class="delegation-note muted">The observed tree was truncated.</p>');
  }
  if (invocation.historyPartial) {
    notes.push('<p class="delegation-note muted">Retained state history is partial.</p>');
  }
  if (invocation.reconciledGaps > 0) {
    notes.push(
      `<p class="delegation-note muted">${String(invocation.reconciledGaps)} earlier observation gap${invocation.reconciledGaps === 1 ? "" : "s"} reconciled; intermediate activity may have been missed.</p>`,
    );
  }
  for (const gap of invocation.openGaps) {
    if (gap.endsWith("active-map-scope-limited")) {
      notes.push(
        '<p class="delegation-gap muted">Child activity is unknown when a session is absent from the foreground active map; absence does not establish idle or completion.</p>',
      );
    } else {
      notes.push(`<p class="delegation-gap muted">Observation gap: ${escapeHtml(gap)}</p>`);
    }
  }
  return notes.join("");
}

/** One root invocation's expandable, keyed child tree. */
function delegationInvocation(
  invocation: DelegationInvocationView,
  attemptNumber: number,
  attemptId: number,
  timeZone?: string,
): string {
  const key = `delegation-invocation-${String(attemptId)}-${String(invocation.ordinal)}`;
  const root =
    invocation.rootSessionId === null
      ? '<span class="muted">root session not captured</span>'
      : `root session <code class="session-id">${escapeHtml(invocation.rootSessionId)}</code>`;
  const childNodes = invocation.nodes.filter((node) => !node.isRoot);
  const counts = observedCounts(childNodes);
  // Include the root in the parent map so children with a verified edge to it
  // render nested. Counts remain child-only, and a root with no children stays
  // visible as the sole tree node.
  const tree = delegationTree(invocation.nodes);
  const body =
    invocation.nodes.length > 0
      ? delegationTreeList(tree, attemptNumber, attemptId, invocation.ordinal, timeZone)
      : '<p class="muted">No child sessions observed under this invocation.</p>';
  return `<li class="delegation-invocation"><details class="delegation-invocation-tree" data-live-key="${escapeHtml(key)}" data-details-key="${escapeHtml(key)}"><summary><span class="chip">root invocation ${String(invocation.ordinal)}</span> ${root} <span class="muted">${escapeHtml(counts)}</span></summary>${delegationInvocationNotes(invocation)}${body}</details></li>`;
}

/** Configured managed definitions, kept visibly separate from observed nodes. */
function delegationConfiguredList(configured: readonly DelegationConfiguredAgent[]): string {
  if (configured.length === 0) return "";
  return `<div class="delegation-configured"><h3>Configured callable agents</h3><p class="muted">Configured definitions are capability, not evidence that an agent ran; only observed sessions appear below.</p><ul class="cmd-list">${configured
    .map((agent) => {
      const role = agent.primary ? "primary" : agent.callable ? "callable" : "disabled";
      const model =
        agent.model === null ? "" : `<span class="chip">model: ${escapeHtml(agent.model)}</span>`;
      return `<li data-delegation-configured="${escapeHtml(agent.id)}"><code>${escapeHtml(agent.id)}</code><span class="chip">${role}</span>${model}</li>`;
    })
    .join("")}</ul></div>`;
}

/** The one-line truthful summary of an attempt's observed execution. */
function delegationAttemptHeadline(delegation: DelegationAttemptDetail): string {
  if (delegation.availability === "unsupported") {
    return "Delegation not observable for this executor";
  }
  if (delegation.availability === "unavailable") {
    return "Delegation not observable: no attributed session source";
  }
  if (delegation.observed === 0) {
    return delegation.availability === "partial"
      ? "No delegations observed yet (partial coverage)"
      : "No delegations observed yet";
  }
  const counts = observedCounts(delegation.invocations.flatMap((invocation) => invocation.nodes));
  const partial = delegation.availability === "partial" ? " · partial coverage" : "";
  return `${String(delegation.observed)} observed · ${counts}${partial}`;
}

/** One attempt's expandable parent/child execution tree. */
function delegationAttempt(attempt: AttemptDetail, timeZone?: string): string {
  const delegation = attempt.delegation;
  if (delegation === undefined) return "";
  const key = `delegation-attempt-${String(attempt.id)}`;
  const invocations =
    delegation.invocations.length > 0
      ? `<ol class="delegation-invocations">${delegation.invocations
          .map((invocation) =>
            delegationInvocation(invocation, attempt.attempt_number, attempt.id, timeZone),
          )
          .join("")}</ol>`
      : "";
  const configured = delegationConfiguredList(delegation.configured);
  return `<details class="delegation-attempt" data-live-key="${escapeHtml(key)}" data-details-key="${escapeHtml(key)}"><summary>Attempt ${String(attempt.attempt_number)} · ${escapeHtml(delegationAttemptHeadline(delegation))}</summary>${configured}${invocations}</details>`;
}

/**
 * The delegated-execution panel: configured-versus-observed agents, per-attempt
 * keyed trees, explicit gaps and truthful coverage. Unknown identity and an
 * unobservable executor never read as an empty managed team, and no percentage
 * is inferred. Rendered for every job so a non-OpenCode executor is explicitly
 * limited rather than silent.
 */
function delegationPanel(model: JobDetail, timeZone?: string): string {
  const attempts = model.attempts
    .map((attempt) => delegationAttempt(attempt, timeZone))
    .filter((html) => html.length > 0);
  const captured = model.job.opencodeSelection ?? null;
  const isOpenCodeJob = captured !== null || (model.job.opencodeProfile ?? null) !== null;
  const body =
    attempts.length > 0
      ? attempts.join("")
      : isOpenCodeJob
        ? '<p class="muted">No delegations observed yet.</p>'
        : '<p class="muted">Delegation is not observable for this executor; attributed child sessions are unavailable.</p>';
  return `<section class="panel presentation-inset span-all delegation-panel" data-presentation="inset" aria-label="Delegated agent execution"><h2>Delegated execution <span class="muted panel-note">observed evidence</span></h2>${body}</section>`;
}

/**
 * Everything that is context rather than live state, in a card grid below.
 *
 * Paired by height, not just by topic: the timeline and the validation table
 * are both short and share the first row, while the review context and the
 * attempts both want the full width. Putting a tall panel beside a short one
 * left a column of dead space taller than either.
 */
function jobAside(model: JobDetail, timeZone?: string): string {
  const totalStart = model.job.created_at ?? model.timeline[0]?.at;
  const totalEnd = model.job.finished_at ?? undefined;
  const attempts =
    model.attempts
      .map((attempt, index) =>
        attemptCard(attempt, {
          showActivity: index !== model.attempts.length - 1,
          timeZone,
        }),
      )
      .join("") || '<p class="muted">No attempts recorded.</p>';
  const timeline = `<section class="panel presentation-panel"><h2>Timeline</h2>${timelineStepper(model.timeline, model.job.finished_at, timeZone)}<p class="panel-foot"><strong>Total elapsed</strong> ${durationBetween(totalStart, totalEnd)}</p></section>`;
  const review = `<section class="panel presentation-inset span-all" data-presentation="inset"><h2>Review feedback</h2>${reviewContext(model.job.review_context)}</section>`;
  const attemptPanel = `<section class="panel presentation-panel span-all" data-presentation="panel"><h2>Attempts <span class="muted panel-note">${String(model.attempts.length)}</span></h2><div class="attempt-grid">${attempts}</div></section>`;
  const validation = `<section class="panel presentation-inset span-2" data-presentation="inset">${validationTable(model.validation)}</section>`;
  return `<div class="job-aside">${timeline}${validation}${review}${managedOpenCodePanel(model)}${opencodeSelectionPanel(model)}${attemptPanel}${dangerZone(model.job.repo_id, model.job.pr_number)}</div>`;
}

export function jobRegions(
  model: JobDetail,
  timeZone?: string,
): {
  "job-detail-region": string;
  "job-log-region": string;
} {
  const logControls = `<div class="actions log-controls"><label class="log-search">Search <input data-log-filter placeholder="Filter entries"></label><label>Level <select data-log-level><option value="">All</option><option>debug</option><option>info</option><option>warn</option><option>error</option></select></label><label class="log-follow"><input type="checkbox" data-log-follow checked> Follow</label></div>`;
  return {
    "job-detail-region": `${jobHeader(model)}${activityPanel(model, timeZone)}${delegationPanel(model, timeZone)}${jobAside(model, timeZone)}`,
    "job-log-region": `<section class="panel presentation-inset" data-presentation="inset" id="log-viewer" data-resizable="log"><h2 data-focus-fallback tabindex="-1">Live log ${liveBadge(model.job.status)} <span class="muted panel-note">${logCount(model)}</span></h2>${logControls}<div class="log-stream" data-scroll-keep="log" data-log-items>${logEntries(model.logs, timeZone)}</div></section>`,
  };
}

function durationBetween(start: string | null | undefined, end: string | null | undefined): string {
  return elapsedTimeElement(start, end);
}

export function jobView(model: JobDetail, timeZone?: string): string {
  const regions = jobRegions(model, timeZone);
  return `<div class="job-page"><div id="job-detail-region">${regions["job-detail-region"]}</div><div id="job-log-region">${regions["job-log-region"]}</div></div>`;
}
