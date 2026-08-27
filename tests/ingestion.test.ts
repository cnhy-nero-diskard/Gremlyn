import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import {
  CommandRegistry,
  createDefaultCommandRegistry,
  enforceCommandPlacement,
} from "../src/ingest/commands.js";
import { normalizeReviewComment } from "../src/ingest/normalize.js";
import { PollingEventSource } from "../src/ingest/polling.js";
import { Store } from "../src/store/db.js";
import type { NormalizedEvent } from "../src/types.js";

const COMMENT = {
  id: 100,
  inReplyToId: null,
  path: "src/file.ts",
  diffHunk: "@@ -1 +1 @@",
  body: "!RESOLVE",
  authorLogin: "someuser",
  createdAt: "2026-01-01T10:00:00Z",
  prNumber: 42,
};

test("review comments normalize with every required transport-independent field", () => {
  assert.deepEqual(normalizeReviewComment("owner", "repo", COMMENT), {
    owner: "owner",
    repo: "repo",
    kind: "review-comment",
    commentId: 100,
    authorLogin: "someuser",
    body: "!RESOLVE",
    prNumber: 42,
    observedAt: "2026-01-01T10:00:00Z",
  });
});

test("polling source sends durable since and ETag checkpoints and handles 304", async () => {
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const github = new FixtureGitHubClient({ login: "bot", comments: [COMMENT] });
  const repository = { id: 7, owner: "owner", repo: "repo" };
  try {
    const source = new PollingEventSource(github, store.db, () => "2026-01-01T11:00:00Z");
    assert.equal((await source.poll(repository)).length, 1);
    assert.deepEqual(await source.poll(repository), []);
    assert.equal(github.rateLimitConsumed, 1, "304 response consumed rate limit");
    const state = store.db
      .prepare("SELECT etag, since, last_polled_at FROM ingestion_state WHERE repo_id = 7")
      .get() as { etag: string; since: string; last_polled_at: string };
    assert.equal(state.etag, 'W/"fixture-1"');
    assert.equal(state.since, COMMENT.createdAt);
    assert.equal(state.last_polled_at, "2026-01-01T11:00:00Z");
  } finally {
    store.close();
  }
});

test("a stop, post, and restart cycle observes the new command exactly once", async () => {
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const github = new FixtureGitHubClient({ login: "bot" });
  const repository = { id: 8, owner: "owner", repo: "repo" };
  try {
    assert.deepEqual(await new PollingEventSource(github, store.db).poll(repository), []);
    github.addComment(COMMENT);
    const afterRestart = new PollingEventSource(github, store.db);
    assert.deepEqual(
      (await afterRestart.poll(repository)).map((event) => event.commentId),
      [COMMENT.id],
    );
    assert.deepEqual(await new PollingEventSource(github, store.db).poll(repository), []);
  } finally {
    store.close();
  }
});

test("command parser handles start-of-line, fences, inline code, quotes, and unknown tokens", () => {
  const registry = createDefaultCommandRegistry();
  const cases: [string, number][] = [
    ["!RESOLVE", 1],
    ["context\n!RESOLVE model-a", 1],
    ["```\n!RESOLVE\n```", 0],
    ["Use `!RESOLVE` here", 0],
    ["> !RESOLVE", 0],
    ["!UNKNOWN", 0],
    ["prefix !RESOLVE", 0],
  ];
  for (const [body, count] of cases) assert.equal(registry.detect(body).length, count, body);
  assert.deepEqual(registry.detect("!RESOLVE model-a")[0], {
    name: "RESOLVE",
    args: ["model-a"],
  });
});

test("RESOLVE accepts review threads and rejects conversation placement with guidance", async () => {
  const registry = createDefaultCommandRegistry();
  const github = new FixtureGitHubClient({ login: "bot" });
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const reviewEvent: NormalizedEvent = {
    ...normalizeReviewComment("owner", "repo", COMMENT),
    kind: "review-comment",
  };
  const command = registry.detect(reviewEvent.body)[0]!;
  assert.deepEqual(await enforceCommandPlacement(reviewEvent, command, registry, github), {
    kind: "accepted",
  });

  const conversationEvent: NormalizedEvent = { ...reviewEvent, kind: "issue-comment" };
  assert.deepEqual(await enforceCommandPlacement(conversationEvent, command, registry, github), {
    kind: "rejected",
    reason: "command-placement",
  });
  assert.equal(github.conversationReplies.length, 1);
  assert.match(github.conversationReplies[0]!.body, /review comment thread/u);
  const jobs = store.db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
    count: number;
  };
  assert.equal(jobs.count, 0);
  store.close();
});

test("a second command is registered without changes to ingestion or orchestration", () => {
  const registry = new CommandRegistry();
  registry.register({ name: "RESOLVE", eligibleKinds: ["review-comment"] });
  registry.register({ name: "TEST", eligibleKinds: ["review-comment", "issue-comment"] });
  assert.deepEqual(registry.detect("!TEST unit"), [{ name: "TEST", args: ["unit"] }]);
});
