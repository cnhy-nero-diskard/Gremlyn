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

test("terminal layout identifies lifecycle rows and overflow within the row budget", () => {
  const snapshot: TerminalSnapshot = {
    readiness: "ready",
    connection: "stale",
    configured: 2,
    enabled: 1,
    lastPollAt: null,
    pollAgeSec: null,
    activeCount: 2,
    queuedCount: 50,
    recentCount: 10,
    rows: [1, 2, 3].map((id) => ({
      id,
      repository: "owner/repo",
      pr: id,
      stage: "validating",
      elapsedSec: 10,
      outcome: "agent-succeeded",
    })),
    overflow: 59,
  };
  const lines = snapshotLines(snapshot, "disabled", 7);
  assert.equal(lines.length, 7);
  assert.match(lines[0]!, /connection: stale/);
  assert.match(lines[1]!, /Active: 2 \| Queued: 50/);
  assert.match(lines[4]!, /PR #1 \| validating \| 10s/);
  assert.match(lines[6]!, /60 more jobs/);
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
