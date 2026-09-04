# runtime-lifecycle Specification

## Purpose
Guarantees that exactly one Gremlyn instance owns a data directory at a time, and
that an instance which is asked to stop always does stop and always surrenders
that ownership — so a restart never requires manual cleanup.

## Requirements

### Requirement: Exclusive data directory ownership

The system SHALL claim exclusive ownership of its configured data directory
before opening the database, and SHALL refuse to start when another live
instance already owns it. The claim SHALL record the owning process identity so
that a later instance can distinguish a live owner from an abandoned claim.

#### Scenario: Second live instance is refused

- **WHEN** an instance is started against a data directory already owned by a
  running instance
- **THEN** the second instance refuses to start, reports which data directory is
  in use, and leaves the existing owner's claim and data untouched

#### Scenario: Claim precedes database access

- **WHEN** two instances are started against the same data directory
- **THEN** at most one of them opens the database

### Requirement: Abandoned ownership is reclaimed automatically

When the recorded owner of a data directory claim is no longer a live process,
the system SHALL reclaim the claim and continue starting, and SHALL report the
reclamation. A claim whose recorded owner cannot be determined SHALL be treated
as abandoned.

Reclamation SHALL NOT occur while the recorded owner is live.

#### Scenario: Restart after an abrupt termination

- **WHEN** an instance is terminated without releasing its claim, and a new
  instance is then started against the same data directory
- **THEN** the new instance reclaims the claim, reports that it did so, and
  starts normally without any manual file removal

#### Scenario: Unreadable or malformed claim

- **WHEN** the recorded claim cannot be parsed as a process identity
- **THEN** it is treated as abandoned and reclaimed, and the reclamation is
  reported

#### Scenario: Live owner is never reclaimed

- **WHEN** a claim's recorded owner is still running
- **THEN** the claim is not reclaimed and the starting instance refuses to start

### Requirement: Ownership is released on every exit path

The system SHALL release its data directory claim when the process exits, for
every exit path — an orderly shutdown, a startup failure occurring after the
claim was made, an unhandled error, and termination by a signal the process can
observe.

A failure while releasing the claim SHALL NOT prevent the remaining shutdown
steps from running.

#### Scenario: Startup fails after the claim is made

- **WHEN** startup fails after the data directory is claimed — for example
  because credentials are missing, the configured agent binary is unusable, or
  the GitHub token authenticates as an unexpected account
- **THEN** the process reports the failure and exits without leaving the data
  directory claimed

#### Scenario: Unhandled error during operation

- **WHEN** an unhandled error or rejection terminates the process while it is
  running
- **THEN** the data directory claim is released before the process exits

#### Scenario: Release error does not strand shutdown

- **WHEN** releasing the claim fails
- **THEN** the failure is reported and the remaining shutdown steps still
  complete

### Requirement: Shutdown completes even with live console connections

Shutdown SHALL terminate the console's held-open live-update connections before
waiting for the HTTP server to close, so that a connected console cannot prevent
the process from exiting.

#### Scenario: Console left open during shutdown

- **WHEN** an operator has the console open with live updates connected, and the
  process is asked to stop
- **THEN** the live-update connections are ended, the server closes, the data
  directory claim is released, and the process exits without operator
  intervention

### Requirement: A repeated stop request escalates

A second stop request received while shutdown is already in progress SHALL
escalate to terminating the process, rather than being ignored. Escalation SHALL
still attempt to release the data directory claim.

#### Scenario: Operator interrupts twice

- **WHEN** an operator issues a stop request, shutdown does not complete, and the
  operator issues a second stop request
- **THEN** the process terminates, having attempted to release its data directory
  claim

### Requirement: Ownership can be released by explicit operator instruction

The system SHALL provide an explicit operator instruction that releases a data
directory claim without starting the orchestrator, for the case where a claim
must be surrendered and automatic reclamation does not apply.

#### Scenario: Operator releases a claim deliberately

- **WHEN** an operator invokes the release instruction for a data directory
- **THEN** the claim is removed, the outcome is reported, and no orchestrator is
  started

#### Scenario: Release instruction reports a live owner

- **WHEN** an operator invokes the release instruction while the recorded owner is
  still running
- **THEN** the operator is told the owner is live and the claim is removed only
  when the operator confirms overriding that
