/* eslint-disable no-control-regex -- Tests explicitly assert terminal-control containment. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AnchoredRenderer } from "../src/terminal/renderer.js";
import { TerminalPresentation, snapshotLines } from "../src/terminal/controller.js";
import { DEFAULT_TERMINAL_OPTIONS } from "../src/terminal/options.js";
import type { TerminalSnapshot } from "../src/terminal/projection.js";
import { Store } from "../src/store/db.js";

class FakeStream extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  output: string[] = [];
  throws = false;
  blocked = false;
  write(text: string): boolean {
    if (this.throws) throw new Error("fixture closed stream");
    this.output.push(text);
    return !this.blocked;
  }
}

test("anchored refresh is bounded, change-only, ASCII-safe and never full-screen", () => {
  const stream = new FakeStream();
  let now = 0;
  const renderer = new AnchoredRenderer(
    stream,
    () => assert.fail("unexpected fallback"),
    () => now,
  );
  renderer.render(["Gremlyn", "queued: 1"]);
  assert.deepEqual(stream.output, ["Gremlyn\nqueued: 1\n"]);
  now = 100;
  renderer.render(["Gremlyn", "running: 1"]);
  assert.equal(stream.output.length, 1);
  now = 250;
  renderer.render(["Gremlyn", "running: 1"]);
  assert.equal(stream.output[1], "\x1b[1A\r\x1b[2Krunning: 1\r\x1b[1B");
  now = 500;
  renderer.render(["Gremlyn", "running: 1"]);
  assert.equal(stream.output.length, 2);
  now = 750;
  renderer.render(["Gremlyn", "hostile\x1b[2J\x07\u202erepo 日本語"]);
  assert.doesNotMatch(stream.output.join(""), /\x1b\[2J|\x07|\x1b\[\?1049/);
  renderer.dispose();
  renderer.dispose();
  assert.equal(stream.listenerCount("resize"), 0);
  assert.equal(stream.listenerCount("error"), 0);
});

test("dimension snapshots truncate narrow layouts and clear removed anchored rows", () => {
  const stream = new FakeStream();
  stream.columns = 12;
  stream.rows = 5;
  let now = 0;
  const renderer = new AnchoredRenderer(
    stream,
    () => assert.fail(),
    () => now,
  );
  renderer.render(["123456789012345", "second", "third", "fourth"]);
  assert.equal(stream.output[0], "12345678...\nsecond\nthird\n");
  stream.columns = 8;
  stream.rows = 4;
  stream.emit("resize");
  now = 250;
  renderer.render(["123456789012345", "second", "third"]);
  assert.match(stream.output[1]!, /\x1b\[2K\r/);
  assert.match(stream.output[1]!, /\x1b\[1A\r$/);
  assert.doesNotMatch(stream.output.join(""), /\x1b\[2J/);
  renderer.dispose();
});

test("diagnostics use the same anchor owner and cannot inject controls", () => {
  const stream = new FakeStream();
  const renderer = new AnchoredRenderer(
    stream,
    () => assert.fail(),
    () => 0,
  );
  renderer.render(["Gremlyn", "active: 1"]);
  renderer.diagnostic("failure \x1b[2J\x07details\nnext action");
  renderer.diagnostic("warning two");
  const text = stream.output.join("");
  assert.match(text, /failure .*details next action/);
  assert.match(text, /warning two/);
  assert.doesNotMatch(text, /\x1b\[2J|\x07/);
  renderer.dispose();
});

test("write and capability failure degrade exactly once without throwing", () => {
  for (const failure of ["throw", "backpressure", "capability", "async"] as const) {
    const stream = new FakeStream();
    let failures = 0;
    const renderer = new AnchoredRenderer(stream, () => {
      failures++;
    });
    if (failure === "throw") stream.throws = true;
    if (failure === "backpressure") stream.blocked = true;
    if (failure === "capability") stream.isTTY = false;
    if (failure === "async") stream.emit("error", new Error("fixture"));
    assert.doesNotThrow(() => renderer.render(["Gremlyn"]));
    renderer.dispose();
    renderer.dispose();
    assert.equal(failures, 1);
  }
});

test("single terminal owner suppresses routine JSON, preserves diagnostics, and falls back to plain", () => {
  const stream = new FakeStream();
  const store = new Store({ dataDir: "unused", file: ":memory:" });
  const presentation = new TerminalPresentation(
    { ...DEFAULT_TERMINAL_OPTIONS, presentation: "terminal", noColor: true },
    stream,
    { TERM: "xterm" },
    ["fixture-secret"],
  );
  try {
    presentation.attach(store.db, 60);
    presentation.sink({
      at: "fixture",
      level: "info",
      event: "poll",
      fields: { secret: "fixture-secret" },
    });
    assert.doesNotMatch(stream.output.join(""), /"level"|fixture-secret/);
    presentation.sink({
      at: "fixture",
      level: "warn",
      event: "failure fixture-secret\x07",
      fields: {},
    });
    assert.match(stream.output.join(""), /failure \[redacted\]/);
    assert.doesNotMatch(stream.output.join(""), /\x07/);
    stream.isTTY = false;
    stream.emit("error", new Error("fixture"));
    const start = stream.output.length;
    presentation.sink({ at: "fixture", level: "error", event: "plain diagnostic", fields: {} });
    assert.match(stream.output.slice(start).join(""), /plain diagnostic/);
    assert.doesNotMatch(stream.output.slice(start).join(""), /\x1b/);
  } finally {
    presentation.dispose();
    presentation.dispose();
    store.close();
  }
  assert.equal(stream.listenerCount("resize"), 0);
  assert.equal(stream.listenerCount("error"), 0);
});

test("JSON pathway keeps legacy flattened fields and has no controls; unsafe terminal uses plain", () => {
  for (const mode of ["json", "plain", "terminal"] as const) {
    const stream = new FakeStream();
    stream.isTTY = false;
    const presentation = new TerminalPresentation(
      { ...DEFAULT_TERMINAL_OPTIONS, presentation: mode },
      stream,
      {},
    );
    presentation.sink({
      at: "fixture",
      level: "warn",
      event: "diagnostic",
      fields: { nextAction: "retry" },
    });
    const text = stream.output.join("");
    assert.doesNotMatch(text, /\x1b/);
    if (mode === "json")
      assert.deepEqual(JSON.parse(text), {
        at: "fixture",
        level: "warn",
        event: "diagnostic",
        nextAction: "retry",
      });
    presentation.dispose();
  }
});

function snapshotRow(
  id: number,
  lane: "active" | "queued" | "recent",
  overrides: Partial<TerminalSnapshot["rows"][number]> = {},
): TerminalSnapshot["rows"][number] {
  return {
    id,
    repository: "widgets",
    pr: id,
    stage: lane === "recent" ? "succeeded" : lane === "active" ? "running" : "queued",
    elapsedSec: id,
    outcome: null,
    lane,
    ...overrides,
  };
}

function terminalSnapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    readiness: "ready",
    connection: "healthy",
    configured: 2,
    enabled: 1,
    lastPollAt: null,
    pollAgeSec: 3,
    activeCount: 0,
    queuedCount: 0,
    recentCount: 0,
    rows: [],
    latestCompletion: null,
    overflow: 0,
    ...overrides,
  };
}

test("terminal layout prioritizes current work, labels overflow and shows one completion", () => {
  const snapshot = terminalSnapshot({
    connection: "stale",
    pollAgeSec: null,
    activeCount: 2,
    queuedCount: 50,
    recentCount: 10,
    rows: [
      snapshotRow(1, "active", { stage: "validating", outcome: "agent-succeeded" }),
      snapshotRow(2, "active"),
      snapshotRow(3, "queued"),
    ],
    latestCompletion: snapshotRow(4, "recent", { stage: "succeeded", outcome: "succeeded" }),
    overflow: 49,
  });
  const lines = snapshotLines(snapshot, "disabled", 12);
  assert.match(lines[0]!, /connection: stale/);
  assert.match(lines[1]!, /Active: 2 \| Queued: 50/);
  assert.match(lines[2]!, /Poll: not observed/);
  assert.match(lines[2]!, /Sound: disabled/);
  assert.match(lines[3]!, /^Active \(2\)$/);
  // A distinct recorded outcome is shown once, next to its stage.
  assert.match(lines[4]!, /widgets PR #1 \| validating \(agent-succeeded\) \| 1s/);
  assert.match(lines[5]!, /widgets PR #2 \| running \| 2s/);
  assert.match(lines[6]!, /^Queued \(50\)$/);
  assert.match(lines[7]!, /widgets PR #3 \| queued \| 3s/);
  assert.match(lines[8]!, /^\.\.\. 49 more active\/queued$/);
  // The stage-identical outcome is never repeated on the completion line.
  assert.match(lines[9]!, /^Latest: widgets PR #4 \| succeeded \| 4s$/);
  assert.equal(lines.length, 10);
});

test("idle layout waits and shows at most one latest completion, never history", () => {
  const snapshot = terminalSnapshot({
    recentCount: 412,
    latestCompletion: snapshotRow(7, "recent", {
      stage: "failed",
      outcome: "failed",
      elapsedSec: 4,
    }),
  });
  const lines = snapshotLines(snapshot, "enabled", 20);
  assert.equal(lines.length, 5);
  assert.match(lines[1]!, /Active: 0 \| Queued: 0/);
  assert.match(lines[3]!, /^Idle\. Waiting for authorized review commands\.$/);
  assert.match(lines[4]!, /^Latest: widgets PR #7 \| failed \| 4s$/);
  assert.doesNotMatch(lines.join("\n"), /412|more/);
});

test("idle layout without any completion shows only the waiting line", () => {
  const lines = snapshotLines(terminalSnapshot(), "disabled", 20);
  assert.equal(lines.length, 4);
  assert.match(lines[3]!, /^Idle\. Waiting for authorized review commands\.$/);
});

test("a narrow row budget truncates current work but still labels the backlog exactly", () => {
  const snapshot = terminalSnapshot({
    activeCount: 3,
    queuedCount: 20,
    rows: [
      snapshotRow(1, "active"),
      snapshotRow(2, "active"),
      snapshotRow(3, "active"),
      snapshotRow(4, "queued"),
    ],
    overflow: 19,
  });
  // available = 5 - 3 = 2, which cannot hold a label, a row and the summary,
  // so the surface reports the full 3 + 20 backlog instead of an off-by-one.
  const lines = snapshotLines(snapshot, "disabled", 5);
  assert.equal(lines.length, 4);
  assert.doesNotMatch(lines[3]!, /^Active \(3\)$/);
  assert.match(lines[3]!, /^\.\.\. 23 more active\/queued$/);
  assert.doesNotMatch(lines.join("\n"), /recent/);
});

test("an extremely tight budget shows the exact summary and never an orphan heading", () => {
  const snapshot = terminalSnapshot({
    activeCount: 3,
    queuedCount: 0,
    rows: [snapshotRow(1, "active"), snapshotRow(2, "active"), snapshotRow(3, "active")],
    latestCompletion: snapshotRow(9, "recent", { stage: "succeeded", outcome: "succeeded" }),
  });
  // available = 4 - 3 = 1: only the summary fits, so the "Active (3)" heading
  // must not be shown without its rows, and the count is exact (3 active).
  const lines = snapshotLines(snapshot, "disabled", 4);
  assert.equal(lines.length, 4);
  assert.doesNotMatch(lines[3]!, /^Active \(3\)$/);
  assert.match(lines[3]!, /^\.\.\. 3 more active\/queued$/);
  assert.doesNotMatch(lines.join("\n"), /Latest:/);
});

test("a tight budget keeps exact per-lane counts when multiple lanes are truncated", () => {
  const snapshot = terminalSnapshot({
    activeCount: 1,
    queuedCount: 2,
    rows: [snapshotRow(1, "active"), snapshotRow(2, "queued"), snapshotRow(3, "queued")],
    latestCompletion: snapshotRow(9, "recent", { stage: "succeeded", outcome: "succeeded" }),
  });
  // available = 7 - 3 = 4: one active row, the block summary for the two queued
  // rows that cannot fit beside it, and the completion all fit exactly.
  const lines = snapshotLines(snapshot, "disabled", 7);
  assert.equal(lines.length, 7);
  assert.match(lines[3]!, /^Active \(1\)$/);
  assert.match(lines[4]!, /widgets PR #1 \| running \| 1s/);
  assert.match(lines[5]!, /^\.\.\. 2 more active\/queued$/);
  assert.match(lines[6]!, /^Latest: /);
  assert.equal(
    lines.join("\n").match(/more active\/queued/g)?.length,
    1,
    "the overflow line is emitted exactly once",
  );
});

test("the sound hint offers enable while disabled and mute once enabled", () => {
  const stream = new FakeStream();
  const presentation = new TerminalPresentation(
    { ...DEFAULT_TERMINAL_OPTIONS, presentation: "terminal", noColor: true },
    stream,
    { TERM: "xterm" },
  );
  try {
    presentation.setSoundControlAvailable(true);
    presentation.setReadiness("ready");
    const before = stream.output.join("");
    assert.match(before, /Sound: disabled \[m: enable\]/);
    assert.doesNotMatch(before, /\[m: mute\]/);

    presentation.setSound(true, false);
    const after = stream.output.join("");
    assert.match(after, /\[m: mute\]/);
    assert.doesNotMatch(after, /disabled \[m: mute\]/);
  } finally {
    presentation.dispose();
  }
});

test("presentation redacts quoted credentials before serializing the JSON pathway", () => {
  const stream = new FakeStream();
  stream.isTTY = false;
  const secret = 'fixture-only-"quoted\\token';
  const presentation = new TerminalPresentation(
    { ...DEFAULT_TERMINAL_OPTIONS, presentation: "json" },
    stream,
    {},
    [secret],
  );
  presentation.sink({ at: "fixture", level: "error", event: secret, fields: { nested: [secret] } });
  assert.deepEqual(JSON.parse(stream.output.join("")), {
    at: "fixture",
    level: "error",
    event: "[redacted]",
    nested: ["[redacted]"],
  });
  presentation.dispose();
});
