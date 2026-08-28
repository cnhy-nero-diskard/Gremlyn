# Gremlyn — Local PR Resolution Orchestrator

## Why

Pull-request review feedback is cheap to write and expensive to act on. The loop —
read the comment, find the file, re-derive the context, make the change, run the
checks, push, reply — is mechanical for a large fraction of review comments, but it
still costs a developer a full context switch each time.

A locally installed coding agent can attempt most of that work. What is missing is
the part an agent must not be trusted to do itself: deciding *which* repository to
touch, *whether* the requester is allowed to ask, *where* on disk the work happens,
*whether* the result is good enough to publish, and *what* the audit trail says
afterwards.

Gremlyn is that missing part. It turns an authorized GitHub PR comment into a
controlled, isolated, observable agent run — and keeps every irreversible decision
on the orchestrator's side of the line.

## What Changes

This change bootstraps the entire application. The repository currently contains
only `Layer1.md` (the system-level contract) and an empty OpenSpec scaffold.

- **New application**: a single-process TypeScript/Node service that polls GitHub
  for `!RESOLVE` commands, runs the configured coding agent in an isolated git
  worktree, validates the result, publishes it, and reports back.
- **New command surface**: `!RESOLVE` on a PR *review* comment thread. The command
  parser is built so additional commands can be registered later without
  restructuring the orchestrator.
- **New persistence**: an embedded SQLite database holding the repository registry,
  jobs, job attempts, processed-event keys, and execution results. Job history
  survives restarts.
- **New operator console**: a loopback-bound web UI for monitoring jobs, reading
  agent output, and performing manual retry/cancel actions.
- **New safety envelope**: repository allowlist, GitHub-user allowlist, event
  deduplication, per-PR execution locking, no-force-push and no-merge policies,
  and interrupted-job detection on restart.

### Scope decisions made here

Layer1 leaves these open. Deciding them now prevents plausible-but-wrong
implementations rather than deferring the same questions into design:

- **Ingestion is polling**, not webhooks or a self-hosted runner. The deployment
  target is one developer on one machine (Layer1 §33); polling needs no inbound
  network path and survives a sleeping laptop.
- **Same-repository PRs only.** Fork PRs are detected and rejected with an
  explanatory comment. Their head branch lives in another repository, so the
  fetch/push model in Layer1 §9/§17 does not apply unmodified.
- **`!RESOLVE` requires a review-comment thread.** Issued as a top-level PR
  conversation comment it carries no file, line, hunk, or thread, so Layer1 §8's
  context reconstruction has nothing to work from. It is rejected with guidance
  rather than silently reinterpreted as the (future) `!RESOLVE-ALL`.
- **Validation commands are per-repository configuration**, not auto-detected.
  Layer1 §16 asks the orchestrator to "discover them from the target repository";
  general auto-detection is a research problem, while one config field per
  registered repository ends it. Detection may be layered on later.
- **The local API binds to loopback and requires a token.** Layer1 §23 names UI
  ports but §25 never constrains them, and the console's retry/rerun endpoints are
  remote code execution by design.
- **The orchestrator authenticates as a dedicated identity**, distinct from the
  developer's own account, and excludes itself from the author allowlist. This
  breaks the loop where the bot's own comments could re-trigger it.

### Explicitly deferred

- Worktree garbage collection and agent-log retention (bounded growth is accepted
  for MVP; both are recorded as known unbounded resources).
- Automatic review-thread resolution (Layer1 §19 — conservative default: reply
  only, never mark resolved).
- Additional commands (`!TEST`, `!INVESTIGATE`, `!RESOLVE-ALL`, `!RETRY`).

### Accepted risk

**The coding agent is not sandboxed.** Layer1 §9 isolates the *filesystem via git
worktrees*, but a worktree is a directory, not a sandbox: the agent process runs
with the invoking user's full privileges and can reach outside its working
directory, including into the developer's primary checkout that §9 exists to
protect. Additionally, untrusted review-comment text is placed into the agent
prompt by design (§8), which is the one channel where untrusted text is inherently
executable-adjacent.

For the intended deployment — one developer, repositories they own, an allowlist of
one — this is accepted rather than mitigated. It is bounded by: the author
allowlist, per-run isolated agent state, an agent environment that excludes
orchestrator secrets, and a full audit trail. Process-level sandboxing is a
candidate for a later change and is called out in the design's risk register.

## Capabilities

### New Capabilities

- `repository-registry`: which GitHub repositories are managed, where their local
  source and workspaces live, and what agent, model, and validation commands each
  one uses.
- `command-ingestion`: detecting GitHub activity, normalizing it into internal
  events, parsing commands from comment text, and guaranteeing each command
  executes at most once.
- `command-authorization`: deciding whether a parsed command may execute at all —
  user allowlist, repository allowlist and enablement, PR eligibility, and the
  handling of GitHub text as untrusted input.
- `job-orchestration`: the job and attempt model, queueing, per-PR execution
  locking, state transitions, cancellation, and restart recovery.
- `workspace-isolation`: preparing, refreshing, and guarding the disposable git
  worktree each job runs in, and refusing unsafe operations against developer
  checkouts.
- `agent-execution`: reconstructing review context, generating the resolution
  prompt, and invoking the configured coding agent behind a replaceable executor
  abstraction with timeouts, isolated state, and captured output.
- `resolution-publication`: independently validating the agent's result, deciding
  whether it may be committed and pushed, and reporting the outcome to GitHub.
- `operator-console`: the local HTTP API and UI for observing jobs and performing
  manual operator actions, and the access controls on that surface.

### Modified Capabilities

None. This is the first change in the repository; `openspec/specs/` is empty.

## Impact

- **Repository**: introduces the entire source tree, build tooling, test setup, and
  developer documentation. No existing code to modify.
- **Runtime dependencies**: Node 22+, git 2.x, and a locally installed Cline CLI
  (verified present at 3.0.60) with an authenticated provider and model.
- **External systems**: GitHub REST API (read PRs, review comments, and diffs;
  write comments; push to branches). Requires a token with the minimum scopes in
  Layer1 §24, held in a dedicated identity.
- **Host**: creates and mutates disposable git worktrees under a configured
  workspace root, spawns agent processes, and listens on a loopback port.
- **Developer checkouts**: read-only. The orchestrator fetches from configured
  source repositories but never mutates their working trees.
