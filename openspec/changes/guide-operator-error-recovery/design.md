## Context

See `proposal.md` — Why. The console is server-rendered HTML with shared client
behavior in `src/console/assets.ts`. Its current `data-live-status` node carries
connection heartbeats, stream errors, action progress, action success, and action
failure, so unrelated events overwrite one another. Actions return mostly
`{ ok: true }` or `{ error: <string> }`, and the client reports every result in
that same global node.

Job controls are rendered from persisted job state, while retry preparation and
workspace reset remain authoritative in the orchestrator and workspace layers.
The existing safety contracts are constraints: the browser cannot expand action
availability, reset remains confined to a system-derived path, raw secrets are
never rendered, and every operator action and refusal remains auditable. The
active `add-agent-stall-failsafe` change also adds `stalled` as an outcome that
must remain distinct from a maximum-duration timeout.

## Goals / Non-Goals

**Goals:**

- Give the client a small, stable presentation contract for action outcomes and
  recovery advice without making it a second policy engine.
- Preserve contextual feedback across SSE fragment swaps and announce only
  meaningful state transitions.
- Make the exact target and consequence of reset visible before typed
  confirmation, then revalidate that target at invocation.
- Keep the change localized to the console boundary and its tests.

**Non-Goals:**

- Changing retry eligibility, retained-edit rules, workspace reset scope, or any
  job transition.
- Adding automatic recovery, automatic retry, or a new operator action.
- Diagnosing the root cause of an agent stall or timeout beyond the recorded
  reason.
- Replacing SSE, changing persistence, or weakening redaction and audit behavior.

## Decisions

### D1 — Derive recovery advice on the server as a presentation model

Add a focused console recovery presenter that maps the current `JobDetail`,
repository state, recorded failure reason, and available configured actions to a
small `RecoveryAdvice` model. The model contains the recorded reason label,
retained-state summary, one recommended kind (`retry`, `reset`, `configure`, or
`wait`), consequence copy, and an identifier for an already-authorized control.
It does not execute anything.

The mapping will enumerate known failure reasons, including separate entries for
`stalled` and maximum-duration timeout. Unknown reasons use safe generic copy and
recommend inspection or waiting rather than guessing that reset is safe.
Retry copy describes retained-edit reuse as conditional on the existing
authoritative eligibility checks; it never promises reuse based only on browser
state.

This keeps policy at the layers that already own it. Controls continue to be
rendered only for states where the server offers them, and action handlers repeat
their existing checks when invoked. A recommendation can highlight or link to an
existing control but cannot manufacture an enabled action.

*Alternative considered:* map reason strings to actions entirely in
`assets.ts`. Rejected because a stale page or new failure reason could expose a
misleading recovery action, and the browser lacks authoritative workspace and
repository state.

### D2 — Return a backward-compatible action-feedback envelope

Console mutation routes will retain their existing success fields (for example,
`enabled`) and add a consistent feedback object with an action identifier,
operator-safe message, retained-state summary, and the one current recommendation.
Expected failures and refusals use stable reason codes mapped to redacted display
copy. Unexpected exception text is logged through existing redaction and returned
as a generic operator-facing cause rather than echoed verbatim.

The route builds feedback after the underlying action accepts or refuses the
request, so it can describe the authoritative post-action state. Audit recording
stays at the existing action/workspace authority; the presentation envelope must
not create a second or duplicate audit event.

*Alternative considered:* keep returning raw error strings and maintain a client
lookup table. Rejected because it couples UX copy to exception text, risks secret
disclosure, and cannot reliably state what was retained.

### D3 — Key visible feedback to an action scope, separate from connection state

Action groups in job, repository, and danger-zone views will render a stable
`data-action-scope` plus a nearby feedback placeholder. The client stores the
latest feedback by that scope and registers it with the keyed reconciler owned by
`improve-console-accessibility-and-session-ux`. If this change lands first, it
uses only a narrowly compatible scoped-state adapter that the shared reconciler
later absorbs. A new action from the same scope replaces it; a connection
transition does not.

Connection state gets its own persistent visual node with three states:
connected, reconnecting, and disconnected/stale. `EventSource.onopen` and
`readyState`-aware error handling update it only when the state changes.
Heartbeat payloads update neither action feedback nor accessible text. The
existing health fragment may still refresh observed orchestrator health; it is
not treated as proof that the browser's stream is connected.

*Alternative considered:* make every action result a global toast. Rejected
because toasts detach failures from their source, are easily overwritten, and
do not survive current fragment swaps.

### D4 — Use one deduplicating announcer in addition to persistent feedback

Visible feedback and connection state remain in the document. Recovery semantics
register new action failures, changed recovery recommendations, and connection
transitions with the scoped deduplicating announcement helper owned by
`improve-console-accessibility-and-session-ux`; this change does not create a
second live-region mechanism. Event keys suppress identical repeats caused by
rerendering, heartbeats, or elapsed-time ticks. Invoking an action disables only
its own control and does not move focus; completion restores that control's
appropriate server-derived state.

Authentication errors keep their existing alert semantics because they are not
part of the event stream or operator-action workflow.

*Alternative considered:* put `aria-live` on every feedback placeholder and the
health region. Rejected because SSE swaps would repeatedly announce unchanged
content and make heartbeat-driven pages unusably noisy.

### D5 — Treat reset confirmation as a server-issued target snapshot

The job query/view will render the repository name, pull request number, and
exact deterministic reset path supplied by the server. The confirmation form
sends that displayed target together with the pull request number and exact
`RESET` text. The reset route recomputes the path from the current repository
configuration and pull request using the existing workspace path derivation and
refuses a mismatch before invoking reset.

The path check supplements rather than replaces the workspace layer's existing
beneath-root, system-derived-path, and adopted-checkout protections. The dialog
copy explicitly says the bounded workspace contents are discarded and rebuilt,
while job, attempt, and audit records remain.

*Alternative considered:* display the path but submit only repository and pull
request as today. Rejected because a configuration or target change between
render and invocation would make the operator's typed confirmation refer to a
different path than the one actually reset.

## Risks / Trade-offs

- **Recovery copy drifts from execution rules.** → Keep recommendations in a
  typed, exhaustively tested server presenter and phrase retained-edit reuse as
  conditional on the existing workspace checks; never reproduce those checks in
  the browser.
- **Action feedback survives after it is no longer relevant.** → Key it by action
  scope and clear or replace it only on explicit dismissal, a new action in that
  scope, or an authoritative state update that changes its recommendation.
- **An SSE error briefly reports reconnecting before a permanent disconnect is
  known.** → Use the EventSource ready state, transition to disconnected when it
  closes, and always state that visible data may be stale while not connected.
- **Structured feedback exposes operational detail.** → Return allow-listed
  reason codes and composed, redacted summaries; do not serialize exception
  objects, credentials, captured output, or arbitrary paths beyond the exact
  reset target already visible to the authenticated local operator.
- **The active stall-failsafe lands in either order.** → Isolate its display
  label in the recovery reason mapping and add tests for both `stalled` and
  timeout; do not modify its orchestration semantics or duplicate its delta
  requirement.

## Migration Plan

1. Add the recovery presentation model and focused unit coverage for known,
   unknown, stalled, and timed-out outcomes.
2. Extend server-rendered action scopes, recovery guidance, connection status,
   and the deduplicating announcer while retaining existing response fields.
3. Adopt the feedback envelope across job, repository, settings, and reset
   mutations; retain current endpoint paths and authorization.
4. Add reset target snapshot validation, then update integration tests for exact
   path display, typed confirmation, stale-target refusal, audit, and redaction.
5. Roll back by ignoring/removing the additive feedback fields and new rendering;
   no database or persisted-data migration is required.
