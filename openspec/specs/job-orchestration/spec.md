# job-orchestration Specification

## Purpose
Models each resolution attempt as a durable, observable job with explicit states,
serializes work that would otherwise collide, and defines what happens to in-flight
work when the process stops unexpectedly.

## Requirements

### Requirement: Durable job and attempt records

The system SHALL persist a job for every authorized command. A job SHALL record its
identifier, repository, pull request number, triggering comment identifier, command
name, current status, creation time, and terminal time when finished.

Each execution of a job SHALL be persisted as an attempt, recording the attempt
number, agent, model, workspace path, start and end times, agent exit status,
validation outcome, resulting commit identifier when one exists, GitHub reporting
outcome, and error detail when the attempt failed.

Job and attempt records SHALL survive process restart.

#### Scenario: History survives restart

- **WHEN** the orchestrator is restarted after jobs have completed
- **THEN** all prior jobs and their attempts remain readable with their recorded
  detail

#### Scenario: Retry adds an attempt

- **WHEN** a failed job is retried
- **THEN** a second attempt is recorded against the same job, and the first
  attempt's record is preserved unchanged

### Requirement: Explicit lifecycle states

A job SHALL occupy exactly one status at a time, drawn from a defined set that
distinguishes at minimum: queued, preparing workspace, running agent, validating,
publishing, reporting, succeeded, failed, cancelled, and interrupted.

Every status transition SHALL be persisted with its timestamp, so that a job's
timeline is reconstructable after the fact.

#### Scenario: Timeline is reconstructable

- **WHEN** an operator inspects a completed job
- **THEN** the ordered sequence of statuses the job passed through, with the time
  of each transition, is available

#### Scenario: Failure records its stage

- **WHEN** a job fails
- **THEN** the persisted record names the status the job was in when it failed

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

- **WHEN** an attempt ends by crash, timeout, or cancellation
- **THEN** the lock for that pull request is released and subsequent queued work
  for it can proceed

### Requirement: Bounded concurrency

The system SHALL limit the number of attempts executing simultaneously to a
configured maximum. Work beyond the limit SHALL wait in the queue.

#### Scenario: Concurrency limit respected

- **WHEN** more eligible jobs exist than the configured concurrency limit
- **THEN** the number of simultaneously running attempts never exceeds the limit

### Requirement: Queued work reflects current pull request state

Before starting a queued attempt, the system SHALL re-verify that the pull request
is still open and its head branch still exists. If either check fails, the job
SHALL terminate as failed with the specific reason rather than proceeding.

#### Scenario: Pull request closed while queued

- **WHEN** a queued job's pull request is closed before the job starts
- **THEN** the job fails with a reason identifying the pull request state, and no
  workspace is prepared

### Requirement: Cancellation semantics

The system SHALL support cancelling a queued or running job. Cancelling a queued
job SHALL prevent it from starting. Cancelling a running job SHALL terminate the
agent process.

A cancelled attempt SHALL NOT commit or push. Cancellation SHALL be observed for
the whole duration of an attempt, including after the agent has exited and while
the attempt is validating, publishing, or reporting. A cancel requested during any
of those stages SHALL take effect at the next point the attempt is between
operations, and SHALL NOT be deferred until the stage completes of its own accord.

Where an attempt is cancelled after a commit has been created but before it has
been pushed, the commit SHALL remain in the workspace and SHALL NOT be pushed, and
the job record SHALL state that the workspace holds an unpushed commit.

Modifications left in the workspace by a terminated agent SHALL be preserved for
inspection, and the job record SHALL state whether the workspace contains
uncommitted modifications.

#### Scenario: Cancelling a running attempt

- **WHEN** an operator cancels a job whose agent is running
- **THEN** the agent process is terminated, nothing is committed or pushed, and
  the job reaches the cancelled status

#### Scenario: Cancelled workspace is inspectable

- **WHEN** an agent is terminated mid-edit
- **THEN** the workspace retains its modifications and the job record indicates
  that uncommitted changes are present

#### Scenario: Cancelling during publishing, before any commit

- **WHEN** an operator cancels a job that has entered the publishing stage and no
  commit has been created yet
- **THEN** no commit is created, nothing is pushed, and the job reaches the
  cancelled status

#### Scenario: Cancelling between the commit and the push

- **WHEN** an operator cancels a job after the attempt has committed but before the
  push has begun
- **THEN** the push does not occur, the commit remains in the workspace, the job
  record states that an unpushed commit is present, and the job reaches the
  cancelled status

#### Scenario: Cancellation is not deferred to the end of a stage

- **WHEN** an operator cancels a job during publishing
- **THEN** the cancellation takes effect at the next boundary between operations
  rather than after the remaining publishing work has run to completion

### Requirement: Interrupted job detection on startup

On startup the system SHALL identify jobs persisted in a non-terminal status,
mark them as interrupted, and preserve their recorded detail. Interrupted jobs
SHALL NOT resume or re-execute automatically.

#### Scenario: Crash during agent execution

- **WHEN** the process terminates while a job is running the agent, and is then
  restarted
- **THEN** that job is marked interrupted, its logs are retained, and no agent is
  launched for it without an explicit operator action

#### Scenario: Interrupted job is retryable

- **WHEN** an operator retries an interrupted job
- **THEN** a new attempt begins under the same job
