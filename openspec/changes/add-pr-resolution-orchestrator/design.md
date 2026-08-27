# Design — Gremlyn Layer 2

## Context

See [proposal.md](proposal.md) for motivation and scope decisions, and the capability
specs under [specs/](specs/) for the behavior contract. This document covers how the
system is built.

Two facts shape everything here.

**The repository is empty.** Only `Layer1.md` and an OpenSpec scaffold exist. Layer1
§3 asks for a plan derived from "existing conventions, dependencies, and runtime
environment" — there are none. Every technology deferral in Layer1 (§6 transport,
§22 persistence, §20 UI, §30 module boundaries) collapses into one greenfield
decision, made here.

**The agent CLI was probed, not assumed.** Layer1 §13's executor contract was the
project's largest unknown. `cline` 3.0.60 is installed and exposes a headless
surface matching the required contract almost exactly:

```
cline "<prompt>"                positional argv — no shell string construction
      -c, --cwd <path>          orchestrator supplies the working directory
      -m, --model <id>          model from configuration
      -P, --provider <id>       provider from configuration
      --json                    structured message stream
      -t, --timeout <seconds>   §13's "timeout if supported" — supported
      --auto-approve <bool>     defaults true; act mode is the default
      --retries <n>             bounded consecutive-mistake allowance
      --data-dir <path>         isolated mutable state per invocation
      -s, --system <prompt>     system prompt override
```

Three consequences Layer1 did not anticipate:

1. `--data-dir` exists because agent state is otherwise shared at `~/.cline/data`.
   Concurrent attempts must each get their own, or they race.
2. `--worktree` exists — Cline can create its own checkout. Using it would hand
   workspace selection to the agent, violating Layer1 §15. It is deliberately unused.
3. Interactive subcommands (`cline config`) hard-fail without a TTY. The executor
   must only touch the non-interactive surface.

Verified host: Node 22.21, npm 10.9, git 2.47 (Windows), `gh` 2.96, Cline 3.0.60.

## Goals / Non-Goals

**Goals:**

- One installable, startable process that satisfies Layer1 §39's end-to-end scenario.
- Every irreversible action — authorization, path selection, commit, push, reply —
  decided by orchestrator code, never by agent output.
- A failure is always attributable to a named stage with a specific reason.
- The agent layer, the GitHub layer, and the ingestion transport are each replaceable
  without touching the job lifecycle.
- Testable end-to-end without spending real agent invocations.

**Non-Goals:**

- Process- or container-level sandboxing of the agent (see Risks).
- Any distribution, multi-user, or remote-access story.
- Resource reclamation: worktree GC and log retention are out of scope for MVP.
- Auto-detection of a repository's validation commands.

## Decisions

### D1 — Single process, modular internals

One Node process hosts ingestion, orchestration, agent execution, and the HTTP
console. Modules are internal boundaries, not packages or services.

*Why:* Layer1 §33 targets one developer on one machine, and §38.3 asks for the
smallest architecture that satisfies the requirements. Job locking becomes an
in-memory map instead of a distributed lease; the console reads the same SQLite
handle the orchestrator writes; there is one thing to start and one thing to watch.

*Alternative considered:* separate ingestion daemon, worker pool, and UI server.
Rejected — it buys crash isolation that the restart-recovery design already provides
(§28), at the cost of three processes, an IPC layer, and a real distributed lock.

*Constraint accepted:* concurrency is bounded by one Node event loop plus child
processes. Since the expensive work happens in spawned agent and validation
processes, this is not a bottleneck at the intended scale.

### D2 — TypeScript on Node 22

*Why:* the agent is a Node CLI, so its structured output, exit semantics, and
installation are native to this runtime. `child_process.spawn` with an argv array
satisfies Layer1 §25's "safe process spawning" structurally rather than by
discipline. Octokit is first-class. The console can be served in-process.

*Alternative considered:* Go — a single static `.exe` and a better daemon story,
genuinely attractive for a long-running local service. Rejected on ecosystem
alignment: the process being orchestrated is Node, and a Go build would still need a
separate frontend toolchain for the console.

*Rejected:* Python — weakest of the three for a long-running Windows service with a
bundled UI.

### D3 — SQLite (`better-sqlite3`) as the single store

One database file under the configuration directory. Synchronous API.

*Why:* Layer1 §22 asks for lightweight embedded persistence and warns against remote
infrastructure. Synchronous access removes a class of interleaving bug from the state
machine — a status transition and its audit row commit in one call, with no `await`
between them for another job to slip through. WAL mode lets the console read while
the orchestrator writes.

*Alternative considered:* JSON files. Rejected — Layer1 §11's at-most-once guarantee
needs an atomic uniqueness constraint, which files do not provide.

*Alternative considered:* Postgres. Rejected by §22 explicitly.

### D4 — Polling ingestion behind an `EventSource` interface

Poll each enabled repository's review comments on a configured interval, using
`since` plus ETag conditional requests.

*Why:* Layer1 §33's deployment has no public URL, and a laptop that sleeps breaks any
tunnel-based webhook. Polling needs no inbound network path and resumes cleanly.
Latency of roughly the poll interval is negligible against a multi-minute agent run.

Conditional requests keep the cost near zero: an unchanged repository returns `304`
and does not consume rate limit.

*Alternative considered:* webhooks via a tunnel — instant, but adds a public
endpoint, a signing secret, and a component that dies silently. *Self-hosted Actions
runner* — no inbound path and a natural home for validation, but drags Actions YAML
into an otherwise entirely local system.

Both remain available: per the `command-ingestion` spec, everything downstream
consumes normalized events and knows nothing of transport.

### D5 — Module boundaries

```
                 ┌─────────────────────────────────────────────┐
                 │  ingest/    poller → normalizer             │
                 │             command parser + registry       │
                 └──────────────────┬──────────────────────────┘
                                    │ NormalizedEvent
                 ┌──────────────────▼──────────────────────────┐
                 │  gate/      authorization · preconditions   │
                 │             dedupe (unique constraint)      │
                 └──────────────────┬──────────────────────────┘
                                    │ Job
   ┌────────────────────────────────▼──────────────────────────┐
   │  orchestrator/   queue · locks · state machine · recovery │
   └──┬─────────┬──────────┬───────────┬──────────┬────────────┘
      │         │          │           │          │
 ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌────▼────┐ ┌───▼─────┐
 │workspc/│ │context/│ │ agent/ │ │validate/│ │publish/ │
 │worktree│ │ recon  │ │Executor│ │ spawn + │ │ commit  │
 │  mgmt  │ │ prompt │ │ ├Cline │ │ inspect │ │ push    │
 │        │ │        │ │ └Fake  │ │         │ │ report  │
 └────┬───┘ └───┬────┘ └───┬────┘ └────┬────┘ └───┬─────┘
      │         │          │           │          │
      └─────────┴──────────┴─────┬─────┴──────────┘
                                 │
           ┌─────────────────────▼─────────────────────┐
           │  store/ (SQLite)   github/ (Octokit)      │
           │  log/ (structured) config/                │
           └─────────────────────┬─────────────────────┘
                                 │
                       ┌─────────▼─────────┐
                       │  console/ API+UI  │
                       └───────────────────┘
```

Three seams are load-bearing and exist to be swapped: `EventSource` (D4),
`AgentExecutor` (D10), and `GitHubClient`. Everything else is an internal boundary
kept only where it clarifies.

### D6 — Data model

```
repositories        id · owner · name · source_path · workspace_root
                    agent · model · provider · enabled
                    validation_commands (json) · agent_instructions
                    allowed_models (json)

processed_commands  id · repo_id · pr_number · comment_id · command
                    observed_at · outcome · reason · job_id?
                    UNIQUE(repo_id, pr_number, comment_id, command)   ← §11

jobs                id · repo_id · pr_number · comment_id · command
                    thread_id · status · created_at · finished_at
                    current_attempt

attempts            id · job_id · attempt_number · agent · model
                    workspace_path · head_sha_at_prepare
                    started_at · ended_at · agent_exit_code
                    agent_session_id · outcome · failure_stage
                    failure_reason · commit_sha? · pushed (bool)
                    report_status · has_uncommitted_changes (bool)

status_events       id · job_id · attempt_id? · status · at        ← §12 timeline

validation_runs     id · attempt_id · seq · command · exit_code
                    duration_ms · output_ref

log_entries         id · at · level · event · job_id? · attempt_id?
                    fields (json)
```

`processed_commands` is written **before** the job is queued, in the same transaction
that creates the job. Its unique constraint — not application logic — is what makes
at-most-once true across a crash. A duplicate delivery fails the insert and is
recorded as already-processed.

Bulky text (agent stdout/stderr, validation output) is stored as files under the data
directory, referenced by `output_ref`, per Layer1 §22. Structured rows stay small and
queryable.

### D7 — Job state machine

```
                    ┌──────────┐
                    │  QUEUED  │◄──── retry (new attempt, same job)
                    └────┬─────┘
                         │ lock acquired + PR re-verified
                    ┌────▼─────┐
                    │PREPARING │──┐
                    └────┬─────┘  │
                    ┌────▼─────┐  │
                    │ RUNNING  │──┤
                    └────┬─────┘  │
                    ┌────▼─────┐  ├──► FAILED (stage + reason recorded)
                    │VALIDATING│──┤
                    └────┬─────┘  │
                    ┌────▼─────┐  │
                    │PUBLISHING│──┤
                    └────┬─────┘  │
                    ┌────▼─────┐  │
                    │REPORTING │──┘
                    └────┬─────┘
                    ┌────▼─────┐     ┌───────────┐   ┌─────────────┐
                    │SUCCEEDED │     │ CANCELLED │   │ INTERRUPTED │
                    └──────────┘     └───────────┘   └─────────────┘
                                      operator act    startup sweep
```

Layer1 §12 lists twelve states; this is nine. `RECEIVED` and `AUTHORIZED` are
deliberately absent — authorization happens before a job exists, so a job in those
states would be unobservable by construction. `COMMITTING` and `PUSHING` fold into
`PUBLISHING`, which is atomic from the operator's perspective; the `pushed` flag and
`commit_sha` on the attempt already distinguish "committed but not pushed."

Every transition writes a `status_events` row. The failure stage is simply the status
held at the moment of failure, which makes Layer1 §27's "do not collapse all failures
into *something went wrong*" mechanical rather than aspirational.

### D8 — Locking and concurrency

An in-process `Map<string, Lock>` keyed `repo_id:pr_number`, acquired before
`PREPARING` and released in a `finally` that runs on success, failure, timeout, and
cancellation alike. A global semaphore caps simultaneous attempts.

*Why in-memory:* D1 makes it correct — a single process is the only writer. The
restart sweep (D16) covers the case a persistent lock would otherwise handle, and
covers it better: after a crash the truth is "this job was interrupted," not "this
lock is stale."

Queued jobs re-verify PR state at dequeue, not at enqueue. A PR closed while its job
waited fails cleanly before any worktree is touched.

### D9 — Worktree strategy

```
<workspace_root>/pr-<number>/          ← deterministic; number, never branch name

  prepare:
    git -C <source> fetch origin --prune
    resolve head branch + SHA via API      → record head_sha_at_prepare
    if worktree absent:  git -C <source> worktree add <path> <branch>
    if present & clean:  fast-forward to head SHA
    if present & dirty:  FAIL — do not discard
```

The path derives from the registry's `workspace_root` and the PR number only. Branch
names are attacker-influenced (Layer1 §7) and can contain traversal sequences; PR
numbers are integers from the API.

Worktrees are created from the source repository, so they share its object store —
preparation is cheap and no re-clone occurs. The source repository's own working tree
is never checked out, reset, or cleaned; `fetch` and `worktree add` do not disturb it.

**Dirty means stop.** A worktree with uncommitted changes is evidence of a previous
interrupted attempt, and discarding it destroys the only record of what the agent did
before it died. The job fails with a specific reason and the operator decides.
`git reset --hard` and `git clean -fd` exist only inside the explicit workspace-reset
action, which first asserts the target path lies beneath a configured
`workspace_root`.

`head_sha_at_prepare` is re-compared against the remote immediately before pushing. A
force-push mid-run becomes a clean, explained refusal instead of a rejected push
after a full agent run.

### D10 — Agent execution

```ts
interface AgentExecutor {
  run(opts: {
    cwd: string; model: string; provider: string;
    prompt: string; env: Record<string, string>;
    timeoutSec: number; signal: AbortSignal;
  }): Promise<AgentResult>   // stdout, stderr, exitCode, sessionId?, times
}
```

`ClineExecutor` maps that onto the probed surface from Context:

```
spawn("cline", [prompt, "-c", cwd, "-m", model, "-P", provider,
                "--json", "-t", String(timeoutSec),
                "--data-dir", <attempt-scoped dir>,
                "--auto-approve", "true"],
      { env: sanitizedEnv, shell: false })
```

`shell: false` with an argv array is the whole of Layer1 §25's "no arbitrary shell
execution" — untrusted comment text is a single argument no shell ever parses.

`--data-dir` is scoped per attempt, resolving the concurrency hazard noted in Context.
`sanitizedEnv` is built by allowlist rather than by deleting keys from `process.env`,
so the GitHub token cannot reach the agent through an oversight (Layer1 §25 secret
isolation).

`cline history export <sessionId>` yields a standalone HTML transcript; the session
id is captured on the attempt and the export backs the console's agent-output pane,
satisfying Layer1 §18's "detailed logs belong in the local UI."

`FakeExecutor` is a first-class peer, not a test double bolted on later — it is what
makes Layer1 §34 achievable, simulating success, failure, timeout, no-changes,
files-modified, and validation-failure without spending a real invocation.

### D11 — Prompt construction

Assembled deterministically, bounded, in fixed order:

```
  repository + PR number/title + branch          (identity)
  review thread, in order                        (the actual feedback)
  anchored file path + diff hunk                 (locus)
  repository-specific instructions, if configured
  ────────────────────────────────────────────
  fixed resolution instruction block             (Layer1 §14, verbatim intent)
```

The full PR diff is never included — Layer1 §8 is explicit, and the agent has the
worktree. Only the anchored hunk goes in, because that is what the comment refers to.

The instruction block is a constant. Nothing derived from GitHub text alters the
instructions themselves; untrusted content appears only in the clearly delimited
context region above them.

### D12 — Validation

Configured per repository as an argv array per command (D6), spawned in the worktree
with `shell: false`, each recording exit code, duration, and an output reference.

No built-in defaults and no auto-detection: Layer1 §16 forbids inventing universal
commands, and an empty list means inspection-only, recorded as such. This makes the
proposal's scope decision concrete — whoever registers a repository knows its test
command, and one config field ends a problem that is unsolvable in general.

Independent worktree inspection runs regardless: files modified, valid git state,
expected branch still checked out, no conflict markers. Layer1 §16's "agent success
is not command success" is enforced here, never inferred from the agent's own report.

### D13 — Publication

Six preconditions, all required (see the `resolution-publication` spec). The commit
message references the originating comment id for traceability. Push is a plain
`git push origin HEAD:<branch>` — never `--force`, never a branch create or delete,
never a merge.

Reporting failure is recorded separately from publication outcome. A pushed commit
whose reply failed to post stays pushed; retracting published work to tidy a status
field would be worse than the inconsistency.

### D14 — Security model

| Control | Mechanism | Layer1 |
|---|---|---|
| Repository allowlist | registry lookup; unregistered activity discarded | §25 |
| User allowlist | login match, case-insensitive, before any local operation | §7 |
| Self-trigger loop | orchestrator identity excluded from the allowlist | — |
| No shell execution | argv arrays, `shell: false`, everywhere | §25 |
| No path injection | paths from registry + integer PR number only | §25 |
| Argument validation | model/agent args checked against `allowed_models` | §25 |
| Secret isolation | allowlist-built child env; token never in agent env or prompt | §24 |
| Console access | loopback bind + required token | *gap closed* |
| Redaction | configured secret values filtered from displayed output | §24 |
| Audit | `processed_commands` + `status_events` + `log_entries` | §25 |

The console control is the one this design adds rather than inherits. Layer1 §23
names UI ports but never constrains them, while the console's retry and rerun
endpoints are remote code execution by design — an unauthenticated bind would give
away every other control in the table.

### D15 — Console structure

Fastify serving server-rendered HTML, with htmx for interaction and SSE for live
updates. No separate frontend build, no client bundle, one process.

*Why:* Layer1 §20 asks for an engineering control panel and warns against visual
complexity. The surface is three list views, a detail view, a handful of POST
actions, and a streaming log tail — precisely what htmx does without a toolchain. A
React SPA would add a build step, a dev server, and an API contract to maintain, in
exchange for interactivity this UI does not need.

```
  /                      dashboard: status · repos · running · queued · recent
  /jobs/:id              timeline · feedback · agent output · validation · commit
  /jobs/:id/stream       SSE: status transitions + output tail
  /jobs/:id/retry        POST
  /jobs/:id/cancel       POST
  /repos/:id/toggle      POST
  /workspaces/:id/reset  POST — confirmed, visually separated (§21)
```

Every route requires the token from D14.

### D16 — Failure and recovery

Failures are values, not exceptions escaping the loop. Each stage returns a typed
outcome; the orchestrator records `failure_stage` + `failure_reason` and moves the job
to `FAILED`. Layer1 §27's enumerated failures each map to a distinct reason code.

On startup, a sweep marks every job found in a non-terminal status as `INTERRUPTED`,
preserving all recorded detail and output. Nothing re-executes automatically — Layer1
§28 is explicit, and auto-resume after a crash is exactly how one half-applied agent
edit becomes two. The operator retries deliberately.

An interrupted job's worktree is left dirty on purpose, which means D9's "dirty means
stop" fires on the next attempt — the operator sees the leftover state and chooses
between inspecting it and resetting it.

### D17 — Test strategy

| Layer | Approach |
|---|---|
| Command parsing | table-driven: fences, quotes, placement, unknown tokens |
| Authorization | each precondition failing independently, reason asserted |
| Idempotency | duplicate insert rejected by the constraint, not by a code path |
| State machine | transitions and timeline rows |
| Worktree | real git against temp repositories — cheap and high-value |
| Agent | `FakeExecutor` across all six simulated outcomes |
| GitHub | recorded fixtures behind the `GitHubClient` seam |
| End-to-end | fake agent + real git + fixture GitHub, exercising §39's scenario |

The seams from D5 exist partly for this: the §39 acceptance path runs in CI with zero
agent spend and no network. Layer1 §34's required behaviors — unauthorized rejected,
duplicate not executed twice, same PR not concurrent, failed agent does not push,
restart does not duplicate, malformed data executes no shell — each become a test at
the layer that owns the guarantee.

### D18 — Build order: walking skeleton first

Layer1 §36 proposes nine bottom-up phases with nothing running end-to-end until phase
six. This design inverts the first move: build a thin vertical slice — one registered
repository, `FakeExecutor`, real worktree, real commit, real push, real GitHub reply —
before thickening any stage.

*Why:* the risky assumptions here are integration assumptions (does the worktree
round-trip work, does the push land, does the reply post, does dedupe hold), not
algorithmic ones. A skeleton answers them in the first phase instead of the sixth, and
costs nothing extra — every piece is required anyway, and `FakeExecutor` is mandated
by §34 regardless. Task ordering in [tasks.md](tasks.md) follows this.

## Risks / Trade-offs

**The agent is not sandboxed** → Accepted, not mitigated. A git worktree is a
directory, not a boundary: the agent runs with the invoking user's privileges and can
reach the developer's primary checkout that D9 exists to protect. Bounded by the
author allowlist, per-attempt state isolation, an allowlist-built environment
excluding orchestrator secrets, and full auditability. Process-level confinement is a
candidate follow-up change.

**Untrusted text reaches the agent prompt by design** → Structurally unavoidable: the
review comment *is* the instruction (Layer1 §8). Bounded by D11's fixed instruction
block and delimited context region, and by the requirement that the triggering
command's author be allowlisted. Not defended against a malicious comment authored by
a third party on a repository the operator owns and reviews.

**Polling latency and rate limit** → Conditional requests make unchanged repositories
nearly free; the interval is configurable. If latency becomes objectionable, D4's seam
makes webhooks a drop-in.

**Unbounded worktrees and logs** → Accepted for MVP and recorded. Both grow with job
count; neither is reclaimed. Disk pressure is the failure mode, and it is visible in
the console before it becomes fatal.

**Single process is a single failure domain** → A crash stops ingestion, execution,
and the console together. Mitigated by the startup sweep, which makes the consequences
explicit and recoverable rather than silent.

**Cline CLI surface may shift across versions** → The executor depends on documented
flags of a fast-moving tool. Isolated behind `AgentExecutor`; a version check at
startup surfaces drift as a clear configuration error rather than a confusing runtime
failure.

**In-memory locking assumes exactly one process** → True by D1, but a second
orchestrator started against the same database would violate it. Mitigated by a
startup exclusivity check on the data directory.

## Migration Plan

Greenfield: nothing to migrate. Deployment is `install → configure → register a
repository → start`. Rollback is stopping the process; published commits are ordinary
commits on the PR branch and are reverted through normal git means.

Schema changes during development use ordered migration files applied at startup,
established from the first migration so the pattern exists before it is needed.

## Open Questions

- **Poll interval default.** Starts at 60s. Needs real use to tune, and changing it
  touches no spec, decision, or task.
- **Agent transcript retention.** Deferred by the proposal. When it becomes a real
  problem, the shape of the answer (an age or count cap over `output_ref` files) does
  not change any decision here.
- **Provider/model identifiers.** Layer1 names "Luna"; these are opaque configured
  strings validated against `allowed_models`, resolved by the operator through
  `cline auth`. No design dependency on their values.
