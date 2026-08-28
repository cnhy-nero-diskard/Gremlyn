import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClineExecutor, AgentVersionError, type ProcessRunner } from "../src/agent/cline.js";
import { buildAgentEnvironment } from "../src/agent/environment.js";
import { writeAgentOutput } from "../src/agent/output.js";
import {
  buildResolutionPrompt,
  CONTEXT_END,
  CONTEXT_START,
  RESOLUTION_INSTRUCTIONS,
  RESOLUTION_PREAMBLE,
} from "../src/agent/prompt.js";
import { reconstructReviewContext } from "../src/context/review.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import type { AgentRunOptions } from "../src/types.js";

function fixture(): FixtureGitHubClient {
  return new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: 12,
        title: "Do not run $(malicious)",
        state: "open",
        merged: false,
        headBranch: "feature/review",
        headSha: "abc123",
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRepoOwner: "acme",
        baseRepoName: "widgets",
        htmlUrl: "https://example.test/acme/widgets/pull/12",
      },
    ],
    comments: [
      {
        id: 100,
        inReplyToId: null,
        path: "src/widget.ts",
        diffHunk: "@@ -1 +1 @@\n-old\n+new",
        body: "Please preserve the old contract.",
        authorLogin: "reviewer",
        createdAt: "2026-01-01T00:00:00.000Z",
        prNumber: 12,
      },
      {
        id: 101,
        inReplyToId: 100,
        path: "src/widget.ts",
        diffHunk: "@@ -1 +1 @@\n-old\n+new",
        body: "!RESOLVE\n`$(touch nope)` & echo bad",
        authorLogin: "developer",
        createdAt: "2026-01-01T00:01:00.000Z",
        prNumber: 12,
      },
    ],
  });
}

test("review context contains the ordered thread and anchored hunk without a full diff", async () => {
  const github = fixture();
  const context = await reconstructReviewContext(github, {
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    triggeringCommentId: 101,
  });

  assert.equal(context.filePath, "src/widget.ts");
  assert.equal(context.diffHunk, "@@ -1 +1 @@\n-old\n+new");
  assert.deepEqual(
    context.thread.map((comment) => comment.id),
    [100, 101],
  );
  assert.equal("fullDiff" in context, false);
});

test("prompt assembly is deterministic and confines GitHub text to the context region", async () => {
  const context = await reconstructReviewContext(fixture(), {
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    triggeringCommentId: 101,
    agentInstructions: "Use the repository test command.",
  });
  const first = buildResolutionPrompt(context);
  const second = buildResolutionPrompt(context);
  assert.equal(first, second);
  assert.equal(first.startsWith("-"), false);
  assert.ok(first.startsWith(RESOLUTION_PREAMBLE));
  assert.ok(first.endsWith(RESOLUTION_INSTRUCTIONS));
  const start = first.indexOf(CONTEXT_START);
  const end = first.indexOf(CONTEXT_END);
  const malicious = first.indexOf("$(touch nope)");
  assert.ok(start >= 0 && malicious > start && malicious < end);
  assert.ok(first.indexOf(context.prTitle) < end);
  assert.ok(first.indexOf("Use the repository test command.") > end);
});

function options(root: string, overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    cwd: join(root, "workspace"),
    model: "provider/model",
    provider: "provider",
    effort: "xhigh",
    prompt: `${CONTEXT_START}\nfix "this"; $(never-run) & echo nope`,
    env: { PATH: "test-path" },
    timeoutSec: 45,
    retries: 2,
    dataDir: join(root, "attempt-data"),
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("Cline executor passes prompt and controls as argv with no worktree flag", async () => {
  const calls: Parameters<ProcessRunner>[] = [];
  const runner: ProcessRunner = (binary, args, runOptions) => {
    calls.push([binary, args, runOptions]);
    return Promise.resolve({
      stdout: '{"sessionId":"session-7"}',
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isCanceled: false,
    });
  };
  const root = mkdtempSync(join(tmpdir(), "gremlyn-cline-"));
  const opts = options(root);
  const result = await new ClineExecutor("cline-test", runner).run(opts);

  assert.equal(calls.length, 1);
  const [binary, args, runOptions] = calls[0]!;
  assert.equal(binary, "cline-test");
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), opts.prompt);
  assert.equal(args[args.indexOf("-c") + 1], opts.cwd);
  assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
  assert.equal(args[args.indexOf("--data-dir") + 1], opts.dataDir);
  assert.equal(args[args.indexOf("--retries") + 1], "2");
  assert.equal(args.includes("--worktree"), false);
  assert.equal(runOptions.cwd, opts.cwd);
  assert.equal(result.sessionId, "session-7");
});

test("Cline receives an absolute data dir when its cwd differs from Gremlyn's", async () => {
  let passedDataDir: string | undefined;
  const runner: ProcessRunner = (_binary, args) => {
    passedDataDir = args[args.indexOf("--data-dir") + 1];
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isCanceled: false,
    });
  };
  const relativeDataDir = join(".gremlyn", "attempts", "7");
  await new ClineExecutor("cline-test", runner).run(
    options(mkdtempSync(join(tmpdir(), "gremlyn-cline-")), { dataDir: relativeDataDir }),
  );
  assert.equal(passedDataDir, resolve(relativeDataDir));
});

test("attempt data directories remain distinct across concurrent invocations", async () => {
  const dataDirs: string[] = [];
  const runner: ProcessRunner = (_binary, args) => {
    dataDirs.push(args[args.indexOf("--data-dir") + 1]!);
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isCanceled: false,
    });
  };
  const root = mkdtempSync(join(tmpdir(), "gremlyn-cline-"));
  const executor = new ClineExecutor("cline", runner);
  await Promise.all([
    executor.run(options(root, { dataDir: join(root, "attempt-1") })),
    executor.run(options(root, { dataDir: join(root, "attempt-2") })),
  ]);
  assert.deepEqual(new Set(dataDirs), new Set([join(root, "attempt-1"), join(root, "attempt-2")]));
});

test("agent environment is allowlist-built and excludes the GitHub token", () => {
  const env = buildAgentEnvironment({
    PATH: "safe",
    TEMP: "temp",
    GREMLYN_GITHUB_TOKEN: "top-secret",
    UNRELATED_SECRET: "also-secret",
  });
  assert.deepEqual(env, { PATH: "safe", TEMP: "temp" });
});

test("timeout, cancellation, and non-zero output remain observable", async () => {
  const root = mkdtempSync(join(tmpdir(), "gremlyn-cline-"));
  const controller = new AbortController();
  const runner: ProcessRunner = (_binary, _args, runOptions) => {
    assert.equal(runOptions.signal, controller.signal);
    assert.equal(runOptions.timeoutMs, 45_000);
    return Promise.resolve({
      stdout: "partial output",
      stderr: "agent failed",
      exitCode: 9,
      timedOut: true,
      isCanceled: true,
    });
  };
  const result = await new ClineExecutor("cline", runner).run(
    options(root, { signal: controller.signal }),
  );
  assert.equal(result.exitCode, 9);
  assert.equal(result.timedOut, true);

  const outputRef = writeAgentOutput(root, 77, result);
  const retained = JSON.parse(readFileSync(outputRef, "utf8")) as Record<string, unknown>;
  assert.equal(retained.stdout, "partial output");
  assert.equal(retained.stderr, "agent failed");
  assert.equal(retained.exitCode, 9);
  assert.equal(retained.timedOut, true);
});

test("Cline version mismatch fails as a startup configuration error", async () => {
  const runner: ProcessRunner = () =>
    Promise.resolve({
      stdout: "cline 4.0.0",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isCanceled: false,
    });
  const executor = new ClineExecutor("cline", runner);
  await assert.rejects(() => executor.checkVersion("3.0.60", {}), AgentVersionError);
});
