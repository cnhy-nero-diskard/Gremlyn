## MODIFIED Requirements

### Requirement: Operator actions

The console SHALL offer retrying a failed, cancelled, or interrupted job;
cancelling a queued or running job; enabling or disabling a repository;
configuring its agent timeout, including no limit; configuring its inactivity
bound, which SHALL NOT offer no limit; and navigating to the pull request and the
triggering comment on GitHub.

Every operator action SHALL be recorded with its time and effect.

#### Scenario: Retry from the console

- **WHEN** an operator retries a failed job
- **THEN** a new attempt is created under that job and the action is recorded

#### Scenario: Disable a repository from the console

- **WHEN** an operator disables a repository
- **THEN** subsequent commands for it produce no jobs

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
