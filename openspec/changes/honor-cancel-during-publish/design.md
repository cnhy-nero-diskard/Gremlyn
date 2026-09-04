## Context

See proposal.md — Why. The mechanics that matter for the approach:

- `publishIfEligible` (`src/publish/policy.ts`) evaluates the preconditions, calls
  `commitAll`, then `pushHead`. It takes no `AbortSignal` and imports nothing from
  the orchestrator; the commit→push boundary exists only inside this function.
- The publishing stage in `src/orchestrator/resolution.ts` awaits that call as a
  single opaque step. Its one `signal.aborted` check sits before validation.
- The state machine in `src/store/jobs.ts` already allows `publishing → cancelled`,
  and `cancelJob(jobId, attemptId, hasUncommittedChanges)` already exists. The
  infrastructure for a cancelled publish is present; nothing ever reaches it.
- `recordPublication(attemptId, commitSha)` is called only on the success path, so
  today a recorded commit implies a pushed commit.

## Goals / Non-Goals

**Goals:**

- Cancellation is observed at both publishing boundaries: before the commit, and
  between the commit and the push.
- A cancelled publish stays distinguishable from a failed one in the attempt record
  and in what reaches the pull request.
- A commit created before a cancel is retained and recorded as unpushed, so a later
  retry has an accurate starting picture.

**Non-Goals:**

- Interrupting a git subprocess mid-operation. A cancel arriving during a push still
  waits for that push to return.
- Changing the operator console, the cancel API, or the shape of the cancel request.
- Revisiting cancellation during preparing, running, or reporting beyond what the
  existing checks already do.

## Decisions

### Thread the signal into `publishIfEligible` rather than checking around it

The meaningful checkpoint is *between* the commit and the push, and that boundary
exists only inside `publishIfEligible`. Checking `signal.aborted` in
`resolution.ts` before and after the call cannot reach it: by the time the call
returns, the push has already happened. So the signal is passed in.

*Alternative considered:* split `publishIfEligible` into `commitIfEligible` and
`pushCommit`, letting the orchestrator interleave its own checks. Rejected — it
moves the ordering guarantee ("commit and push only after every precondition
passes") out of the module that currently owns it and into the caller, where a
future caller can get the order wrong. The signal is the smaller intrusion.

### Return a cancelled result; do not throw from the policy module

`publishIfEligible` returns `{ kind: "blocked" } | { kind: "published" }`. Add a
third kind — `{ kind: "cancelled"; commitSha?: string }` — rather than throwing.

The policy module has no dependency on the orchestrator's error types today, and
`AbortSignal.throwIfAborted()` would raise a DOM `AbortError` that the orchestrator
would have to pattern-match. A third result kind keeps the module honest about the
three things that can actually happen and forces the caller to handle the new case
at the type level.

`commitSha` is present when the cancel landed after the commit, absent when it
landed before. That distinction is exactly what the spec requires the job record to
carry, so it is carried in the return value rather than re-derived.

### Cancellation is not a `StageFailure`

The orchestrator maps `{ kind: "blocked" }` to `throw new StageFailure(stage,
reason)`, which records a failure reason and reports it to the pull request. A
cancelled publish must not travel that path: it is not a judgement about the work,
and `resolution-publication` now requires the two to stay distinguishable.

Instead the publishing stage raises the same `job-cancelled` error the pre-validation
check already uses, so cancellation converges on one existing path and `cancelJob`
does the recording. No new failure reason is added to `FAILURE_REASONS`.

### Record the commit at creation, not at push

To report "an unpushed commit is present", the commit sha has to be recorded before
the push is attempted. Move the `recordPublication` call to just after the commit
succeeds, and let the existing `pushed` column carry whether it left the machine.

This makes `commit_sha != null AND pushed = 0` the representation of a
committed-but-unpushed workspace — a state that is currently unreachable and
therefore unambiguous. It also fixes a smaller latent gap: a push that fails today
loses the sha of the commit it was pushing.

*Alternative considered:* a separate `unpushed_commit_sha` column. Rejected as
redundant — `pushed` already answers the question the extra column would encode.

## Risks / Trade-offs

- **The check is inherently racy: a cancel can land immediately after the last
  check and before `pushHead` starts.** → Accepted and stated as the guarantee's
  shape: no push *begins* after cancellation has been observed. Closing the window
  entirely would require killing the subprocess, which is a non-goal. The spec
  scenarios are written against boundaries, not instants, for this reason.

- **A cancelled attempt can now leave a workspace with a local commit ahead of
  origin, which the retry path has not had to reason about before.** → The retry
  logic already inspects a prior attempt's outcome and workspace state
  (`resolution.ts` treats a cancelled attempt as one whose workspace may be dirty).
  It must be extended to recognise an unpushed commit and reuse rather than
  re-create it; this is called out as a task rather than left to be discovered.

- **Moving `recordPublication` earlier changes what a recorded `commit_sha` means
  to anything reading the attempts table**, including the console. → `pushed` is
  already stored alongside it and already displayed; readers that treat a sha as
  proof of publication need to consult `pushed`. Auditing those readers is a task.

## Migration Plan

No data migration. `commit_sha != null AND pushed = 0` is a new combination for rows
written after the change; existing rows are unaffected, since the state was
previously unreachable. No configuration or API surface changes, so a rollback is a
straight revert.
