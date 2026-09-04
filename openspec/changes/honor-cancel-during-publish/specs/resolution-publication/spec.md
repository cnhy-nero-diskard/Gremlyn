## ADDED Requirements

### Requirement: Cancellation checkpoint before publication

Publication SHALL observe cancellation independently of its preconditions. The
system SHALL check for cancellation before creating a commit and again immediately
before pushing, and SHALL abandon publication at either point if the attempt has
been cancelled.

A cancelled attempt SHALL NOT be recorded or reported as a publication precondition
failure. Cancellation is an operator decision, not a judgement about the work, and
the two SHALL remain distinguishable in the attempt record and in anything reported
to the pull request.

#### Scenario: Cancelled before the commit

- **WHEN** an attempt satisfies every publication precondition but is cancelled
  before the commit is created
- **THEN** no commit is created, nothing is pushed, and the attempt is recorded as
  cancelled rather than as a blocked publication

#### Scenario: Cancelled between the commit and the push

- **WHEN** an attempt is cancelled after its commit has been created but before the
  push begins
- **THEN** the push does not occur and the attempt is recorded as cancelled, naming
  the commit that exists in the workspace

#### Scenario: Cancellation is not a precondition failure

- **WHEN** an attempt is cancelled during publishing
- **THEN** no publication precondition is named as the cause, and no outcome is
  reported to the pull request that attributes the stop to the work being unfit to
  publish
