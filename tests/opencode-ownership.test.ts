/**
 * Focused tests for the generic OpenCode ownership journal (task 3.3 journal
 * side; `src/agent/opencode-ownership.ts`).
 *
 * The journal is the attempt-scoped, outside-the-workspace record that exists
 * for EVERY OpenCode launch (managed, native, default). These tests pin the
 * lifecycle contract — begin (pre-launch uncertainty) / record (early parent +
 * initial identity) / settle — the immutable return values, ordinal history,
 * strict validation, and the guarantee that no secret/instruction/env content
 * is ever accepted or serialized.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  OPENCODE_OWNERSHIP_RECORD_FILE,
  OpenCodeOwnershipError,
  beginOpenCodeInvocation,
  opencodeOwnershipIsUnresolved,
  opencodeOwnershipOwnsWorkspace,
  opencodeOwnershipPath,
  opencodeOwnershipWorkspace,
  readOpenCodeOwnership,
  recordOpenCodeInvocation,
  settleOpenCodeInvocation,
  writeOpenCodeOwnership,
  type OpenCodeOwnershipDescriptor,
} from "../src/agent/opencode-ownership.js";

const NOW = "2026-10-01T00:00:00.000Z";

function descriptor(workspacePath: string): OpenCodeOwnershipDescriptor {
  return {
    executor: "opencode",
    binary: "opencode",
    version: "2.0.16",
    workspacePath,
    source: "native",
    nativeId: "build",
  };
}

function tempAttemptDir(): { root: string; attemptDataDir: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "gremlyn-ownership-"));
  return {
    root,
    attemptDataDir: join(root, "attempts", "7"),
    workspace: join(root, "workspaces", "pr-7"),
  };
}

test("lifecycle journals pre-launch uncertainty, records the parent, then settles immutably", () => {
  const { root, attemptDataDir, workspace } = tempAttemptDir();
  try {
    const started = beginOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      descriptor: descriptor(workspace),
      now: NOW,
    });
    assert.equal(started.version, 1);
    assert.equal(started.attemptId, 7);
    assert.equal(started.invocations.length, 1);
    const first = started.invocations[0]!;
    assert.equal(first.ordinal, 1);
    assert.equal(first.launchState, "pending");
    assert.equal(first.parentSessionId, null);
    assert.equal(first.settled, false);
    assert.equal(opencodeOwnershipIsUnresolved(started), true);
    assert.equal(opencodeOwnershipWorkspace(started), workspace);
    assert.equal(opencodeOwnershipOwnsWorkspace(started, workspace), true);

    const recorded = recordOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      ordinal: 1,
      parentSessionId: "ses_parent",
      observedPrimaryId: "build",
      now: NOW,
    });
    assert.equal(recorded.invocations[0]!.launchState, "launched");
    assert.equal(recorded.invocations[0]!.parentSessionId, "ses_parent");
    assert.equal(recorded.invocations[0]!.observedPrimaryId, "build");
    // The returned journal is a NEW value; the prior value is untouched.
    assert.equal(started.invocations[0]!.launchState, "pending");
    assert.equal(started.invocations[0]!.parentSessionId, null);

    const settled = settleOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      ordinal: 1,
      now: NOW,
    });
    assert.equal(settled.invocations[0]!.settled, true);
    assert.equal(settled.invocations[0]!.settledAt, NOW);
    assert.equal(opencodeOwnershipIsUnresolved(settled), false);
    assert.equal(recorded.invocations[0]!.settled, false);

    // The on-disk journal reflects the settled state and is re-readable.
    const onDisk = readOpenCodeOwnership(attemptDataDir);
    assert.deepEqual(onDisk, settled);
    assert.equal(existsSync(opencodeOwnershipPath(attemptDataDir)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent and observed identities are write-once: retargeting or clearing is rejected with the journal intact", () => {
  const { root, attemptDataDir, workspace } = tempAttemptDir();
  try {
    beginOpenCodeInvocation({ attemptDataDir, attemptId: 7, descriptor: descriptor(workspace) });
    const recorded = recordOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      ordinal: 1,
      parentSessionId: "ses_A",
      observedPrimaryId: "primary-A",
      now: NOW,
    });
    assert.equal(recorded.invocations[0]!.parentSessionId, "ses_A");

    // A different parent id is rejected and must not rewrite anything.
    assert.throws(
      () =>
        recordOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          ordinal: 1,
          parentSessionId: "ses_B",
        }),
      OpenCodeOwnershipError,
    );
    // Clearing an established parent id is rejected too.
    assert.throws(
      () =>
        recordOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          ordinal: 1,
          parentSessionId: null,
        }),
      OpenCodeOwnershipError,
    );
    // A different observed primary id is rejected.
    assert.throws(
      () =>
        recordOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          ordinal: 1,
          observedPrimaryId: "primary-B",
        }),
      OpenCodeOwnershipError,
    );
    // Idempotent re-recording the same identity is allowed and leaves it intact.
    const again = recordOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      ordinal: 1,
      parentSessionId: "ses_A",
      observedPrimaryId: "primary-A",
    });
    assert.equal(again.invocations[0]!.parentSessionId, "ses_A");
    assert.equal(again.invocations[0]!.observedPrimaryId, "primary-A");
    assert.equal(again.invocations[0]!.settled, false);

    // The on-disk journal was never rewritten by the rejected attempts.
    const onDisk = readOpenCodeOwnership(attemptDataDir);
    assert.equal(onDisk?.invocations[0]!.parentSessionId, "ses_A");
    assert.equal(onDisk?.invocations[0]!.observedPrimaryId, "primary-A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relaunched invocation gets a distinct ordinal without touching the first", () => {
  const { root, attemptDataDir, workspace } = tempAttemptDir();
  try {
    beginOpenCodeInvocation({ attemptDataDir, attemptId: 7, descriptor: descriptor(workspace) });
    const afterFirst = recordOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      ordinal: 1,
      parentSessionId: "ses_first",
    });
    const afterSecond = beginOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      descriptor: descriptor(workspace),
    });
    assert.equal(afterSecond.invocations.length, 2);
    assert.deepEqual(
      afterSecond.invocations.map((invocation) => invocation.ordinal),
      [1, 2],
    );
    assert.equal(afterSecond.invocations[0]!.parentSessionId, "ses_first");
    assert.equal(afterSecond.invocations[1]!.launchState, "pending");
    assert.equal(afterFirst.invocations.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the journal records the binary/version/executor/workspace descriptor but no secret content", () => {
  const { root, attemptDataDir, workspace } = tempAttemptDir();
  try {
    beginOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      descriptor: {
        executor: "opencode",
        binary: "C:/tools/opencode/opencode.exe",
        version: "2.0.16",
        workspacePath: workspace,
        source: "native",
        nativeId: "build",
      },
    });
    const raw = readFileSync(opencodeOwnershipPath(attemptDataDir), "utf8");
    assert.ok(raw.includes("C:/tools/opencode/opencode.exe"));
    assert.ok(raw.includes("2.0.16"));
    // The descriptor is a closed shape: no environment, prompt, or credential
    // field exists to leak.
    for (const forbidden of ["env", "prompt", "instructions", "token", "apiKey", "secret"]) {
      assert.equal(raw.includes(forbidden), false, `journal must not mention ${forbidden}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native ids reject argument-like prefixes and non-native sources reject a native id", () => {
  const { root, attemptDataDir, workspace } = tempAttemptDir();
  try {
    assert.throws(
      () =>
        beginOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          descriptor: { ...descriptor(workspace), nativeId: "--force" },
        }),
      OpenCodeOwnershipError,
    );
    assert.throws(
      () =>
        beginOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          descriptor: { ...descriptor(workspace), source: "default", nativeId: "build" },
        }),
      OpenCodeOwnershipError,
    );
    assert.throws(
      () =>
        beginOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          descriptor: { ...descriptor(workspace), source: "native", nativeId: null },
        }),
      OpenCodeOwnershipError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the journal must live outside its own workspace", () => {
  const { root, attemptDataDir } = tempAttemptDir();
  try {
    // A workspace that CONTAINS the attempt data dir is refused.
    assert.throws(
      () =>
        beginOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          descriptor: descriptor(root),
        }),
      OpenCodeOwnershipError,
    );
    // A sibling workspace is fine.
    const journal = beginOpenCodeInvocation({
      attemptDataDir,
      attemptId: 7,
      descriptor: descriptor(join(root, "workspaces", "pr-1")),
    });
    assert.equal(journal.attemptId, 7);
    assert.equal(existsSync(opencodeOwnershipPath(attemptDataDir)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable journal reads as undefined and refuses to be overwritten by a later begin", () => {
  const { root, attemptDataDir, workspace } = tempAttemptDir();
  try {
    const path = opencodeOwnershipPath(attemptDataDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json\n", "utf8");
    assert.equal(readOpenCodeOwnership(attemptDataDir), undefined);
    assert.throws(
      () =>
        beginOpenCodeInvocation({
          attemptDataDir,
          attemptId: 7,
          descriptor: descriptor(workspace),
        }),
      OpenCodeOwnershipError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes are atomic: no staged temp files remain", () => {
  const { root, attemptDataDir, workspace } = tempAttemptDir();
  try {
    beginOpenCodeInvocation({ attemptDataDir, attemptId: 7, descriptor: descriptor(workspace) });
    const entries = readdirSync(attemptDataDir);
    assert.deepEqual(entries, [OPENCODE_OWNERSHIP_RECORD_FILE]);
    // A direct write of an untouched journal is accepted and re-readable.
    const journal = readOpenCodeOwnership(attemptDataDir)!;
    assert.equal(writeOpenCodeOwnership(attemptDataDir, journal).attemptId, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
