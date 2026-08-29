/**
 * Credential seeding, verification, and teardown (change
 * `fix-agent-credential-isolation`, tasks 3.2–4.3).
 *
 * These assertions are the security boundary of that change: a credential is
 * copied onto Gremlyn-managed disk, and the mitigations claimed for that are
 * lifetime, permissions, and never touching the operator's source directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  CREDENTIAL_SEED_FILES,
  persistRotatedCredentials,
  removeAttemptDataDir,
  seedAgentCredentials,
  verifyCredentialSource,
} from "../src/agent/credentials.js";
import { agentFailureReason, classifyFailure } from "../src/orchestrator/failures.js";

const SECRET = '{"apiKey":"sk-not-a-real-key"}';
const OAUTH = '{"openai-codex":{"refreshToken":"not-a-real-token"}}';

/** An authenticated cline data directory, with the state files that must NOT be copied. */
function makeSource(): string {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-credsrc-"));
  writeFileSync(join(dir, "secrets.json"), SECRET, "utf8");
  // openai-codex keeps its OAuth token here — a nested seed entry.
  mkdirSync(join(dir, "settings"), { recursive: true });
  writeFileSync(join(dir, "settings", "providers.json"), OAUTH, "utf8");
  writeFileSync(join(dir, "globalState.json"), '{"provider":"cline-pass"}', "utf8");
  writeFileSync(join(dir, "locks.db"), "lockstate", "utf8");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", "prior.json"), "{}", "utf8");
  return dir;
}

function makeAttemptDir(): string {
  return join(mkdtempSync(join(tmpdir(), "gremlyn-attempt-")), "data");
}

test("seeding copies exactly the declared set and nothing more", () => {
  const source = makeSource();
  const dest = makeAttemptDir();

  const seeded = seedAgentCredentials(source, dest);

  assert.deepEqual(seeded, [...CREDENTIAL_SEED_FILES]);
  // The state files D10 isolates must not ride along, or isolation is undone.
  const copied = readdirSync(dest, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(sep).join("/"))
    .sort();
  assert.deepEqual(copied, ["secrets.json", "settings", "settings/providers.json"]);
  assert.equal(readFileSync(join(dest, "secrets.json"), "utf8"), SECRET);
  assert.equal(readFileSync(join(dest, "settings", "providers.json"), "utf8"), OAUTH);
});

test("the seeded credential is owner-only", { skip: process.platform === "win32" }, () => {
  const dest = makeAttemptDir();
  seedAgentCredentials(makeSource(), dest);
  const mode = statSync(join(dest, "secrets.json")).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test(
  "the seeded credential ACL grants access only to the current Windows user",
  { skip: process.platform !== "win32" },
  () => {
    const dest = makeAttemptDir();
    seedAgentCredentials(makeSource(), dest);
    const target = join(dest, "secrets.json");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$acl = Get-Acl -LiteralPath $env:GREMLYN_TEST_ACL_TARGET",
      "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$rules = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })",
      "[pscustomobject]@{ current = $current; protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Compress -Depth 3",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GREMLYN_TEST_ACL_TARGET: target,
        },
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const acl = JSON.parse(result.stdout) as {
      current: string;
      protected: boolean;
      rules: string | string[];
    };
    assert.equal(acl.protected, true);
    assert.deepEqual(
      [...new Set(Array.isArray(acl.rules) ? acl.rules : [acl.rules])],
      [acl.current],
    );
  },
);

test("seeding never writes to the operator's source directory", () => {
  const source = makeSource();
  const before = readdirSync(source, { recursive: true, encoding: "utf8" }).sort();
  const beforeSecret = readFileSync(join(source, "secrets.json"), "utf8");
  const beforeStat = statSync(join(source, "secrets.json")).mtimeMs;

  seedAgentCredentials(source, makeAttemptDir());
  seedAgentCredentials(source, makeAttemptDir());

  assert.deepEqual(readdirSync(source, { recursive: true, encoding: "utf8" }).sort(), before);
  assert.equal(readFileSync(join(source, "secrets.json"), "utf8"), beforeSecret);
  assert.equal(statSync(join(source, "secrets.json")).mtimeMs, beforeStat);
});

test("seeding fails loudly when a declared file is absent", () => {
  const source = mkdtempSync(join(tmpdir(), "gremlyn-empty-"));
  assert.throws(
    () => seedAgentCredentials(source, makeAttemptDir()),
    /credential source file not found/u,
  );
});

test("seeding refuses a directory standing in for a credential file", () => {
  const source = mkdtempSync(join(tmpdir(), "gremlyn-dirsecret-"));
  mkdirSync(join(source, "secrets.json"));
  assert.throws(() => seedAgentCredentials(source, makeAttemptDir()), /is not a file/u);
});

test("startup verification accepts an authenticated source", () => {
  assert.doesNotThrow(() => verifyCredentialSource("cline", makeSource()));
});

test("startup verification names the agent and the default when the source is missing", () => {
  const missing = join(tmpdir(), "gremlyn-does-not-exist-4c1f");
  assert.throws(
    () => verifyCredentialSource("cline", missing),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /"cline"/u);
      assert.match(message, /~\/\.cline\/data/u);
      return true;
    },
  );
});

test("startup verification rejects a file where a directory is required", () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-notdir-"));
  const file = join(dir, "data");
  writeFileSync(file, "not a directory", "utf8");
  assert.throws(() => verifyCredentialSource("cline", file), /is not a directory/u);
});

test("startup verification names the specific file that is missing", () => {
  const source = mkdtempSync(join(tmpdir(), "gremlyn-nosecret-"));
  writeFileSync(join(source, "globalState.json"), "{}", "utf8");
  assert.throws(
    () => verifyCredentialSource("cline", source),
    /missing required file "secrets\.json"/u,
  );
});

test("startup verification catches a missing nested credential file", () => {
  // secrets.json alone authenticates cline-pass but not openai-codex, so a
  // source missing settings/providers.json must fail at startup rather than
  // per-job on whichever repository runs the OAuth provider.
  const source = mkdtempSync(join(tmpdir(), "gremlyn-nonested-"));
  writeFileSync(join(source, "secrets.json"), SECRET, "utf8");
  assert.throws(
    () => verifyCredentialSource("cline", source),
    /missing required file "settings\/providers\.json"/u,
  );
});

test("a Windows ACL failure is not reported as a provider auth failure", () => {
  // Regression: the ACL helper fails with "Attempted to perform an unauthorized
  // operation", which a case-insensitive /Unauthorized/ once matched. Eight jobs
  // were reported as `agent-auth-failed` while the credential was never seeded
  // at all, pointing the operator at a provider that was working fine.
  const failure = classifyFailure(
    new Error(
      'cannot restrict credential file ACL .gremlyn\\attempts\\20\\secrets.json: Exception calling "SetAccessControl" with "2" argument(s): "Attempted to perform an unauthorized operation."',
    ),
    "running",
  );
  assert.notEqual(failure.reason, "agent-auth-failed");
});

test("the provider's own Unauthorized is still classified as an auth failure", () => {
  const failure = classifyFailure(new Error("Unauthorized: invalid refresh token"), "running");
  assert.equal(failure.reason, "agent-auth-failed");
});

test("seeding into a real project-directory path succeeds", () => {
  // The ACL helper passed in %TEMP% but failed under the repo's own .gremlyn
  // dir, so a temp-only fixture cannot catch this. Seed where Gremlyn runs.
  const source = makeSource();
  const dest = join(process.cwd(), ".gremlyn", "acl-seed-test", "data");
  try {
    assert.deepEqual(seedAgentCredentials(source, dest), [...CREDENTIAL_SEED_FILES]);
    assert.equal(readFileSync(join(dest, "secrets.json"), "utf8"), SECRET);
  } finally {
    removeAttemptDataDir(join(process.cwd(), ".gremlyn", "acl-seed-test"));
  }
});

/**
 * Write-back: the OAuth half of the seed set is *stateful*. These tests pin the
 * property that seeding alone cannot provide — a token the agent rotated inside
 * the ephemeral attempt dir must survive the dir's deletion.
 */
test("a rotated OAuth token is written back to the source", () => {
  const source = makeSource();
  const dest = makeAttemptDir();
  seedAgentCredentials(source, dest);

  // The agent redeems the refresh token; the provider issues a replacement and
  // invalidates the one just used. Only the attempt dir knows the new value.
  const rotated = '{"openai-codex":{"refreshToken":"rotated-token"}}';
  writeFileSync(join(dest, "settings", "providers.json"), rotated, "utf8");

  const persisted = persistRotatedCredentials(source, dest);
  assert.deepEqual(persisted, ["settings/providers.json"]);
  assert.equal(readFileSync(join(source, "settings", "providers.json"), "utf8"), rotated);

  // Without this, the source would still hold the consumed token and every
  // later attempt would fail Unauthorized identically, forever.
  removeAttemptDataDir(dest);
  assert.equal(readFileSync(join(source, "settings", "providers.json"), "utf8"), rotated);
});

test("an unrotated credential is left untouched", () => {
  const source = makeSource();
  const dest = makeAttemptDir();
  seedAgentCredentials(source, dest);
  const before = statSync(join(source, "secrets.json")).mtimeMs;

  // A static API key is identical after the run; the source must not churn.
  assert.deepEqual(persistRotatedCredentials(source, dest), []);
  assert.equal(readFileSync(join(source, "secrets.json"), "utf8"), SECRET);
  assert.equal(statSync(join(source, "secrets.json")).mtimeMs, before);
});

test("write-back leaves no staging file behind", () => {
  const source = makeSource();
  const dest = makeAttemptDir();
  seedAgentCredentials(source, dest);
  writeFileSync(join(dest, "secrets.json"), '{"apiKey":"sk-rotated"}', "utf8");
  persistRotatedCredentials(source, dest);
  assert.deepEqual(
    readdirSync(source).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("removing the attempt directory leaves no credential material", () => {
  const dest = makeAttemptDir();
  seedAgentCredentials(makeSource(), dest);
  assert.ok(existsSync(join(dest, "secrets.json")));

  removeAttemptDataDir(dest);

  assert.equal(existsSync(join(dest, "secrets.json")), false);
  assert.equal(existsSync(dest), false);
});

test("removing the attempt directory clears co-located agent state too", () => {
  const dest = makeAttemptDir();
  seedAgentCredentials(makeSource(), dest);
  mkdirSync(join(dest, "sessions"), { recursive: true });
  writeFileSync(join(dest, "sessions", "run.json"), "{}", "utf8");
  writeFileSync(join(dest, "locks.db"), "x", "utf8");

  removeAttemptDataDir(dest);

  assert.equal(existsSync(dest), false);
});

test("removing an attempt directory that never existed is not an error", () => {
  assert.doesNotThrow(() => removeAttemptDataDir(join(tmpdir(), "gremlyn-never-existed-9a2")));
});

test("two attempts seeded from one source get independent copies", () => {
  const source = makeSource();
  const first = makeAttemptDir();
  const second = makeAttemptDir();
  seedAgentCredentials(source, first);
  seedAgentCredentials(source, second);

  removeAttemptDataDir(first);

  // Tearing down one attempt must not disturb the other or the shared source.
  assert.equal(existsSync(join(second, "secrets.json")), true);
  assert.equal(readFileSync(join(source, "secrets.json"), "utf8"), SECRET);
});

/** Captured verbatim from a real unauthenticated `cline --json` run. */
const REAL_UNAUTHORIZED_STDOUT =
  '{"ts":"2026-08-28T01:53:12.687Z","type":"run_result","finishReason":"error",' +
  '"iterations":1,"durationMs":333,"text":"Unauthorized: Please make sure you\'re ' +
  'using the latest version of Cline and re-authenticate your Cline account."}';
const REAL_UNAUTHORIZED_STDERR =
  '{"ts":"2026-08-28T01:53:12.687Z","type":"error","message":"Unauthorized: Please ' +
  "make sure you're using the latest version of Cline and re-authenticate your Cline account.\"}";

test("a real unauthenticated run is classified as an auth failure", () => {
  const reason = agentFailureReason({
    stdout: REAL_UNAUTHORIZED_STDOUT,
    stderr: REAL_UNAUTHORIZED_STDERR,
    exitCode: 1,
    startedAt: "2026-08-28T01:53:11.000Z",
    endedAt: "2026-08-28T01:53:12.700Z",
    timedOut: false,
  });
  assert.equal(reason, "agent-auth-failed");
});

test("the stderr error line alone is sufficient", () => {
  const reason = agentFailureReason({
    stdout: "",
    stderr: REAL_UNAUTHORIZED_STDERR,
    exitCode: 1,
    startedAt: "2026-08-28T01:53:11.000Z",
    endedAt: "2026-08-28T01:53:12.700Z",
    timedOut: false,
  });
  assert.equal(reason, "agent-auth-failed");
});

test("an agent failure while editing auth code is not an auth failure", () => {
  // Gremlyn resolves review feedback on code, and code about authorization
  // routinely contains this word. A substring match over the stream would
  // report the wrong reason to the reviewer and tell the operator that every
  // later job is doomed.
  const stdout = [
    '{"ts":"2026-08-28T02:10:00.000Z","type":"agent_event","event":{"type":"tool_result",' +
      '"text":"  if (res.status === 401) throw new UnauthorizedError(\'Unauthorized\');"}}',
    '{"ts":"2026-08-28T02:10:05.000Z","type":"run_result","finishReason":"error",' +
      '"iterations":3,"text":"Type error in src/auth.ts: UnauthorizedError is not exported."}',
  ].join("\n");
  const reason = agentFailureReason({
    stdout,
    stderr: "tsc failed: 401 Unauthorized handler is untyped",
    exitCode: 2,
    startedAt: "2026-08-28T02:10:00.000Z",
    endedAt: "2026-08-28T02:10:05.000Z",
    timedOut: false,
  });
  assert.equal(reason, "agent-nonzero-exit");
});

test("an ordinary agent failure is not an auth failure", () => {
  const reason = agentFailureReason({
    stdout: '{"type":"run_result","finishReason":"error","text":"Validation failed."}',
    stderr: "",
    exitCode: 1,
    startedAt: "2026-08-28T02:10:00.000Z",
    endedAt: "2026-08-28T02:10:05.000Z",
    timedOut: false,
  });
  assert.equal(reason, "agent-nonzero-exit");
});
