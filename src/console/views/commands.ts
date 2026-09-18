import type { OperatorActionModel, ProcessedCommandModel } from "../queries.js";
import {
  clockTime,
  escapeHtml,
  relativeTimeElement,
  responsiveTable,
  statusPill,
  timeElement,
} from "./components.js";

const commandColumns = [
  { label: "Observed" },
  { label: "Repository / PR" },
  { label: "Comment" },
  { label: "Command" },
  { label: "Author" },
  { label: "Outcome" },
  { label: "Reason" },
] as const;

export function commandsView(commands: ProcessedCommandModel[], timeZone?: string): string {
  const table = responsiveTable({
    caption: "Command ingestion records",
    columns: commandColumns,
    emptyMessage: "No commands observed.",
    className: "commands-table",
    rows: commands.map((command) => ({
      key: `command-${String(command.id)}`,
      cells: [
        `${timeElement(command.observed_at, "clock", clockTime(command.observed_at, timeZone), { timeZone })}<br><span class="muted">${relativeTimeElement(command.observed_at)}</span>`,
        `${escapeHtml(command.repository)} #${command.pr_number}`,
        command.job_id
          ? `<a href="/jobs/${command.job_id}">${command.comment_id}</a>`
          : escapeHtml(command.comment_id),
        `<code>${escapeHtml(command.command)}</code>`,
        escapeHtml(command.author_login),
        statusPill(command.outcome),
        command.reason ? escapeHtml(command.reason) : '<span class="muted">—</span>',
      ],
    })),
  });
  return `<h1 data-focus-fallback tabindex="-1">Command ingestion</h1><p>Observed commands, including requests that were refused or produced no job.</p><section class="panel">${table}</section>`;
}

const auditColumns = [
  { label: "Time" },
  { label: "Action" },
  { label: "Target" },
  { label: "Effect" },
  { label: "Detail" },
] as const;

export function auditView(actions: OperatorActionModel[], timeZone?: string): string {
  const table = responsiveTable({
    caption: "Operator audit records",
    columns: auditColumns,
    emptyMessage: "No operator actions recorded.",
    className: "audit-table",
    rows: actions.map((action) => ({
      key: `audit-${String(action.id)}`,
      cells: [
        timeElement(action.at, "clock", clockTime(action.at, timeZone), { timeZone }),
        escapeHtml(action.action),
        escapeHtml(action.target),
        action.effect ? escapeHtml(action.effect) : '<span class="muted">—</span>',
        action.detail
          ? `<code>${escapeHtml(action.detail)}</code>`
          : '<span class="muted">—</span>',
      ],
    })),
  });
  return `<h1 data-focus-fallback tabindex="-1">Operator audit</h1><p>Every manual action is recorded with its target and effect.</p><section class="panel">${table}</section>`;
}
