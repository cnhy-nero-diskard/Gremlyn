## Why

Five operator-facing defects make routine use of Gremlyn unpleasant, and two of
them block restarts outright. A browser tab left open on the console prevents the
process from ever shutting down, which strands `.gremlyn.lock` and forces a manual
delete before every rerun. The dashboard's model picker silently substitutes a
different model when the live catalog re-renders, then persists that substitution
on the operator's next unrelated edit. Every wall-clock time in the UI is rendered
in UTC. Several console surfaces never update without a manual reload. And nothing
ever reclaims per-pull-request workspaces or captured output, so disk use grows
without bound.

A sixth defect blocks work outright rather than merely annoying: a pull request
whose branch is already checked out in one of the operator's own worktrees
cannot be worked on at all. Preparation refuses with `workspace-branch-in-use`,
and that reason is classified as terminal, so no retry ever clears it. This is
the ordinary state whenever a second agent is working the same branch — the very
situation the tool exists to cooperate with — and the operator's only recourse
today is to tear down their own worktree.

## What Changes

**Instance lock and shutdown**

- Shutdown terminates held-open SSE streams before closing the HTTP server, so
  `close()` cannot block on a connection that never ends.
- A repeated interrupt escalates to a forced exit instead of being swallowed by
  the already-stopping guard.
- The lock is released on every exit path — early startup failure, crash,
  unhandled rejection, and additional termination signals — not only on a clean
  `SIGINT`/`SIGTERM`.
- Lock acquisition reclaims a lock whose recorded process is no longer alive, and
  reports the reclamation. A lock held by a live process is still refused.
- A deliberate operator override exists for the case where automatic staleness
  detection cannot decide.

**Per-repository provider and model fidelity**

- The picker treats the persisted repository record as authoritative and never
  silently substitutes a different model when a catalog re-render cannot find the
  saved one; an unknown saved value is preserved as an explicit current selection.
- Editing one field no longer rewrites the others. Changing reasoning effort
  persists reasoning effort only.
- A saved provider that the repository's agent kind does not offer is surfaced as
  a mismatch to correct, rather than being quietly demoted to a free-text custom
  provider.

**Local time**

- Wall-clock times render in the operator's local timezone, with an optional
  configured override. Stored timestamps remain UTC and unchanged.

**Proactive console**

- Time-derived displays (relative timestamps, elapsed durations, poll freshness
  and staleness) advance on their own instead of only when an unrelated database
  row changes.
- Change detection covers per-repository provider, model, effort and timeout, and
  validation runs.
- The command ingestion and operator audit views update live.
- The dashboard header's status and summary update with the rest of the page.

**Workspace and artifact reclamation**

- Workspaces for pull requests with no active work are reclaimed automatically
  under conservative, auditable conditions, handling both linked worktrees and
  standalone fallback clones.
- A workspace with uncommitted work is never reclaimed automatically; it is
  reported instead.
- Captured agent output and validation artifacts are subject to a retention
  policy.
- A report-only mode shows what reclamation would remove before it is armed.

**A branch already checked out elsewhere**

- A branch held by a checkout other than the configured source repository no
  longer fails the job outright. Preparation falls back to an independent clone
  beneath the workspace root — the same shape already used when the source
  checkout itself holds the branch.
- A repository may opt in to adopting that existing checkout instead, so a
  second agent working the same branch and this system share one working tree
  rather than accumulating two.
- Adoption requires the existing checkout to be clean and fast-forwardable to the
  pull request head. It never resumes another tool's uncommitted work, which is a
  distinct thing from resuming this system's own interrupted attempt.
- An adopted checkout is never reset, reclaimed, or removed, and is claimed for
  the duration of an attempt in a way the other tool can observe.
- `workspace-branch-in-use` survives only for the case where neither adoption nor
  an independent clone is possible.

## Capabilities

### New Capabilities

- `runtime-lifecycle`: Single-instance ownership of the data directory and
  orderly process shutdown — how the instance lock is acquired, when it may be
  reclaimed, how it is released across every exit path, and how a shutdown that
  cannot complete is escalated.

### Modified Capabilities

- `operator-console`: Live progress broadened from running-job status and output
  to every operator-monitored surface and to time-derived displays; wall-clock
  rendering in local time; repository configuration edits must persist exactly
  the field edited and must not substitute unselected values.
- `repository-registry`: Operator-selected provider, model and reasoning effort
  are durable per-repository state that survives restart and outranks file
  configuration for an existing entry.
- `workspace-isolation`: Automatic reclamation of workspaces with no active work,
  and retention limits for captured artifacts — a deliberate narrowing of the
  existing rule that discarding working-tree contents happens only through an
  explicitly requested reset. Also a resolution order for a branch already
  checked out elsewhere, including opt-in adoption of an existing checkout the
  system did not create — a deliberate widening of where an agent may run, paired
  with a guarantee that such a checkout is never a destructive target.

## Impact

- `src/orchestrator/instance-lock.ts` — staleness detection, reclamation,
  tolerant release.
- `src/index.ts` — shutdown ordering, signal and crash coverage, forced exit,
  release on early failure; reclamation sweep wiring.
- `src/console/server.ts` — SSE stream registry and shutdown draining; streams
  for the commands and audit routes.
- `src/console/stream.ts` — heartbeat emission, change-signature coverage,
  signature cost.
- `src/console/assets.ts` — picker render fidelity, per-field persistence,
  local-time hydration, self-advancing timestamps.
- `src/console/views/components.ts` — `clockTime` and `logClock` timezone
  handling; `dashboard.ts` header region boundaries.
- `src/workspace/` — a reclamation module reusing the existing `isBeneath` and
  `workspacePathFor` guards and the `statusEntries` cleanliness check.
- `src/workspace/worktree.ts` — the resolution order for a held branch, adoption
  preconditions, the attempt claim, and the independent-clone fallback for a
  holder that is not the source checkout.
- `src/orchestrator/failures.ts` — `workspace-branch-in-use` narrows to the case
  where no workspace of any shape can be produced.
- `src/config/loader.ts` — retention, reclamation, timezone and per-repository
  worktree-adoption settings; `config.example.yaml` and `README.md`
  documentation.
- No schema change is required for reclamation decisions: `jobs` already carries
  `repo_id`, `pr_number` and `status`, and `operator_actions` already records
  destructive outcomes. Nor for adoption: `attempts.workspace_path` already
  records the path an attempt actually used, which is what makes an adopted
  checkout visible after the fact.
