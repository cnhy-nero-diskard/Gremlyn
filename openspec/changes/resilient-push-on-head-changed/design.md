## Context

See proposal.md for motivation. Current state: the agent (`ClineExecutor`, `OpenCodeExecutor`) is a one-shot CLI invocation that exits before validation; `publishIfEligible` (`src/publish/policy.ts`) then commits (`commitAll`) and non-force pushes (`pushHead`, `src/publish/gitops.ts`). A moved head blocks as `head-changed` (precondition in `publicationBlockReason`, re-verified in `workspace-isolation`); a race between the check and the push surfaces as `GitError` → `push-rejected` (`src/orchestrator/failures.ts`). There is no in-attempt recovery — only a deliberate manual retry, which quarantines stranded work as a patch on the next run. Constraints carried forward: no force-push, no rewrite of pushed history, no branch create/delete, no GitHub PR merge, cancellation distinguishable from publication blocks, every recovery step observable and recorded.

## Goals / Non-Goals

**Goals:**
- Recover inside the same attempt from `head-changed` and non-fast-forward `push-rejected` via fetch + merge-in, bounded retry (3 push attempts), and agent-assisted conflict resolution with mandatory re-validation.
- Preserve the user's "don't kill the agent until publish succeeds" intent within the one-shot CLI reality by re-invoking the same attempt's executor with conflict context and the same isolated credentials/data-dir.

**Non-Goals:**
- Long-lived agent daemon or streaming session resume — executors stay one-shot; "kept alive" means re-invoked, not held open.
- Auto-merging the PR on GitHub, force-push, rebase, or branch management — explicitly out of scope.
- General retry-policy or timeout changes outside the push loop.

## Decisions

- **Merge-in, not rebase (per user choice).** On a moved head: `git fetch origin`, then `git merge origin/<headBranch>` (no `--ff-only`, no `--force`, argv-array, no shell). Alternative rebase considered: would rewrite the unpublished fix commit and complicate conflict attribution; merge preserves both histories and matches the user's explicit "merge remote in". Local merge commit message is deterministic: `Merge remote head <newSha> into resolution (comment <id>)`.
- **Re-invoke, don't hold open.** Cline/OpenCode CLIs have no suspend/resume; the attempt keeps `attemptDataDir`, seeded credentials, model/provider/effort, and review context, and calls `executor.run` again with a conflict-resolution prompt (unmerged files + conflicting hunks + instruction to preserve both intents). Alternative long-lived process rejected: would require new executor protocol and leak credential lifetime.
- **Loop lives at the publish boundary.** `publishIfEligible` gains the fetch/merge/retry core returning `published | blocked | cancelled` plus a `recovered: boolean` and the final head; `ResolutionOrchestrator.runAttempt` owns agent re-invocation and re-validation (`inspectWorkspace` + `runValidationCommands`) between retries. Alternative putting agent calls inside `publish/` rejected: that module must stay agent-free per the trust boundary.
- **Bound 3 push attempts, fresh head each iteration.** Re-read remote head (`ls-remote` / `fetch`) before every retry; exhaustion returns the original `head-changed` / `push-rejected` reason codes unchanged so existing handling still matches.
- **Conflict prompt is separate from resolution prompt.** New `buildConflictResolutionPrompt` in `src/agent/prompt.ts` reuses the delimiters (`CONTEXT_START/END`, orchestrator-authored markers) and adds only unmerged paths + hunks; fixed instructions forbid `git commit/push` by the agent — the orchestrator still commits.

## Risks / Trade-offs

- [Busy PR livelock: head moves on every retry] → Bound 3 attempts guarantees termination; exhaustion reports the last head so the operator sees progress, not a silent drop.
- [Agent mis-resolves conflicts, favoring one side] → Mandatory `inspectWorkspace` + full `validation_commands` before each retry push; conflicted state preserved on exhaustion for inspection, never force-pushed.
- [Merge commits add noise to PR history] → Accepted trade-off of merge-in (user chose it over rebase/fresh-retry); merge message is deterministic and attributable, and clean merges skip the agent entirely.
- [Recovery lengthens publishing and spends agent budget] → Only conflicted merges re-invoke the agent; clean merges just re-validate. Attempt record logs each merge/re-invocation/re-validation for cost visibility.
- [Cancel arriving mid-merge or mid-agent-retry] → Check `signal.aborted` before merge, before agent re-invocation, before re-validation, and before each push (the existing commit→push boundary rule extends to every iteration); mid-subprocess cancels finish the subprocess but never start the next step.

## Migration Plan

- Additive behavior change, no config migration: existing `head-changed` / `push-rejected` handling remains the exhaustion path, so old tests asserting failure on a moved head become exhaustion-after-3-attempts cases.
- Rollback: revert the loop to fail-fast; no persisted schema change (recovery detail lives in existing attempt logs/report fields).
- Deploy: land behind no flag — bound and observability make it safe; console reply text gains a "recovered after merge" variant, which old clients render as plain text.
