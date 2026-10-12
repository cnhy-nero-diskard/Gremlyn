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
  for (const failure of ["throw", "capability", "async"] as const) {
    const stream = new FakeStream();
    let failures = 0;
    const renderer = new AnchoredRenderer(stream, () => {
      failures++;
    });
    if (failure === "throw") stream.throws = true;
    if (failure === "capability") stream.isTTY = false;
    if (failure === "async") stream.emit("error", new Error("fixture"));
    assert.doesNotThrow(() => renderer.render(["Gremlyn"]));
    renderer.dispose();
    renderer.dispose();
    assert.equal(failures, 1);
  }
});

test("write backpressure preserves the accepted render and coalesces until drain", () => {
  const stream = new FakeStream();
  let failures = 0;
  let now = 0;
  const renderer = new AnchoredRenderer(
    stream,
    () => failures++,
    () => now,
  );
  stream.blocked = true;
  renderer.render(["Gremlyn", "Health: HEALTHY"]);
  assert.deepEqual(stream.output, ["Gremlyn\nHealth: HEALTHY\n"]);
  assert.equal(failures, 0, "false means accepted but backpressured");

  now = 250;
  renderer.render(["Gremlyn", "Health: STALE"]);
  now = 500;
  renderer.render(["Gremlyn", "Health: FAILED"]);
  assert.equal(stream.output.length, 1, "intermediate dashboard states are coalesced");

  stream.blocked = false;
  stream.emit("drain");
  assert.equal(stream.output.length, 2);
  assert.match(stream.output[1]!, /Health: FAILED/);
  assert.equal(failures, 0);

  now = 750;
  renderer.render(["Gremlyn", "Health: HEALTHY"]);
  assert.equal(stream.output.length, 3, "normal refresh resumes after drain");
  renderer.dispose();
});

test("diagnostics share bounded drain-aware output and shutdown drops pending messages", () => {
  const stream = new FakeStream();
  stream.blocked = true;
  const renderer = new AnchoredRenderer(stream, () => assert.fail());
  renderer.render(["Gremlyn", "Health: HEALTHY"]);
  for (let index = 0; index < 32; index++) renderer.diagnostic(`WARN repeated ${index}`);
  renderer.diagnostic("ERROR critical fixture");
  assert.equal(stream.output.length, 1, "blocked diagnostics do not enqueue more writes");

  stream.blocked = false;
  stream.emit("drain");
  const recovered = stream.output.join("");
  assert.match(recovered, /ERROR critical fixture/);
  assert.match(recovered, /additional terminal diagnostics omitted during backpressure/);
  assert.match(stream.output.at(-1)!, /Gremlyn\nHealth: HEALTHY/);
  assert.ok(stream.output.length <= 11, "diagnostic backlog and restoration stay bounded");
  renderer.dispose();

  const shutdownStream = new FakeStream();
  shutdownStream.blocked = true;
  const shutdownRenderer = new AnchoredRenderer(shutdownStream, () => assert.fail());
  shutdownRenderer.render(["Gremlyn", "running"]);
  shutdownRenderer.diagnostic("ERROR pending at shutdown");
  const writesAtShutdown = shutdownStream.output.length;
  shutdownRenderer.dispose();
  shutdownStream.blocked = false;
  shutdownStream.emit("drain");
  assert.equal(shutdownStream.output.length, writesAtShutdown);
  assert.equal(shutdownStream.listenerCount("drain"), 0);
});

test("meaningful health and latest-outcome colors are optional and retain their text labels", () => {
  const stream = new FakeStream();
  const renderer = new AnchoredRenderer(stream, () => assert.fail());
  renderer.render(
    [
      "Gremlyn | ready",
      "Health: HEALTHY",
      "Latest outcome: widgets PR #1 | failed | job 2s | completed 1m ago",
    ],
    true,
  );
  const colored = stream.output.join("");
  assert.match(colored, /\x1b\[1mGremlyn/);
  assert.match(colored, /\x1b\[32mHealth: HEALTHY\x1b\[0m/);
  assert.match(colored, /\x1b\[31mLatest outcome: widgets PR #1 \| failed/);
  renderer.dispose();

  const plainStream = new FakeStream();
  const plainRenderer = new AnchoredRenderer(plainStream, () => assert.fail());
  plainRenderer.render(["Gremlyn | ready", "Health: HEALTHY"], false);
  assert.doesNotMatch(plainStream.output.join(""), /\x1b/);
  plainRenderer.dispose();
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
    completionAgeSec: lane === "recent" ? 30 : null,
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
  const lines = snapshotLines(snapshot, "disabled", 14);
  assert.match(lines[0]!, /^Gremlyn \| ready$/);
  assert.match(lines[1]!, /^Health: STALE$/);
  assert.match(lines[3]!, /2 active \| 50 queued/);
  assert.match(lines[4]!, /Poll: not observed/);
  assert.match(lines[5]!, /Sound: disabled/);
  assert.match(lines[7]!, /^Active \(2\)$/);
  // A distinct recorded outcome is shown once, next to its stage.
  assert.match(lines[8]!, /widgets PR #1 \| validating \(agent-succeeded\) \| 1s elapsed/);
  assert.match(lines[9]!, /widgets PR #2 \| running \| 2s elapsed/);
  assert.match(lines[10]!, /^Queued \(50\)$/);
  assert.match(lines[11]!, /widgets PR #3 \| queued \| 3s elapsed/);
  assert.match(lines[12]!, /^\.\.\. 49 more active\/queued$/);
  // The stage-identical outcome is never repeated on the completion line.
  assert.match(
    lines[13]!,
    /^Latest outcome: widgets PR #4 \| succeeded \| job 4s \| completed 30s ago$/,
  );
  assert.equal(lines.length, 14);
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
  assert.equal(lines.length, 9);
  assert.match(lines[3]!, /Work: 0 active \| 0 queued/);
  assert.match(lines[7]!, /^Idle\. Waiting for authorized review commands\.$/);
  assert.match(
    lines[8]!,
    /^Latest outcome: widgets PR #7 \| failed \| job 4s \| completed 30s ago$/,
  );
  assert.doesNotMatch(lines.join("\n"), /412|more/);
});

test("idle layout without any completion shows only the waiting line", () => {
  const lines = snapshotLines(terminalSnapshot(), "disabled", 20);
  assert.equal(lines.length, 8);
  assert.match(lines[7]!, /^Idle\. Waiting for authorized review commands\.$/);
});

test("status groups and keyboard hints adapt to narrow widths without hiding health or controls", () => {
  const snapshot = terminalSnapshot({
    pollAgeSec: 1_192,
    latestCompletion: snapshotRow(1234, "recent", {
      stage: "succeeded",
      elapsedSec: 3_661,
      completionAgeSec: 1_192,
    }),
  });
  const wide = snapshotLines(snapshot, "enabled", 22, 80, true);
  assert.match(wide[0]!, /^Gremlyn \| ready$/);
  assert.match(wide[1]!, /^Health: HEALTHY$/);
  assert.match(wide[2]!, /Repositories: 1 enabled \/ 2 configured/);
  assert.match(wide[3]!, /Work: 0 active \| 0 queued/);
  assert.match(wide[4]!, /Poll: 19m 52s ago/);
  assert.match(wide[6]!, /\? help {2}m sound {2}q quit/);
  assert.match(wide.join("\n"), /job 1h 01m \| completed 19m 52s ago/);
  assert.doesNotMatch(wide.join("\n"), /npm run logs/);

  const narrow = snapshotLines(snapshot, "enabled", 22, 20, true);
  assert.match(narrow[1]!, /^Health: HEALTHY$/);
  assert.ok(narrow.includes("? help"));
  assert.ok(narrow.includes("m sound / q quit"));
  assert.ok(
    narrow.slice(0, 8).every((line) => line.length <= 19),
    "the compact status and all keys fit a 20-column terminal",
  );
});

test("short physical heights keep current work and shortcut hints in the rendered surface", () => {
  const snapshot = terminalSnapshot({
    activeCount: 2,
    queuedCount: 3,
    rows: [
      snapshotRow(1, "active", { stage: "running" }),
      snapshotRow(2, "active", { stage: "validating" }),
      snapshotRow(3, "queued"),
    ],
    overflow: 2,
    latestCompletion: snapshotRow(9, "recent", {
      stage: "failed",
      outcome: "failed",
    }),
  });

  for (let height = 6; height <= 12; height++) {
    const stream = new FakeStream();
    stream.columns = 80;
    stream.rows = height;
    const renderer = new AnchoredRenderer(stream, () => assert.fail());
    const { columns, rows } = renderer.dimensions;
    const lines = snapshotLines(snapshot, "enabled", rows - 2, columns, true, true);
    renderer.render(lines);

    const rendered = stream.output.join("");
    assert.match(rendered, /Keys: \? help\s+m sound\s+q quit/, `height ${height} keeps shortcuts`);
    assert.match(rendered, /running #1|widgets PR #1 \| running/, `height ${height} shows work`);
    assert.match(
      rendered,
      /\+4 more|4 more active\/queued/,
      `height ${height} accounts for overflow`,
    );
    assert.ok(lines.length <= height - 2, `height ${height} respects the renderer budget`);
    renderer.dispose();
  }
});

test("rendered narrow work and completion lines preserve status, PR and completion age", () => {
  const snapshot = terminalSnapshot({
    activeCount: 1,
    rows: [
      snapshotRow(1, "active", {
        repository: "widgets-with-a-long-colliding-name",
        pr: 1234,
        stage: "running",
        elapsedSec: 3_661,
      }),
    ],
    latestCompletion: snapshotRow(2, "recent", {
      repository: "another-long-colliding-name",
      pr: 5678,
      stage: "failed",
      outcome: "failed",
      elapsedSec: 3_661,
      completionAgeSec: 1_192,
    }),
  });

  for (const columns of [20, 30, 40, 60]) {
    const stream = new FakeStream();
    stream.columns = columns;
    const renderer = new AnchoredRenderer(stream, () => assert.fail());
    renderer.render(snapshotLines(snapshot, "disabled", 20, columns, true, true));

    const renderedLines = stream.output.join("").split("\n").filter(Boolean);
    assert.ok(
      renderedLines.some((line) => /running #1234/.test(line)),
      `${columns} columns keep the active stage and PR before the repository name`,
    );
    const completion = renderedLines.find((line) => line.includes("5678"));
    assert.ok(completion, `${columns} columns render the latest result`);
    assert.match(completion!, /failed/, `${columns} columns keep the failed outcome`);
    assert.match(completion!, /19m/, `${columns} columns retain the completion age`);
    assert.ok(renderedLines.every((line) => line.length <= columns - 1));
    renderer.dispose();
  }
});

test("help view puts the long read-only detail command on demand and no-color remains plain", () => {
  const stream = new FakeStream();
  const store = new Store({ dataDir: "unused", file: ":memory:" });
  let now = 0;
  const presentation = new TerminalPresentation(
    { ...DEFAULT_TERMINAL_OPTIONS, presentation: "terminal", noColor: true },
    stream,
    { TERM: "xterm" },
    [],
    () => now,
  );
  try {
    presentation.attach(store.db, 60);
    presentation.setSoundControlAvailable(true);
    now = 250;
    presentation.toggleHelp();
    const help = stream.output.join("");
    assert.match(help, /npm run logs -- --data-dir <directory>/);
    assert.match(help, /Read-only display/);
    assert.doesNotMatch(help, /\x1b\[(?:1|31|32|33)m/);
    now = 500;
    presentation.toggleHelp();
    assert.match(stream.output.at(-1)!, /Health: UNKNOWN/);
  } finally {
    presentation.dispose();
    store.close();
  }
});

test("a narrow row budget keeps one current job and summarizes the remaining backlog", () => {
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
  // The compact layout spends its one current-work line on a representative
  // active job and the exact number of other active/queued jobs.
  const lines = snapshotLines(snapshot, "disabled", 8);
  assert.ok(lines.length <= 8);
  assert.ok(lines.some((line) => /running #1 \+22 more/.test(line)));
  assert.doesNotMatch(lines.join("\n"), /^Active \(3\)$/m);
  assert.doesNotMatch(lines.join("\n"), /recent/);
});

test("an extremely tight budget shows current work without an orphan heading", () => {
  const snapshot = terminalSnapshot({
    activeCount: 3,
    queuedCount: 0,
    rows: [snapshotRow(1, "active"), snapshotRow(2, "active"), snapshotRow(3, "active")],
    latestCompletion: snapshotRow(9, "recent", { stage: "succeeded", outcome: "succeeded" }),
  });
  // The compact surface uses one line for a representative job and exact
  // remaining count, rather than showing an orphan lane heading.
  const lines = snapshotLines(snapshot, "disabled", 8);
  assert.ok(lines.length <= 8);
  assert.ok(lines.some((line) => /running #1 \+2 more/.test(line)));
  assert.doesNotMatch(lines.join("\n"), /^Active \(3\)$/m);
});

test("a tight budget keeps exact per-lane counts when multiple lanes are truncated", () => {
  const snapshot = terminalSnapshot({
    activeCount: 1,
    queuedCount: 2,
    rows: [snapshotRow(1, "active"), snapshotRow(2, "queued"), snapshotRow(3, "queued")],
    latestCompletion: snapshotRow(9, "recent", { stage: "succeeded", outcome: "succeeded" }),
  });
  // available = 11 - 7 = 4: one active row, the block summary for the two queued
  // rows that cannot fit beside it, and the completion all fit exactly.
  const lines = snapshotLines(snapshot, "disabled", 11);
  assert.equal(lines.length, 11);
  assert.match(lines[7]!, /^Active \(1\)$/);
  assert.match(lines[8]!, /widgets PR #1 \| running \| 1s elapsed/);
  assert.match(lines[9]!, /^\.\.\. 2 more active\/queued$/);
  assert.match(lines[10]!, /^Latest outcome: /);
  assert.equal(
    lines.join("\n").match(/more active\/queued/g)?.length,
    1,
    "the overflow line is emitted exactly once",
  );
});

test("the installed sound key is hinted and its action gets textual feedback", () => {
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
    assert.match(before, /Sound: disabled/);
    assert.match(before, /Keys: \? help m sound q quit/);

    presentation.setSound(true, false);
    const after = stream.output.join("");
    assert.match(after, /INFO sound enabled/);
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
