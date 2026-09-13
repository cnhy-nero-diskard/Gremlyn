## Why

A retry of a job that failed validation cannot run. It fails at `preparing` with
`workspace-dirty`, every time, and the operator's only route forward is to clean
the workspace by hand — which throws away the agent's work.

Job 75 (`Backlogium#138`) is the whole shape of it. Attempt 103 ran green, left
two files modified, and was blocked at `publishing` with `validation-failed`
because two tests in a class it never touched failed on an unrelated flake.
Attempt 104 then died at `preparing` with `workspace-dirty` eleven seconds after
it started, having done nothing. The edits are still sitting in
`Backlogium-workspaces/pr-138` as this is written.

This is not a defect in the dirty-workspace rule, which exists so that a
workspace is never silently discarded. It is a gap in the carve-out beside it:
`canResumeRetainedWorkspace` admits a retained workspace from an attempt that was
interrupted, cancelled, or ended abruptly while *running*, and a validation
failure is none of those. But it has exactly the property the carve-out is built
on — the uncommitted edits in that workspace are the orchestrator's own agent's
work, made in this attempt, against this recorded head. Refusing to resume them
treats the orchestrator's own output as if it were a stranger's.

The two failure modes the exclusion produces are both bad. Either the operator
discards work an agent spent minutes producing and the retry starts from nothing,
or the job stays stuck. And when the retry does start from nothing, it starts
*blind*: nothing tells the agent that the previous run's changes failed
validation, or how, so a second attempt is free to reproduce the same failure.

## What Changes

- **Admit a validation failure to the retained-workspace carve-out.** A retry MAY
  resume the uncommitted edits of an attempt that failed at `publishing` with
  `validation-failed`, under the same guards as the existing cases: the
  deterministic workspace path still matches, the recorded PR head is unchanged,
  the workspace is neither conflicted nor diverged, and the attempt actually
  recorded uncommitted changes.
- **Tell the retrying agent why validation failed.** When a retry resumes such a
  workspace, the prompt SHALL carry the failing command and its captured output,
  delimited as data and identified as orchestrator-authored, so the agent knows
  the state it is inheriting and what it has to make pass.
- **Nothing else is admitted.** `no-changes` retains nothing to resume;
  `head-changed` already fails the head guard; `workspace-conflicted` and
  `workspace-invalid` are the states the rule exists to protect. Only
  `validation-failed` gains admission.

## Non-goals

- Retrying automatically on a validation failure. This changes what a retry *may*
  do, not when one is issued; retries stay operator-initiated.
- Any change to publication preconditions. Validation must still pass before
  anything is committed or pushed.
- Distinguishing a flaky validation failure from a real one. The orchestrator has
  no basis for that judgement, and guessing it would be worse than resuming.

## Impact

- **Specs**: `workspace-isolation` ("Unsafe workspace state halts the job" — the
  carve-out sentence and a new scenario); `agent-execution` ("Resolution prompt
  content" — the inherited-failure section).
- **Code**: `src/orchestrator/resolution.ts` (`canResumeRetainedWorkspace`, and
  threading the prior validation failure into the prompt), `src/agent/prompt.ts`
  (the new delimited section).
- **Tests**: `tests/resolution-orchestrator.test.ts`,
  `tests/validation-publication.test.ts`.
- **Operator-visible**: a retry after `validation-failed` now runs instead of
  failing instantly with `workspace-dirty`. The README's troubleshooting entry for
  `workspace-dirty` no longer applies to that path.
