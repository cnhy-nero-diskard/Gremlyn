import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import {
  DEFAULT_TERMINAL_ROW_LIMIT,
  DEFAULT_TERMINAL_TEXT_LENGTH,
  MAX_TERMINAL_ROW_LIMIT,
  readTerminalSnapshot,
  sanitizeTerminalText,
  type TerminalJobRow,
  type TerminalSnapshotOptions,
} from "../src/terminal/projection.js";

/**
 * Task 3.1: safe read-only terminal projections. These tests exercise the
 * whitelist SQL boundary, observed-only health, full-database counts with a
 * bounded prioritized row set, retry-accurate durations and untrusted-label
 * handling (control/ANSI/OSC stripping, secret redaction, instruction omission).
 */

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const SECRET = "super-secret-value";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function options(overrides: Partial<TerminalSnapshotOptions> = {}): TerminalSnapshotOptions {
  return {
    now: NOW,
    pollIntervalSec: 60,
    readiness: "ready",
    secrets: [],
    ...overrides,
  };
}

function addRepo(store: Store, owner: string, name: string, enabled = 1): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES (?, ?, 'source', 'workspaces', 'cline', 'model', 'provider', 'high', ?)`,
      )
      .run(owner, name, enabled).lastInsertRowid,
  );
}

function addJob(
  store: Store,
  repoId: number,
  status: string,
  opts: {
    pr?: number;
    commentId?: number;
    createdAt?: string;
    finishedAt?: string | null;
    reviewContext?: string | null;
  } = {},
): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO jobs
           (repo_id, pr_number, comment_id, command, status, created_at, finished_at, review_context)
         VALUES (?, ?, ?, 'RESOLVE', ?, ?, ?, ?)`,
      )
      .run(
        repoId,
        opts.pr ?? 1,
        opts.commentId ?? 1,
        status,
        opts.createdAt ?? iso(NOW),
        opts.finishedAt ?? null,
        opts.reviewContext ?? null,
      ).lastInsertRowid,
  );
}

function addAttempt(
  store: Store,
  jobId: number,
  attemptNumber: number,
  opts: { startedAt?: string | null; outcome?: string | null } = {},
): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO attempts
           (job_id, attempt_number, agent, model, provider, effort, started_at, outcome)
         VALUES (?, ?, 'cline', 'model', 'provider', 'high', ?, ?)`,
      )
      .run(jobId, attemptNumber, opts.startedAt ?? null, opts.outcome ?? null).lastInsertRowid,
  );
}

function addStatusEvent(
  store: Store,
  jobId: number,
  status: string,
  at: string,
  attemptId: number | null = null,
): void {
  store.db
    .prepare("INSERT INTO status_events (job_id, attempt_id, status, at) VALUES (?, ?, ?, ?)")
    .run(jobId, attemptId, status, at);
}

function rowById(rows: TerminalJobRow[], id: number): TerminalJobRow {
  const row = rows.find((candidate) => candidate.id === id);
  assert.ok(row, `expected a row for job ${id}`);
  return row;
}

/* ------------------------------------------------------------------ *
 * sanitizeTerminalText
 * ------------------------------------------------------------------ */

test("sanitizeTerminalText strips CSI, OSC, escapes and controls", () => {
  assert.equal(sanitizeTerminalText("a\u001b[2Jb"), "ab");
  assert.equal(sanitizeTerminalText("a\u001b]8;;http://evil.example\u0007b"), "ab");
  assert.equal(sanitizeTerminalText("a\u001b]0;title\u001b\\b"), "ab");
  assert.equal(sanitizeTerminalText("a\u001bMb"), "ab");
  assert.equal(sanitizeTerminalText("a\u0007b"), "a b");
  // Newlines and tabs never split the single-line surface.
  assert.equal(sanitizeTerminalText("a\nb\tc"), "a b c");
});

test("sanitizeTerminalText falls back to ASCII, collapses whitespace and bounds length", () => {
  assert.equal(sanitizeTerminalText("caf\u00e9"), "caf?");
  assert.equal(sanitizeTerminalText("\ud83d\ude00ok"), "??ok");
  assert.equal(sanitizeTerminalText("  a   b  "), "a b");
  assert.equal(sanitizeTerminalText("abcdefgh", 4), "abcd");
  assert.equal(sanitizeTerminalText("abcdefgh", 0), "");
  assert.equal(sanitizeTerminalText("x".repeat(500)).length, DEFAULT_TERMINAL_TEXT_LENGTH);
});

/* ------------------------------------------------------------------ *
 * Observed health (unknown / stale / failed) and repository counts
 * ------------------------------------------------------------------ */

test("connection health is derived only from explicit polling observations", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    // No observation at all, even with a ready readiness label, is unknown.
    const none = readTerminalSnapshot(store.db, options({ readiness: "ready" }));
    assert.equal(none.connection, "unknown");
    assert.equal(none.lastPollAt, null);
    assert.equal(none.pollAgeSec, null);
    assert.equal(none.readiness, "ready");

    const fresh = readTerminalSnapshot(
      store.db,
      options({
        readiness: "starting",
        pollObservation: { lastSuccessAt: NOW - 10_000, failed: false },
      }),
    );
    assert.equal(fresh.connection, "healthy");
    assert.equal(fresh.lastPollAt, iso(NOW - 10_000));
    assert.equal(fresh.pollAgeSec, 10);

    const stale = readTerminalSnapshot(
      store.db,
      options({ pollObservation: { lastSuccessAt: NOW - 180_000, failed: false } }),
    );
    assert.equal(stale.connection, "stale");
    assert.equal(stale.pollAgeSec, 180);

    const failedAfterSuccess = readTerminalSnapshot(
      store.db,
      options({ pollObservation: { lastSuccessAt: NOW - 10_000, failed: true } }),
    );
    assert.equal(failedAfterSuccess.connection, "failed");
    assert.equal(failedAfterSuccess.lastPollAt, iso(NOW - 10_000));

    const failedWithoutSuccess = readTerminalSnapshot(
      store.db,
      options({ pollObservation: { lastSuccessAt: null, failed: true } }),
    );
    assert.equal(failedWithoutSuccess.connection, "failed");
    assert.equal(failedWithoutSuccess.lastPollAt, null);
    assert.equal(failedWithoutSuccess.pollAgeSec, null);

    // A whitespace-only interval cannot fabricate freshness for a real age.
    const zeroInterval = readTerminalSnapshot(
      store.db,
      options({
        pollIntervalSec: Number.NaN,
        pollObservation: { lastSuccessAt: NOW - 5_000, failed: false },
      }),
    );
    assert.equal(zeroInterval.connection, "stale");
  } finally {
    store.close();
  }
});

test("counts cover every configured repository including disabled ones", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const enabledRepo = addRepo(store, "acme", "widgets", 1);
    const disabledRepo = addRepo(store, "acme", "legacy", 0);
    addJob(store, disabledRepo, "queued", { pr: 7 });

    const snapshot = readTerminalSnapshot(store.db, options());
    assert.equal(snapshot.configured, 2);
    assert.equal(snapshot.enabled, 1);
    // A disabled repository's queued job stays visible rather than vanishing.
    assert.equal(snapshot.queuedCount, 1);
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.rows[0]?.repository, "acme/legacy");
    // Disabled repositories never make an unobserved connection look healthy.
    assert.equal(snapshot.connection, "unknown");
    void enabledRepo;
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------ *
 * Full-database counts, lane priority and overflow
 * ------------------------------------------------------------------ */

test("counts span the full database while rows stay bounded and prioritized", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const repo = addRepo(store, "acme", "widgets");
    for (let i = 0; i < 60; i += 1) {
      addJob(store, repo, "running", { pr: 100 + i, commentId: 100 + i });
    }
    for (let i = 0; i < 60; i += 1) {
      addJob(store, repo, "queued", { pr: 200 + i, commentId: 200 + i });
    }

    const snapshot = readTerminalSnapshot(store.db, options({ rowLimit: 65 }));
    // Counts are not the dashboard's 50-row window.
    assert.equal(snapshot.activeCount, 60);
    assert.equal(snapshot.queuedCount, 60);
    assert.equal(snapshot.recentCount, 0);

    assert.equal(snapshot.rows.length, 65);
    assert.equal(
      snapshot.rows.slice(0, 60).every((row) => row.stage === "running"),
      true,
    );
    assert.equal(
      snapshot.rows.slice(60).every((row) => row.stage === "queued"),
      true,
    );
    // Active lane newest-first; queued lane oldest-first (FIFO).
    const activeIds = snapshot.rows.slice(0, 60).map((row) => row.id);
    assert.equal(activeIds[0]!, Math.max(...activeIds));
    const queuedIds = snapshot.rows.slice(60).map((row) => row.id);
    assert.equal(queuedIds[0]!, Math.min(...queuedIds));

    // Overflow is the exact aggregate of omitted displayable jobs.
    assert.equal(snapshot.overflow, 120 - 65);
  } finally {
    store.close();
  }
});

test("a small active lane yields to queued rows and reports accurate overflow", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const repo = addRepo(store, "acme", "widgets");
    addJob(store, repo, "running", { pr: 1 });
    addJob(store, repo, "validating", { pr: 2 });
    for (let i = 0; i < 60; i += 1) {
      addJob(store, repo, "queued", { pr: 100 + i, commentId: 100 + i });
    }

    const snapshot = readTerminalSnapshot(store.db, options({ rowLimit: 5 }));
    assert.equal(snapshot.activeCount, 2);
    assert.equal(snapshot.queuedCount, 60);
    assert.equal(snapshot.rows.length, 5);
    assert.deepEqual(
      snapshot.rows.map((row) => row.stage),
      ["validating", "running", "queued", "queued", "queued"],
    );
    assert.equal(snapshot.overflow, 62 - 5);
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------ *
 * Lifecycle and retry-accurate durations
 * ------------------------------------------------------------------ */

test("durations use the latest attempt, then requeue time, then created_at", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const repo = addRepo(store, "acme", "widgets");
    const now = NOW + 40_000;

    // Retried then running: the newest (second) attempt measures the run.
    const running = addJob(store, repo, "running", { pr: 1, createdAt: iso(NOW) });
    addAttempt(store, running, 1, { startedAt: iso(NOW + 1_000), outcome: "agent-failed" });
    addAttempt(store, running, 2, { startedAt: iso(NOW + 10_000), outcome: null });

    // Terminal: measures from the attempt to the recorded finish.
    const done = addJob(store, repo, "succeeded", {
      pr: 2,
      createdAt: iso(NOW),
      finishedAt: iso(NOW + 25_000),
    });
    addAttempt(store, done, 1, { startedAt: iso(NOW + 5_000), outcome: "succeeded" });

    // Never started, waiting since the last requeue event.
    const waiting = addJob(store, repo, "queued", { pr: 3, createdAt: iso(NOW) });
    addStatusEvent(store, waiting, "queued", iso(NOW + 30_000));

    // Explicit retry: newest attempt has no started_at, so the requeue wins
    // rather than the stale first-attempt timestamp.
    const retried = addJob(store, repo, "queued", { pr: 4, createdAt: iso(NOW) });
    const firstAttempt = addAttempt(store, retried, 1, {
      startedAt: iso(NOW + 2_000),
      outcome: "failed",
    });
    addStatusEvent(store, retried, "failed", iso(NOW + 20_000), firstAttempt);
    addStatusEvent(store, retried, "queued", iso(NOW + 34_000));
    addAttempt(store, retried, 2, { startedAt: null, outcome: null });

    const snapshot = readTerminalSnapshot(store.db, options({ now }));
    assert.equal(rowById(snapshot.rows, running).elapsedSec, 30);
    assert.equal(rowById(snapshot.rows, running).stage, "running");
    assert.equal(rowById(snapshot.rows, running).outcome, null);
    assert.equal(rowById(snapshot.rows, done).elapsedSec, 20);
    assert.equal(rowById(snapshot.rows, done).outcome, "succeeded");
    assert.equal(rowById(snapshot.rows, waiting).elapsedSec, 10);
    assert.equal(rowById(snapshot.rows, retried).elapsedSec, 6);
  } finally {
    store.close();
  }
});

test("unparseable timestamps never produce NaN durations", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const repo = addRepo(store, "acme", "widgets");
    const bad = addJob(store, repo, "running", { pr: 1, createdAt: "not-a-date" });
    addAttempt(store, bad, 1, { startedAt: "also-not-a-date", outcome: null });

    const snapshot = readTerminalSnapshot(store.db, options());
    const row = rowById(snapshot.rows, bad);
    assert.equal(row.elapsedSec, 0);
    assert.equal(Number.isInteger(row.elapsedSec), true);
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------ *
 * Untrusted labels, secrets and instruction omission
 * ------------------------------------------------------------------ */

test("labels are stripped, redacted and ASCII-fallback safe; instructions never appear", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const repo = addRepo(store, "ac\u001b[2Jme", "wid\u001b]0;x\u0007gets", 1);
    // Private instruction text and review context must never be selected.
    const instruction = "TOP-SECRET-INSTRUCTION";
    store.db
      .prepare("UPDATE repositories SET agent_instructions = ? WHERE id = ?")
      .run(instruction, repo);
    const job = addJob(store, repo, "failed", {
      pr: 5,
      createdAt: iso(NOW),
      finishedAt: iso(NOW + 1_000),
      reviewContext: JSON.stringify({ feedback: instruction }),
    });
    addAttempt(store, job, 1, { startedAt: iso(NOW), outcome: "failed" });

    const secretRepo = addRepo(store, "acme", `widgets-${SECRET}`, 1);
    addJob(store, secretRepo, "queued", { pr: 6 });

    const snapshot = readTerminalSnapshot(store.db, options({ secrets: [SECRET], rowLimit: 15 }));
    const primary = rowById(snapshot.rows, job);
    assert.equal(primary.repository, "acme/widgets");
    assert.equal(primary.stage, "failed");
    assert.equal(primary.outcome, "failed");

    const secretRow = rowById(snapshot.rows, job + 1);
    assert.equal(secretRow.repository, "acme/widgets-[redacted]");

    // Every emitted string is printable ASCII with no escape introducers.
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(instruction), false);
    assert.equal(serialized.includes(SECRET), false);
    // eslint-disable-next-line no-control-regex -- deliberate control-character scan
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(serialized), false);
    assert.equal(/[^\u0020-\u007e]/.test(serialized), false);
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------ *
 * Read-only behavior and bounding
 * ------------------------------------------------------------------ */

test("readTerminalSnapshot performs no mutations", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const repo = addRepo(store, "acme", "widgets");
    const job = addJob(store, repo, "running", { pr: 1 });
    addAttempt(store, job, 1, { startedAt: iso(NOW), outcome: null });

    const dump = (): unknown => ({
      jobs: store.db
        .prepare("SELECT id, status, current_attempt, finished_at FROM jobs ORDER BY id")
        .all(),
      attempts: store.db.prepare("SELECT id, outcome, started_at FROM attempts ORDER BY id").all(),
      events: store.db.prepare("SELECT id, status, at FROM status_events ORDER BY id").all(),
      repositories: store.db.prepare("SELECT id, enabled FROM repositories ORDER BY id").all(),
    });
    const before = JSON.stringify(dump());
    readTerminalSnapshot(store.db, options());
    const after = JSON.stringify(dump());
    assert.equal(after, before);
    assert.equal(store.db.inTransaction, false);
  } finally {
    store.close();
  }
});

test("rowLimit defaults and clamps into a bounded, usable integer", () => {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  try {
    const repo = addRepo(store, "acme", "widgets");
    for (let i = 0; i < 5; i += 1) {
      addJob(store, repo, "succeeded", { pr: 10 + i, commentId: 10 + i, finishedAt: iso(NOW) });
    }

    const byDefault = readTerminalSnapshot(store.db, options());
    assert.equal(byDefault.rows.length, 5);
    assert.ok(DEFAULT_TERMINAL_ROW_LIMIT >= 5);

    const clampedLow = readTerminalSnapshot(store.db, options({ rowLimit: 0 }));
    assert.equal(clampedLow.rows.length, 1);

    const clampedHigh = readTerminalSnapshot(store.db, options({ rowLimit: 10_000 }));
    assert.equal(clampedHigh.rows.length, 5);
    assert.ok(MAX_TERMINAL_ROW_LIMIT >= 5);
  } finally {
    store.close();
  }
});
