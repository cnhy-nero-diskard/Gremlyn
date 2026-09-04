## Context

See proposal.md — Why. This section records only what was established by
diagnosis, because several of the decisions below depend on the exact mechanism
rather than on the symptom.

**Shutdown deadlock.** `DataDirectoryLock.release()` is the last statement of
`stop()` in `src/index.ts`, after `await consoleServer.close()`. The console's
live-update route hijacks the reply and holds the response open indefinitely.
Fastify is constructed without `forceCloseConnections`; with that option unset
and no `serverFactory`, Fastify closes no sockets on shutdown and `server.close()`
waits for every in-flight request to end. An SSE stream never ends, so
`close()` never resolves and `release()` is never reached. Because `stop()` is
registered with `process.once` and latches on a `stopping` flag, the default
`SIGINT` behavior is gone and a second interrupt is a no-op: the process cannot
be stopped from the terminal at all. This is the whole of the reported symptom —
the lock is stranded because the process never exits, not because release is
wrong.

**Model substitution.** The bundled fallback catalog and the live Cline feed order
the ClinePass models differently — `cline-pass/glm-5.3-flash` is first in the
fallback, while the live feed returns `cline-pass/deepseek-v4-pro` first. The
console renders pickers from the bundled catalog, then re-renders them from the
live catalog after `/model-catalog` resolves. In that re-render, when a saved
model cannot be matched to an option for its provider, `syncPicker` assigns the
provider's *first* option instead. Three properties turn that into persisted
corruption:

1. re-render reads its "current" values from the previous DOM, not from the
   persisted record, so one substitution becomes the new baseline;
2. the `change` handler calls the combined save for reasoning effort as well, and
   that save posts provider, model and effort scraped from the DOM;
3. the live-update swap replaces the repository region wholesale and restores the
   previous DOM values over freshly rendered ones.

The operator audit table confirms the mechanism end to end: on three occasions
`repository:1` was written to `cline-pass/deepseek-v4-pro` and corrected back to
`cline-pass/glm-5.3-flash` within five seconds, and `repository:16` shows the
same shape with `opencode/big-pickle` — in each case the substituted value is
exactly the first live catalog entry for that provider. One earlier row records
`cline-pass` paired with `gpt-5.6-luna`, a model belonging to a different
provider, which is the same fault crossing a provider boundary.

Note that persistence itself is sound: `syncRepositories` deliberately excludes
`model`, `provider` and `effort` from its `ON CONFLICT DO UPDATE` and reads back
the winning row, and the live database holds the operator's selections. The
defect is confined to the console's render-and-write path.

**Timezone.** `clockTime` and `logClock` in `src/console/views/components.ts`
extract the time field from an ISO string with a regular expression, so they
render the UTC field verbatim. Storage is correct and stays as it is. `duration`
and `relativeTimestamp` are differences and are already correct.

**Update coverage.** `SharedChangeTicker` emits only when a signature over the
database changes. Anything derived from the passage of time therefore freezes,
including the poll-freshness metric and the `stale` flag — the one indicator
whose purpose is to detect that nothing is happening cannot fire when nothing is
happening. The signature also covers `repositories.enabled` only, omits
`validation_runs` rows without an output reference, and is computed by
`GROUP_CONCAT` over all jobs and all attempts plus a `statSync` per output file,
four times a second. The command-ingestion and audit routes have no stream at
all, and the dashboard header's status pill and summary are rendered outside any
swapped region.

**Workspace accumulation.** Nothing reclaims workspaces. On the development
machine, `Backlogium-workspaces` holds six `pr-*` directories dating to Aug 29
and `.gremlyn/output` holds 198 MB. Critically, `git worktree list` in that
source repository reports only `pr-84`: the other five are standalone fallback
clones or worktrees whose registration was pruned, so `git worktree prune` and
`git worktree remove` cannot reclaim them. The same source repository has
operator-owned worktrees at sibling paths *outside* the workspace root.

**Branch held by another checkout.** `createWorkspaceCheckout` resolves a held
branch in two ways and then gives up. It prunes stale registrations, and if the
holder is the configured source checkout it falls back to an independent clone.
Any other holder raises `workspace-branch-in-use`, which `classifyFailure` maps
to a terminal reason on the stated grounds that "the operator has to release that
worktree, and no retry will help". Job 50 on `Backlogium#131` died there at
`preparing` with no workspace, no agent run, and nothing to retry: the branch
`fix/auditfix-poller-log-hygiene` was held by an operator worktree at
`…/Backlogium-fix-auditfix-poller-log-hygiene`, a live sibling of the same kind
this change already excludes from reclamation. The refusal itself is sound — a
second checkout of a branch another live working copy owns would corrupt it — but
the conclusion drawn from it is not, because a clone was available and was simply
never attempted for that holder.

## Goals / Non-Goals

**Goals**

- Shutdown always terminates and always releases the data directory claim.
- A stale claim never requires manual file removal.
- The persisted repository record is the only input to the picker's selection.
- Wall-clock times read as local time without losing the underlying instant.
- Monitored surfaces stay current without a reload, including time-derived ones.
- Workspace and artifact disk use is bounded, with uncommitted work protected.
- A branch already checked out elsewhere never leaves a job with nowhere to run.
- Sharing a checkout with another tool is possible, and is something the operator
  asks for rather than something that happens to them.

**Non-Goals**

- Replacing polling-based change detection with a write-notification event bus.
  The ticker's cost is bounded here instead; the seam is noted below so the
  larger change stays available.
- Cross-machine or network-filesystem locking. The claim remains advisory and
  local, sufficient for a loopback single-operator tool.
- Reclaiming anything outside a configured workspace root, or any path the system
  did not itself derive. Adoption widens where an agent may *run*; it does not
  widen where anything may be *deleted*.
- Arbitrating concurrent edits between this system's agent and another tool
  inside a shared checkout. The claim in D11 is advisory, and the preconditions
  narrow the window rather than closing it.
- Changing how timestamps are stored, or introducing a second time
  representation in the database.

## Decisions

### D1. Terminate live-update streams during shutdown, rather than forcing all connections

The console keeps a registry of open live-update streams. Shutdown ends every
registered stream, then closes the server, then releases the claim.

*Alternatives considered.* `Fastify({ forceCloseConnections: true })` destroys
every socket on close, which also works but is blunt: it would abort an ordinary
in-flight request mid-response, and it makes correct shutdown depend on a
framework option rather than on the code that created the long-lived streams.
Ending the streams we deliberately held open is narrower, and leaves normal
requests to drain as they do today. `closeIdleConnections()` alone is
insufficient — an SSE stream is active, not idle.

The stream registry is also what makes the runtime-lifecycle requirement
testable without a browser: a test opens a stream, requests shutdown, and
asserts the process settles.

### D2. Ownership release is a `finally`, not a shutdown step

`main` wraps everything after the claim in `try/finally` so that a startup
failure — missing credentials, an unusable agent binary, a token authenticating
as the wrong account, all of which occur after `acquire` today — releases the
claim on the way out. `release()` becomes idempotent and swallows its own errors
after reporting them, so it cannot abort the rest of shutdown.

A synchronous best-effort release is additionally registered on `exit`, and on
`uncaughtException`/`unhandledRejection`, and the signal set is widened to
include `SIGHUP` and `SIGBREAK`. These are belt-and-braces: `exit` handlers must
be synchronous, which is why the release path must not depend on any async work.

*Alternative considered.* Relying only on staleness reclamation (D3) and
accepting stranded lock files. Rejected: reclamation is the safety net for
`SIGKILL` and power loss, not a licence to leak on paths we control.

### D3. Staleness by process liveness, with an explicit operator override

`acquire` on an existing claim reads the recorded process id and probes it with
signal `0`. A dead or unparseable owner is reclaimed and the reclamation is
reported at warn level. A live owner is refused, as today.

`gremlyn unlock <data-dir>` (added to the existing setup CLI alongside `setup`,
`add-repo` and `verify`) removes a claim without starting the orchestrator, and
requires explicit confirmation when the recorded owner is live.

*Alternatives considered.* A heartbeat — the owner touches the claim on an
interval and staleness is "dead pid **or** mtime older than 3× the interval" —
is more robust against process-id reuse, but adds a timer and a tuning constant
to defend against a scenario that the explicit override already covers. Chosen
against for now; the claim file's format leaves room to add a heartbeat
timestamp later without changing the requirement. An OS advisory lock (`flock`)
would be the most correct answer but has no portable Node binding, and the
Windows semantics differ enough to be a project of its own.

The residual risk is process-id reuse producing a false "live owner" and a
refused start; the override exists precisely for that, and the message names it.

### D4. The persisted record is the only render input for a picker

The picker already carries `data-saved-provider`, `data-saved-model` and
`data-saved-effort` on its root, set at first render and updated after each
successful save — but render reads the DOM controls instead, and the saved
attributes are used only to roll back a failed save. Those attributes become the
sole render input. Every render — first paint, catalog refresh, live-update swap
— derives the selection from them, never from the controls it is about to
rewrite. This removes the compounding property: a bad paint can no longer become
the next paint's baseline.

The substitution is removed outright: when a saved model has no matching option
for its provider, it is added as an explicit current option, as the code already
does for the server-rendered path and for `renderLivePicker`'s matching-provider
case. There is no remaining branch in which the picker chooses a model the
operator did not.

*Alternative considered.* Re-fetching the persisted record over HTTP before each
render. Rejected as redundant: the attributes are already maintained from
authoritative save responses, and a fetch introduces a window in which the
controls show one thing and the record another.

### D5. Reasoning effort saves on its own; provider and model stay coupled

Effort gets its own endpoint and its own save path, so changing effort cannot
write a model. Provider and model remain a single atomic save, because changing
a provider legitimately changes the model and two sequential writes would leave
a transiently invalid pair persisted. Repository-level provider and model
endpoints already exist (`POST /repos/:id/provider`, `POST /repos/:id/model`)
and are unused by the console; the combined endpoint stays as the console's
path, and the effort endpoint joins the per-field set.

### D6. Regions declare whether a heartbeat re-renders them

The ticker gains a heartbeat: with at least one subscriber it emits at least once
per second, whether or not the signature changed. That alone would re-render the
repository cards every second and fight every picker interaction — making D4's
problem worse rather than better. So the emission carries its kind, and each
region declares its policy:

```
                      on change   on heartbeat
  health-region           ✓            ✓      (`stale` is a server judgment)
  job-lanes               ✓            ✗      (time text handled client-side)
  repositories            ✓            ✗      (never clobber an open picker)
  job-detail / job-log    ✓            ✗
```

The repository region is additionally suppressed while a picker within it holds
focus or has a save in flight, and picker controls are removed from the generic
"restore previous input values" path so a swap can no longer reinstate stale DOM
values over freshly rendered ones.

### D7. Time is rendered once server-side and re-derived client-side per second

Every timestamp is emitted as an element carrying its exact UTC instant and the
format it should be displayed in — clock, relative, or elapsed. The server
renders the initial text, so the page is correct with JavaScript disabled and
there is no flash of UTC. A one-second client tick re-derives `relative` and
`elapsed` text from the carried instant. Those two formats are timezone
independent, so the client needs no timezone knowledge and the two concerns stay
separate.

Wall-clock (`clock`) formatting moves to `Intl.DateTimeFormat` on the server,
using the host's zone by default and an optional `console.timezone` setting as an
override. The console binds to loopback and serves one operator, so the host's
zone is the operator's zone in the normal case; the setting covers the remote
case without inventing per-request timezone negotiation.

The underlying UTC instant stays on every element, which is what keeps a
rendered time unambiguous when it is copied into a bug report.

*Alternative considered.* Formatting wall-clock times client-side from the
carried instant, giving each viewer their true local zone. Better in principle,
but it puts the formatting rule in the client script where it cannot be unit
tested, and it reintroduces a UTC flash before hydration. `clockTime` and
`logClock` are pure functions today and stay that way.

### D8. Bound the change signature rather than replace the mechanism

The signature is narrowed to non-terminal jobs and attempts plus a bounded window
of recent rows, and widened in coverage to include each repository's provider,
model, effort and timeout, and `validation_runs` rows. Coverage is what the
requirement needs; the narrowing is what keeps a four-times-a-second query from
degrading as the job table grows.

Streams are added to the command-ingestion and audit routes. The dashboard
header's status pill and summary move inside the health region so they are
swapped with it.

*Alternative considered.* Having the store and orchestrator notify subscribers on
write, making change detection O(1) and exact. This is the right long-term
shape and the heartbeat introduced in D6 is a prerequisite for it either way,
but it reaches into every write path and is out of scope here. The ticker keeps
its current interface so that substituting a notification source later does not
touch the routes or the views.

### D9. Reclamation is its own module, reusing the existing path guards

A workspace is a reclamation candidate only if `workspacePathFor` derives its
exact path and `isBeneath` places it under the configured root — the two checks
`resetWorkspace` already performs. This is what keeps the operator's own
sibling worktrees (`…/Backlogium-feat-*`, outside the root) out of scope
structurally rather than by a name filter, and it is why no new path logic is
introduced.

Eligibility is the conjunction specified in the spec: derived path, no
non-terminal job for that repository and pull request, clean tree, and older than
a configured minimum age. Every predicate fails closed — an error determining any
of them retains the workspace. `statusEntries` already provides the cleanliness
check.

Removal must handle both shapes found on disk. `git worktree remove --force`
from the source repository is attempted first; on failure the directory is
removed directly and `git worktree prune` reconciles the registry — the same
two-step `resetWorkspace` already uses, which is what makes standalone fallback
clones reclaimable.

*On the GitHub signal.* "The pull request is merged or closed" is the strongest
evidence a workspace is finished, but it couples reclamation to network
availability and costs a call per candidate. It is not part of eligibility.
Local state is sufficient and always available, and the age threshold covers the
lag. If it is added later it can only ever *narrow* eligibility, so it needs no
spec change.

*Trigger.* A sweep at startup, mirroring the existing `cleanupStaleAttemptDirs`
call site, plus a periodic sweep on the poll timer. Preview is a CLI mode, so an
operator can see the decisions before the sweep is enabled. Reclamation is
disabled by default: it deletes things, and the first release should require the
operator to turn it on after looking at a preview.

### D10. Artifact retention is by age and total size, and job views tolerate absence

Captured output, validation artifacts and per-attempt state for terminal jobs are
trimmed by age and by a total size ceiling. `readOutput` already returns an empty
string for a missing file, so a job view degrades rather than failing; the change
is to say so in the view instead of silently showing nothing. `output_ref` is
left in place — a row pointing at a trimmed file is the record that it existed.

### D11. A held branch resolves to adoption or a clone; refusal is the last resort

`createWorkspaceCheckout` gains a third and fourth outcome, in this order: prune,
then source-holder to a clone (both as today), then — for any other holder — adopt
the holding checkout if the repository opted in and every precondition holds, and
otherwise clone. `workspace-branch-in-use` is left as the reason for the single
case where no workspace of any shape can be produced, which today is a source
checkout with no usable `origin`; that case currently reports `workspace-diverged`
and is corrected to the accurate reason as part of this.

The clone fallback is the important half. It requires no configuration, no new
trust, and no new code — `createStandaloneCheckout` already exists and is already
exercised by the source-holder path — and it alone turns the reported failure into
a job that runs. Adoption is the answer to a different question: whether the two
tools share one working tree instead of accumulating a second one.

*Adoption is opt-in per repository and off by default.* Every other guarantee in
`workspace-isolation` rests on the agent running beneath a configured workspace
root; adoption is the one place that stops being true, and the operator should be
the one who decides it. This also matches how reclamation and retention ship in
this change — the behaviors that touch things the operator owns are the behaviors
they must switch on.

*Preconditions are the same clean-state checks preparation already performs* —
on-branch, not detached, no unmerged entries or merge in progress, no
`statusEntries`, fast-forwardable to the recorded head. A checkout failing any of
them is left exactly as found and preparation clones instead. Crucially, the
dirty case must not route into `resumeDirtyWorkspace`: that flag exists to resume
*this system's own* abruptly-ended attempt in a workspace it created, and reusing
it for a foreign tree would commit and push another tool's work-in-progress under
this system's authorship. The distinction is worth stating in the spec because the
code path is superficially identical.

*An adopted checkout is structurally undeletable.* `resetWorkspace` and the
reclamation module of D9 both gate on `workspacePathFor` deriving the exact path
and `isBeneath` placing it under the configured root. An adopted path satisfies
neither, so both already refuse it — the guards fail closed in the direction we
want. The spec states the guarantee anyway, since it is now load-bearing rather
than incidental.

*The claim lives in the worktree's git admin directory*, at the path
`git rev-parse --git-dir` reports — `<source>/.git/worktrees/<name>` for a linked
worktree. That location is outside the working tree, so the claim cannot appear
in `git status`, cannot be committed, and cannot trip the very cleanliness check
that admitted the adoption. It is discoverable by any tool willing to run one
`rev-parse`, which is what makes it a coordination point with the other agent
rather than a private lock. It carries the attempt id and owning process id and
is reclaimed on a dead owner, reusing D3's liveness probe rather than inventing a
second staleness rule.

*Alternatives considered.* **Adopt by default.** Tidier, no setting to remember,
and it is what the operator asked for in the reported case — but it means writing
into directories outside every workspace root without anyone having asked, which
inverts the guarantee the capability is named for. **Adopt or fail, with no clone
fallback.** Minimal disk and it forces the shared-tree workflow, but a live
agent's worktree is dirty most of the time, so the common case would block a job
exactly as it does today. **Keep the refusal and expose an operator override.**
Rejected because the override would be a manual step on a condition the system can
resolve by itself. **A branch-level lease negotiated through the source repo's
config.** More general, but it needs the other tool to participate before anything
works, whereas a clone fallback needs nothing from anyone.

## Risks / Trade-offs

**Reclamation deletes an operator's work** → Eligibility is a conjunction of four
independently sufficient-to-refuse predicates, every one fails closed, dirty
trees are reported rather than removed, the target path must be one the system
itself derives beneath a configured root, it is off by default, and a preview
mode exists. Every decision is recorded through the existing operator-action
audit, which is what let this diagnosis happen at all.

**Another tool edits an adopted checkout while an attempt is running** → Its
edits are swept into the attempt's commit under this system's authorship, and
pushed. This is the real cost of sharing a tree, and it cannot be fully closed:
a working-tree change carries no attribution, so publication cannot tell whose it
is. It is narrowed by requiring a clean tree at adoption, by the discoverable
claim, and by the head re-verification that already runs before publication. It
is bounded by being opt-in — a repository that has not asked for adoption cannot
encounter it at all.

**An adopted checkout is not disposable, so preparation guarantees weaken** → A
workspace the system created can always be reset into a known state; an adopted
one never can, because resetting it is forbidden. The preconditions compensate by
admitting only a checkout that is *already* in the known state, and a checkout
that drifts out of it is simply not adopted next time — preparation clones and the
job still runs.

**A stale claim blocks adoption of a checkout nobody is using** → The claim
records its owning process and is reclaimed when that process is not alive, the
same rule as D3. A claim that survives anyway costs a clone, not a failure.

**Process-id reuse makes a stale claim look live** → Start is refused with a
message naming the possibility, and `gremlyn unlock` overrides it. The claim
format leaves room for a heartbeat timestamp if this proves real.

**Ending live-update streams during shutdown could truncate a response an
operator is reading** → It is a shutdown; the alternative is a process that
cannot exit. Ordinary requests still drain normally.

**A one-second heartbeat costs a health-region render per second per client** →
Only while a client is subscribed, and only for the smallest fragment; the
regions that are expensive to render are explicitly excluded (D6).

**Suppressing repository re-renders during picker interaction can show a stale
card** → Bounded to the duration of the interaction, and the alternative is the
clobbering that contributed to the original defect. The card refreshes on the
next emission after focus leaves.

**Per-field saves multiply endpoints** → Two of the three already exist and are
unused; provider and model stay coupled precisely to avoid an endpoint per field
where the fields are not independent (D5).

**The retention ceiling could remove artifacts an operator still wants** →
Terminal jobs only, never live ones, and the job view reports the absence
explicitly instead of presenting an empty panel as if it were empty output.

## Migration Plan

No schema migration is required: reclamation reads `jobs.repo_id`,
`jobs.pr_number` and `jobs.status`, and records through `operator_actions`, all
of which exist.

Adoption ships disabled per repository, and the clone fallback ships enabled
because it strictly replaces a failure with a working outcome and needs no
decision from the operator.

Reclamation and artifact retention ship disabled. The rollout is: upgrade, run
the preview, then enable in configuration. Rollback is turning them back off —
nothing else in the change is stateful.

The lock file's contents change from a bare process id to a parseable record.
Both directions are handled by treating an unparseable claim as abandoned, so a
downgrade sees the new format as reclaimable rather than as a live owner, and an
upgrade sees the old bare-id format the same way. This is the intended behavior
in both directions and needs no operator action.

## Open Questions

- Whether the ClinePass and Codex catalog entries should be selectable for an
  OpenCode repository, and the OpenCode entry for a Cline repository. The
  console currently filters by executor kind, which is what demoted the
  operator's `opencode` selection on a `cline` repository to a free-text custom
  provider. This change reports the mismatch rather than hiding it, which is
  correct either way; whether the underlying pairing is legitimate is an
  agent-execution question that can be answered without revisiting these specs.
- Whether an adopted checkout should also be offered for a repository whose
  configured source checkout holds the branch — that is, adopting the developer's
  primary working copy. Deliberately excluded here, because "developer checkouts
  are never mutated" is the oldest requirement in this capability and relaxing it
  deserves its own change rather than a clause in this one.
- The default minimum age for workspace reclamation and the default artifact
  retention ceiling. Both are configuration values with no behavioral
  dependency, and the preview mode is the right way to choose them.
