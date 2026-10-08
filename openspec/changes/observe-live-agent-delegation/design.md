## Context

See `proposal.md` and `specs/`. Parent stdout currently enters an un-attributed `ActivityRecorder`; a session ID is assigned after process return, and managed child outcomes are persisted after settlement. `SharedChangeTicker` notices job/database signatures and activity-file changes, while the framework-free client already reconciles keyed fragments and preserves details/follow state.

The pinned session adapter proves parentage and workspace but discards identity/time metadata. The official V2 API reference documents agent/session/active endpoints and an event stream; its stream is volatile, so it cannot be a historical authority. Published docs are guidance, not proof of this installation's pinned event shape. This cross-cutting, privacy-sensitive storage/collection change requires a design.

## Goals / Non-Goals

**Goals:** Start observation before parent exit; keep invocation-root and child identities trustworthy; retain bounded history and explicit gaps; update existing console surfaces without changing execution safety.

**Non-Goals:** Session interruption by the observer; authorizing validation from UI state; broad transcript capture; inferring progress percentages; interpreting prompts/tool arguments as identity; reconstructing unobserved historical events.

## Decisions

### D1. Supported session reconciliation is the baseline; events accelerate it

Begin implementation with a bounded contract probe covering early run-stream root IDs, session `agent`/`model`/time fields, filtered child enumeration, active/inactive state and foreground/background children. Produce redacted fixtures and a coverage matrix for the pinned runtime without upgrading it. Read-only discovery is the default; real delegation verification remains explicit model opt-in.

Use the existing alias-aware binary/cwd/environment session transport for periodic reconciliation while a root runs and settles. Initial cadence is one second with at most one in-flight round per root, bounded per-call timeouts and a global concurrency limit. Stop coalesced work promptly on lifecycle teardown. A successfully supported event subscription is an optional accelerator that schedules/coalesces reconciliation; it never replaces it. If the CLI cannot stream events safely, the same design works with polling and reports polling coverage. Do not connect to a separately guessed unauthenticated service URL or expose credentials to the browser.

Alternative: render delegation tool calls from parent stdout as the full tree. Rejected because callable tools and narrated delegation are not proof of actual attributed child sessions. Alternative: event-only tracking. Rejected because disconnect/overflow loses events by contract.

### D2. Root ownership arrives early and each invocation has its own observer

Observe a verified parent-ID signal during OpenCode stdout rather than waiting for `AgentResult`. Consume the generic invocation journal/worker descriptor from #14 when available; otherwise use a narrow early-root callback and the existing exact workspace/session attribution seam without implementing new safety policy. Before attaching a root, verify record ID, root parentage and directory. Repeated parent IDs/events are idempotent; a new invocation receives another ordinal/root, never reuses the previous tree.

Recursively enumerate only verified parent edges with directory checks. Observe known sessions from the active map only after attribution; ignore unrelated active entries. Read failures or wrong-parent/directory responses reduce coverage instead of inventing ownership. Initial observer caps are 256 nodes per invocation, eight levels and existing pagination bounds. Over-limit trees visibly become partial; these presentation bounds are separate from #14's stricter fail-closed safety bounds. A root with no ownership signal remains unobservable, not an empty complete tree.

Alternative: infer child ownership from timing, titles or matching agent names. Rejected because concurrent jobs share the service and can invoke identically named agents.

### D3. Store safe node snapshots plus bounded state transitions

Add observation nodes keyed by `(attempt, invocation ordinal, session ID)` and containing root/parent IDs, source kind, supported actual agent/model, source-created/updated/idle times when valid, first/last observation, last-known state/outcome and interruption-request metadata. Store a small invocation coverage record with generation, transport status, gaps, truncation and freshness. Add capped safe state transitions, not token/event dumps (initial limits: 128 transitions per node and 2048 per invocation; trim oldest transitions and mark history partial).

Whitelist fields before persistence, redact string metadata and limit lengths. Do not store session titles, arbitrary metadata, raw system fields, prompts, instructions, tool input/output or credentials. Descriptions are optional safe scoped-inventory metadata, never identity evidence. Resolve a friendly managed label only when the actual runtime ID matches its captured generated definition; otherwise show the actual ID or unknown identity.

Add optional session/invocation attribution to public activity blocks where verified, preserving backward compatibility for old snapshots. Parent/child messages cannot be flattened into parent activity merely because they share stdout. For delegation tools, retain safe name/state/session references and remove prompt-bearing arguments from new rendered activity. Child transcript collection is not included in this change.

Alternative: extend `managed_child_sessions` into the whole observer store. Rejected because that table carries settlement evidence, managed-only scope and no invocation roots; observation and safety must not share a writable verdict.

### D4. Keep evidence, coverage and projected state separate

Project state from fresh supported evidence rather than reusing `classifyChildSession`, whose safety meaning of running includes nonterminal inactive sessions. The observer matrix is:

| Record/active evidence | Display |
| --- | --- |
| Verified spawn/record, active state not yet known | Invoked; current execution unknown |
| Nonterminal record plus fresh active presence | Running |
| Nonterminal record plus fresh active absence | Idle, not finished |
| Terminal outcome plus fresh active absence | Observed succeeded/failed/interrupted |
| Terminal record plus active presence, missing record or stale source | Unknown, retaining last-known evidence |

Show cancellation requested independently until runtime interruption is confirmed. A poll refresh only advances last-observed time, not last-action/heartbeat; use source update/action metadata only when its semantics are verified. Elapsed time uses supported source bounds where available, otherwise clearly labeled observed duration; never invent a terminal end instant. Unknown children are not counted as completed, and active/completed counters are labeled observed when coverage is partial.

After two missed expected observation intervals, mark live projected states stale/unknown; keep explicit gaps until reconciliation succeeds and retain the historical gap note. No safe gap persistence means current UI falls back to stale-on-age, not fresh success. On restart, mark unresolved observations unknown until refreshed; do not convert a job interruption into child cancellation. Preserve terminal historical evidence without claiming a current running connection.

Alternative: map job terminal status to every child. Rejected because service-owned background sessions can outlive their parent or daemon.

### D5. Publish bounded keyed fragments without moving safety gates

`ConsoleQueries` exposes safe observed counts and trees, configuration summaries separately, and empty/partial/unavailable coverage. Dashboard rows add one subdued delegation line. Job detail/live preview add an expandable attempt-local tree with stable keys including invocation and session, state text, time, identity and optional last observable action. Unknown source and never-observed configurations have distinct copy. Cline shows limited observability without OpenCode-managed vocabulary.

Extend ticker signatures using observer generation/state revision rather than rescanning whole telemetry histories. Queries batch per dashboard/job to avoid a session query per row. Reuse authenticated SSE fragments, `data-live-key` and stable details keys; preserve expansion/focus/follow/scroll through updates and reconnect. Announce newly meaningful errors/transitions in a scoped region, not every poll/timestamp/tool tick. Coordinate placement with `surface-job-safety-progress`, but do not infer execution/publish success from the tree.

The observer owns only read operations, its timers/subscription and its observation store. It cannot interrupt sessions or call publication/settlement completion. Catch transport/parser/storage/notification failures, rate-limit safe diagnostics, dispose in `finally`, and allow independent safety settlement to fail closed if its own proof is unavailable.

## Risks / Trade-offs

- Polling misses short intermediate running states → Reconcile available historical sessions, optionally accelerate with verified events, disclose gaps, and use a deliberately long-lived child in live acceptance.
- API/CLI event shapes drift → Pin adapters and fixtures, default to supported session polling, and report unsupported fields instead of guessing.
- Shared-service data is misattributed → Require root/workspace and each parent edge before attachment; test cross-job races and ignored filters.
- Observer bounds hide part of a large tree → Label partial counts/history and never reuse observation bounds or absence as safety proof.
- Metadata accidentally includes private prompts → Whitelist before persistence, sanitize delegation activity, cap/redact descriptions and assert privacy in storage/HTML/SSE tests.
- Slow CLI polls or database failures interfere with execution → Coalescing, concurrency/time limits, isolated stores/error handling and shutdown tests.

## Migration Plan

1. Add observation/coverage/transition tables in the next free additive migration. Seed existing managed terminal/unproven records as legacy evidence only where attempt/root attribution exists; mark missing parentage/timestamps and coverage unknown rather than inventing them.
2. Add early-root observation and polling with safe metadata projection before presenting counters. Introduce the optional event adapter only if the pinned contract probe proves it usable.
3. Integrate dashboard/detail fragments and exercise reconnect, interruption, restart, attribution and redaction fixtures. Run the opt-in real delegation harness and all existing child safety regressions.
4. Rollback can disable observer collection/presentation and leave additive evidence intact. It must not disable or modify #14's ownership/quiescence gates; expired observer state never authorizes continuation.
