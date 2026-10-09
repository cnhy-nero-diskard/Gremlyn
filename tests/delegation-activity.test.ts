/**
 * Task 3.5: verified parent/child attribution and delegation-tool sanitization
 * for the live activity recorder.
 *
 * The recorder is a diagnostic surface that must never fail the run, must not
 * flatten a child session's events into the parent's transcript, and must not
 * persist the prompts/instructions a delegation tool is invoked with. Old
 * snapshots (no attribution fields) stay readable and ordinary single-session
 * runs keep their existing behavior.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityRecorder,
  activityPath,
  isDelegationToolName,
  opencodeLineMapper,
  redactCredentials,
  writeActivity,
  type ActivityAttribution,
  type AgentActivity,
} from "../src/agent/activity.js";

const TS_MILLIS = Date.parse("2026-08-28T18:05:44.524Z");
const TS_ISO = "2026-08-28T18:05:44.524Z";

/** A GitHub-token-shaped string, and an Anthropic-key-shaped one. */
const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ANTHROPIC_KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
const BEARER_TOKEN = "Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

function openCodeLine(type: string, sessionID: string, part: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, timestamp: TS_MILLIS, sessionID, part });
}

function openCodeText(sessionID: string, text: string): string {
  return openCodeLine("text", sessionID, { type: "text", text });
}

function clineLine(event: Record<string, unknown>, ts = TS_ISO): string {
  return JSON.stringify({ ts, type: "agent_event", event });
}

test("verified attribution is stamped onto new blocks and survives a snapshot", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(openCodeText("ses_parent", "hello"), {
    sessionId: "ses_parent",
    rootSessionId: "ses_root",
    parentSessionId: "ses_root",
    invocation: 1,
    role: "parent",
  });

  const [block] = recorder.snapshot().blocks;
  assert.ok(block);
  assert.equal(block.sessionId, "ses_parent");
  assert.equal(block.rootSessionId, "ses_root");
  assert.equal(block.parentSessionId, "ses_root");
  assert.equal(block.invocation, 1);
  assert.equal(block.role, "parent");
});

test("an ordinary run without attribution leaves blocks unchanged (backward compatible)", () => {
  const recorder = new ActivityRecorder();
  recorder.push(clineLine({ type: "content_start", contentType: "text", accumulated: "plain" }));

  const [block] = recorder.snapshot().blocks;
  assert.ok(block);
  assert.equal(block.text, "plain");
  assert.equal(Object.hasOwn(block, "sessionId"), false);
  assert.equal(Object.hasOwn(block, "rootSessionId"), false);
  assert.equal(Object.hasOwn(block, "role"), false);
  assert.equal(Object.hasOwn(block, "invocation"), false);
});

test("open blocks never merge across verified session or invocation boundaries", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(openCodeText("ses_a", "first"), { sessionId: "ses_a", invocation: 1 });
  recorder.push(openCodeText("ses_b", "second"), { sessionId: "ses_b", invocation: 2 });
  const blocks = recorder.snapshot().blocks;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.sessionId, "ses_a");
  assert.equal(blocks[0]?.text, "first");
  assert.equal(blocks[0]?.done, true);
  assert.equal(blocks[1]?.sessionId, "ses_b");
  assert.equal(blocks[1]?.invocation, 2);
  assert.equal(blocks[1]?.text, "second");
});

test("a line from a different stream session is not flattened into the parent transcript", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  const parent: ActivityAttribution = { sessionId: "ses_parent", role: "parent" };

  recorder.push(openCodeLine("step_start", "ses_parent", { type: "step-start" }), parent);
  recorder.push(openCodeLine("step_start", "ses_child", { type: "step-start" }), parent);
  recorder.push(openCodeText("ses_parent", "parent narration"), parent);
  recorder.push(openCodeText("ses_child", "child secret transcript"), parent);
  recorder.push(
    openCodeLine("tool_use", "ses_child", {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "child-only.txt" } },
    }),
    parent,
  );

  const snapshot = recorder.snapshot();
  assert.deepEqual(
    snapshot.blocks.map((block) => block.text),
    ["parent narration"],
  );
  assert.equal(snapshot.iterations, 1, "only the parent step_start is counted");
  assert.equal(snapshot.toolCalls, 0, "a child tool call is not counted");
  assert.equal(snapshot.blocks[0]?.sessionId, "ses_parent");
  assert.equal(
    JSON.stringify(snapshot).includes("child secret transcript"),
    false,
    "no child transcript is collected",
  );
});

test("invalid or oversized attribution references are dropped, never persisted", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  const attribution = {
    sessionId: "bad session id\n",
    rootSessionId: "x".repeat(200),
    invocation: -1,
    role: "root",
  } as unknown as ActivityAttribution;
  recorder.push(openCodeText("anything", "hi"), attribution);

  const [block] = recorder.snapshot().blocks;
  assert.ok(block);
  assert.equal(block.sessionId, undefined);
  assert.equal(block.rootSessionId, undefined);
  assert.equal(block.invocation, undefined);
  assert.equal(block.role, undefined);
  // The line itself is still captured; only the unverifiable attribution is gone.
  assert.equal(block.text, "hi");
});

test("OpenCode delegation tools persist only safe references, never prompt or output", () => {
  const secret = "OPERATOR SECRET INSTRUCTIONS";
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(
    openCodeLine("tool_use", "ses_parent", {
      type: "tool",
      tool: "task",
      callID: "call_1",
      state: {
        status: "completed",
        input: {
          subagent_type: "reviewer",
          prompt: secret,
          description: "private plan",
        },
        output: `child transcript: ${secret}`,
        metadata: { sessionId: "ses_child" },
      },
    }),
    { sessionId: "ses_parent", role: "parent" },
  );

  const [block] = recorder.snapshot().blocks;
  assert.ok(block);
  assert.match(block.text, /^task\n/u);
  assert.match(block.text, /state: completed/u);
  assert.match(block.text, /session: ses_child/u);
  assert.match(block.text, /agent: reviewer/u);
  assert.equal(block.text.includes(secret), false);
  assert.equal(block.text.includes("private plan"), false);
  assert.equal(block.text.includes("child transcript"), false);
  assert.equal(recorder.snapshot().toolCalls, 1);
});

test("Cline delegation tools drop prompt-bearing arguments and keep safe references", () => {
  const secret = "OPERATOR SECRET PROMPT";
  const recorder = new ActivityRecorder();
  recorder.push(
    clineLine({
      type: "content_start",
      contentType: "tool",
      toolName: "new_task",
      input: { context: secret, taskId: "conv_1_abc", agent: "reviewer" },
    }),
  );

  const [block] = recorder.snapshot().blocks;
  assert.ok(block);
  assert.match(block.text, /^new_task\n/u);
  assert.match(block.text, /session: conv_1_abc/u);
  assert.match(block.text, /agent: reviewer/u);
  assert.equal(block.text.includes(secret), false);
});

test("unrelated tools keep their full arguments and existing rendering", () => {
  const openCode = new ActivityRecorder(opencodeLineMapper);
  openCode.push(
    openCodeLine("tool_use", "ses_a", {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "sample.txt" }, output: "hello world" },
    }),
  );
  assert.match(openCode.snapshot().blocks[0]?.text ?? "", /^read\n/u);
  assert.match(openCode.snapshot().blocks[0]?.text ?? "", /sample\.txt/u);

  const cline = new ActivityRecorder();
  cline.push(
    clineLine({
      type: "content_start",
      contentType: "tool",
      toolName: "run_commands",
      input: { commands: ["git status"] },
    }),
  );
  assert.match(cline.snapshot().blocks[0]?.text ?? "", /git status/u);
});

test("delegation tool recognition covers task/subagent/delegation spellings only", () => {
  for (const name of [
    "task",
    "new_task",
    "subtask",
    "subagent",
    "sub_agent",
    "delegate",
    "delegate_task",
    "spawn_subagent",
    "use_subagents",
  ]) {
    assert.equal(isDelegationToolName(name), true, `${name} should be a delegation tool`);
  }
  for (const name of ["read", "run_commands", "task_progress", "list_tasks", "grep", ""]) {
    assert.equal(isDelegationToolName(name), false, `${name} should not be a delegation tool`);
  }
});

test("invalid timestamps fall back instead of throwing and dropping the event", () => {
  const openCode = new ActivityRecorder(opencodeLineMapper);
  assert.doesNotThrow(() => {
    openCode.push(
      JSON.stringify({
        type: "text",
        timestamp: 1e30,
        sessionID: "ses_a",
        part: { type: "text", text: "still captured" },
      }),
    );
  });
  const openCodeAt = openCode.snapshot().blocks[0]?.at;
  assert.ok(openCodeAt);
  assert.equal(Number.isNaN(Date.parse(openCodeAt)), false);

  const cline = new ActivityRecorder();
  assert.doesNotThrow(() => {
    cline.push(
      clineLine(
        { type: "content_start", contentType: "text", accumulated: "still captured" },
        "not-a-date",
      ),
    );
  });
  const clineAt = cline.snapshot().blocks[0]?.at;
  assert.ok(clineAt);
  assert.equal(Number.isNaN(Date.parse(clineAt)), false);
});

test("an oversized stream payload is clamped rather than persisted unbounded", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  const huge = "z".repeat(50_000);
  assert.doesNotThrow(() => {
    recorder.push(
      JSON.stringify({
        type: "text",
        timestamp: TS_MILLIS,
        sessionID: "ses_a",
        part: { type: "text", text: huge },
      }),
    );
  });
  const text = recorder.snapshot().blocks[0]?.text ?? "";
  assert.ok(text.length < 50_000);
  assert.match(text, /truncated/u);
});

test("a legacy snapshot without attribution fields stays readable", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-delegation-"));
  const legacy: AgentActivity = {
    blocks: [{ seq: 1, kind: "text", at: TS_ISO, text: "old snapshot", done: true }],
    toolCalls: 0,
    iterations: 0,
    usage: null,
    updatedAt: TS_ISO,
  };
  const path = writeActivity(dataDir, 3, legacy);
  assert.equal(path, activityPath(dataDir, 3));

  const read = JSON.parse(readFileSync(path, "utf8")) as AgentActivity;
  assert.equal(read.blocks[0]?.text, "old snapshot");
  assert.equal(Object.hasOwn(read.blocks[0] ?? {}, "sessionId"), false);
});

test("persisting redacts attribution references as well as text", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-delegation-"));
  const activity: AgentActivity = {
    blocks: [
      {
        seq: 1,
        kind: "text",
        at: TS_ISO,
        text: "kept",
        done: true,
        sessionId: "ses_secret",
        rootSessionId: "ses_root",
        parentSessionId: "ses_parent",
        invocation: 2,
        role: "child",
      },
    ],
    toolCalls: 0,
    iterations: 0,
    usage: null,
    updatedAt: TS_ISO,
  };
  const path = writeActivity(dataDir, 4, activity, (value) =>
    value.replaceAll("ses_secret", "[redacted]"),
  );
  const read = JSON.parse(readFileSync(path, "utf8")) as AgentActivity;
  assert.equal(read.blocks[0]?.sessionId, "[redacted]");
  assert.equal(read.blocks[0]?.rootSessionId, "ses_root");
  assert.equal(read.blocks[0]?.role, "child");
});

test("delegation references reject credential-shaped session, agent, and status values", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(
    openCodeLine("tool_use", "ses_parent", {
      type: "tool",
      tool: "task",
      state: {
        status: `completed-${GITHUB_TOKEN}`,
        input: { subagent_type: GITHUB_TOKEN, agent: ANTHROPIC_KEY },
        metadata: { sessionId: ANTHROPIC_KEY },
        output: `child said ${GITHUB_TOKEN}`,
      },
    }),
    { sessionId: "ses_parent", role: "parent" },
  );

  const snapshot = recorder.snapshot();
  const [block] = snapshot.blocks;
  assert.ok(block);
  // Every unsafe reference is dropped; only the safe tool name remains.
  assert.equal(block.text, "task");
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(GITHUB_TOKEN), false);
  assert.equal(serialized.includes(ANTHROPIC_KEY), false);
});

test("URL/userinfo-shaped and non-session agent/session references are rejected", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(
    openCodeLine("tool_use", "ses_parent", {
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        input: { subagent_type: "https://user:pass@host/reviewer?x=1", agent: "reviewer" },
        metadata: { sessionId: "not-a-session" },
      },
    }),
    { sessionId: "ses_parent", role: "parent" },
  );

  const [block] = recorder.snapshot().blocks;
  assert.ok(block);
  assert.equal(block.text, "task\nstate: running\nagent: reviewer");

  const cline = new ActivityRecorder();
  cline.push(
    clineLine({
      type: "content_start",
      contentType: "tool",
      toolName: "new_task",
      input: { session_id: "not-a-conv", taskId: "conv_2_xyz" },
    }),
  );
  assert.equal(cline.snapshot().blocks[0]?.text, "new_task\nsession: conv_2_xyz");
});

test("an unsafe delegation tool name falls back to a fixed label with no leak", () => {
  const names = [
    `delegate_${"x".repeat(200)}`,
    `delegate_${GITHUB_TOKEN}`,
    "delegate\nOPERATOR SECRET",
  ];
  for (const name of names) {
    const recorder = new ActivityRecorder(opencodeLineMapper);
    recorder.push(
      openCodeLine("tool_use", "ses_parent", {
        type: "tool",
        tool: name,
        state: { status: "completed" },
      }),
    );
    const [block] = recorder.snapshot().blocks;
    assert.ok(block);
    assert.equal(block.text, "delegation tool\nstate: completed");
    assert.equal(block.text.includes("OPERATOR SECRET"), false);
    assert.equal(block.text.includes(GITHUB_TOKEN), false);
  }
});

test("the baseline scrubber removes unconfigured credentials from persisted text", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-delegation-"));
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(openCodeText("ses_a", `leaked ${GITHUB_TOKEN} and ${ANTHROPIC_KEY}`));
  const path = writeActivity(dataDir, 5, recorder.snapshot());
  const written = readFileSync(path, "utf8");
  assert.equal(written.includes(GITHUB_TOKEN), false);
  assert.equal(written.includes(ANTHROPIC_KEY), false);
  assert.match(written, /\[redacted\]/u);
});

test("the baseline scrubber covers credential-shaped refs and Bearer tokens on disk", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-delegation-"));
  const activity: AgentActivity = {
    blocks: [
      {
        seq: 1,
        kind: "text",
        at: TS_ISO,
        text: `auth ${BEARER_TOKEN}`,
        done: true,
        sessionId: ANTHROPIC_KEY,
        rootSessionId: GITHUB_TOKEN,
        parentSessionId: "ses_parent",
      },
    ],
    toolCalls: 0,
    iterations: 0,
    usage: null,
    updatedAt: TS_ISO,
  };
  const path = writeActivity(dataDir, 6, activity);
  const written = readFileSync(path, "utf8");
  assert.equal(written.includes(ANTHROPIC_KEY), false);
  assert.equal(written.includes(GITHUB_TOKEN), false);
  assert.equal(written.includes(BEARER_TOKEN), false);
  // A legitimate session reference is untouched.
  assert.equal(written.includes("ses_parent"), true);
});

test("redactCredentials covers common token shapes and preserves ordinary ids", () => {
  for (const token of [
    GITHUB_TOKEN,
    ANTHROPIC_KEY,
    BEARER_TOKEN,
    "AKIAIOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ]) {
    const redacted = redactCredentials(`x ${token} y`);
    assert.equal(redacted.includes(token), false, token);
    assert.match(redacted, /\[redacted\]/u);
  }
  assert.equal(redactCredentials("ses_parent reviewer-1"), "ses_parent reviewer-1");

  const lowerBearer = redactCredentials("authorization: bearer abcdefghijklmnop");
  assert.equal(lowerBearer.includes("abcdefghijklmnop"), false);
  const pem = redactCredentials(
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----",
  );
  assert.equal(pem.includes("MIIEsecret"), false);
  assert.match(pem, /\[redacted\]/u);
});

test("a delegation tool's credential-bearing output never reaches the snapshot or disk", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-delegation-"));
  const recorder = new ActivityRecorder(opencodeLineMapper);
  recorder.push(
    openCodeLine("tool_use", "ses_parent", {
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: { subagent_type: "reviewer", prompt: `use ${GITHUB_TOKEN}` },
        output: `child leaked ${ANTHROPIC_KEY}`,
        metadata: { sessionId: "ses_child" },
      },
    }),
    { sessionId: "ses_parent", role: "parent" },
  );

  const snapshot = recorder.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(GITHUB_TOKEN), false);
  assert.equal(serialized.includes(ANTHROPIC_KEY), false);
  assert.equal(
    snapshot.blocks[0]?.text,
    "task\nstate: completed\nsession: ses_child\nagent: reviewer",
  );

  const path = writeActivity(dataDir, 7, snapshot);
  const written = readFileSync(path, "utf8");
  assert.equal(written.includes(GITHUB_TOKEN), false);
  assert.equal(written.includes(ANTHROPIC_KEY), false);
});

test("malformed, oversized, or missing session ownership is never stamped as the verified parent", () => {
  const recorder = new ActivityRecorder(opencodeLineMapper);
  const parent: ActivityAttribution = { sessionId: "ses_parent", role: "parent" };
  const secret = "PRIVATE CHILD TRANSCRIPT";

  // A valid parent text line and step/tool give the baseline counters.
  recorder.push(openCodeText("ses_parent", "parent line"), parent);
  recorder.push(openCodeLine("step_start", "ses_parent", { type: "step-start" }), parent);
  recorder.push(
    openCodeLine("tool_use", "ses_parent", {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "parent.txt" } },
    }),
    parent,
  );

  // Present but malformed ownership.
  recorder.push(openCodeLine("step_start", "wrong/invalid", { type: "step-start" }), parent);
  recorder.push(openCodeText("wrong/invalid", secret), parent);
  // Present but oversized ownership.
  recorder.push(
    openCodeLine("step_start", `ses_${"x".repeat(300)}`, { type: "step-start" }),
    parent,
  );
  recorder.push(openCodeText(`ses_${"x".repeat(300)}`, secret), parent);
  // Present but non-string ownership.
  recorder.push(
    JSON.stringify({
      type: "text",
      timestamp: TS_MILLIS,
      sessionID: 42,
      part: { type: "text", text: secret },
    }),
    parent,
  );
  // Ownership entirely missing.
  recorder.push(
    JSON.stringify({ type: "text", timestamp: TS_MILLIS, part: { type: "text", text: secret } }),
    parent,
  );
  recorder.push(
    JSON.stringify({ type: "step_start", timestamp: TS_MILLIS, part: { type: "step-start" } }),
    parent,
  );
  // A different valid child session, including a child tool call.
  recorder.push(openCodeText("ses_child", secret), parent);
  recorder.push(
    openCodeLine("tool_use", "ses_child", {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "child.txt" } },
    }),
    parent,
  );

  const snapshot = recorder.snapshot();
  assert.deepEqual(
    snapshot.blocks.map((block) => block.kind),
    ["text", "tool"],
    "only verified parent blocks are captured",
  );
  assert.equal(snapshot.blocks[0]?.text, "parent line");
  assert.ok(snapshot.blocks.every((block) => block.sessionId === "ses_parent"));
  assert.equal(snapshot.iterations, 1, "only the verified parent step_start counts");
  assert.equal(snapshot.toolCalls, 1, "only the verified parent tool call counts");
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test("Cline verified attribution requires matching task ownership", () => {
  const recorder = new ActivityRecorder();
  const parent: ActivityAttribution = { sessionId: "conv_1_abc", role: "parent" };
  const secret = "PRIVATE CLINE CHILD";

  const content = (taskId: unknown, text: string): string =>
    JSON.stringify({
      ts: TS_ISO,
      type: "agent_event",
      ...(taskId === undefined ? {} : { taskId }),
      event: { type: "content_start", contentType: "text", accumulated: text },
    });

  const hook = (taskId: unknown): string =>
    JSON.stringify({
      ts: TS_ISO,
      type: "hook_event",
      hookEventName: "tool_call",
      ...(taskId === undefined ? {} : { taskId }),
    });

  // Matching ownership is captured and counted.
  recorder.push(content("conv_1_abc", "parent text"), parent);
  recorder.push(hook("conv_1_abc"), parent);
  // Malformed, oversized, non-string and absent ownership are dropped.
  recorder.push(hook("wrong/task"), parent);
  recorder.push(hook(`conv_${"x".repeat(300)}`), parent);
  recorder.push(hook(42), parent);
  recorder.push(hook(undefined), parent);
  recorder.push(content("wrong/task", secret), parent);
  recorder.push(content(undefined, secret), parent);
  // A different valid task is dropped.
  recorder.push(content("conv_2_other", secret), parent);

  const snapshot = recorder.snapshot();
  assert.deepEqual(
    snapshot.blocks.map((block) => block.text),
    ["parent text"],
  );
  assert.equal(snapshot.toolCalls, 1, "only the verified parent hook counts");
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test("agentRef allows scoped managed references but rejects URL, traversal and credential shapes", () => {
  const cases: Array<[string, string | undefined]> = [
    ["reviewer", "reviewer"],
    ["attempt-1/reviewer", "attempt-1/reviewer"],
    ["/etc/passwd", undefined],
    ["https://user:pass@host/reviewer?x=1", undefined],
    ["a//b", undefined],
    ["../secret", undefined],
    ["attempt-1/..", undefined],
    ["attempt-1/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", undefined],
  ];

  for (const [input, expected] of cases) {
    const recorder = new ActivityRecorder(opencodeLineMapper);
    recorder.push(
      openCodeLine("tool_use", "ses_parent", {
        type: "tool",
        tool: "task",
        state: { status: "completed", input: { subagent_type: input } },
      }),
      { sessionId: "ses_parent", role: "parent" },
    );
    const text = recorder.snapshot().blocks[0]?.text ?? "";
    assert.equal(
      text,
      expected === undefined
        ? "task\nstate: completed"
        : `task\nstate: completed\nagent: ${expected}`,
      `${expected === undefined ? "rejected" : "accepted"}: ${input}`,
    );
  }
});
