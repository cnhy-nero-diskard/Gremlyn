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
import { ActivityRecorder, activityPath, opencodeLineMapper, writeActivity } from "../src/agent/activity.js";

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

/**
 * OpenCode fixtures below are captured verbatim from two real
 * `opencode run --format json` sessions (opencode 1.18.27, the free
 * `opencode/big-pickle` OpenCode Zen model — zero-cost, no credential
 * required): one plain text reply, one tool-using exchange. Every event
 * carries terminal state, unlike Cline's token deltas, so there is nothing to
 * de-duplicate — see design D-opencode.
 */
const OPENCODE_TEXT_SESSION = [
  '{"type":"step_start","timestamp":1788408388432,"sessionID":"ses_a",' +
    '"part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_a","snapshot":"s1","type":"step-start"}}',
  '{"type":"reasoning","timestamp":1788408389114,"sessionID":"ses_a",' +
    '"part":{"id":"prt_2","messageID":"msg_1","sessionID":"ses_a","type":"reasoning",' +
    '"text":"The user is asking me to reply with a single word.","time":{"start":1,"end":2}}}',
  '{"type":"text","timestamp":1788408389127,"sessionID":"ses_a",' +
    '"part":{"id":"prt_3","messageID":"msg_1","sessionID":"ses_a","type":"text","text":"READY",' +
    '"time":{"start":1,"end":2}}}',
  '{"type":"step_finish","timestamp":1788408389489,"sessionID":"ses_a",' +
    '"part":{"id":"prt_4","reason":"stop","snapshot":"s2","messageID":"msg_1","sessionID":"ses_a",' +
    '"type":"step-finish","tokens":{"total":8080,"input":6244,"output":44,"reasoning":0,' +
    '"cache":{"write":0,"read":1792}},"cost":0}}',
].join("\n");

const OPENCODE_TOOL_SESSION = [
  '{"type":"step_start","timestamp":1788408404491,"sessionID":"ses_b",' +
    '"part":{"id":"prt_10","messageID":"msg_10","sessionID":"ses_b","snapshot":"s1","type":"step-start"}}',
  '{"type":"reasoning","timestamp":1788408404826,"sessionID":"ses_b",' +
    '"part":{"id":"prt_11","messageID":"msg_10","sessionID":"ses_b","type":"reasoning",' +
    '"text":"I will use the Read tool.","time":{"start":1,"end":2}}}',
  '{"type":"tool_use","timestamp":1788408405125,"sessionID":"ses_b",' +
    '"part":{"type":"tool","tool":"read","callID":"call_1","state":{"status":"completed",' +
    '"input":{"filePath":"sample.txt"},"output":"hello world","title":"sample.txt",' +
    '"time":{"start":1,"end":2}},"id":"prt_12","sessionID":"ses_b","messageID":"msg_10"}}',
  '{"type":"step_finish","timestamp":1788408406073,"sessionID":"ses_b",' +
    '"part":{"id":"prt_13","reason":"tool-calls","snapshot":"s2","messageID":"msg_10",' +
    '"sessionID":"ses_b","type":"step-finish","tokens":{"total":8111,"input":8037,"output":74,' +
    '"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
  '{"type":"step_start","timestamp":1788408409974,"sessionID":"ses_b",' +
    '"part":{"id":"prt_14","messageID":"msg_14","sessionID":"ses_b","snapshot":"s3","type":"step-start"}}',
  '{"type":"text","timestamp":1788408410404,"sessionID":"ses_b",' +
    '"part":{"id":"prt_15","messageID":"msg_14","sessionID":"ses_b","type":"text",' +
    '"text":"The exact contents of `sample.txt` are:\\n\\n```\\nhello world\\n```",' +
    '"time":{"start":1,"end":2}}}',
  '{"type":"step_finish","timestamp":1788408412188,"sessionID":"ses_b",' +
    '"part":{"id":"prt_16","reason":"stop","snapshot":"s4","messageID":"msg_14","sessionID":"ses_b",' +
    '"type":"step-finish","tokens":{"total":8230,"input":179,"output":51,"reasoning":0,' +
    '"cache":{"write":0,"read":8000}},"cost":0}}',
].join("\n");

/** Captured verbatim from a real invalid-model run: a session-level error event. */
const OPENCODE_ERROR_EVENT =
  '{"type":"error","timestamp":1788408457085,"sessionID":"ses_c",' +
  '"error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs ' +
  'for details.","ref":"err_7be42bd4"}}}';

test("OpenCode: text and reasoning are recovered as separate closed blocks", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  for (const l of OPENCODE_TEXT_SESSION.split("\n")) recorder.push(l);
  const activity = recorder.snapshot();
  assert.deepEqual(
    activity.blocks.map((b) => b.kind),
    ["reasoning", "text"],
  );
  assert.equal(activity.blocks[0]?.text, "The user is asking me to reply with a single word.");
  assert.equal(activity.blocks[1]?.text, "READY");
  assert.ok(activity.blocks.every((b) => b.done), "OpenCode blocks arrive already complete");
  assert.equal(activity.iterations, 1);
  assert.deepEqual(activity.usage, {
    tokens: { total: 8080, input: 6244, output: 44, reasoning: 0, cache: { write: 0, read: 1792 } },
    cost: 0,
  });
});

test("OpenCode: a tool call is recovered with its name, input, and count, across two iterations", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  for (const l of OPENCODE_TOOL_SESSION.split("\n")) recorder.push(l);
  const activity = recorder.snapshot();
  assert.deepEqual(
    activity.blocks.map((b) => b.kind),
    ["reasoning", "tool", "text"],
  );
  assert.match(activity.blocks[1]?.text ?? "", /^read\n/u);
  assert.match(activity.blocks[1]?.text ?? "", /sample\.txt/u);
  assert.equal(activity.toolCalls, 1);
  // Two step_start events: the tool-using step and the final response step.
  assert.equal(activity.iterations, 2);
  assert.deepEqual(activity.usage, {
    tokens: { total: 8230, input: 179, output: 51, reasoning: 0, cache: { write: 0, read: 8000 } },
    cost: 0,
  });
});

test("OpenCode: a session-level error event is recovered as a result block", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(OPENCODE_ERROR_EVENT);
  const activity = recorder.snapshot();
  assert.equal(activity.blocks.length, 1);
  assert.equal(activity.blocks[0]?.kind, "result");
  assert.match(activity.blocks[0]?.text ?? "", /UnknownError/u);
  assert.match(activity.blocks[0]?.text ?? "", /Unexpected server error/u);
  assert.equal(activity.blocks[0]?.done, true);
});

test("OpenCode: an unparsable or unknown event line is swallowed, matching the Cline mapper", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  for (const bad of ["", "not json", "{oops", JSON.stringify({ type: "mystery" }), "[]"]) {
    assert.doesNotThrow(() => {
      recorder.push(bad);
    });
  }
  assert.equal(recorder.snapshot().blocks.length, 0);
});
