## 1. Configuration

- [ ] 1.1 Add the inactivity bound to `agent_defaults` in `src/config/loader.ts`, applied when absent, and verify a config omitting it loads with the 15-minute default
- [ ] 1.2 Reject zero, no-limit, and values below the 1-minute floor, and verify `npm run verify:config` fails with a named reason for each rejected form
- [ ] 1.3 Add the per-repository override alongside `timeout_seconds`, and verify a repository-level value wins over the default while an absent one inherits it
- [ ] 1.4 Add the store migration for the persisted override in `src/store/migrations.ts`, defaulting existing rows to inherit, and verify migrating an existing database leaves current repositories on the default
- [ ] 1.5 Document the setting in `config.example.yaml` with the default and floor stated, and verify the example config still passes `verify:config`

## 2. Stall detection

- [ ] 2.1 Add a watchdog around the existing `onLine` callback in `src/orchestrator/resolution.ts` that resets on every line and aborts through the run's signal when the bound elapses; verify with a fake executor that emits nothing and is aborted at the bound
- [ ] 2.2 Verify the watchdog does not fire for an executor that keeps emitting past the bound, using a fake executor that streams slowly for longer than the window
- [ ] 2.3 Record the abort reason before firing the signal, so a stall is distinguishable from an operator cancellation, and verify the attempt records a stall reason rather than `cancelled`
- [ ] 2.4 Add the stall failure reason to the attempt record and status events, and verify the persisted attempt reports the stall reason and its failure stage
- [ ] 2.5 Confirm the pull-request lock is released on a stall, and verify a queued job for the same pull request proceeds after one stalls
- [ ] 2.6 Confirm stalled work is preserved and never published, and verify the workspace retains edits with no commit and no push after a stall

## 3. Process-tree reaping

- [ ] 3.1 Add tree termination to `defaultRunner` in `src/agent/launcher.ts` — `taskkill /T /F` on Windows, process-group kill on POSIX — and verify a spawned child of a killed process is gone
- [ ] 3.2 Verify reaping covers a *detached* descendant, spawning one the way the incident did (PowerShell `Start-Process`) and asserting it does not survive termination
- [ ] 3.3 Apply reaping to all three termination paths, and verify operator cancel, duration timeout, and stall each leave no descendant running
- [ ] 3.4 Record a descendant that cannot be terminated against the attempt, and verify the survivor is logged rather than silently ignored
- [ ] 3.5 Verify a normally-exiting agent is unaffected — no reaping is attempted and the exit code is unchanged

## 4. Operator console

- [ ] 4.1 Surface the inactivity bound in repository settings with no "no limit" option, and verify the control rejects zero and sub-floor values
- [ ] 4.2 Record the configuration change as an operator action, and verify it appears in the audit view with its time and effect
- [ ] 4.3 Render a stalled attempt distinctly from a timed-out one, including the time of the agent's last output, and verify the job view labels each correctly

## 5. Verification

- [ ] 5.1 Run `npm run lint`, `npm run build`, and `npm test`, and verify all pass
- [ ] 5.2 Run `openspec validate --changes add-agent-stall-failsafe` and verify the change validates
- [ ] 5.3 End-to-end: run an agent that goes silent against a scratch repository and verify the attempt fails as stalled, the tree is reaped, the lock releases, and the console shows it as stalled
- [ ] 5.4 Note the behaviour change for installations running `timeout_seconds: 0` in the release notes, and verify the note states that previously unbounded runs are now bounded
