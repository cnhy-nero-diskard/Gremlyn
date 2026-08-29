/**
 * Live agent activity: folding Cline's `--json` token stream into a transcript.
 *
 * Every fixture below is the real shape captured from a completed attempt
 * (`.gremlyn/output/attempt-25.json`), because the three content types do not
 * share a payload field and an invented shape would prove nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityRecorder, activityPath, writeActivity } from "../src/agent/activity.js";

function line(event: Record<string, unknown>, ts = "2026-08-28T18:05:44.524Z"): string {
  return JSON.stringify({ ts, type: "agent_event", event });
}

test("each content type is extracted from its own field", () => {
  const recorder = new ActivityRecorder();
  // Narration streams deltas plus the whole block so far.
  recorder.push(line({ type: "content_start", contentType: "text", text: "Pl", accumulated: "Pl" }));
  recorder.push(
    line({ type: "content_start", contentType: "text", text: "an", accumulated: "Plan" }),
  );
  recorder.push(line({ type: "content_end", contentType: "text", accumulated: "Plan" }));
  // Reasoning arrives complete, in `reasoning` — not `text`.
  recorder.push(
    line({ type: "content_start", contentType: "reasoning", reasoning: "**Planning**" }),
  );
  recorder.push(line({ type: "content_end", contentType: "reasoning", reasoning: "**Planning**" }));
  // A tool call carries a name and structured input.
  recorder.push(
    line({
      type: "content_start",
      contentType: "tool",
      toolName: "run_commands",
      input: { commands: ["git status"] },
    }),
  );
  recorder.finish();

  const activity = recorder.snapshot();
  assert.deepEqual(
    activity.blocks.map((block) => block.kind),
    ["text", "reasoning", "tool"],
  );
  assert.equal(activity.blocks[0]?.text, "Plan");
  assert.equal(activity.blocks[1]?.text, "**Planning**");
  assert.match(activity.blocks[2]?.text ?? "", /run_commands/u);
  assert.match(activity.blocks[2]?.text ?? "", /git status/u);
  assert.ok(activity.blocks.every((block) => block.done));
});

test("token deltas collapse into one block per content run", () => {
  const recorder = new ActivityRecorder();
  for (let i = 1; i <= 300; i += 1) {
    recorder.push(
      line({ type: "content_start", contentType: "text", accumulated: "x".repeat(i) }),
    );
  }
  const activity = recorder.snapshot();
  // 300 deltas describe one growing block; storing each would be the wall of
  // output this exists to avoid.
  assert.equal(activity.blocks.length, 1);
  assert.equal(activity.blocks[0]?.text.length, 300);
  assert.equal(activity.blocks[0]?.done, false, "an unclosed block is still being written");
});

test("a new iteration starts a fresh block rather than extending the last", () => {
  const recorder = new ActivityRecorder();
  recorder.push(line({ type: "content_start", contentType: "text", accumulated: "first" }));
  recorder.push(line({ type: "iteration_start" }));
  recorder.push(line({ type: "content_start", contentType: "text", accumulated: "second" }));
  const activity = recorder.snapshot();
  assert.deepEqual(
    activity.blocks.map((block) => block.text),
    ["first", "second"],
  );
  assert.equal(activity.iterations, 1);
});

test("tool calls are counted from the hook stream", () => {
  const recorder = new ActivityRecorder();
  for (let i = 0; i < 3; i += 1) {
    recorder.push(JSON.stringify({ type: "hook_event", hookEventName: "tool_call" }));
  }
  assert.equal(recorder.snapshot().toolCalls, 3);
});

test("unparsable and unknown lines are ignored, never thrown", () => {
  const recorder = new ActivityRecorder();
  // The stream is a diagnostic surface: it must not be able to fail the
  // attempt it describes.
  for (const bad of ["", "not json", "{oops", JSON.stringify({ type: "mystery" }), "[]"]) {
    assert.doesNotThrow(() => {
      recorder.push(bad);
    });
  }
  assert.equal(recorder.snapshot().blocks.length, 0);
});

test("a runaway block is truncated with the loss stated", () => {
  const recorder = new ActivityRecorder();
  recorder.push(line({ type: "content_start", contentType: "text", accumulated: "y".repeat(25_000) }));
  const text = recorder.snapshot().blocks[0]?.text ?? "";
  assert.ok(text.length < 25_000);
  assert.match(text, /truncated \(5000 more characters\)/u);
});

test("snapshots are redacted on the way to disk", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-activity-"));
  const recorder = new ActivityRecorder();
  // Reasoning is the model's unfiltered intermediate output and can echo file
  // contents, so it must pass through the same redactor as everything else.
  recorder.push(
    line({ type: "content_start", contentType: "reasoning", reasoning: "token is hunter2" }),
  );
  const path = writeActivity(dataDir, 7, recorder.snapshot(), (value) =>
    value.replaceAll("hunter2", "[redacted]"),
  );
  assert.equal(path, activityPath(dataDir, 7));
  const written = readFileSync(path, "utf8");
  assert.equal(written.includes("hunter2"), false);
  assert.match(written, /\[redacted\]/u);
});

test("hasChanges gates writes so an idle stream does not thrash the disk", () => {
  const recorder = new ActivityRecorder();
  assert.equal(recorder.hasChanges, false);
  recorder.push(line({ type: "content_start", contentType: "text", accumulated: "a" }));
  assert.equal(recorder.hasChanges, true);
  recorder.snapshot();
  assert.equal(recorder.hasChanges, false);
});
