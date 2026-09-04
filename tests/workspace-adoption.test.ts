import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  prepareWorkspace,
  adoptionClaimPath,
  readAdoptionClaim,
  type WorkspaceFailureReason,
} from "../src/workspace/worktree.js";
import { currentBranch, git, headSha, statusEntries } from "../src/workspace/gitops.js";
import { createTempRepo, pushCommit, remoteSha, type TempRepo } from "./helpers/gitrepo.js";

interface RecordedAction {
  action: string;
  target: string;
  effect?: string;
  detail?: Record<string, unknown>;
}

function actions(): { rows: RecordedAction[]; record: (row: RecordedAction) => number } {
  const rows: RecordedAction[] = [];
  return { rows, record: (row) => (rows.push(row), rows.length) };
}

async function foreignHolder(repo: TempRepo, name: string): Promise<string> {
  const path = join(repo.root, name);
  await git(["worktree", "add", path, repo.headBranch], { cwd: repo.sourcePath });
  return path;
}

async function gitDir(path: string): Promise<string> {
  const reported = (await git(["rev-parse", "--git-dir"], { cwd: path })).stdout.trim();
  return resolve(path, reported);
}

function baseOptions(repo: TempRepo, holder: string, prNumber: number, headSha: string) {
  const audit = actions();
  return {
    options: {
      sourcePath: repo.sourcePath,
      workspaceRoot: repo.workspaceRoot,
      prNumber,
      headBranch: repo.headBranch,
      headSha,
      adoptExistingCheckout: true,
      attemptId: prNumber,
      actions: audit,
    },
    audit,
    holder,
  };
}

test("adoption claims a clean foreign checkout and leaves its tree clean", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "operator-checkout");
  const fixture = baseOptions(repo, holder, 101, expectedSha);

  const prepared = await prepareWorkspace(fixture.options);
  try {
    assert.equal(
      resolve(prepared.path).replaceAll("/", "\\").toLowerCase(),
      resolve(holder).replaceAll("/", "\\").toLowerCase(),
    );
    assert.equal(prepared.adopted, true);
    assert.equal(prepared.created, false);
    assert.equal(await currentBranch(holder), repo.headBranch);
    assert.equal(await headSha(holder), expectedSha);
    assert.deepEqual(await statusEntries(holder), []);
    assert.ok(prepared.adoptionClaim);
    const claim = readAdoptionClaim(prepared.adoptionClaim!.path);
    assert.deepEqual(claim, {
      attemptId: 101,
      pid: process.pid,
      claimedAt: prepared.adoptionClaim!.claimedAt,
    });
    assert.equal(
      resolve(prepared.adoptionClaim!.path).replaceAll("/", "\\").toLowerCase(),
      resolve(adoptionClaimPath(await gitDir(holder)))
        .replaceAll("/", "\\")
        .toLowerCase(),
    );
    assert.equal(fixture.audit.rows.at(-1)?.effect, "adopted");
  } finally {
    prepared.adoptionClaim?.release();
  }
  assert.equal(existsSync(adoptionClaimPath(await gitDir(holder))), false);
  assert.deepEqual(await statusEntries(holder), []);
});

test("a dirty foreign checkout is never resumed and falls back to an untouched clone", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "dirty-checkout");
  const marker = join(holder, "operator-progress.txt");
  writeFileSync(marker, "do not resume\n", "utf8");
  const before = await statusEntries(holder);
  const fixture = baseOptions(repo, holder, 102, expectedSha);

  const prepared = await prepareWorkspace({
    ...fixture.options,
    resumeDirtyWorkspace: true,
  });

  assert.equal(prepared.adopted, false);
  assert.notEqual(resolve(prepared.path), resolve(holder));
  assert.equal(readFileSync(marker, "utf8"), "do not resume\n");
  assert.deepEqual(await statusEntries(holder), before);
  assert.equal(existsSync(join(prepared.path, "operator-progress.txt")), false);
  assert.ok(
    fixture.audit.rows.some((row) => row.effect === "refused" && row.detail?.reason === "dirty"),
  );
});

test("a non-fast-forwardable foreign checkout stays untouched and falls back to a clone", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "diverged-checkout");
  writeFileSync(join(holder, "local-only.txt"), "local\n", "utf8");
  await git(["add", "local-only.txt"], { cwd: holder });
  await git(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "local-only"],
    { cwd: holder },
  );
  const localHead = await headSha(holder);
  const fixture = baseOptions(repo, holder, 103, expectedSha);

  const prepared = await prepareWorkspace(fixture.options);

  assert.equal(prepared.adopted, false);
  assert.notEqual(resolve(prepared.path), resolve(holder));
  assert.equal(await headSha(holder), localHead);
  assert.deepEqual(await statusEntries(holder), []);
  assert.ok(fixture.audit.rows.some((row) => row.detail?.reason === "not-fast-forwardable"));
});

test("a foreign checkout in a merge state is cloned without changing its conflict", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "merge-checkout");
  await git(["checkout", "-b", "merge-side"], { cwd: holder });
  writeFileSync(join(holder, "feature.txt"), "side\n", "utf8");
  await git(["add", "feature.txt"], { cwd: holder });
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "side"], {
    cwd: holder,
  });
  await git(["checkout", repo.headBranch], { cwd: holder });
  writeFileSync(join(holder, "feature.txt"), "local\n", "utf8");
  await git(["add", "feature.txt"], { cwd: holder });
  await git(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "local"],
    { cwd: holder },
  );
  await git(["merge", "merge-side"], { cwd: holder }).catch(() => undefined);
  const conflictContents = readFileSync(join(holder, "feature.txt"), "utf8");
  const fixture = baseOptions(repo, holder, 104, expectedSha);

  const prepared = await prepareWorkspace(fixture.options);

  assert.equal(prepared.adopted, false);
  assert.notEqual(resolve(prepared.path), resolve(holder));
  assert.equal(readFileSync(join(holder, "feature.txt"), "utf8"), conflictContents);
  assert.ok(fixture.audit.rows.some((row) => row.detail?.reason === "unmerged-entries"));
});

test("a live adoption claim forces the second attempt into an independent clone", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "claimed-checkout");
  const first = baseOptions(repo, holder, 105, expectedSha);
  const second = baseOptions(repo, holder, 106, expectedSha);
  const prepared = await prepareWorkspace(first.options);
  try {
    const fallback = await prepareWorkspace(second.options);
    assert.equal(prepared.adopted, true);
    assert.equal(fallback.adopted, false);
    assert.notEqual(resolve(fallback.path), resolve(holder));
    assert.equal(await currentBranch(holder), repo.headBranch);
    assert.deepEqual(await statusEntries(holder), []);
    assert.ok(second.audit.rows.some((row) => row.detail?.reason === "adoption-claimed"));
  } finally {
    prepared.adoptionClaim?.release();
  }
});

test("a dead adoption claim is reclaimed before adoption", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "stale-claim-checkout");
  const claimPath = adoptionClaimPath(await gitDir(holder));
  writeFileSync(
    claimPath,
    JSON.stringify({ attemptId: 999, pid: 99_999_999, claimedAt: "2020-01-01T00:00:00.000Z" }),
    "utf8",
  );
  const fixture = baseOptions(repo, holder, 107, expectedSha);

  const prepared = await prepareWorkspace(fixture.options);
  try {
    assert.equal(prepared.adopted, true);
    assert.equal(readAdoptionClaim(claimPath)?.attemptId, 107);
  } finally {
    prepared.adoptionClaim?.release();
  }
});

test("adoption fast-forwards a clean foreign checkout to the recorded head", async () => {
  const repo = await createTempRepo();
  const oldSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "behind-checkout");
  const expectedSha = await pushCommit(
    repo.sourcePath,
    repo.headBranch,
    "new-head.txt",
    "new head\n",
    "advance head",
  );
  assert.equal(await headSha(holder), oldSha);
  const fixture = baseOptions(repo, holder, 108, expectedSha);

  const prepared = await prepareWorkspace(fixture.options);
  try {
    assert.equal(prepared.adopted, true);
    assert.equal(await headSha(holder), expectedSha);
    assert.equal(await currentBranch(holder), repo.headBranch);
    assert.deepEqual(await statusEntries(holder), []);
  } finally {
    prepared.adoptionClaim?.release();
  }
});

test("an adoption claim is released when preparation fails after admission", async () => {
  const repo = await createTempRepo();
  const expectedSha = await remoteSha(repo.remotePath, repo.headBranch);
  const holder = await foreignHolder(repo, "failed-adoption-checkout");
  const fixture = baseOptions(repo, holder, 109, expectedSha);
  const claimPath = adoptionClaimPath(await gitDir(holder));

  await assert.rejects(
    prepareWorkspace({ ...fixture.options, seedFiles: ["feature.txt"] }),
    (error: unknown) => {
      assert.equal((error as { reason?: WorkspaceFailureReason }).reason, "workspace-seed-failed");
      return true;
    },
  );
  assert.equal(existsSync(claimPath), false);
  assert.equal(await currentBranch(holder), repo.headBranch);
});
