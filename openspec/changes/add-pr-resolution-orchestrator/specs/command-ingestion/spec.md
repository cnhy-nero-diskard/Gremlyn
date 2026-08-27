## Purpose

Detects relevant GitHub activity, normalizes it into internal events regardless of
transport, extracts commands from comment text, and guarantees that a given command
occurrence executes at most once.

## ADDED Requirements

### Requirement: Transport-independent event normalization

The system SHALL normalize GitHub activity into internal events before any other
processing. Downstream components — authorization, job creation, orchestration —
SHALL depend only on the normalized event shape and SHALL NOT depend on the
delivery mechanism.

A normalized event SHALL carry at minimum: the source repository owner and name,
the event kind, the comment identifier, the comment author's GitHub login, the
comment body, the pull request number, and the timestamp reported by GitHub.

#### Scenario: Transport substitution preserves behavior

- **WHEN** the ingestion transport is replaced with an alternative that produces
  equivalent normalized events
- **THEN** authorization, job creation, and execution behavior are unchanged

### Requirement: Command detection in comment text

The system SHALL detect commands appearing in normalized event comment bodies. A
command SHALL be recognized only when it appears as a standalone token at the start
of a line, and SHALL NOT be recognized inside fenced code blocks, inline code
spans, or block quotes.

#### Scenario: Command at start of line

- **WHEN** a comment body's first line is `!RESOLVE`
- **THEN** the `RESOLVE` command is detected

#### Scenario: Command quoted in code fence

- **WHEN** a comment body contains `!RESOLVE` only inside a fenced code block
- **THEN** no command is detected

#### Scenario: Command quoted in a reply

- **WHEN** a comment body contains `!RESOLVE` only inside a block quote line
  beginning with `>`
- **THEN** no command is detected

#### Scenario: Unknown command token

- **WHEN** a comment body begins with a command-like token that is not registered
- **THEN** no command is detected and the event is recorded as carrying no command

### Requirement: Extensible command registry

The system SHALL support registering additional commands without modifying the
ingestion, authorization, or orchestration components. Only `RESOLVE` is required
initially.

#### Scenario: Adding a command

- **WHEN** a new command is registered with its parser and handler
- **THEN** it is detected and routed without changes to event normalization,
  authorization checks, or the job lifecycle

### Requirement: Command placement eligibility

The `RESOLVE` command SHALL be accepted only when it appears on a pull request
review comment thread, which supplies the file, line or diff hunk, and thread
context required to reconstruct the feedback.

A `RESOLVE` command appearing as a top-level pull request conversation comment
SHALL be rejected with an explanatory reply, and SHALL NOT be reinterpreted as a
request to resolve all outstanding threads.

#### Scenario: Command on a review thread

- **WHEN** `!RESOLVE` is posted as a reply within an inline review comment thread
- **THEN** the command is eligible and proceeds to authorization

#### Scenario: Command on the conversation tab

- **WHEN** `!RESOLVE` is posted as a top-level pull request comment with no
  associated review thread
- **THEN** the command is rejected, a reply explains that `!RESOLVE` must be used
  on a review comment thread, and no job is created

### Requirement: At-most-once command execution

The system SHALL persist a stable identity for every command occurrence it
processes, derived from the repository, pull request number, comment identifier,
and command name. Redelivery of an event whose identity has already been recorded
SHALL NOT create a new job or invoke an agent.

The recorded identity SHALL be committed before agent invocation, so that a crash
between detection and execution does not permit silent re-execution on restart.

#### Scenario: Duplicate delivery

- **WHEN** the same comment is observed twice by the ingestion layer
- **THEN** the second observation is recorded as already processed and no
  additional job is created

#### Scenario: Edited comment retains identity

- **WHEN** a comment that already triggered a command is edited and observed again
- **THEN** the command is not executed a second time

#### Scenario: Crash before execution

- **WHEN** the process terminates after a command is recorded but before the agent
  is invoked
- **THEN** on restart the command is not re-executed automatically

### Requirement: Manual retries are distinct attempts

A retry initiated by an operator SHALL be recorded as a new attempt under the same
logical job, and SHALL NOT require or produce a new command identity.

#### Scenario: Operator retries a failed job

- **WHEN** an operator retries a failed job
- **THEN** a new attempt is recorded against the existing job, and deduplication
  does not block it

### Requirement: Ingestion progress is durable

The system SHALL persist ingestion progress so that a restart resumes from the last
observed position rather than reprocessing all historical activity or skipping
activity that occurred while the process was stopped.

#### Scenario: Restart after downtime

- **WHEN** the orchestrator is stopped, commands are posted, and it is restarted
- **THEN** the commands posted during downtime are observed exactly once
