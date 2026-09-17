## MODIFIED Requirements

### Requirement: Operator actions

The console SHALL offer retrying a failed, cancelled, or interrupted job;
cancelling a queued or running job; enabling or disabling a repository;
configuring its agent timeout, including no limit; configuring its inactivity
bound, which SHALL NOT offer no limit; and navigating to the pull request and the
triggering comment on GitHub.

Every such action SHALL be invocable from the console's own interface. A control
presented for an action SHALL either invoke that action or state why it is
unavailable; the console SHALL NOT present a control that does nothing.

Each action SHALL be offered only where it applies to the target's current state,
and the console SHALL reflect the outcome of an invoked action without requiring
the operator to navigate elsewhere to discover whether it took effect.

Every operator action SHALL be recorded with its time and effect.

#### Scenario: Retry from the console

- **WHEN** an operator retries a failed job
- **THEN** a new attempt is created under that job and the action is recorded

#### Scenario: Disable a repository from the console

- **WHEN** an operator disables a repository
- **THEN** subsequent commands for it produce no jobs

#### Scenario: Every offered control works

- **WHEN** an operator views the controls offered for a job or a repository
- **THEN** each control either performs its action when used or states why it is
  unavailable

#### Scenario: Reaching the pull request and the comment

- **WHEN** an operator views a job
- **THEN** the console links both to the pull request and to the triggering review
  comment on GitHub

#### Scenario: An action that cannot be performed

- **WHEN** an operator invokes an action the orchestrator cannot perform
- **THEN** the console reports the refusal in the view rather than failing silently

#### Scenario: The inactivity bound offers no way to disable it

- **WHEN** an operator configures a repository's inactivity bound
- **THEN** the console offers no "no limit" option for it, and rejects a value
  below the floor the system defines

## ADDED Requirements

### Requirement: A stalled attempt reads as stalled

The console SHALL distinguish an attempt that failed because the agent stopped
producing output from one that failed because it exceeded its maximum duration,
so that an operator can tell "stopped responding" from "took too long" without
reading the agent's raw output.

#### Scenario: Stall is labelled distinctly

- **WHEN** an operator views an attempt that failed on the inactivity bound
- **THEN** it is presented as stalled, distinctly from a timed-out attempt, and
  the time of the agent's last output is available
