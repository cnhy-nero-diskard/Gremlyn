## Why

Gremlyn's current activity stream is flat, and managed child-session evidence is collected chiefly after the parent exits, so operators cannot reliably see delegation during a long job. [Issue #15](https://github.com/cnhy-nero-diskard/Gremlyn/issues/15) requires a live, attributable parent-to-child view for managed and externally configured OpenCode agents that distinguishes configured capability from actual invocation.

## What Changes

- Establish a bounded telemetry-contract investigation against the pinned OpenCode runtime before choosing collection transport. Verify early parent-session identification, child parentage/workspace attribution, agent/model identity, activity/idle/terminal signals, concurrent/background sessions, and reconnect behavior through supported sources; document unsupported facts rather than inventing them.
- Observe child execution while the parent runs and through post-parent settlement. Correlate every observed node with repository, job, attempt, parent invocation/session, and workspace; retain separate roots when internal invocation retries create multiple parent sessions within one attempt. Reuse strict attribution checks rather than inferring ownership from a shared active-session list.
- Persist bounded, privacy-safe observations: session and parent IDs, actual agent/model identity when available, observed state/outcome, source timestamps when exposed, first/last observation, and telemetry coverage/freshness. Keep configured/callable agents separate from actual child-session nodes, including repeated invocations of the same agent.
- Distinguish configured-but-not-observed, invoked, running, idle, succeeded/failed/interrupted, and unknown/unobservable states using supported evidence. Show cancellation requests separately from confirmed interruption, and missing or contradictory observations as unknown. Do not equate inactivity or absence from the active map with terminal completion, or describe polling freshness as an agent heartbeat.
- Support both dashboard-managed profiles and native/project/global orchestrators where attributed runtime telemetry permits it. Distinguish **no delegations observed yet** from **delegation not observable**, and provide an honest limited-data state for Cline and other executors. Do not claim configured agents ran or guarantee complete observation across gaps.
- Add a compact delegation summary to running dashboard jobs and an expandable parent/child execution view in job detail/live preview, with state, identity, elapsed time, and last observed activity. Make overlapping/background sessions legible, keep prior attempts separate, and retain useful history after restart without leaving stale nodes labeled running.
- Use supported events for responsiveness where verified, with bounded session reconciliation to recover after disconnects or missed events; an event stream alone is not a complete history. Feed changes into existing authenticated SSE/fragment updates while preserving keyed expansion, focus, reading position, and follow state, with quiet routine updates.
- Keep collection observational and failure-isolated. Whitelist metadata before persistence/projection, redact and cap retained data, and exclude private instructions, prompts, sensitive tool arguments, and raw event dumps. Observer failures produce telemetry-gap evidence, never a job outcome or a publication permission.

## Capabilities

### New Capabilities

- `agent-delegation-observability`: Live, strictly attributed and bounded parent/child execution evidence, durable session history, truthful lifecycle/freshness classification, reconnect reconciliation, and explicit unsupported/partial-data states across executors.

### Modified Capabilities

- `operator-console`: Dashboard delegation summaries and expandable live/historical attempt trees that distinguish configured agents from observed execution and preserve operator state during authenticated live updates.

## Impact

- Extends live session identification and observation around `src/agent/opencode.ts`, `src/agent/activity.ts`, `src/agent/managed-sessions.ts`, and `src/orchestrator/resolution.ts`; adds durable telemetry storage/migrations and redacted projections in `src/console/queries.ts`.
- Updates `src/console/views/dashboard.ts`, `src/console/views/job.ts`, `src/console/stream.ts`, and keyed client reconciliation in `src/console/assets.ts`. Reuse session parsing/attribution primitives without reusing safety verdicts as optimistic UI activity labels.
- Tests cover two simultaneous children, background sessions, multiple roots/attempts, never-invoked configuration, lost/contradictory telemetry, attribution errors, redaction/caps, cancel/retry/restart, polling races, and SSE reconnect/state preservation. An explicit opt-in real OpenCode acceptance run must observe a child running before the parent finishes and later show its terminal result; existing safety regressions remain mandatory.
- Independent of which primary the operator selects. Coordinate with `select-native-opencode-agent` (#14), which owns extending native invocation/recovery safety, and `surface-job-safety-progress`, which owns end-to-end job progress. This change does not change delegation permissions, cancellation policy, quiescence/publication gates, or add terminal sounds.
- Precise percent-complete estimates, child transcript export, raw tool/prompt inspection, new delegation controls, and unbounded recursive visualization are out of scope. Supported nested execution may be represented only through bounded, verified parentage, with explicit coverage limits.
