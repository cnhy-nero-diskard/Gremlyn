## MODIFIED Requirements

### Requirement: Bounded execution

Every agent invocation SHALL have a bounded retry allowance, SHALL have a
bounded period of inactivity, and MAY have a configured maximum duration.

The inactivity bound SHALL always be in force. It SHALL have a non-zero default
so that an installation which configures nothing is still protected, and it
SHALL NOT be configurable to zero, to no limit, or to any value below a floor
the system defines. Inactivity SHALL be measured from the agent's most recent
observable output; each new output resets it. When the bound elapses with no
output, the system SHALL terminate the agent process and fail the attempt with a
stall reason, distinct from the timeout reason.

When a maximum duration is configured and exceeded, the system SHALL terminate
the agent process and fail the attempt with a timeout reason. An unset or zero
maximum duration SHALL leave the agent free to run for as long as it keeps
producing output, bounded only by the inactivity bound.

Work left in the workspace by a timed-out or stalled agent SHALL be preserved for
inspection and SHALL NOT be committed or pushed.

#### Scenario: Agent exceeds its time limit

- **WHEN** an agent invocation runs longer than the configured maximum
- **THEN** the process is terminated, the attempt fails with a timeout reason, and
  nothing is published

#### Scenario: Agent stops producing output

- **WHEN** an agent invocation produces no output for longer than the inactivity
  bound
- **THEN** the process is terminated, the attempt fails with a stall reason
  distinct from a timeout, and nothing is published

#### Scenario: A slow but productive agent is not interrupted

- **WHEN** an agent runs for longer than the inactivity bound in total but never
  goes without producing output for that long, and no maximum duration is
  configured
- **THEN** the invocation is allowed to continue

#### Scenario: The inactivity bound cannot be switched off

- **WHEN** a configuration sets the inactivity bound to zero, to no limit, or
  below the system's floor
- **THEN** the configuration is rejected as invalid and the system does not start
  with it

#### Scenario: Stalled work survives for inspection

- **WHEN** an attempt fails with a stall reason
- **THEN** the workspace retains the agent's edits, and nothing is committed or
  pushed

## ADDED Requirements

### Requirement: Termination reaps the process tree

When the system terminates an agent invocation — whether by operator
cancellation, by the maximum duration, or by the inactivity bound — it SHALL
leave no process descended from that invocation running. This SHALL hold for
descendants the agent detached from its own process tree, which do not receive a
signal sent to the agent process alone.

Reaping SHALL be reported: a descendant that cannot be terminated SHALL be
recorded rather than passed over in silence.

#### Scenario: Detached descendants are terminated

- **WHEN** an agent starts a long-running child that detaches itself, and the
  attempt is then cancelled, times out, or stalls
- **THEN** that child is terminated along with the agent, and no process from the
  invocation is left running

#### Scenario: A descendant that survives is recorded

- **WHEN** the system cannot terminate a descendant of the agent process
- **THEN** the survivor is recorded against the attempt rather than ignored
