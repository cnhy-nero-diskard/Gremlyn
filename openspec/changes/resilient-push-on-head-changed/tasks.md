## 1. Push-resilience core

- [ ] 1.1 Add fetch + merge-in helper to `src/publish/gitops.ts` (argv-array `fetch` + `merge origin/<branch>`, deterministic merge message, conflict detection via `unmergedEntries`/`mergeInProgress`) and verify with a temp-repo test where the remote moved and merges cleanly.
- [ ] 1.2 Extend `publishIfEligible` in `src/publish/policy.ts` with the bounded loop (3 push attempts, fresh head check per iteration, `recovered` flag, exhaustion returns `head-changed`/`push-rejected`) and verify the existing `validation-publication` precondition tests still pass plus a new retry-exhaustion test fails with the original reason and no force-push.
- [ ] 1.3 Add cancellation checkpoints before each merge, re-validation, and retry push (cancel stays distinguishable from a block) and verify both cancel-before-commit and cancel-between-commit-and-push tests still record `cancelled` with no push.

## 2. Agent conflict resolution

- [ ] 2.1 Add `buildConflictResolutionPrompt` to `src/agent/prompt.ts` (unmerged files + conflicting hunks as delimited data, preserve-both-intents instructions, agent must not commit/push) and verify via a prompt unit test that conflict paths appear delimited and fixed instructions forbid git publish.
- [ ] 2.2 Wire same-attempt agent re-invocation in `src/orchestrator/resolution.ts` (reuse executor, model/provider/effort, `attemptDataDir` credentials, review context) triggered only on conflicted merge, and verify with a fake-executor orchestrator test that a conflicted merge re-invokes once and commits the resolution.

## 3. Re-validation and reporting

- [ ] 3.1 Re-run `inspectWorkspace` + full `runValidationCommands` after every merge and every agent conflict fix before the retry push, and verify with a test where the post-merge validation fails that nothing is pushed and the attempt records `validation-failed`.
- [ ] 3.2 Record and report recovery (attempt log entries for each merge/re-invocation/re-validation/retry, GitHub reply names the recovery and final commit, exhaustion reply names `head-changed`/`push-rejected`) and verify with an orchestrator test asserting the success reply contains the recovery note and the failure reply states nothing was pushed.

## 4. Regression and docs

- [ ] 4.1 Update `tests/publish-gitops.test.ts` (clean-merge recovery, conflict-preserved-on-exhaustion, never force-push) and verify with `npm test` that the new push-resilience cases pass.
- [ ] 4.2 Run full verification (`npm run build`, `npm test`, `npm run lint`, `npm run format:check`) and verify everything is green before handing off to apply.
