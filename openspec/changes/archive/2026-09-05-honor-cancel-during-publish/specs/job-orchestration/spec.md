## MODIFIED Requirements

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
