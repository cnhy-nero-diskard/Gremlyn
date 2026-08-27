# Tasks — Gremlyn

Ordering follows design.md D18: a thin end-to-end slice first (groups 1–3), then each
stage thickened in place (groups 4–10). Groups 2 and 3 deliver a system that already
answers the integration questions — worktree round-trip, push, reply, dedupe — before
any stage is built out fully.

## 1. Foundation

- [ ] 1.1 Initialize the Node/TypeScript project (strict `tsconfig`, ESM, Node 22 target) and verify `npm run build` and `npm test` both succeed on an empty test suite
- [ ] 1.2 Add runtime dependencies (`better-sqlite3`, `octokit`, `fastify`, `execa`) and dev tooling (test runner, linter, formatter) and verify a clean install builds and lints
- [ ] 1.3 Implement the config loader — file plus environment overlay, secrets sourced from environment only — and verify it rejects a config with a missing GitHub token and one naming an unknown agent
- [ ] 1.4 Write `config.example.yaml` covering every field in design.md D6 with no real credentials, and verify the loader parses it successfully
- [ ] 1.5 Implement the SQLite store with an ordered startup migration runner, applying the D6 schema, and verify migrations run idempotently against a fresh and an already-migrated database
- [ ] 1.6 Implement structured logging with job/attempt correlation fields and a configured-secret redaction filter, and verify a log call containing a secret value emits it redacted

## 2. Walking skeleton — mechanics

- [ ] 2.1 Implement the `GitHubClient` seam (fetch PR, fetch review thread, fetch diff hunk, post reply) over Octokit, and verify each call against recorded fixtures
- [ ] 2.2 Implement `FakeExecutor` covering all six outcomes from design D10 (success, failure, timeout, no-changes, files-modified, validation-failure) and verify each outcome is selectable and observable
- [ ] 2.3 Implement worktree create/refresh for a single PR against a temp git repository and verify the worktree ends on the expected branch at the expected commit
- [ ] 2.4 Implement commit and non-force push to a PR head branch and verify against a temp bare remote that the commit lands and no history is rewritten

## 3. Walking skeleton — end to end

- [ ] 3.1 Wire a minimal path from a hardcoded normalized event through workspace prepare, `FakeExecutor`, commit, push, and GitHub reply, and verify a fixture-driven run produces a commit on the temp remote and a posted reply
- [ ] 3.2 Persist a job and a single attempt across that path and verify the job reaches a terminal status with its attempt detail recorded
- [ ] 3.3 Add the `processed_commands` unique-constraint write inside the job-creation transaction and verify replaying the same event creates no second job
- [ ] 3.4 Establish the end-to-end test harness (fake agent + real git + fixture GitHub, no network) and verify the Layer1 §39 happy path runs green in CI

## 4. Ingestion

- [ ] 4.1 Implement the `EventSource` interface and the polling source with `since` plus ETag conditional requests, and verify an unchanged repository returns `304` and consumes no rate limit
- [ ] 4.2 Implement event normalization to the shape required by the `command-ingestion` spec and verify normalized events carry every required field
- [ ] 4.3 Persist and restore ingestion progress per repository and verify a stop/post/restart cycle observes the posted command exactly once
- [ ] 4.4 Implement the command parser and registry, and verify the table-driven cases: start-of-line match, fenced code block ignored, inline code ignored, block quote ignored, unknown token ignored
- [ ] 4.5 Implement command placement eligibility and verify a review-thread `!RESOLVE` is accepted while a top-level conversation `!RESOLVE` is rejected with an explanatory reply and no job
- [ ] 4.6 Verify a second registered command can be added without modifying ingestion, gate, or orchestrator code

## 5. Authorization

- [ ] 5.1 Implement the author allowlist with case-insensitive login matching and verify an allowlisted login passes, a non-allowlisted login is rejected, and a spoofed display name does not pass
- [ ] 5.2 Exclude the orchestrator identity from authorization and verify a command token in an orchestrator-authored comment creates no job
- [ ] 5.3 Implement the full precondition set from the `command-authorization` spec and verify each precondition fails independently with its own specific reason
- [ ] 5.4 Implement fork-PR detection and verify a fork PR is rejected with reason `fork-pull-request` and an explanatory reply
- [ ] 5.5 Implement command-argument validation against `allowed_models` and verify an out-of-allowlist model argument is rejected before any agent invocation
- [ ] 5.6 Persist authorization outcomes for both executed and rejected commands and verify each is traceable to login, repository, PR, comment, and time

## 6. Orchestration

- [ ] 6.1 Implement the D7 state machine with a `status_events` row per transition and verify a completed job's timeline is reconstructable in order with timestamps
- [ ] 6.2 Implement the per-PR lock and global concurrency semaphore and verify two commands for one PR serialize while two commands for different PRs run concurrently
- [ ] 6.3 Verify the lock is released on success, failure, timeout, and cancellation, and that queued work for that PR then proceeds
- [ ] 6.4 Implement dequeue-time PR re-verification and verify a job whose PR closed while queued fails with a PR-state reason before any workspace is touched
- [ ] 6.5 Implement cancellation for queued and running jobs and verify a cancelled running job terminates the agent, publishes nothing, and records whether the workspace holds uncommitted changes
- [ ] 6.6 Implement the startup interrupted-job sweep and verify a job left in a non-terminal status is marked interrupted, retains its output, and does not re-execute
- [ ] 6.7 Implement operator retry as a new attempt under the same job and verify prior attempt records are preserved unchanged
- [ ] 6.8 Implement the single-instance startup check on the data directory and verify a second orchestrator against the same directory refuses to start

## 7. Workspace

- [ ] 7.1 Implement deterministic workspace paths from `workspace_root` plus PR number and verify a branch name containing traversal sequences does not influence the resulting path
- [ ] 7.2 Implement the full prepare sequence from design D9 and verify fresh-create and clean-refresh both end at the current head commit
- [ ] 7.3 Implement unsafe-state detection (dirty, conflicted, diverged, not a worktree) and verify each fails the job with its specific reason and leaves contents intact
- [ ] 7.4 Verify a source repository with uncommitted local changes is unaffected by a full job run — working tree, index, and checked-out branch unchanged
- [ ] 7.5 Implement the explicit workspace-reset action with a path assertion beneath a configured `workspace_root`, and verify a path outside any workspace root is refused and recorded
- [ ] 7.6 Record `head_sha_at_prepare` and re-verify it before publication, and verify a head change during the run refuses publication with a specific reason

## 8. Agent execution

- [ ] 8.1 Implement review-context reconstruction (thread in order, anchored file, diff hunk) and verify assembled context includes the whole thread and excludes the full PR diff
- [ ] 8.2 Implement deterministic prompt assembly per design D11 and verify the instruction block is constant and untrusted text appears only in the delimited context region
- [ ] 8.3 Implement `ClineExecutor` over the argv surface in design D10 with `shell: false`, and verify a prompt containing shell metacharacters reaches the agent intact with no shell interpretation
- [ ] 8.4 Pass the configured reasoning effort via `--thinking`, defaulting to the agent's highest supported tier (`xhigh` for Cline), and verify an effort above the agent's ceiling is rejected at startup rather than at invocation
- [ ] 8.5 Implement per-attempt `--data-dir` isolation and verify two concurrent attempts do not share or corrupt agent session state
- [ ] 8.6 Implement the allowlist-built child environment and verify the orchestrator GitHub token is absent from the agent process environment
- [ ] 8.7 Implement timeout and cancellation via `-t` plus `AbortSignal` and verify an over-running agent is terminated, the attempt fails with a timeout reason, and nothing is published
- [ ] 8.8 Capture stdout, stderr, exit code, session id, reasoning effort, and timings to attempt records with bulk output written to `output_ref` files, and verify output is retained after a non-zero exit
- [ ] 8.9 Implement the agent version check at startup and verify an unexpected CLI version surfaces as a clear configuration error
- [ ] 8.10 Verify the orchestrator never passes the agent's own worktree flag and always supplies the prepared workspace as the working directory

## 9. Validation and publication

- [ ] 9.1 Implement per-repository validation command execution with `shell: false` and verify each command's exit code, duration, and output are recorded separately and order is respected
- [ ] 9.2 Verify an empty validation command list performs inspection only and records that no commands were configured, with no built-in fallback
- [ ] 9.3 Implement independent worktree inspection (modified, valid, expected branch, no conflicts) and verify a wrong checked-out branch and a conflicted state each block publication with their own reason
- [ ] 9.4 Implement the six publication preconditions and verify each one failing independently prevents commit and push and names the failed precondition
- [ ] 9.5 Verify an agent that exits successfully having changed nothing publishes nothing and records a no-changes outcome
- [ ] 9.6 Implement the deterministic commit message referencing the originating comment id and verify the resulting commit SHA is recorded on the attempt
- [ ] 9.7 Verify a rejected push fails the attempt with a rejection reason and attempts no force-push and no history rewrite
- [ ] 9.8 Implement outcome reporting for success, failure, and agent-declined cases and verify each reply matches its required content and contains no transcript and no secret
- [ ] 9.9 Verify review-thread resolution state is never modified by a successful attempt
- [ ] 9.10 Implement separate recording of reporting failure and verify a failed reply after a successful push leaves the commit in place

## 10. Console

- [ ] 10.1 Implement the Fastify server with loopback-only default binding and mandatory token auth, and verify an unauthenticated request to every route is rejected with no data disclosed and no action performed
- [ ] 10.2 Implement the dashboard view (orchestrator status, repositories with enablement, running, queued, recent successes and failures) and verify running and queued jobs appear with repository and PR
- [ ] 10.3 Implement the job detail view covering every field required by the `operator-console` spec and verify a failed job's stage, reason, agent output, and validation results are all present
- [ ] 10.4 Verify a retried job shows each attempt's output and outcome separately
- [ ] 10.5 Implement SSE live updates and verify status transitions and new agent output appear without a manual reload
- [ ] 10.6 Implement operator actions (retry, cancel, repository toggle, links to PR and comment) and verify each is recorded with time and effect
- [ ] 10.7 Implement the workspace-reset action as visually and structurally separated with a required confirmation step, and verify it does not execute without explicit confirmation
- [ ] 10.8 Apply secret redaction across job detail, agent output, configuration views, and error traces, and verify a configured secret present in captured output is redacted in every view
- [ ] 10.9 Expose the structured log filtered by job id and verify a job's full lifecycle entries are returned without reading a terminal

## 11. Hardening and documentation

- [ ] 11.1 Verify the Layer1 §34 security behaviors as explicit tests: unauthorized rejected, duplicate not executed twice, same PR not concurrent, failed agent does not push, restart does not duplicate work, malformed GitHub data executes no shell
- [ ] 11.2 Map each Layer1 §27 failure mode to a distinct reason code and verify no failure path produces a generic message
- [ ] 11.3 Verify every job failure records stage, whether files changed, whether a commit exists, and whether anything was pushed
- [ ] 11.4 Write the README covering install, configure, GitHub auth, repository registration, agent and model setup, start, and verify connectivity — Windows and PowerShell friendly, no WSL requirement
- [ ] 11.5 Document development, test, and build commands plus troubleshooting notes, and verify a clean clone can be brought to a running orchestrator by following them
- [ ] 11.6 Run the full Layer1 §39 acceptance scenario against a real repository with a real agent invocation and verify all fifteen steps, ending with the developer's normal checkout untouched
