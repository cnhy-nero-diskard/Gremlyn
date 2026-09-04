import type { OperatorActionModel, ProcessedCommandModel } from "../queries.js";
import {
  clockTime,
  escapeHtml,
  relativeTimeElement,
  statusPill,
  timeElement,
} from "./components.js";

export function commandsView(commands: ProcessedCommandModel[], timeZone?: string): string {
  return `<h1>Command ingestion</h1><p>Observed commands, including requests that were refused or produced no job.</p><section class="panel"><table><thead><tr><th>Observed</th><th>Repository / PR</th><th>Comment</th><th>Command</th><th>Author</th><th>Outcome</th><th>Reason</th></tr></thead><tbody>${commands.map((command) => `<tr><td>${timeElement(command.observed_at, "clock", clockTime(command.observed_at, timeZone), { timeZone })}<br><span class="muted">${relativeTimeElement(command.observed_at)}</span></td><td>${escapeHtml(command.repository)} #${command.pr_number}</td><td>${command.job_id ? `<a href="/jobs/${command.job_id}">${command.comment_id}</a>` : escapeHtml(command.comment_id)}</td><td><code>${escapeHtml(command.command)}</code></td><td>${escapeHtml(command.author_login)}</td><td>${statusPill(command.outcome)}</td><td>${command.reason ? escapeHtml(command.reason) : '<span class="muted">—</span>'}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No commands observed.</td></tr>'}</tbody></table></section>`;
}

export function auditView(actions: OperatorActionModel[], timeZone?: string): string {
  return `<h1>Operator audit</h1><p>Every manual action is recorded with its target and effect.</p><section class="panel"><table><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Effect</th><th>Detail</th></tr></thead><tbody>${actions.map((action) => `<tr><td>${timeElement(action.at, "clock", clockTime(action.at, timeZone), { timeZone })}</td><td>${escapeHtml(action.action)}</td><td>${escapeHtml(action.target)}</td><td>${action.effect ? escapeHtml(action.effect) : '<span class="muted">—</span>'}</td><td>${action.detail ? `<code>${escapeHtml(action.detail)}</code>` : '<span class="muted">—</span>'}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No operator actions recorded.</td></tr>'}</tbody></table></section>`;
}
