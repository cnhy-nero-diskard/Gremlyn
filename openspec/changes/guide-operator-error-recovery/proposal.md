## Why

The operator console exposes failures and action outcomes, but it often leaves an
operator to infer whether the connection failed, an action was refused, retained
work is safe, or a destructive reset is warranted. Recovery guidance needs to be
local, explicit, and quiet enough that assistive technology announces meaningful
changes instead of routine heartbeat traffic.

## What Changes

- Separate console connection and SSE health from feedback about an operator
  action, so reconnecting does not overwrite or masquerade as a mutation result.
- Present an action failure beside the control that caused it, with a concise
  cause, the state that was retained, and one recommended next action.
- Give Retry, Reset, configuration repair, and Wait distinct guidance based on
  the authoritative job and action state; explain what each recovery path reuses,
  preserves, or discards before the operator invokes it.
- Strengthen destructive workspace-reset confirmation by naming the repository,
  pull request, and exact bounded workspace path while retaining the typed
  `RESET` guard and structural separation from routine actions.
- Announce meaningful failures and recovery outcomes to assistive technology
  without announcing connection heartbeats or other routine live updates.
- Preserve server-side action authorization, state gating, secret redaction,
  action auditing, workspace bounds, and the active distinction between an agent
  stall and a maximum-duration timeout.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Make failure feedback contextual and actionable, distinguish
  recovery paths and their data effects, strengthen destructive confirmations,
  and provide focused accessible announcements without changing server authority.

## Impact

- Console views and client behavior under `src/console/`, including connection
  status, action controls, inline feedback, recovery copy, and live regions.
- Existing console action responses may need structured, redacted metadata that
  lets the client explain retained state and the recommended next action without
  deriving authority locally.
- Console rendering, action-state, accessibility, and reset-confirmation tests.
- No new operator action, destructive scope, persistence rule, or orchestration
  outcome is introduced.
