## 1. Runtime contract and shared discovery

- [x] 1.1 Record pinned V2 inventory, primary-mode/hidden semantics, native `--agent`, initial runtime identity and early session-ID surfaces in a bounded probe artifact; verify against CLI help/read-only fixtures and keep real model calls explicitly opt-in.
- [x] 1.2 Extract a shared effective-inventory reader and safe public metadata projection from managed preflight; verify parser tests cover primary/all/subagent modes, hidden entries, descriptions, malformed records and instruction/credential exclusion.
- [x] 1.3 Introduce one alias-aware binary/cwd/environment worker descriptor for discovery, execution and session transport; verify injected-runner tests prove identical context and isolation across two repository aliases.
- [x] 1.4 Add bounded source discovery, keyed advisory caching, explicit refresh and abortable workspace-context preflight; verify cold convergence, timeout, cancellation, wrong-directory and source-versus-worktree mismatch tests.

## 2. Durable selection and job capture

- [x] 2.1 Add additive repository-selection, job-capture and per-invocation ownership/identity migrations; verify fresh and legacy databases preserve existing profile bytes/revisions and seed managed/default sources correctly.
- [x] 2.2 Implement strict discriminated selection validation and revisioned source updates without touching other repository fields; verify malformed/conflicting choices, stale revisions, non-OpenCode aliases and safe audit tests.
- [x] 2.3 Implement explicit managed-profile activation/dormancy and atomic active-profile clearing; verify native/default switches retain profiles, dormant edits do not activate them, and active profile/revision races cannot split a selection.
- [x] 2.4 Capture source/native ID/revision and only active managed definitions in the job-claim transaction; verify concurrent-save, queued-job and legacy-job fallback tests.
- [x] 2.5 Make explicit retries and internal invocations resolve selection solely from job capture; verify selection stability after repository edits and database reopen without changing unrelated model/retry policy.

## 3. Executor selection and invocation ownership

- [x] 3.1 Extend executor options with validated default/native/managed intent and keep generated-ID guards intact; verify argv tests cover native `--agent`, default omission, invalid IDs and unchanged Cline options.
- [ ] 3.2 Wire actual-workspace inventory validation before every explicit primary invocation; verify unavailable/ineligible choices cannot spawn and managed permission/model preflight regressions still pass.
- [ ] 3.3 Journal generic OpenCode ownership before launch and capture attributable parent IDs/initial primary evidence during the stream; verify early persistence, missing/contradictory identity, multiple invocation ordinals and diagnostic-redaction tests.

## 4. Delegation safety and recovery

- [ ] 4.1 Generalize filtered child discovery to bounded recursive parentage with workspace/root validation; verify nested/background sessions, wrong-parent/directory records, cycles, duplicate IDs, pagination and cap-exhaustion tests fail safely.
- [ ] 4.2 Require fresh full-tree terminal/inactive proof after every OpenCode parent exit before retry or validation; verify parent/listing/active-map race tests and that a still-active native descendant blocks all publication operations.
- [ ] 4.3 Carry remaining timeout and cancellation through settlement/interruption, retaining the existing no-outer-timeout fallback; verify configured-budget, fallback, abort, nonzero-parent and unconfirmed-interruption tests preserve failed/quarantined evidence.
- [ ] 4.4 Extend startup recovery and workspace admission to generic native/default ownership while retaining manifest-only generated-file cleanup; verify crashed native trees, missing parent IDs, legacy ownership, unavailable workers/APIs and fatal quarantine-write failures.
- [ ] 4.5 Protect unresolved generic ownership from legacy cleanup, artifact retention and workspace reclamation; verify recovery-evidence preservation and that no native/project configuration or unrelated files are removed.

## 5. Authenticated console integration

- [ ] 5.1 Add repository-scoped discovery/source-update routes with strict bodies, authentication, server-derived paths and safe errors; verify unauthorized, cross-repository, stale-revision, unavailable-source and successful-notification route tests.
- [ ] 5.2 Project configured executor/source and captured versus per-invocation effective primary into repository/job summaries; verify old/new/retired-profile/unknown-identity fixtures and no raw instructions in HTML, API or audit output.
- [ ] 5.3 Add the keyed Run with agent editor using native selects and local Apply/Cancel/refresh feedback; verify default/native/managed states, unavailable current values, managed edit/switch and Cline exclusion in view/client tests.
- [ ] 5.4 Preserve agent drafts, focused nodes and profile expansion across SSE updates and reject conflicting applies; verify reconciliation/reconnect tests and manual keyboard operation on the existing configuration surface.

## 6. Acceptance and release guidance

- [ ] 6.1 Add seam integration proving two repositories run their own captured native IDs across queueing/retry/restart and managed switching; verify actual argv and injected effective-runtime configuration rather than the saved label alone.
- [ ] 6.2 Extend an opt-in temporary-repository acceptance harness to run a discovered native primary and prove its actual identity; verify it uses fixture GitHub/local publication only and skips without an explicit model opt-in.
- [ ] 6.3 Run the full automated suite, build, lint and changed-file format checks; verify managed preflight/session/recovery, workspace isolation, cancellation and publication regression tests remain green.
- [ ] 6.4 Document default-policy/native-ID snapshot semantics, unavailable worktree-local definitions, explicit source switching and the native safety compatibility change; verify upgrade/rollback guidance prohibits dropping unresolved ownership or bypassing quarantine.
