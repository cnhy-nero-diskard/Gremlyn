import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeExecutor } from "../src/agent/fake.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import {
  runWalkingSkeleton,
  type WalkingSkeletonRepository,
} from "../src/orchestrator/walking-skeleton.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import type { AgentExecutor, NormalizedEvent } from "../src/types.js";
import { currentBranch, git, statusEntries } from "../src/workspace/gitops.js";
import { reclaimWorkspaces, listReclamationCandidates } from "../src/workspace/reclamation.js";
import { resetWorkspace } from "../src/workspace/reset.js";
import { prepareWorkspace, WorkspaceError, workspacePathFor } from "../src/workspace/worktree.js";
import { createTempRepo, pushCommit, remoteSha, type TempRepo } from "./helpers/gitrepo.js";

test("reclamation candidates include only derived PR directories inside the root", async () => {
  const repo = await createTempRepo();
  mkdirSync(join(repo.workspaceRoot, "pr-42"), { recursive: true });
  mkdirSync(join(repo.workspaceRoot, "operator-checkout"), { recursive: true });
  mkdirSync(join(repo.root, "pr-43"), { recursive: true });
  const candidates = await listReclamationCandidates([
    { id: 1, sourcePath: repo.sourcePath, workspaceRoot: repo.workspaceRoot },
  ]);
  assert.deepEqual(candidates, [
    { repositoryId: 1, prNumber: 42, path: workspacePathFor(repo.workspaceRoot, 42) },
  ]);
});

test("reclamation removes an old clean linked worktree and audits the outcome", async () => {
  const repo = await createTempRepo();
  const fixture = await makeFixture(repo, 41, 4100);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 41,
    headBranch: repo.headBranch,
    headSha: fixture.originalHead,
  });
  const now = Date.now();
  ageWorkspace(prepared.path, now, 10_000);
  const report = await reclaimWorkspaces({
    db: fixture.store.db,
    repositories: reclamationRepository(fixture),
    minimumAgeMs: 1_000,
    now,
    actions: new OperatorActionStore(fixture.store.db),
  });
  assert.equal(report.reclaimed, 1);
  assert.equal(existsSync(prepared.path), false);
  assert.equal(
    (await git(["worktree", "list", "--porcelain"], { cwd: repo.sourcePath })).stdout.includes(
      prepared.path,
    ),
    false,
  );
  const audit = new OperatorActionStore(fixture.store.db).list(1)[0];
  assert.deepEqual(
    { action: audit?.action, target: audit?.target, effect: audit?.effect },
    { action: "workspace-reclamation", target: prepared.path, effect: "reclaimed" },
  );
  fixture.store.close();
});

test("reclamation removes an old clean standalone fallback clone", async () => {
  const repo = await createTempRepo();
  await git(["checkout", repo.headBranch], { cwd: repo.sourcePath });
  const fixture = await makeFixture(repo, 42, 4200);
  const sourceBranch = await currentBranch(repo.sourcePath);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 42,
    headBranch: repo.headBranch,
    headSha: fixture.originalHead,
  });
  const now = Date.now();
  ageWorkspace(prepared.path, now, 10_000);
  const report = await reclaimWorkspaces({
    db: fixture.store.db,
    repositories: reclamationRepository(fixture),
    minimumAgeMs: 1_000,
    now,
    actions: new OperatorActionStore(fixture.store.db),
  });
  assert.equal(report.reclaimed, 1);
  assert.equal(existsSync(prepared.path), false);
  assert.equal(await currentBranch(repo.sourcePath), sourceBranch);
  fixture.store.close();
});

test("reclamation retains a dirty workspace byte-for-byte and reports the refusal", async () => {
  const repo = await createTempRepo();
  const fixture = await makeFixture(repo, 43, 4300);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 43,
    headBranch: repo.headBranch,
    headSha: fixture.originalHead,
  });
  const dirtyPath = join(prepared.path, "operator-notes.txt");
  writeFileSync(dirtyPath, "keep this work\n", "utf8");
  const before = readFileSync(dirtyPath, "utf8");
  const now = Date.now();
  ageWorkspace(prepared.path, now, 10_000);
  const report = await reclaimWorkspaces({
    db: fixture.store.db,
    repositories: reclamationRepository(fixture),
    minimumAgeMs: 1_000,
    now,
    actions: new OperatorActionStore(fixture.store.db),
  });
  assert.equal(report.reclaimed, 0);
  assert.equal(report.retained, 1);
  assert.equal(readFileSync(dirtyPath, "utf8"), before);
  assert.ok(
    (await statusEntries(prepared.path)).some((entry) => entry.includes("operator-notes.txt")),
  );
  assert.match(report.decisions[0]?.reason ?? "", /uncommitted or untracked/u);
  fixture.store.close();
});

test("reclamation retains active, recent, and indeterminate workspaces", async () => {
  const repo = await createTempRepo();
  const fixture = await makeFixture(repo, 44, 4400);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 44,
    headBranch: repo.headBranch,
    headSha: fixture.originalHead,
  });
  fixture.store.db
    .prepare(
      "INSERT INTO jobs (repo_id, pr_number, comment_id, command, status, created_at) VALUES (?, 44, 4401, 'RESOLVE', 'running', ?)",
    )
    .run(fixture.options.repository.id, new Date().toISOString());
  const recentPath = workspacePathFor(repo.workspaceRoot, 45);
  mkdirSync(recentPath, { recursive: true });
  const unknownPath = workspacePathFor(repo.workspaceRoot, 46);
  mkdirSync(unknownPath, { recursive: true });
  const now = Date.now();
  ageWorkspace(prepared.path, now, 10_000);
  ageWorkspace(unknownPath, now, 10_000);
  const report = await reclaimWorkspaces({
    db: fixture.store.db,
    repositories: reclamationRepository(fixture),
    minimumAgeMs: 1_000,
    now,
    actions: new OperatorActionStore(fixture.store.db),
  });
  assert.equal(report.reclaimed, 0);
  assert.equal(report.retained, 3);
  assert.match(
    report.decisions.find((decision) => decision.prNumber === 44)?.reason ?? "",
    /active/u,
  );
  assert.match(
    report.decisions.find((decision) => decision.prNumber === 45)?.reason ?? "",
    /newer/u,
  );
  assert.match(
    report.decisions.find((decision) => decision.prNumber === 46)?.reason ?? "",
    /cleanliness/u,
  );
  assert.equal(existsSync(prepared.path), true);
  assert.equal(existsSync(recentPath), true);
  assert.equal(existsSync(unknownPath), true);
  fixture.store.close();
});

test("reclamation preview reports eligible and retained workspaces without removal", async () => {
  const repo = await createTempRepo();
  const fixture = await makeFixture(repo, 47, 4700);
  const prepared = await prepareWorkspace({
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    prNumber: 47,
    headBranch: repo.headBranch,
    headSha: fixture.originalHead,
  });
  const retainedPath = workspacePathFor(repo.workspaceRoot, 48);
  mkdirSync(retainedPath, { recursive: true });
  const now = Date.now();
  ageWorkspace(prepared.path, now, 10_000);
  const report = await reclaimWorkspaces({
    db: fixture.store.db,
    repositories: reclamationRepository(fixture),
    minimumAgeMs: 1_000,
    now,
    preview: true,
    actions: new OperatorActionStore(fixture.store.db),
  });
  assert.equal(report.decisions.find((decision) => decision.prNumber === 47)?.outcome, "preview");
  assert.equal(report.decisions.find((decision) => decision.prNumber === 48)?.outcome, "retained");
  assert.equal(existsSync(prepared.path), true);
  assert.equal(existsSync(retainedPath), true);
  fixture.store.close();
});

test("reset refuses an adopted checkout and reclamation never lists it", async () => {
  const repo = await createTempRepo();
  const fixture = await makeFixture(repo, 114, 11400);
  const adopted = join(repo.root, "adopted-operator-checkout");
  await git(["worktree", "add", adopted, repo.headBranch], { cwd: repo.sourcePath });
  const actions = new OperatorActionStore(fixture.store.db);

  try {
    await assert.rejects(
      resetWorkspace({
        sourcePath: repo.sourcePath,
        workspaceRoot: repo.workspaceRoot,
        prNumber: 114,
        headBranch: repo.headBranch,
        headSha: fixture.originalHead,
        targetPath: adopted,
        actions,
      }),
      (error: unknown) =>
        error instanceof WorkspaceError && error.reason === "workspace-outside-root",
    );
    assert.equal(existsSync(adopted), true);
    assert.deepEqual(await listReclamationCandidates(reclamationRepository(fixture)), []);
    const audit = actions.list(1)[0];
    assert.deepEqual(
      { action: audit?.action, target: audit?.target, effect: audit?.effect },
      { action: "workspace-reset", target: adopted, effect: "refused" },
    );
  } finally {
    fixture.store.close();
  }
});

test("a full job leaves the dirty source checkout tree, index, and branch unchanged", async () => {
  const repo = await createTempRepo();
  writeFileSync(join(repo.sourcePath, "staged.txt"), "staged\n", "utf8");
  await git(["add", "staged.txt"], { cwd: repo.sourcePath });
  writeFileSync(join(repo.sourcePath, "README.md"), "dirty source\n", "utf8");
  const before = await sourceState(repo.sourcePath);
  const fixture = await makeFixture(repo, 21, 2100);

  try {
    const result = await runWalkingSkeleton({
      ...fixture.options,
      executor: new FakeExecutor({
        outcome: "success",
        edits: { "resolution.txt": "resolved\n" },
      }),
    });
    assert.equal(result.kind, "succeeded");
    assert.deepEqual(await sourceState(repo.sourcePath), before);
  } finally {
    fixture.store.close();
  }
});

test("a full job adapts when the source checkout already holds the PR branch", async () => {
  const repo = await createTempRepo();
  await git(["checkout", repo.headBranch], { cwd: repo.sourcePath });
  writeFileSync(join(repo.sourcePath, "developer-notes.txt"), "keep in source\n", "utf8");
  const before = {
    branch: await currentBranch(repo.sourcePath),
    status: await statusEntries(repo.sourcePath),
  };
  const fixture = await makeFixture(repo, 93, 9300);

  try {
    const result = await runWalkingSkeleton({
      ...fixture.options,
      executor: new FakeExecutor({
        outcome: "success",
        edits: { "resolution.txt": "resolved from source checkout\n" },
      }),
    });
    assert.equal(result.kind, "succeeded");
    assert.deepEqual(
      {
        branch: await currentBranch(repo.sourcePath),
        status: await statusEntries(repo.sourcePath),
      },
      before,
    );
    assert.equal(
      readFileSync(join(workspacePathFor(repo.workspaceRoot, 93), "resolution.txt"), "utf8"),
      "resolved from source checkout\n",
    );
  } finally {
    fixture.store.close();
  }
});

test("a head move during execution blocks publication and retains agent work", async () => {
  const repo = await createTempRepo();
  const fixture = await makeFixture(repo, 22, 2200);
  const fake = new FakeExecutor({
    outcome: "success",
    edits: { "resolution.txt": "retain this work\n" },
  });
  let movedHead = "";
  const racingExecutor: AgentExecutor = {
    id: "racing-fake",
    async run(options) {
      const result = await fake.run(options);
      movedHead = await pushCommit(
        repo.sourcePath,
        repo.headBranch,
        "concurrent.txt",
        "remote update\n",
        "concurrent update",
      );
      return result;
    },
  };

  try {
    await assert.rejects(
      runWalkingSkeleton({ ...fixture.options, executor: racingExecutor }),
      (err: unknown) => err instanceof WorkspaceError && err.reason === "head-changed",
    );
    assert.equal(await remoteSha(repo.remotePath, repo.headBranch), movedHead);
    const workspace = workspacePathFor(repo.workspaceRoot, 22);
    assert.equal(readFileSync(join(workspace, "resolution.txt"), "utf8"), "retain this work\n");
    assert.ok((await statusEntries(workspace)).some((entry) => entry.includes("resolution.txt")));
    assert.deepEqual(fixture.github.replies, []);

    const attempt = fixture.store.db
      .prepare(
        `SELECT head_sha_at_prepare, failure_stage, failure_reason, commit_sha, pushed
         FROM attempts`,
      )
      .get() as {
      head_sha_at_prepare: string;
      failure_stage: string;
      failure_reason: string;
      commit_sha: string | null;
      pushed: number;
    };
    assert.equal(attempt.head_sha_at_prepare, fixture.originalHead);
    assert.equal(attempt.failure_stage, "publishing");
    assert.equal(attempt.failure_reason, "head-changed");
    assert.equal(attempt.commit_sha, null);
    assert.equal(attempt.pushed, 0);
  } finally {
    fixture.store.close();
  }
});

async function makeFixture(repo: TempRepo, prNumber: number, commentId: number) {
  const originalHead = await remoteSha(repo.remotePath, repo.headBranch);
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const repositoryId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, provider,
            effort, validation_commands, allowed_models)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "someuser",
        "repo",
        repo.sourcePath,
        repo.workspaceRoot,
        "fake",
        "fixture-model",
        "fixture-provider",
        "xhigh",
        "[]",
        '["fixture-model"]',
      ).lastInsertRowid,
  );
  const repository: WalkingSkeletonRepository = {
    id: repositoryId,
    sourcePath: repo.sourcePath,
    workspaceRoot: repo.workspaceRoot,
    agent: "fake",
    model: "fixture-model",
    provider: "fixture-provider",
    effort: "xhigh",
  };
  const event: NormalizedEvent = {
    owner: "someuser",
    repo: "repo",
    kind: "review-comment",
    commentId,
    authorLogin: "someuser",
    body: "!RESOLVE",
    prNumber,
    observedAt: "2026-01-01T10:10:00Z",
  };
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: prNumber,
        title: "Resolve review feedback",
        state: "open",
        merged: false,
        headBranch: repo.headBranch,
        headSha: originalHead,
        headRepoOwner: "someuser",
        headRepoName: "repo",
        baseRepoOwner: "someuser",
        baseRepoName: "repo",
        htmlUrl: `https://github.test/someuser/repo/pull/${prNumber}`,
      },
    ],
  });
  return {
    store,
    github,
    originalHead,
    options: {
      event,
      command: "RESOLVE",
      threadId: String(commentId),
      repository,
      db: store.db,
      github,
      dataDir: join(repo.root, "data"),
      commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    },
  };
}

async function sourceState(sourcePath: string) {
  return {
    branch: await currentBranch(sourcePath),
    status: (await git(["status", "--porcelain=v1"], { cwd: sourcePath })).stdout,
    index: (await git(["diff", "--cached"], { cwd: sourcePath })).stdout,
    readme: readFileSync(join(sourcePath, "README.md"), "utf8"),
    staged: readFileSync(join(sourcePath, "staged.txt"), "utf8"),
  };
}

function reclamationRepository(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  const repository = fixture.options.repository;
  return [
    {
      id: repository.id,
      sourcePath: repository.sourcePath,
      workspaceRoot: repository.workspaceRoot,
    },
  ];
}

function ageWorkspace(path: string, now: number, ageMs: number): void {
  const seconds = (now - ageMs) / 1_000;
  utimesSync(path, seconds, seconds);
}
