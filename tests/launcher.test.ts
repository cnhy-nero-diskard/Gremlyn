import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmedSpawnErrorCode, defaultRunner } from "../src/agent/launcher.js";

test("defaultRunner reports a CreateProcess failure as confirmed pre-spawn", async () => {
  const missingCwd = join(tmpdir(), `gremlyn-missing-cwd-${randomUUID()}`);
  const result = await defaultRunner(process.execPath, ["-e", ""], {
    env: {},
    cwd: missingCwd,
  });

  assert.equal(result.spawnErrorCode, "ENOENT");
  assert.equal(result.exitCode, undefined);
});

test("a spawned process with EPIPE cannot be classified as not-started", () => {
  assert.equal(
    confirmedSpawnErrorCode({
      pid: 12345,
      spawnEventSeen: true,
      preSpawnErrorCode: "EPIPE",
      timedOut: false,
      isCanceled: false,
    }),
    undefined,
  );
});

test("timeout and cancellation do not count as confirmed spawn failures", () => {
  for (const failure of [
    { timedOut: true, isCanceled: false },
    { timedOut: false, isCanceled: true },
  ]) {
    assert.equal(
      confirmedSpawnErrorCode({
        pid: undefined,
        spawnEventSeen: false,
        preSpawnErrorCode: "ETIMEDOUT",
        ...failure,
      }),
      undefined,
    );
  }
});
