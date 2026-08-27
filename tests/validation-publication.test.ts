import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import {
  buildOutcomeReply,
  reportAttemptOutcome,
  type ReportOutcome,
} from "../src/publish/report.js";
import {
  publicationBlockReason,
  publishIfEligible,
  resolutionCommitMessage,
  type PublicationFacts,
} from "../src/publish/policy.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { inspectWorkspace } from "../src/validate/inspection.js";
import { runValidationCommands, type ValidationProcessRunner } from "../src/validate/runner.js";
import { currentBranch, git } from "../src/workspace/gitops.js";
import { prepareWorkspace } from "../src/workspace/worktree.js";
import { createTempRepo, remoteSha } from "./helpers/gitrepo.js";

const AUTHOR = { name: "Gremlyn", email: "gremlyn@localhost" };

function createAttempt(): { store: Store; jobs: JobStore; attemptId: number } {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const repo = store.db
    .prepare(
      `INSERT INTO repositories
         (owner, name, source_path, workspace_root, agent, model, provider, effort)
       VALUES ('acme', 'widgets', 'source', 'workspaces', 'fake', 'model', 'provider', 'xhigh')`,
    )
    .run();
  const jobs = new JobStore(store.db);
  const created = jobs.createJob({
    repoId: Number(repo.lastInsertRowid),
    prNumber: 1,
    commentId: 10,
    command: "RESOLVE",
    threadId: "9",
    authorLogin: "developer",
    observedAt: new Date().toISOString(),
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("job not created");
  const attempt = jobs.createAttempt({
    jobId: created.jobId,
    agent: "fake",
    model: "model",
    provider: "provider",
    effort: "xhigh",
  });
  return { store, jobs, attemptId: attempt.attemptId };
}

test("validation commands run in argv order and persist separate outcomes", async () => {
  const { store, attemptId } = createAttempt();
  const calls: string[] = [];
  const runner: ValidationProcessRunner = (executable, args, options) => {
    assert.equal(options.shell, false);
    calls.push([executable, ...args].join(" "));
    return Promise.resolve({
      stdout: `out-${calls.length}`,
      stderr: "",
      exitCode: 0,
    });
  };
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-validation-"));
  const outcome = await runValidationCommands({
    commands: [
      ["npm", "run", "build"],
      ["npm", "test"],
    ],
    cwd: dataDir,
    dataDir,
    attemptId,
    db: store.db,
    runner,
  });

  assert.deepEqual(calls, ["npm run build", "npm test"]);
  assert.equal(outcome.succeeded, true);
  assert.deepEqual(
    outcome.runs.map((run) => run.seq),
    [1, 2],
  );
  const rows = store.db
    .prepare("SELECT seq, exit_code, output_ref FROM validation_runs ORDER BY seq")
    .all() as { seq: number; exit_code: number; output_ref: string }[];
  assert.equal(rows.length, 2);
  assert.match(readFileSync(rows[0]!.output_ref, "utf8"), /out-1/);
  store.close();
});

test("empty validation configuration performs no fallback command", async () => {
  let invoked = false;
  const outcome = await runValidationCommands({
    commands: [],
    cwd: ".",
    dataDir: ".",
    attemptId: 1,
    runner: () => {
      invoked = true;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    },
  });
  assert.deepEqual(outcome, { configured: false, succeeded: true, runs: [] });
  assert.equal(invoked, false);
});

test("independent inspection blocks wrong branches and conflicted states", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 62,
    headBranch: repo.headBranch,
    headSha: sha,
  });

  assert.equal((await inspectWorkspace(prepared.path, "other-branch")).reason, "wrong-branch");
  writeFileSync(
    join(prepared.path, "conflicted.txt"),
    "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n",
  );
  await git(["add", "conflicted.txt"], { cwd: prepared.path });
  assert.equal(
    (await inspectWorkspace(prepared.path, repo.headBranch)).reason,
    "workspace-conflicted",
  );
});

function passingFacts(): PublicationFacts {
  return {
    agent: { exitCode: 0, timedOut: false },
    inspection: { ok: true, modified: true, branch: "feature" },
    validation: { succeeded: true },
    expectedHeadSha: "head",
    currentHeadSha: "head",
    prOpen: true,
  };
}

test("each publication precondition fails independently with a specific reason", () => {
  const cases: [string, PublicationFacts][] = [
    ["agent-nonzero-exit", { ...passingFacts(), agent: { exitCode: 2, timedOut: false } }],
    [
      "no-changes",
      { ...passingFacts(), inspection: { ok: true, modified: false, branch: "feature" } },
    ],
    [
      "wrong-branch",
      {
        ...passingFacts(),
        inspection: { ok: false, modified: true, branch: "wrong", reason: "wrong-branch" },
      },
    ],
    ["validation-failed", { ...passingFacts(), validation: { succeeded: false } }],
    ["head-changed", { ...passingFacts(), currentHeadSha: "new-head" }],
    ["pull-request-closed", { ...passingFacts(), prOpen: false }],
  ];
  for (const [expected, facts] of cases) {
    assert.equal(publicationBlockReason(facts), expected);
  }
});

test("a successful agent with no changes publishes nothing", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 63,
    headBranch: repo.headBranch,
    headSha: sha,
  });
  const before = await remoteSha(repo.remotePath, repo.headBranch);
  const result = await publishIfEligible({
    facts: {
      ...passingFacts(),
      inspection: { ok: true, modified: false, branch: repo.headBranch },
      expectedHeadSha: sha,
      currentHeadSha: sha,
    },
    workspacePath: prepared.path,
    headBranch: repo.headBranch,
    commentId: 77,
    author: AUTHOR,
  });
  assert.deepEqual(result, { kind: "blocked", reason: "no-changes" });
  assert.equal(await remoteSha(repo.remotePath, repo.headBranch), before);
});

test("eligible work gets an attributable deterministic commit recorded by the caller", async () => {
  const repo = await createTempRepo();
  const sha = await remoteSha(repo.remotePath, repo.headBranch);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 64,
    headBranch: repo.headBranch,
    headSha: sha,
  });
  writeFileSync(join(prepared.path, "resolution.txt"), "fixed\n");
  const result = await publishIfEligible({
    facts: {
      ...passingFacts(),
      inspection: { ok: true, modified: true, branch: repo.headBranch },
      expectedHeadSha: sha,
      currentHeadSha: sha,
    },
    workspacePath: prepared.path,
    headBranch: repo.headBranch,
    commentId: 808,
    author: AUTHOR,
  });
  assert.equal(result.kind, "published");
  assert.equal(await remoteSha(repo.remotePath, repo.headBranch), result.commitSha);
  const message = (await git(["log", "-1", "--pretty=%s"], { cwd: prepared.path })).stdout;
  assert.equal(message, resolutionCommitMessage(808));
  assert.equal(await currentBranch(prepared.path), repo.headBranch);
});

test("outcome replies distinguish success, failure, and decline without transcripts or secrets", () => {
  const outcomes: ReportOutcome[] = [
    {
      kind: "success",
      commitSha: "abc123",
      summary: "Updated the parser",
      validationSummary: "tests passed",
    },
    { kind: "failure", stage: "validating", reason: "tests failed" },
    { kind: "declined", reason: "feedback is obsolete", jobId: 99 },
  ];
  const replies = outcomes.map((outcome) =>
    buildOutcomeReply(outcome, (value) => value.replaceAll("secret", "[redacted]")),
  );
  assert.match(replies[0]!, /abc123.*Updated the parser.*tests passed/);
  assert.match(replies[1]!, /validating.*tests failed.*No changes were pushed/);
  assert.match(replies[2]!, /declined.*feedback is obsolete.*job 99/);
  assert.equal(
    replies.some((reply) => /stdout|stderr|transcript/u.test(reply)),
    false,
  );
  assert.equal(
    buildOutcomeReply({ kind: "failure", stage: "agent", reason: "secret" }, (value) =>
      value.replaceAll("secret", "[redacted]"),
    ).includes("secret"),
    false,
  );
});

test("report failure remains separate after a successful push and thread state is untouched", async () => {
  class FailingReplyClient extends FixtureGitHubClient {
    override postReviewReply(): Promise<number> {
      return Promise.reject(new Error("GitHub unavailable"));
    }
  }
  const { store, jobs, attemptId } = createAttempt();
  jobs.recordPublication(attemptId, "commit-123");
  const github = new FailingReplyClient({ login: "gremlyn-bot" });
  const report = await reportAttemptOutcome({
    github,
    jobs,
    attemptId,
    owner: "acme",
    repo: "widgets",
    prNumber: 1,
    commentId: 10,
    outcome: {
      kind: "success",
      commitSha: "commit-123",
      summary: "Fixed it",
      validationSummary: "passed",
    },
  });
  assert.equal(report.posted, false);
  const attempt = jobs.getAttempt(attemptId);
  assert.equal(attempt.commit_sha, "commit-123");
  assert.equal(attempt.pushed, 1);
  assert.equal(attempt.report_status, "failed");
  assert.equal(github.replies.length, 0);
  store.close();
});
