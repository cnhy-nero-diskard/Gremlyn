## Why

`job-orchestration` already requires that "a cancelled attempt SHALL NOT commit or
push", but the implementation only honours cancellation up to the moment the agent
exits. Once an attempt enters publishing, the abort signal is never consulted
again: `publishIfEligible` accepts no signal, and the last `signal.aborted` check
sits before validation. A cancel that arrives during publishing is therefore
recorded, ignored, and the push proceeds.

This is not theoretical. On job 52 (2026-09-04) a cancel was requested at 18:39
while the attempt sat in publishing; the orchestrator pushed anyway at 18:42, and
the cancellation only took effect at 18:46 once the push process had ended on its
own. The operator's stop control silently did nothing for seven minutes, across the
one stage where the consequences leave the machine.

## What Changes

- Cancellation becomes observable throughout the publishing stage rather than only
  before it, so an operator's stop reaches the stage where work becomes public.
- The publish step gains a cancellation checkpoint immediately before the push —
  the last point at which a commit is still private to the workspace.
- The outcome of a cancel that lands between commit and push is defined rather than
  incidental: the commit stays in the workspace, unpushed, and the job record says
  so, consistent with the existing guarantee that a cancelled attempt's workspace
  remains inspectable.
- Cancellation is distinguished from a publication precondition failure. A cancelled
  attempt is not a failed one; it must not be reported to the pull request as a
  blocked publication.

Not in scope: interrupting a git subprocess that is already running. A cancel
arriving mid-push still waits for that push to finish, and the underlying operation
is not killed. This change makes the checkpoints between operations honest, which
is what the existing requirement promises; pre-empting an in-flight transfer is a
larger question about subprocess lifetimes and is deliberately left alone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `job-orchestration`: the Cancellation semantics requirement is sharpened to hold
  for the whole attempt, not just while the agent runs, and gains scenarios for a
  cancel arriving during publishing — both before the commit and between the commit
  and the push.
- `resolution-publication`: publication gains an explicit cancellation checkpoint
  before the push, and a statement that a cancelled attempt is not reported as a
  publication precondition failure.

## Impact

- `src/publish/policy.ts` — `publishIfEligible` currently takes no `AbortSignal` and
  runs `commitAll` then `pushHead` unconditionally.
- `src/orchestrator/resolution.ts` — the publishing stage; its only `signal.aborted`
  check precedes validation, and its `StageFailure` mapping has no notion of a
  cancelled publish.
- `src/store/jobs.ts` — records whether the workspace holds uncommitted
  modifications; a cancel after commit produces a *committed but unpushed*
  workspace, a state the record does not currently distinguish.
- Operator console cancel control — unchanged in shape, but its guarantee becomes
  real during publishing.
- No GitHub API, configuration, or agent-facing surface changes.
