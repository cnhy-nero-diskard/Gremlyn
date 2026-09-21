## Why

Pushes fail whenever the PR head moves between workspace preparation and `git push` — currently recorded as `head-changed` (precondition) or `push-rejected` (non-fast-forward) with no recovery inside the attempt. On a busy PR this wastes a full agent run and forces a deliberate manual retry, even though the agent's work is usually still salvageable by merging the new head in and re-validating.

## What Changes

- When publication is blocked by `head-changed`, or `pushHead` is rejected as non-fast-forward, enter a bounded resilient-push loop instead of failing immediately:
  - `fetch` + `merge` the new remote head into the workspace (`merge remote in`, no rebase, no force-push, no history rewrite of already-pushed commits).
  - Keep the attempt's agent session available until publication succeeds — on a clean merge, re-run inspection + `validation_commands` and retry the push; on conflict, re-invoke the same attempt's agent with conflict context to resolve, then re-validate and retry.
  - Bound the loop to 3 push attempts total (initial + 2 retries); after exhaustion fail as `head-changed` / `push-rejected` exactly as today.
- Cancellation is observed at every new boundary (before merge, before agent re-invocation, before re-validation, before each retry push) and remains distinguishable from a publication block.
- Every merge, agent re-invocation, re-validation, and retry push is logged and recorded on the attempt; the GitHub reply names the recovery when it happened.

## Capabilities

### New Capabilities
- None — this extends existing publication behavior.

### Modified Capabilities
- `resolution-publication`: publication preconditions no longer fail fast on `head-changed`; commit-and-push policy gains merge-in + re-validate + bounded retry; `Push rejected` scenario becomes recoverable; agent re-invocation for conflicts becomes part of publishing.
- `workspace-isolation`: `Head commit is re-verified before publication` no longer fails fast — a moved head triggers the resilient-push loop (fetch, merge, conflict handling) within the same attempt instead of an immediate `head-changed` failure.

## Impact

- `src/publish/policy.ts` + `src/publish/gitops.ts`: resilient push loop (fetch/merge, conflict detection, retry bound).
- `src/orchestrator/resolution.ts`: keep agent context alive through publishing; re-invoke agent on conflict; re-run `inspectWorkspace` + `runValidationCommands` before each retry; cancellation checkpoints; attempt record + logging.
- `src/agent/prompt.ts`: new conflict-resolution prompt (unmerged files, conflicting hunks, instruction to resolve keeping both intents).
- `src/orchestrator/failures.ts`, reporting, console/job views: new/updated reason codes and reply text for recovered-vs-exhausted pushes.
- Tests: `tests/publish-gitops.test.ts`, `tests/validation-publication.test.ts`, orchestrator tests for merge-clean, merge-conflict-agent-fix, and retry-exhaustion paths.
