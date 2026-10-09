## 1. Pinned telemetry contract

- [x] 1.1 Produce a redacted pinned-runtime coverage matrix and fixtures for early parent IDs, agent/model/time fields, filtered sessions, active state and foreground/background delegation; verify read-only probes do not upgrade OpenCode or require a paid invocation.
- [x] 1.2 Verify whether the configured CLI can safely consume supported events and record either the event adapter contract or polling-only fallback; verify the delivered evidence states disconnect/overflow and unsupported-field limitations explicitly.
- [x] 1.3 Implement a safe observation parser/projector with actual identity, validated timestamps and no raw metadata/tool prompts; verify malformed/unknown-field, secret, instruction and oversized-payload tests.

## 2. Durable observation state

- [ ] 2.1 Add additive node, invocation-coverage and bounded transition storage keyed by attempt/invocation/session; verify migration, uniqueness, cap/trimming and reopen tests preserve useful metadata without fabricating history.
- [ ] 2.2 Import attributable legacy managed child records as explicitly limited evidence; verify missing roots/timestamps and unsettled/unknown outcomes stay uncertain rather than becoming new live invocations.
- [ ] 2.3 Implement idempotent observation upserts and the independent freshness/state matrix; verify repeated events, inactive nonterminal idle state, active-terminal contradictions, cancellation-request separation and last-known evidence retention.
- [ ] 2.4 Handle restart and storage failure with unresolved nodes projected unknown and coverage gaps retained where possible; verify simulated database failures cannot fail an agent job and stale fallback remains honest.

## 3. Live attributed collection

- [ ] 3.1 Connect an early verified parent-session callback to an invocation-scoped observer using the exact worker descriptor; verify root arrival before process exit, duplicate IDs, missing roots and multiple parent invocations are attributed correctly.
- [ ] 3.2 Add bounded recursive child enumeration with each parent edge and workspace verified before active-map use; verify two simultaneous/background children, cross-job contamination, ignored filters, nested edges, cycles and depth/node/pagination bounds.
- [ ] 3.3 Implement coalesced periodic reconciliation with per-call/global concurrency bounds and optional verified event acceleration; verify slow calls, disconnected streams, missed events, reconnect deduplication and partial coverage tests.
- [ ] 3.4 Continue observation through post-parent settlement and dispose on attempt/daemon teardown without independent session interruption; verify timer/helper leaks, shutdown races and observer failure cannot alter quiescence or publication gates.
- [ ] 3.5 Preserve verified parent/child attribution in new activity blocks and sanitize delegation-tool prompt arguments; verify old snapshots remain readable and child events are not flattened into the parent's transcript.

## 4. Console projections and live interaction

- [ ] 4.1 Add batched redacted dashboard/detail queries for observed counters, invocation trees, configured-versus-observed agents and coverage; verify empty, partial, unknown-identity, repeated-agent and legacy fixtures without per-row unbounded reads.
- [ ] 4.2 Render subdued dashboard delegation summaries and expandable keyed attempt/invocation trees; verify managed/native/default/unsupported Cline views distinguish no observations from unavailable telemetry and never show percent-complete guesses.
- [ ] 4.3 Extend change-ticker signatures and authenticated fragments with observation generations; verify child-only state changes refresh without manual reload and unauthorized SSE exposes no telemetry.
- [ ] 4.4 Preserve expansion, focused nodes, reading/scroll and follow state through child updates and reconnect; verify client reconciliation tests cover sibling changes, repeated sessions and attempt switches.
- [ ] 4.5 Add scoped meaningful announcements and explicit observed-time/activity/gap copy; verify routine polls/timestamps remain quiet and stale running nodes become unknown without inferred child cancellation.

## 5. End-to-end proof and guidance

- [ ] 5.1 Add a fixture integration spanning concurrent children, failed/cancelled jobs, internal retries, restart, source loss and reconciliation; verify session ownership and historical outcomes remain correct while safety behavior is unchanged.
- [ ] 5.2 Extend the explicit opt-in real OpenCode harness with a sufficiently long-lived delegated child; verify it is observed running before parent completion, then terminal without reload, with fixture GitHub/local-only publication and normal-suite skipping.
- [ ] 5.3 Run full tests, build, lint and changed-file format checks including managed settlement/recovery, cancellation and publication regressions; verify observer errors cannot authorize or suppress execution safety.
- [ ] 5.4 Document verified coverage, metadata retention/bounds, polling/event gaps and rollback that disables only observation; verify operator guidance does not equate missing telemetry with no delegation or stopped sessions.
