## MODIFIED Requirements

### Requirement: Per-pull-request execution locking

The system SHALL ensure that at most one attempt mutating a given pull request runs
at any time. The lock SHALL be keyed on the repository and pull request number.

#### Scenario: Second command for a busy pull request

- **WHEN** a command arrives for a pull request that already has a running attempt
- **THEN** the new job is queued rather than started, and no second agent process
  is launched against that pull request

#### Scenario: Independent pull requests proceed concurrently

- **WHEN** commands arrive for two different pull requests and concurrency permits
- **THEN** both may execute at the same time

#### Scenario: Lock released on abnormal termination

- **WHEN** an attempt ends by crash, timeout, stall, or cancellation
- **THEN** the lock for that pull request is released and subsequent queued work
  for it can proceed
