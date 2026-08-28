## MODIFIED Requirements

### Requirement: Isolated agent state per attempt

Each attempt SHALL run with agent state isolated from other concurrent attempts, so
that simultaneous runs do not share or corrupt mutable agent state.

Isolation SHALL NOT deprive the agent of the credentials it needs to operate. The
system SHALL make the configured agent's provider credentials available to every
attempt despite that isolation, and SHALL NOT require the operator to authenticate
the agent separately for each attempt.

Credential material made available to an attempt SHALL NOT outlive that attempt,
and SHALL NOT be readable by any other attempt.

#### Scenario: Concurrent attempts do not interfere

- **WHEN** two attempts for different pull requests run at the same time
- **THEN** neither attempt observes or overwrites the other's agent session state

#### Scenario: An isolated attempt is authenticated

- **WHEN** an attempt runs with agent state isolated from every other attempt
- **THEN** the agent authenticates with its configured provider and begins work,
  rather than failing for lack of credentials

#### Scenario: Credentials do not outlive the attempt

- **WHEN** an attempt finishes, whether it succeeded, failed, timed out, or was
  cancelled
- **THEN** no credential material the system placed for that attempt remains on disk

### Requirement: Secrets are withheld from the agent

The system SHALL NOT expose orchestrator credentials to the agent process
environment, and SHALL NOT include credentials in the prompt.

Provider credentials the agent requires SHALL NOT be passed on the process
argument vector, where they would be visible to other users of the host, nor
through the process environment.

#### Scenario: Agent environment excludes orchestrator token

- **WHEN** an agent process is launched
- **THEN** its environment does not contain the orchestrator's GitHub credential

#### Scenario: Provider credentials are not passed as arguments

- **WHEN** an agent process is launched for a repository whose provider requires
  authentication
- **THEN** no credential value appears in the process arguments or environment

## ADDED Requirements

### Requirement: Agent credential source is configuration

Each configured agent SHALL declare the location holding the credentials
established by the operator when they authenticated that agent. The system SHALL
treat that location as read-only.

The system SHALL verify at startup that the declared location exists and is
readable, and SHALL refuse to start with a configuration error naming the agent
and the location when it is not. An unusable credential source SHALL NOT be
reported as a per-job agent failure.

#### Scenario: Missing credential source refuses startup

- **WHEN** the orchestrator starts with an agent whose declared credential source
  does not exist
- **THEN** startup fails with a configuration error naming the agent and the
  location, and no jobs are accepted

#### Scenario: Credential source is not modified

- **WHEN** any number of attempts run
- **THEN** the operator's authenticated agent installation is unchanged

### Requirement: Authentication failure is distinguishable

An attempt that fails because the agent could not authenticate SHALL be recorded
with a reason distinct from an attempt whose agent ran and failed on the work
itself. The console SHALL show which occurred.

#### Scenario: Authentication failure is reported as its own reason

- **WHEN** an agent exits because it could not authenticate with its provider
- **THEN** the attempt records an authentication reason, not a generic agent
  failure, and the operator can tell the two apart without reading the transcript
