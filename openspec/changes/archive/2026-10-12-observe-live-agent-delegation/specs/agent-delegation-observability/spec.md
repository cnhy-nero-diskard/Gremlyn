## Purpose

Defines trustworthy live and historical evidence of actual agent delegation, including session attribution, partial observability and bounded privacy-safe persistence independent of publication safety.

## ADDED Requirements

### Requirement: Observed execution is distinct from configured capability

The system SHALL represent an agent as invoked only after attributable runtime evidence of its execution exists. Configured or callable definitions SHALL remain separate from observed session nodes. Repeated invocations of one agent SHALL remain distinct sessions. Unsupported telemetry SHALL explicitly show delegation not observable, rather than asserting no subagents or inventing invocation evidence.

#### Scenario: Configured agent is never observed

- **WHEN** a managed profile enables a reviewer but no attributed reviewer session is observed
- **THEN** the view shows its configured/callable state separately and does not display it as having run

#### Scenario: Two sessions use the same agent

- **WHEN** two attributed sessions invoke the same agent definition
- **THEN** they appear as distinct execution nodes with their own timestamps and outcomes

#### Scenario: Telemetry is unsupported

- **WHEN** the executor or runtime provides no supported attributed delegation evidence
- **THEN** the view reports delegation not observable rather than no subagents

### Requirement: Live session attribution is strict and attempt specific

The system SHALL observe supported OpenCode child sessions while the parent is running and during settlement, for managed and externally configured orchestrators. Every observed node SHALL be correlated to repository, job, attempt, parent invocation/root session and the owned workspace through verified parentage and location. A global active-session entry, tool capability or session name alone SHALL NOT establish ownership. Multiple root invocations and bounded nested parentage SHALL remain distinct; rejected or incomplete attribution SHALL produce a coverage limitation without attaching another job's sessions.

#### Scenario: Concurrent and background children are visible live

- **WHEN** an attributable parent owns two overlapping child sessions, including one background session
- **THEN** live observations show both under the correct root while they are active and subsequently show their observed terminal results

#### Scenario: Another job's session is returned

- **WHEN** a session names a different parent or workspace despite appearing in a filtered response
- **THEN** it is not attached to this job and the observation records an attribution/coverage limitation

#### Scenario: Attempt contains multiple parent invocations

- **WHEN** an internal retry launches a second parent within an attempt
- **THEN** the two roots and their children remain separate and earlier evidence is not overwritten

### Requirement: Activity states are evidence backed and freshness is explicit

Nodes SHALL distinguish invocation evidence, running, idle, observed success/failure/interruption and unknown state using supported current records. Running SHALL require fresh active evidence; idle SHALL require readable nonterminal inactive evidence and SHALL NOT imply completion. A cancellation request SHALL remain distinct from confirmed interruption. Missing, stale or contradictory evidence SHALL become unknown with last-known state and observation time preserved. Polling time SHALL NOT be labeled agent activity or heartbeat, and no precise completion percentage SHALL be inferred from tools, tokens or elapsed time.

#### Scenario: Inactive child has no terminal outcome

- **WHEN** a readable attributed child is inactive but has no terminal outcome
- **THEN** it is shown as idle/nonterminal rather than finished or proven quiescent

#### Scenario: Terminal outcome contradicts active state

- **WHEN** an attributed session has a terminal outcome but is still active
- **THEN** its current display state is unknown with contradictory-evidence feedback rather than a confirmed completion

#### Scenario: Cancellation is requested

- **WHEN** Gremlyn requests cancellation but the runtime has not confirmed interruption
- **THEN** the node shows cancellation requested without fabricating a cancelled terminal outcome

#### Scenario: Observation becomes stale

- **WHEN** the session source stops yielding fresh supported observations
- **THEN** previously live nodes no longer assert running and retain their last-known evidence with a freshness/gap indication

### Requirement: Observability gaps reconcile without fabricated history

Collection SHALL use supported runtime sources and bounded reconciliation of attributed session records. Event disconnection, missed observations, polling races and truncated coverage SHALL be recorded explicitly. Reconnection SHALL recover current and available terminal evidence without duplicate nodes or claiming continuous coverage. No observed children with healthy coverage SHALL be described as no delegations observed yet, not proof that delegation never occurred.

#### Scenario: Events are lost during reconnect

- **WHEN** a child starts or finishes during an event-stream disconnection
- **THEN** session reconciliation recovers available attributed state and retains a note that intermediate activity may have been missed

#### Scenario: Bounded observation omits nodes

- **WHEN** session count, depth or retained-history bounds are reached
- **THEN** the view identifies incomplete coverage rather than presenting the visible subset as the complete execution tree

### Requirement: Safe bounded execution evidence survives restart

The system SHALL persist bounded session identity, parentage, invocation attribution, supported actual agent/model identity, source/observation times, state/outcome and coverage metadata. It SHALL NOT persist private instructions, prompts, arbitrary metadata, sensitive tool arguments or unbounded raw runtime events as delegation evidence. Parent/child distinction SHALL be retained in exposed activity where attribution is known; unknown identity SHALL be displayed as unknown. Restart SHALL preserve observed history and mark unresolved live evidence unknown until refreshed, without equating daemon interruption with child termination.

#### Scenario: History is inspected after restart

- **WHEN** a completed or interrupted job is opened after daemon restart
- **THEN** its safe session history remains attributable to the correct attempt and unresolved sessions are not displayed as currently running

#### Scenario: Delegation event carries private prompt arguments

- **WHEN** runtime delegation data contains a prompt, system instructions or credential-bearing tool input
- **THEN** only whitelisted safe identity/state fields enter delegation storage and public activity projections

#### Scenario: Identity is not exposed

- **WHEN** a runtime record exposes a session ID but no actual agent or model
- **THEN** the node retains its useful session evidence and explicitly unknown identity without substituting a configured definition

### Requirement: Observation cannot control execution safety

Observer transport, parsing, persistence and rendering failures SHALL be failure-isolated from jobs and SHALL report limited telemetry safely. Observations SHALL NOT authorize validation, workspace reuse or publication, modify delegation permissions, interrupt sessions independently, or replace fail-closed child settlement. Safety evidence can inform presentation, but presentation freshness or absence SHALL NOT prove termination.

#### Scenario: Telemetry source fails while agent work continues

- **WHEN** the observer loses its source or cannot persist an update
- **THEN** the job continues under its existing execution policy and the view reports unavailable/stale telemetry

#### Scenario: Display has no running children

- **WHEN** the observer shows zero running children or has incomplete data
- **THEN** validation/publication still requires independent existing quiescence proof
