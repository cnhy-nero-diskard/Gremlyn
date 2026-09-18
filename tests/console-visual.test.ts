import { test } from "node:test";
import assert from "node:assert/strict";
import { stylesheet } from "../src/console/assets.js";
import { authLayout } from "../src/console/views/layout.js";
import { auditView, commandsView } from "../src/console/views/commands.js";
import { dashboardView } from "../src/console/views/dashboard.js";
import { jobView } from "../src/console/views/job.js";
import { statusPill } from "../src/console/views/components.js";

const HEALTH = {
  lastPolledAt: null,
  lastPollAt: null,
  pollAgeSec: null,
  queueDepth: 0,
  queuedCount: 0,
  inFlight: 0,
  activeCount: 0,
  concurrency: 1,
  pollIntervalSec: 30,
  stale: false,
  status: "unknown" as const,
};

const dashboardFixture = () =>
  dashboardView({
    repositories: [],
    jobs: [],
    running: [],
    queued: [],
    recent: [],
    health: HEALTH,
  });

const jobFixture = (status: string) =>
  jobView({
    job: {
      id: 7,
      repo_id: 3,
      pr_number: 12,
      comment_id: 101,
      command: "RESOLVE",
      status,
      owner: "acme",
      name: "widgets",
      thread_id: "thread-1",
      created_at: "2026-08-27T00:00:00.000Z",
      finished_at: status === "succeeded" ? "2026-08-27T00:01:00.000Z" : null,
      current_attempt: 1,
      review_context: null,
    },
    attempts: [],
    timeline: [],
    validation: [],
    logs: [],
    logTotal: 0,
  });

test("console stylesheet is offline-safe and uses the declared native stacks", () => {
  assert.match(stylesheet, /--font-sans:\s*"Segoe UI Variable Text",\s*"Segoe UI",\s*system-ui,\s*sans-serif/);
  assert.match(stylesheet, /--font-mono:\s*"Cascadia Mono",\s*"SFMono-Regular",\s*Consolas,\s*monospace/);
  assert.doesNotMatch(stylesheet, /\bInter\b/u);
  assert.doesNotMatch(stylesheet, /@font-face|url\(|font-display|preload/iu);
  assert.doesNotMatch(stylesheet, /https?:\/\//iu);
});

test("console stylesheet exposes primitive, semantic, component, and motion tokens", () => {
  for (const token of [
    "--type-body",
    "--line-body",
    "--weight-semibold",
    "--space-4",
    "--radius-md",
    "--border-thin",
    "--shadow-panel",
    "--motion-standard",
    "--surface-canvas",
    "--text-primary",
    "--divider",
    "--interactive",
    "--focus-ring",
    "--status-success-fg",
    "--status-progress-bg",
    "--status-warning-border",
    "--status-failure-fg",
    "--status-danger-border",
    "--status-neutral-bg",
  ]) {
    assert.match(stylesheet, new RegExp(`${token}:`), token);
  }
  for (const tier of ["peak", "panel", "quiet", "inset"]) {
    assert.match(stylesheet, new RegExp(`\\.presentation-${tier}`), tier);
  }
  assert.match(stylesheet, /prefers-color-scheme:\s*dark/iu);
  assert.match(stylesheet, /prefers-reduced-motion:\s*reduce/iu);
});

test("migrated component selectors consume semantic status tokens instead of raw palette values", () => {
  const componentRules = stylesheet
    .split("\n")
    .filter((line) => /^\s*(?:\.|#|\[|button|input|select|details|nav|table|th|td|pre)/u.test(line));
  for (const line of componentRules) {
    assert.doesNotMatch(line, /#(?:166534|1d4ed8|8a4b08|a61b15|8f2019|6941c6|4b5563)/iu, line);
  }
  assert.match(stylesheet, /\.status-failed[^\n]*var\(--status-failure-(?:fg|bg|border)\)/u);
  assert.match(stylesheet, /\.danger-zone[^\n]*var\(--status-danger-/u);
});

test("route fixtures expose one peak and identify forensic or inset content", () => {
  const routes = [
    dashboardFixture(),
    jobFixture("succeeded"),
    commandsView([], "UTC"),
    auditView([], "UTC"),
    authLayout(),
  ];
  for (const route of routes) {
    assert.ok((route.match(/data-presentation="peak"/gu) ?? []).length <= 1, route);
  }
  assert.match(jobFixture("succeeded"), /data-presentation="peak"[^>]*data-job-outcome="succeeded"/u);
  assert.match(jobFixture("succeeded"), /job-outcome-success/u);
  assert.match(commandsView([], "UTC"), /data-presentation="inset"/u);
  assert.match(auditView([], "UTC"), /data-presentation="inset"/u);
  assert.match(jobFixture("running"), /data-presentation="inset"/u);
});

test("semantic status treatments retain visible text and non-color markers", () => {
  const statuses = ["succeeded", "failed", "cancelled", "interrupted", "running"];
  for (const status of statuses) {
    const pill = statusPill(status);
    assert.match(pill, new RegExp(`>${status}<`));
    assert.match(pill, /data-status-value=/u);
  }
  assert.match(stylesheet, /\.status-pill::before/iu);
  assert.match(stylesheet, /\.status-failed::before/iu);
  assert.match(stylesheet, /\.status-cancelled::before/iu);
});
