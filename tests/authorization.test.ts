import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import type { PullRequestInfo } from "../src/github/client.js";
import {
  authorizeCommand,
  type AuthorizationRepository,
  type AuthorizeCommandOptions,
} from "../src/gate/authorize.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { AuthorizationStore } from "../src/store/authorization.js";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import type { NormalizedEvent, ParsedCommand } from "../src/types.js";

const PR: PullRequestInfo = {
  number: 42,
  title: "Feature",
  state: "open",
  merged: false,
  headBranch: "feature",
  headSha: "abc123",
  headRepoOwner: "owner",
  headRepoName: "repo",
  baseRepoOwner: "owner",
  baseRepoName: "repo",
  htmlUrl: "https://github.test/owner/repo/pull/42",
};

function setup(overrides: Partial<AuthorizeCommandOptions> = {}) {
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
           (owner, name, source_path, workspace_root, agent, model, effort, allowed_models)
         VALUES ('owner', 'repo', 'source', 'workspaces', 'fake', 'model-a', 'xhigh',
                 '["model-a","model-b"]')`,
      )
      .run().lastInsertRowid,
  );
  const repository: AuthorizationRepository = {
    id: repoId,
    owner: "owner",
    name: "repo",
    enabled: true,
    allowedModels: ["model-a", "model-b"],
    defaultModel: "model-a",
  };
  const event: NormalizedEvent = {
    owner: "owner",
    repo: "repo",
    kind: "review-comment",
    commentId: 100,
    authorLogin: "AllowedUser",
    body: "!RESOLVE",
    prNumber: 42,
    observedAt: "2026-01-01T10:00:00Z",
  };
  const command: ParsedCommand = { name: "RESOLVE", args: [] };
  const github = new FixtureGitHubClient({ login: "gremlyn-bot", prs: [PR] });
  const options: AuthorizeCommandOptions = {
    event,
    command,
    repository,
    allowedAuthors: ["alloweduser"],
    orchestratorLogin: "gremlyn-bot",
    registry: createDefaultCommandRegistry(),
    github,
    db: store.db,
    ...overrides,
  };
  return { store, repository, event, command, github, options };
}

test("author allowlist matches login case-insensitively and ignores display-name spoofing", async () => {
  const allowed = setup();
  try {
    assert.equal((await authorizeCommand(allowed.options)).kind, "authorized");
  } finally {
    allowed.store.close();
  }
  const denied = setup();
  denied.options.event = { ...denied.event, authorLogin: "spoofing-user", body: "AllowedUser" };
  try {
    assert.deepEqual(await authorizeCommand(denied.options), {
      kind: "rejected",
      reason: "author-not-allowed",
    });
    assert.equal(countJobs(denied.store), 0);
  } finally {
    denied.store.close();
  }
});

test("orchestrator-authored commands are ignored and create no job", async () => {
  const fixture = setup();
  fixture.options.event = { ...fixture.event, authorLogin: "GREMLYN-BOT" };
  fixture.options.allowedAuthors = ["gremlyn-bot"];
  try {
    assert.deepEqual(await authorizeCommand(fixture.options), {
      kind: "ignored",
      reason: "orchestrator-authored",
    });
    assert.deepEqual(await authorizeCommand(fixture.options), {
      kind: "ignored",
      reason: "duplicate-command",
    });
    assert.equal(countJobs(fixture.store), 0);
  } finally {
    fixture.store.close();
  }
});

test("authorization preconditions fail independently with specific reasons", async () => {
  const cases: {
    reason: string;
    mutate: (fixture: ReturnType<typeof setup>) => void;
  }[] = [
    { reason: "repository-unregistered", mutate: (f) => (f.options.repository = null) },
    {
      reason: "repository-disabled",
      mutate: (f) => (f.options.repository = { ...f.repository, enabled: false }),
    },
    {
      reason: "repository-mismatch",
      mutate: (f) => (f.options.repository = { ...f.repository, name: "different-repository" }),
    },
    {
      reason: "pull-request-not-open",
      mutate: (f) => f.github.addPullRequest({ ...PR, state: "closed" }),
    },
    {
      reason: "fork-pull-request",
      mutate: (f) => f.github.addPullRequest({ ...PR, headRepoOwner: "fork-owner" }),
    },
    {
      reason: "command-unregistered",
      mutate: (f) => (f.options.command = { name: "UNKNOWN", args: [] }),
    },
    {
      reason: "command-placement",
      mutate: (f) => (f.options.event = { ...f.event, kind: "issue-comment" }),
    },
  ];
  for (const entry of cases) {
    const fixture = setup();
    entry.mutate(fixture);
    try {
      const result = await authorizeCommand(fixture.options);
      assert.equal(result.kind === "authorized" ? null : result.reason, entry.reason);
      assert.equal(countJobs(fixture.store), 0);
    } finally {
      fixture.store.close();
    }
  }
});

test("fork PR is rejected with guidance and the required reason", async () => {
  const fixture = setup();
  fixture.github.addPullRequest({ ...PR, headRepoOwner: "fork-owner" });
  try {
    assert.deepEqual(await authorizeCommand(fixture.options), {
      kind: "rejected",
      reason: "fork-pull-request",
    });
    assert.equal(fixture.github.replies.length, 1);
    assert.match(fixture.github.replies[0]!.body, /fork pull requests are not supported/u);
  } finally {
    fixture.store.close();
  }
});

test("model arguments outside allowed_models are rejected before job or agent work", async () => {
  const fixture = setup();
  fixture.options.command = { name: "RESOLVE", args: ["unapproved-model"] };
  try {
    assert.deepEqual(await authorizeCommand(fixture.options), {
      kind: "rejected",
      reason: "model-not-allowed",
    });
    assert.equal(countJobs(fixture.store), 0);
    assert.equal(fixture.github.replies.length, 1);
    assert.match(fixture.github.replies[0]!.body, /model "unapproved-model" is not allowed/u);
  } finally {
    fixture.store.close();
  }
});

test("invalid command arguments are rejected with review-thread guidance", async () => {
  const fixture = setup();
  fixture.options.command = { name: "RESOLVE", args: ["fix", "this"] };
  try {
    assert.deepEqual(await authorizeCommand(fixture.options), {
      kind: "rejected",
      reason: "invalid-command-arguments",
    });
    assert.equal(countJobs(fixture.store), 0);
    assert.equal(fixture.github.replies.length, 1);
    assert.match(fixture.github.replies[0]!.body, /expected at most one model argument/u);
  } finally {
    fixture.store.close();
  }
});

test("executed and rejected authorization outcomes retain complete audit identity", async () => {
  const executed = setup();
  try {
    assert.equal((await authorizeCommand(executed.options)).kind, "authorized");
    const created = new JobStore(executed.store.db).createJob({
      repoId: executed.repository.id,
      prNumber: executed.event.prNumber,
      commentId: executed.event.commentId,
      command: executed.command.name,
      threadId: "99",
      authorLogin: executed.event.authorLogin,
      observedAt: executed.event.observedAt,
    });
    assert.equal(created.kind, "created");
    const row = new AuthorizationStore(executed.store.db).get(
      executed.repository.id,
      executed.event,
      executed.command,
    )!;
    assert.equal(row.outcome, "executed");
    assert.equal(row.author_login, executed.event.authorLogin);
    assert.equal(row.pr_number, executed.event.prNumber);
    assert.equal(row.comment_id, executed.event.commentId);
    assert.equal(row.observed_at, executed.event.observedAt);
    assert.ok(row.job_id);

    assert.deepEqual(await authorizeCommand(executed.options), {
      kind: "ignored",
      reason: "duplicate-command",
    });
  } finally {
    executed.store.close();
  }

  const rejected = setup();
  rejected.options.event = { ...rejected.event, authorLogin: "not-allowed", commentId: 101 };
  try {
    await authorizeCommand(rejected.options);
    const row = new AuthorizationStore(rejected.store.db).get(
      rejected.repository.id,
      rejected.options.event,
      rejected.command,
    )!;
    assert.equal(row.outcome, "rejected");
    assert.equal(row.reason, "author-not-allowed");
    assert.equal(row.author_login, "not-allowed");
    assert.equal(row.job_id, null);
  } finally {
    rejected.store.close();
  }
});

function countJobs(store: Store): number {
  return (store.db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count;
}
