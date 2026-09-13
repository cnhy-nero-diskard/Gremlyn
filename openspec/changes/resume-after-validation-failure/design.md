## Context

`prepareWorkspace` refuses a dirty workspace unless the caller passes
`resumeDirtyWorkspace`, and only `ResolutionOrchestrator.retry` ever passes it —
gated on `canResumeRetainedWorkspace`, which today admits:

```
interrupted
| (has_uncommitted_changes && cancelled)
| (has_uncommitted_changes && failed@running && (agent-timeout | agent-nonzero-exit))
```

A `validation-failed` attempt is `failed@publishing`, so it falls through to
`undefined` and the retry prepares without the flag. `prepareWorkspace` then sees
the agent's edits and throws `workspace-dirty` before the agent is launched.

## Goals / Non-goals

- **Goal**: a retry after a validation failure resumes the same workspace and the
  agent sees why validation failed.
- **Goal**: the guards that make a resume safe stay exactly as strict.
- **Non-goal**: automatic retry, or any weakening of the publication
  preconditions.

## Decisions

### D1 — Extend the carve-out rather than relax the dirty rule

The alternative was to let `prepareWorkspace` resume any dirty workspace whose
head still matches. Rejected: the dirty rule is what stops the orchestrator from
discarding a *human's* uncommitted work in an adopted checkout, and edits whose
provenance the orchestrator cannot vouch for must keep failing the job. The
carve-out is provenance-based — "this attempt's own agent made these edits, in
this workspace, at this head" — and a validation failure satisfies it as
completely as a timeout does. Widening the list of admitted outcomes preserves
that reasoning; loosening the rule discards it.

### D2 — Admit `validation-failed` only, not "any publishing failure"

`publishing` covers six block reasons, and they are not alike:

| Reason | Resume? | Why |
|---|---|---|
| `validation-failed` | yes | Edits exist and are the agent's own; the retry's job is to fix them |
| `no-changes` | no | Nothing retained to resume; the guard on recorded uncommitted changes already excludes it |
| `head-changed` | no | The head guard already rejects it, and the edits were made against a base that moved |
| `workspace-conflicted` | no | The state the rule protects |
| `workspace-invalid` | no | Same |
| `pull-request-closed` | no | Nothing to publish to; resuming would produce work with no destination |

Enumerating one reason keeps every other publishing failure fail-closed, and a
reason added later must be admitted deliberately rather than inheriting a resume
it was never considered for.

### D3 — The inherited failure goes in the prompt as delimited data, outside the review context

The failing command and its output are put in their own block, marked as
orchestrator-authored, not folded into the untrusted review context.

Two reasons. The review context is GitHub text and carries a standing instruction
not to obey requests inside it; validation output is not GitHub text and does not
belong under that framing. But it is also not *trusted*: it is build-tool output
from a repository under review, and a test name or an assertion message can say
anything. Delimiting it as data with an explicit provenance marker — reusing the
`ORCHESTRATOR_STATUS_MARKER` idiom already used for the bot's own thread comments
— keeps both properties true at once: the agent knows the failure is real and
came from the orchestrator, and knows the text inside it is output, not
instruction.

### D4 — Output is truncated from the tail

Validation output is unbounded — the job 75 run captured a full Gradle log — and
the failure is nearly always at the end. The prompt carries a bounded tail of the
captured stdout and stderr, with the elision marked. Sending the head would cut
away exactly the part that says what failed.

### D5 — The prompt section appears only on a resumed retry

A first attempt has no inherited state, and a retry that did *not* resume the
workspace starts from a clean checkout where the previous run's failure describes
code that no longer exists. Tying the section to the resume — not to "the
previous attempt failed validation" — keeps the prompt's claim about the
workspace true.

## Risks

- **A retry inherits a broken working tree it cannot see the origin of.** Mitigated
  by D3/D5: the agent is told explicitly that the workspace carries a previous
  run's uncommitted edits and which command rejected them.
- **A genuinely wrong change gets iterated on instead of restarted.** Accepted.
  The operator can still clean the workspace to force a fresh start, which is the
  behaviour that exists today; this change adds the other option rather than
  removing that one.
