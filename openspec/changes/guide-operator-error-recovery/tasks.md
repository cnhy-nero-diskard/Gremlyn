## 1. Server-Derived Recovery Guidance

- [ ] 1.1 Add a typed console recovery presenter for retry, reset, configuration repair, and wait that uses current job/repository state, retains unknown reasons safely, and distinguishes stalled from maximum-duration timeout; verify focused unit tests cover each recommendation kind, unknown reasons, retained-state copy, and the two timeout labels.
- [ ] 1.2 Render the recovery summary and exactly one recommendation on eligible job views without creating controls that server state does not already authorize; verify `node --import tsx --test tests/console.test.ts` covers failed, cancelled, interrupted, stalled, timed-out, and live job states.
- [ ] 1.3 Explain retry and reset consequences from the existing retained-edit and workspace contracts, including conditional workspace reuse and preservation of prior records; verify view tests assert the reuse/preserve/discard copy and never claim unsafe retained edits will be reused.

## 2. Contextual Action Feedback

- [ ] 2.1 Define an additive action-feedback response envelope with stable action/scope identifiers, redacted cause text, retained-state summary, and one server-derived recommendation while preserving existing endpoint response fields; verify route tests cover success, expected refusal, unknown exception, and secret-bearing exception inputs.
- [ ] 2.2 Apply the feedback envelope to retry, cancel, repository toggle/settings, and workspace-reset routes without changing authorization, state gating, endpoint paths, or audit ownership; verify `node --import tsx --test tests/console.test.ts` asserts authoritative post-action state and no duplicate action records.
- [ ] 2.3 Add stable action scopes and adjacent persistent feedback placeholders to job controls, each repository's controls, configuration controls, and the danger zone; verify rendered-view tests associate every offered mutation with the correct unique scope and feedback target.

## 3. Live Connection and Accessible Announcements

- [ ] 3.1 Use the connection and scoped-action channels plus keyed reconciliation owned by `improve-console-accessibility-and-session-ux`, registering recovery feedback by action scope so it survives SSE updates; verify client-behavior tests simulate an action failure followed by a fragment update and reconnect and assert that the failure remains beside its source without a parallel global status path.
- [ ] 3.2 Implement connected, reconnecting, and disconnected/stale EventSource states using `onopen`, errors, and ready state while making heartbeat payloads silent; verify client-behavior tests simulate each transition and assert heartbeats neither replace action feedback nor emit a status change.
- [ ] 3.3 Register new action failures, changed recommendations, and connection transitions with the shared deduplicating announcer from `improve-console-accessibility-and-session-ux` while preserving focus on the invoked control; verify client-behavior tests assert one announcement per meaningful key and none for repeated renders, heartbeats, or elapsed-time ticks.
- [ ] 3.4 Style connection health, recovery guidance, and inline failure/success feedback with non-color-only labels and visible focus behavior; verify console markup/style tests cover accessible names and run `npm run lint`.

## 4. Reset Target Confirmation

- [ ] 4.1 Supply the job view with the exact server-derived workspace reset target and render the repository, pull request, path, discard/rebuild consequence, and retained records beside the typed `RESET` control; verify view tests cover prepared and not-yet-prepared deterministic workspaces and keep the button disabled for every value except exact `RESET`.
- [ ] 4.2 Include the displayed target snapshot in the reset request and recompute it from current repository configuration and pull request on the server before invoking reset; verify route/workspace tests prove a stale or mismatched target is refused, audited, and left byte-for-byte intact.
- [ ] 4.3 Preserve the existing beneath-root, system-derived-path, adopted-checkout, authorization, and action-audit guards on successful and refused resets; verify focused console and workspace-safety tests cover successful recreation, outside-root refusal, adopted-checkout refusal, and recorded targets/effects.

## 5. Integrated Verification

- [ ] 5.1 Add regression fixtures for connection loss during failed actions, repository-setting refusal, retained retry guidance, reset refusal, and stalled-versus-timeout recovery; verify `node --import tsx --test tests/console.test.ts tests/workspace-safety.test.ts tests/worktree.test.ts` passes.
- [ ] 5.2 Run `npm run build`, `npm run lint`, `npm run format:check`, and `npm test`, then run `openspec validate guide-operator-error-recovery --type change --strict --no-interactive`; record and resolve every failure attributable to this change.
