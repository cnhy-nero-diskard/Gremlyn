/**
 * Focused tests for task 2.1: the versioned OpenCode agent profile type and
 * its runtime field-specific validation (`src/config/opencode-profile.ts`).
 * Covers invalid atomic parse failures (whole-candidate rejection) and
 * per-field errors, plus the safety invariants from design D1: unique
 * case-insensitive ids, required child descriptions, instructions as data,
 * `provider/model[#variant]` overrides, positive step limits, boolean enabled
 * state, the closed supported-permission vocabulary, the read-only child
 * default, and the always-denied external-directory / nested-delegation
 * scopes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalOpenCodeProfileJson,
  DENIED_CHILD_SCOPES,
  effectiveChildPermissions,
  OPENCODE_AGENT_PROFILE_VERSION,
  OPENCODE_PERMISSIONS,
  OpenCodeProfileValidationError,
  parseOpenCodeAgentProfile,
  resolveChildModel,
} from "../src/config/opencode-profile.js";

function validPrimaryInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "primary",
    description: "Primary review agent",
    permissions: ["edit", "shell", "web", "skill"],
    ...overrides,
  };
}

function validSubagentInput(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    description: `Subagent ${id}`,
    enabled: true,
    ...overrides,
  };
}

function validProfileInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    primary: validPrimaryInput(),
    subagents: [validSubagentInput("reviewer"), validSubagentInput("researcher")],
    ...overrides,
  };
}

/** Issues raised by parsing an invalid candidate; throws if it parses cleanly. */
function issuesFor(input: unknown): OpenCodeProfileValidationError["issues"] {
  assert.throws(
    () => parseOpenCodeAgentProfile(input),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeProfileValidationError);
      assert.ok(error.issues.length > 0, `expected issues for ${JSON.stringify(input)}`);
      return true;
    },
    `expected parse of ${JSON.stringify(input)} to fail with field issues`,
  );
  try {
    parseOpenCodeAgentProfile(input);
  } catch (error) {
    return (error as OpenCodeProfileValidationError).issues;
  }
  throw new Error("unreachable");
}

function assertPath(issues: readonly { path: string }[], path: string): void {
  assert.ok(
    issues.some((issue) => issue.path === path),
    `expected an issue at "${path}", got: ${JSON.stringify(issues)}`,
  );
}

test("a valid profile parses with read-only defaults and preserved order", () => {
  const profile = parseOpenCodeAgentProfile(validProfileInput());
  assert.equal(profile.version, OPENCODE_AGENT_PROFILE_VERSION);
  assert.equal(profile.primary.id, "primary");
  assert.deepEqual(profile.primary.permissions, ["edit", "shell", "web", "skill"]);
  // Subagents keep their declared order.
  assert.deepEqual(
    profile.subagents.map((agent) => agent.id),
    ["reviewer", "researcher"],
  );
  // A child without a permission list parses as read-only (empty is explicit).
  assert.deepEqual(effectiveChildPermissions(profile.subagents[0]!), []);
  // A child with permissions keeps exactly those, in order.
  const withTools = parseOpenCodeAgentProfile(
    validProfileInput({
      subagents: [validSubagentInput("reviewer", { permissions: ["shell", "edit"] })],
    }),
  );
  assert.deepEqual(effectiveChildPermissions(withTools.subagents[0]!), ["shell", "edit"]);
});

test("a profile version is required and only version 1 is supported", () => {
  for (const version of [undefined, "1", 2, 1.5, null]) {
    const issues = issuesFor(validProfileInput({ version }));
    assertPath(issues, "version");
  }
});

test("parse is atomic: a non-object candidate fails with a profile issue", () => {
  for (const input of [null, undefined, "profile", 42, ["primary"]]) {
    const issues = issuesFor(input);
    assertPath(issues, "profile");
  }
});

test("structural problems are reported together, not fail-fast", () => {
  // Version, primary shape, and subagents shape problems surface in one throw.
  const issues = issuesFor({ version: 2, subagents: "nope" });
  assert.equal(issues.length, 3);
  assertPath(issues, "version");
  assertPath(issues, "primary");
  assertPath(issues, "subagents");
});

test("ids must be unique case-insensitively across primary and subagents", () => {
  // A subagent whose id differs only by case from the primary collides.
  const primaryCollision = issuesFor(
    validProfileInput({
      primary: validPrimaryInput({ id: "reviewer" }),
      subagents: [validSubagentInput("Reviewer")],
    }),
  );
  assertPath(primaryCollision, "subagents[0].id");

  // Two subagents colliding case-insensitively are reported on the duplicate.
  const siblingCollision = issuesFor(
    validProfileInput({
      subagents: [validSubagentInput("Foo"), validSubagentInput("foo")],
    }),
  );
  assertPath(siblingCollision, "subagents[1].id");
  assert.ok(siblingCollision.some((issue) => issue.message.includes("case-insensitively")));

  // A malformed earlier row cannot shift the error path or hide a collision.
  const malformedSibling = issuesFor(
    validProfileInput({ subagents: [null, validSubagentInput("Foo"), validSubagentInput("foo")] }),
  );
  assertPath(malformedSibling, "subagents[0]");
  assertPath(malformedSibling, "subagents[2].id");

  // Collisions are still detected when the primary itself is malformed.
  const malformedPrimary = issuesFor(
    validProfileInput({
      primary: validPrimaryInput({ description: "" }),
      subagents: [validSubagentInput("Foo"), validSubagentInput("foo")],
    }),
  );
  assertPath(malformedPrimary, "subagents[1].id");

  // Distinct case is accepted: uniqueness is case-insensitive, not lossy.
  const distinct = parseOpenCodeAgentProfile(
    validProfileInput({
      subagents: [validSubagentInput("Reviewer"), validSubagentInput("reviewer2")],
    }),
  );
  assert.deepEqual(
    distinct.subagents.map((agent) => agent.id),
    ["Reviewer", "reviewer2"],
  );
});

test("unsafe ids are rejected as field-specific errors", () => {
  for (const id of [
    "a/b", // path separator
    "a\\b", // Windows separator
    "..", // traversal
    ".",
    "a b", // whitespace
    "-lead", // leading dash reads as a CLI flag
    "trail-", // trailing separator-like char
    "trail.", // trailing dot is stripped on Windows
    "a>b", // filename-illegal character
    "CON", // reserved Windows device name
    "com3", // reserved Windows device name
    "con.md", // reserved device name with extension
  ]) {
    const issues = issuesFor(validProfileInput({ subagents: [validSubagentInput(id)] }));
    assertPath(issues, "subagents[0].id");
  }
});

test("descriptions are required and must not be blank", () => {
  const childMissing = issuesFor(
    validProfileInput({ subagents: [validSubagentInput("reviewer", { description: undefined })] }),
  );
  assertPath(childMissing, "subagents[0].description");

  const childBlank = issuesFor(
    validProfileInput({ subagents: [validSubagentInput("reviewer", { description: "   " })] }),
  );
  assertPath(childBlank, "subagents[0].description");

  const primaryMissing = issuesFor(
    validProfileInput({ primary: validPrimaryInput({ description: undefined }) }),
  );
  assertPath(primaryMissing, "primary.description");
});

test("instructions are optional data preserved verbatim", () => {
  const instructions =
    "Fix the type error.\n```ts\nconst x: number = 1;\n```\nDo $NOT interpolate.";
  const profile = parseOpenCodeAgentProfile(
    validProfileInput({
      primary: validPrimaryInput({ instructions }),
      subagents: [validSubagentInput("reviewer", { instructions })],
    }),
  );
  assert.equal(profile.primary.instructions, instructions);
  assert.equal(profile.subagents[0]?.instructions, instructions);

  // An empty instruction string normalizes to absent.
  const normalized = parseOpenCodeAgentProfile(
    validProfileInput({
      primary: validPrimaryInput({ instructions: "" }),
      subagents: [validSubagentInput("reviewer", { instructions: "" })],
    }),
  );
  assert.ok(!("instructions" in normalized.primary));
  assert.ok(!("instructions" in normalized.subagents[0]!));

  // Non-string instructions are rejected at the exact field.
  for (const instructions of [42, true, ["help"], null]) {
    const issues = issuesFor(
      validProfileInput({ subagents: [validSubagentInput("reviewer", { instructions })] }),
    );
    assertPath(issues, "subagents[0].instructions");
  }
});

test("model overrides must be provider/model[#variant]", () => {
  // Accepted forms: provider/model and provider/model#variant.
  for (const model of [
    "anthropic/claude-sonnet-4-5",
    "opencode-go/kimi-k3#max",
    "openai/gpt-5.6-sol-fast",
  ]) {
    const profile = parseOpenCodeAgentProfile(
      validProfileInput({ subagents: [validSubagentInput("reviewer", { model })] }),
    );
    assert.equal(profile.subagents[0]?.model, model);
  }

  // Rejected malformed identifiers, each at the subagent's model field.
  for (const model of [
    "claude", // missing provider/model slash
    "provider/", // empty model
    "/model", // empty provider
    "a/b/c", // more than one slash
    "a/b#", // empty variant
    "a/b#c#d", // two variants
    "a /b", // whitespace
    "a/b c", // whitespace in model
    42, // not a string
    null, // absent-but-null
  ]) {
    const issues = issuesFor(
      validProfileInput({ subagents: [validSubagentInput("reviewer", { model })] }),
    );
    assertPath(issues, "subagents[0].model");
  }

  // A child without an override inherits the primary session model.
  const inherited = parseOpenCodeAgentProfile(
    validProfileInput({
      subagents: [validSubagentInput("inherits"), validSubagentInput("explicit", { model: "a/b" })],
    }),
  );
  assert.equal(resolveChildModel(inherited.subagents[0]!, "repo/model#high"), "repo/model#high");
  assert.equal(resolveChildModel(inherited.subagents[1]!, "repo/model"), "a/b");
});

test("step limits must be positive integers", () => {
  for (const stepLimit of [0, -1, 1.5, NaN, Infinity, "5", null]) {
    const issues = issuesFor(
      validProfileInput({ subagents: [validSubagentInput("reviewer", { stepLimit })] }),
    );
    assertPath(issues, "subagents[0].stepLimit");
  }
  for (const stepLimit of [1, 42]) {
    const profile = parseOpenCodeAgentProfile(
      validProfileInput({ subagents: [validSubagentInput("reviewer", { stepLimit })] }),
    );
    assert.equal(profile.subagents[0]?.stepLimit, stepLimit);
  }
});

test("enabled must be a boolean on every subagent", () => {
  for (const enabled of ["true", 1, 0, null, undefined]) {
    const issues = issuesFor(
      validProfileInput({ subagents: [validSubagentInput("reviewer", { enabled })] }),
    );
    assertPath(issues, "subagents[0].enabled");
  }
  const accepted = parseOpenCodeAgentProfile(
    validProfileInput({
      subagents: [
        validSubagentInput("on", { enabled: true }),
        validSubagentInput("off", { enabled: false }),
      ],
    }),
  );
  assert.equal(accepted.subagents[0]?.enabled, true);
  assert.equal(accepted.subagents[1]?.enabled, false);
});

test("permissions accept only the supported vocabulary", () => {
  assert.deepEqual(OPENCODE_PERMISSIONS, ["edit", "shell", "web", "skill"]);
  assert.deepEqual(DENIED_CHILD_SCOPES, ["directory", "subagent"]);

  const accepted = parseOpenCodeAgentProfile(
    validProfileInput({
      subagents: [validSubagentInput("reviewer", { permissions: ["web", "skill"] })],
    }),
  );
  assert.deepEqual(accepted.subagents[0]?.permissions, ["web", "skill"]);

  // Duplicate supported values collapse to the first occurrence.
  const deduped = parseOpenCodeAgentProfile(
    validProfileInput({
      subagents: [validSubagentInput("reviewer", { permissions: ["edit", "edit"] })],
    }),
  );
  assert.deepEqual(deduped.subagents[0]?.permissions, ["edit"]);

  // External-directory access and nested delegation are always denied.
  for (const permission of ["directory", "subagent"]) {
    const issues = issuesFor(
      validProfileInput({
        subagents: [validSubagentInput("reviewer", { permissions: [permission] })],
      }),
    );
    assertPath(issues, "subagents[0].permissions[0]");
    assert.ok(issues.some((issue) => issue.message.includes("always denied")));
  }

  // Unknown values are rejected as unsupported, and a non-list is a field error.
  const unknown = issuesFor(
    validProfileInput({
      subagents: [validSubagentInput("reviewer", { permissions: ["edit", "explode"] })],
    }),
  );
  assertPath(unknown, "subagents[0].permissions[1]");
  const nonList = issuesFor(
    validProfileInput({ subagents: [validSubagentInput("reviewer", { permissions: "edit" })] }),
  );
  assertPath(nonList, "subagents[0].permissions");
});

test("a failed parse never changes the prior profile", () => {
  const prior = parseOpenCodeAgentProfile(validProfileInput());
  const priorJson = canonicalOpenCodeProfileJson(prior);

  // An atomic save candidate being rejected leaves the previous profile intact.
  for (const invalid of [
    validProfileInput({ subagents: [validSubagentInput("X"), validSubagentInput("x")] }),
    validProfileInput({ subagents: [validSubagentInput("reviewer", { stepLimit: 0 })] }),
    { version: 99 },
    "not a profile",
  ]) {
    issuesFor(invalid);
    assert.equal(canonicalOpenCodeProfileJson(prior), priorJson);
    assert.deepEqual(
      prior.subagents.map((agent) => agent.id),
      ["reviewer", "researcher"],
    );
  }

  // That the failure is field-specific is visible in the thrown error itself.
  assert.throws(
    () =>
      parseOpenCodeAgentProfile(
        validProfileInput({ subagents: [validSubagentInput("reviewer", { model: "oops" })] }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeProfileValidationError);
      assert.equal(error.issues.length, 1);
      assert.equal(error.issues[0]?.path, "subagents[0].model");
      return true;
    },
  );
});

test("canonical JSON is deterministic and round-trips", () => {
  const a = parseOpenCodeAgentProfile(validProfileInput());
  const b = parseOpenCodeAgentProfile(validProfileInput());
  // Omitted empty instructions normalize identically to absent.
  const c = parseOpenCodeAgentProfile(
    validProfileInput({
      primary: validPrimaryInput({ instructions: "" }),
      subagents: [
        validSubagentInput("reviewer", { instructions: "" }),
        validSubagentInput("researcher"),
      ],
    }),
  );
  const jsonA = canonicalOpenCodeProfileJson(a);
  assert.equal(canonicalOpenCodeProfileJson(b), jsonA);
  assert.equal(canonicalOpenCodeProfileJson(c), jsonA);

  // Parsing the canonical JSON reproduces the identical canonical JSON.
  const roundTrip = parseOpenCodeAgentProfile(JSON.parse(jsonA));
  assert.equal(canonicalOpenCodeProfileJson(roundTrip), jsonA);
});

test("the normalized profile is a closed typed projection", () => {
  // The managed profile is typed (design D1) rather than exposing every
  // OpenCode config field: unknown keys are left out of the normalized
  // document without being treated as errors or carried forward. The console
  // builds candidates from its own form fields, so no operator data is lost.
  const unknown = parseOpenCodeAgentProfile(
    validProfileInput({ primary: validPrimaryInput({ tools: { bash: true }, mcp: ["x"] }) }),
  );
  assert.ok(!("tools" in unknown.primary));
  assert.ok(!("mcp" in unknown.primary));
  assert.deepEqual(Object.keys(unknown.primary).sort(), ["description", "id", "permissions"]);
});
