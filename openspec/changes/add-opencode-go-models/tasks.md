## 1. Reconcile the shipped implementation against the specs

The behavior this change specifies landed in commit `465b0a6`, ahead of these
artifacts. These tasks verify the code satisfies each requirement rather than
rebuilding it — treat a failing check as a defect to fix, not as a spec to soften.

- [x] 1.1 Confirm each OpenCode-hosted namespace is its own catalog entry declaring the `opencode` kind, and that both are present in the bundled snapshot and after a live refresh — verify `npm test -- tests/provider-catalog.test.ts` passes, including the refresh case
- [x] 1.2 Confirm both id lists match `opencode models` on the pinned release: run `opencode models`, diff its `opencode/` and `opencode-go/` sections against `OPENCODE_ZEN_MODEL_IDS` and `OPENCODE_GO_MODEL_IDS`, and verify the counts the catalog test asserts (69 and 27) still hold
- [x] 1.3 Confirm Go's entries badge uniformly as subscription-included and that Zen's `-free` suffix rule still applies within Zen only — verify by the tier assertions in the catalog test
- [x] 1.4 Confirm a provider its executor cannot drive is refused before an agent is launched and before a workspace is prepared, and that an undescribed provider still runs — verify `npm test -- tests/resolution-orchestrator.test.ts` passes both mismatch cases
- [x] 1.5 Confirm the refusal records a reason distinct from an authentication failure and from a failure of the work, and that a refused attempt leaves no workspace and publishes no branch — verify by the recorded stage, reason, workspace path, and unchanged remote sha asserted in that test

## 2. Close the operator-facing gap the implementation left

- [x] 2.1 Add a `provider-executor-mismatch` entry to the README troubleshooting list, stating that the provider cannot be driven by the configured agent, that tool execution would leave the attempt's workspace, and that re-authenticating will not help — verify the entry reads alongside `agent-auth-failed` and `agent-billing-failed`, which it must be told apart from. The console renders the raw reason string, so the README is where its meaning lives
- [x] 2.2 Note in the README's OpenCode provider section that a Cline repository configured with the `opencode` provider is refused per attempt, not merely warned about at startup — verify the text names the refusal and its cause

## 3. Verify end to end against the real CLI

- [ ] 3.1 Probe a Go model through the real executor with per-attempt isolation: `npm run probe:agent -- --kind opencode --provider "" --model opencode-go/kimi-k3 --seed-source <data root>` — verify the unseeded run fails, the seeded run exits 0, and a session id is extracted
- [ ] 3.2 Select a Go model for an OpenCode repository from the console picker and verify it persists and is redisplayed as the current selection after a catalog refresh, with no custom free-text entry used
- [ ] 3.3 Run `npm run build`, `npm run lint`, and `npm test` — verify all pass

## 4. Land the specs

- [ ] 4.1 Sync the three delta specs into `openspec/specs/` and archive this change — verify `openspec validate --strict` passes and `openspec list` no longer shows it as active
