import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { buildThread } from "../src/github/octokit.js";
import { isForkPullRequest, type PullRequestInfo } from "../src/github/client.js";
import { mapPullRequest, mapReviewComment } from "../src/github/mappers.js";

const PR: PullRequestInfo = {
  number: 42,
  title: "Add feature",
  state: "open",
  merged: false,
  headBranch: "feature-branch",
  headSha: "abc123",
  headRepoOwner: "someuser",
  headRepoName: "repo",
  baseRepoOwner: "someuser",
  baseRepoName: "repo",
  htmlUrl: "https://github.com/someuser/repo/pull/42",
};

const THREAD_COMMENTS = [
  {
    id: 100,
    inReplyToId: null,
    path: "src/foo.ts",
    diffHunk: "@@ -1,3 +1,3 @@",
    body: "This looks wrong.",
    authorLogin: "reviewer",
    createdAt: "2026-01-01T10:00:00Z",
    prNumber: 42,
  },
  {
    id: 101,
    inReplyToId: 100,
    path: "src/foo.ts",
    diffHunk: "@@ -1,3 +1,3 @@",
    body: "Agreed, please fix.",
    authorLogin: "someuser",
    createdAt: "2026-01-01T10:05:00Z",
    prNumber: 42,
  },
  {
    id: 102,
    inReplyToId: 100,
    path: "src/foo.ts",
    diffHunk: "@@ -1,3 +1,3 @@",
    body: "!RESOLVE",
    authorLogin: "someuser",
    createdAt: "2026-01-01T10:10:00Z",
    prNumber: 42,
  },
];

test("fetch PR returns the recorded fixture", async () => {
  const client = new FixtureGitHubClient({ login: "gremlyn-bot", prs: [PR] });
  const pr = await client.getPullRequest("someuser", "repo", 42);
  assert.equal(pr.number, 42);
  assert.equal(pr.headBranch, "feature-branch");
  assert.equal(pr.headSha, "abc123");
});

test("fetch review thread returns the whole thread in order", async () => {
  const client = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [PR],
    comments: THREAD_COMMENTS,
  });
  const thread = await client.getReviewThread("someuser", "repo", 42, 102);
  assert.equal(thread.rootCommentId, 100);
  assert.deepEqual(
    thread.comments.map((c) => c.id),
    [100, 101, 102],
  );
  assert.equal(thread.path, "src/foo.ts");
  assert.equal(thread.diffHunk, "@@ -1,3 +1,3 @@");
});

test("fetch diff hunk comes from the thread root", async () => {
  const client = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [PR],
    comments: THREAD_COMMENTS,
  });
  const thread = await client.getReviewThread("someuser", "repo", 42, 101);
  assert.ok(thread.diffHunk.includes("@@"));
});

test("post reply records the reply against the triggering comment", async () => {
  const client = new FixtureGitHubClient({ login: "gremlyn-bot", prs: [PR] });
  const id = await client.postReviewReply("someuser", "repo", 42, 102, "Done.");
  assert.ok(id > 0);
  assert.deepEqual(client.replies, [{ prNumber: 42, inReplyTo: 102, body: "Done." }]);
});

test("buildThread reconstructs a thread from any member", () => {
  const thread = buildThread(THREAD_COMMENTS, 101);
  assert.equal(thread.rootCommentId, 100);
  assert.equal(thread.comments.length, 3);
});

test("poll returns 304 when the ETag matches and 200 after new activity", async () => {
  const client = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [PR],
    comments: THREAD_COMMENTS,
  });
  const first = await client.pollReviewComments("someuser", "repo", {});
  assert.equal(first.status, 200);
  assert.equal(first.comments.length, 3);
  const second = await client.pollReviewComments("someuser", "repo", {
    etag: first.etag ?? undefined,
  });
  assert.equal(second.status, 304);
  assert.equal(second.comments.length, 0);
  client.addComment({ ...THREAD_COMMENTS[0]!, id: 200, body: "new" });
  const third = await client.pollReviewComments("someuser", "repo", {
    etag: first.etag ?? undefined,
  });
  assert.equal(third.status, 200);
});

test("poll respects the since filter", async () => {
  const client = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [PR],
    comments: THREAD_COMMENTS,
  });
  const result = await client.pollReviewComments("someuser", "repo", {
    since: "2026-01-01T10:05:00Z",
  });
  assert.deepEqual(
    result.comments.map((c) => c.id),
    [102],
  );
});

test("mappers shape recorded GitHub payloads", () => {
  const pr = mapPullRequest({
    number: 7,
    title: "t",
    state: "open",
    merged_at: null,
    head: {
      ref: "b",
      sha: "s",
      repo: { owner: { login: "o" }, name: "r" },
      user: { login: "o" },
    },
    base: { repo: { owner: { login: "o" }, name: "r" } },
    html_url: "u",
  });
  assert.equal(pr.headBranch, "b");
  assert.equal(pr.merged, false);
  const comment = mapReviewComment({
    id: 5,
    in_reply_to_id: 4,
    path: "a.ts",
    diff_hunk: "@@ -1 +1 @@",
    body: "x",
    user: { login: "u" },
    created_at: "2026-01-01T00:00:00Z",
    pull_request_url: "https://api.github.com/repos/o/r/pulls/9",
  });
  assert.equal(comment.prNumber, 9);
  assert.equal(comment.inReplyToId, 4);
});

test("fork detection distinguishes same-repo from fork PRs", () => {
  assert.equal(isForkPullRequest(PR), false);
  assert.equal(isForkPullRequest({ ...PR, headRepoOwner: "someone-else" }), true);
});

test("setCommentReaction records each distinct status and skips repeats", async () => {
  const client = new FixtureGitHubClient({ login: "gremlyn-bot", prs: [PR] });
  await client.setCommentReaction("someuser", "repo", 102, "eyes");
  await client.setCommentReaction("someuser", "repo", 102, "rocket");
  await client.setCommentReaction("someuser", "repo", 102, "rocket");
  await client.setCommentReaction("someuser", "repo", 102, "hooray");
  assert.deepEqual(client.reactionHistory, [
    { commentId: 102, content: "eyes" },
    { commentId: 102, content: "rocket" },
    { commentId: 102, content: "hooray" },
  ]);
  assert.equal(client.reactions.get(102), "hooray");
});
