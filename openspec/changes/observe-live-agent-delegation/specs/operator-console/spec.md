## ADDED Requirements

### Requirement: Delegation summaries and attempt trees are live and truthful

The dashboard SHALL expose an unobtrusive per-running-job delegation summary with observed active/completed child counts and partial/unavailable coverage where applicable. Job detail and live preview SHALL offer an expandable parent-to-child execution view with actual identity when known, session identity, state, elapsed time and last observable activity. The view SHALL distinguish configured/callable agents, no delegations observed yet, and delegation not observable; separate attempts and root invocations SHALL remain distinguishable. Cline and unsupported runtimes SHALL show limited-data states without masquerading as managed OpenCode teams.

#### Scenario: Two delegated children change state

- **WHEN** one of two observed active children finishes while the other continues
- **THEN** dashboard counts and the correct detail nodes update without a page reload

#### Scenario: No child evidence exists yet

- **WHEN** supported healthy observation has not seen a child
- **THEN** the view says no delegations observed yet and does not render configured agents as completed or running

#### Scenario: Runtime observation is unavailable

- **WHEN** session evidence cannot be obtained from the executor
- **THEN** both the summary and drilldown disclose limited observability rather than claiming there were no delegations

### Requirement: Delegation updates preserve interaction and historical uncertainty

Delegation views SHALL use the existing authenticated live-update boundary, stable node identity and scoped announcements. Updates SHALL preserve expansion, focus, reading/scroll position and follow state for surviving nodes. Reconnection SHALL not duplicate children or reset user interaction. Interrupted/restarted history SHALL retain unknown outcomes and telemetry-gap notes rather than converting them to confirmed cancellation or completion. Routine elapsed-time and observation ticks SHALL remain quiet.

#### Scenario: Expanded child receives an unrelated update

- **WHEN** an operator expands a child and another child changes state
- **THEN** the expanded node, focus and reading position remain stable

#### Scenario: SSE reconnect follows missed child updates

- **WHEN** live fragments reconnect after child state changes
- **THEN** current evidence is reconciled by stable session/invocation identity and expansion/follow state remains intact

#### Scenario: Interrupted job contains unproven child outcomes

- **WHEN** the operator opens an interrupted job with unresolved child evidence
- **THEN** those nodes remain explicitly unknown with coverage notes rather than inferred cancelled results
