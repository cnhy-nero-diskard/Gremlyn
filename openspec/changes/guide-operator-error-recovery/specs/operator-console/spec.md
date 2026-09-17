## ADDED Requirements

### Requirement: Connection health and action feedback are separate

The console SHALL present its connection and live-update health independently
from the result of an operator action. A connection transition or routine event
stream heartbeat SHALL NOT replace, clear, or masquerade as feedback for an
action, and action feedback SHALL NOT imply that the event stream is healthy.

The connection status SHALL distinguish connected, reconnecting, and disconnected
states and SHALL state when displayed operational data may be stale.

#### Scenario: Event stream reconnects after an action failure

- **WHEN** an operator action fails and the event stream subsequently reconnects
- **THEN** the action failure remains with its originating control while the
  connection status independently reports the reconnection

#### Scenario: Connection is lost while data remains visible

- **WHEN** the console loses its live-update connection
- **THEN** it reports that live updates are disconnected and that the displayed
  operational data may be stale without presenting an operator action as failed

#### Scenario: Routine heartbeat arrives

- **WHEN** the console receives a routine event-stream heartbeat without a
  meaningful health transition
- **THEN** neither action feedback nor the operator-facing connection status is
  replaced

### Requirement: Action feedback is contextual and actionable

The console SHALL present the outcome of an operator action beside the control
or control group that originated it. A failed or refused action SHALL identify,
in redacted operator-facing language, the cause, what job or workspace state was
retained, and exactly one recommended next action.

The recommended action and whether its control is available SHALL be derived from
the server-authoritative current state. Client presentation SHALL NOT make an
otherwise unavailable action invocable. Feedback SHALL remain visible until the
operator dismisses it, retries or replaces the action, or a server-authoritative
state change makes it obsolete.

#### Scenario: Mutation is refused because state changed

- **WHEN** an operator invokes an action that is no longer valid for the target's
  current state
- **THEN** the refusal appears beside that action, identifies the current state,
  states what was left unchanged, and recommends one action that is valid now

#### Scenario: Repository configuration mutation fails

- **WHEN** saving a repository setting fails
- **THEN** the failure appears with that repository's setting controls, identifies
  which persisted values remain authoritative, and recommends one next action

#### Scenario: Sensitive cause detail is available

- **WHEN** an action failure contains a credential, token, or other configured
  secret in its underlying detail
- **THEN** the operator-facing cause and retained-state explanation are redacted
  before they are rendered

### Requirement: Recovery guidance distinguishes consequences

For a failed, cancelled, interrupted, stalled, or timed-out attempt, the console
SHALL explain the recovery paths that the server-authoritative current state
allows. Retry, Reset, configuration repair, and Wait SHALL be presented as
distinct paths and SHALL state, before invocation, what each path reuses,
preserves, or discards.

The console SHALL recommend exactly one of those paths when recovery is required.
It SHALL preserve the recorded distinction between an agent that stalled through
inactivity and an agent that exceeded its maximum duration, and SHALL NOT describe
either outcome as the other.

#### Scenario: Retry can resume retained edits

- **WHEN** the current attempt and deterministic workspace satisfy the existing
  conditions for a retry to resume retained edits
- **THEN** Retry explains that it creates a new attempt under the same job, may
  reuse that workspace and its eligible retained edits, and preserves all prior
  attempt and audit records

#### Scenario: Retry cannot safely reuse the workspace

- **WHEN** the current state does not satisfy the conditions for resuming retained
  edits
- **THEN** the console does not imply that Retry will reuse them and recommends
  the server-authoritative safe recovery path

#### Scenario: Reset is offered for an inconsistent bounded workspace

- **WHEN** an operator may reset a system-derived workspace to recover from an
  inconsistent state
- **THEN** Reset explains that it discards the contents of that exact bounded
  workspace and rebuilds it while preserving the job, attempt, and audit records

#### Scenario: Configuration repair is required

- **WHEN** recovery requires correcting a repository setting rather than changing
  workspace contents
- **THEN** configuration repair identifies the setting to review, explains that
  the workspace and prior records are preserved, and does not imply that a retry
  or reset has already occurred

#### Scenario: Waiting is the safe next action

- **WHEN** an action is temporarily unavailable because authoritative work is
  queued, running, cancelling, or awaiting a live state refresh
- **THEN** Wait explains the condition being awaited, preserves the current job
  and workspace state, and does not invoke a mutation

#### Scenario: Stall and maximum-duration timeout remain distinct

- **WHEN** recovery guidance is shown for one stalled attempt and one attempt that
  exceeded its maximum duration
- **THEN** the first is described as having stopped producing output and the
  second as having taken too long, with neither reason collapsed into the other

### Requirement: Meaningful recovery changes are announced accessibly

The console SHALL expose failed or refused actions, recommended recovery changes,
and connection-health transitions through assistive-technology announcements
that identify the affected action or connection. Routine heartbeats, unchanged
status refreshes, elapsed-time ticks, and repeated renderings of an unchanged
message SHALL NOT generate announcements.

An announcement SHALL supplement rather than replace persistent visible feedback,
and focus SHALL remain at the control the operator used unless the operator moves
it.

#### Scenario: Action failure is announced once

- **WHEN** an invoked operator action fails
- **THEN** assistive technology receives one announcement identifying the action,
  the failure, and the recommended next action while visible feedback remains by
  the originating control

#### Scenario: Heartbeat does not create noise

- **WHEN** routine event-stream heartbeats or elapsed-time refreshes arrive while
  the connection and action state are unchanged
- **THEN** no assistive-technology announcement is generated

#### Scenario: Recovery recommendation changes

- **WHEN** a server-authoritative state change replaces the recommended recovery
  action with a different one
- **THEN** the new recommendation is announced once without moving keyboard focus

## MODIFIED Requirements

### Requirement: Destructive actions are separated and confirmed

Actions that discard work — including discarding and recreating a workspace —
SHALL be visually and structurally separated from routine actions and SHALL require
an explicit confirmation step.

The confirmation step SHALL be reachable from the console: the operator SHALL be
able to supply the required confirmation and complete the action without leaving
the console. For a workspace reset, the confirmation SHALL name the repository,
pull request, and exact server-authoritative workspace path that will be discarded,
and SHALL explain that the workspace will be recreated while job, attempt, and
audit records are retained.

The reset action SHALL remain unavailable until the operator enters the exact text
`RESET`. The server SHALL still verify that the target is the system-derived path
for that repository and pull request beneath its configured workspace root, and a
stale or mismatched confirmation target SHALL be refused without discarding work.
Every invocation and refusal SHALL remain recorded with its target and effect.

#### Scenario: Workspace reset requires confirmation

- **WHEN** an operator requests that a workspace be discarded and recreated
- **THEN** the action is not available until the operator enters the exact text
  `RESET`

#### Scenario: Reset confirmation identifies its bounded target

- **WHEN** the console presents confirmation for a workspace reset
- **THEN** it names the repository, pull request, and exact system-derived path
  beneath the configured workspace root that will be discarded

#### Scenario: Destructive action is not adjacent to routine ones

- **WHEN** an operator views a job's available actions
- **THEN** destructive actions are presented separately from retry and cancel

#### Scenario: Confirming without leaving the console

- **WHEN** an operator supplies the required confirmation in the console
- **THEN** the destructive action becomes available and, when invoked, is
  performed and recorded

#### Scenario: Confirmation not yet supplied

- **WHEN** the required confirmation has not been supplied
- **THEN** the destructive action cannot be invoked from the console

#### Scenario: Confirmed target became stale

- **WHEN** the repository, pull request, or authoritative workspace target no
  longer matches the confirmation presented to the operator
- **THEN** the reset is refused and recorded, the workspace is left untouched,
  and the console requires a fresh confirmation for the current target
