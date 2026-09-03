## MODIFIED Requirements

### Requirement: Replaceable executor abstraction

Agent invocation SHALL occur behind an executor interface that receives the working
directory, model, reasoning effort, prompt, execution options, environment, and a
cancellation signal. Adding or substituting an executor SHALL NOT require changes
to the job lifecycle, workspace management, validation, or reporting.

The system SHALL provide an executor for the configured coding agent CLI and a
fake executor usable in tests.

The system SHALL support more than one agent CLI being registered at the same time,
and SHALL select the executor for a job from the agent its repository names. Each
executor SHALL translate the common invocation contract into the argument vector,
environment, and options its own CLI accepts.

Where the common invocation contract offers a capability that a particular CLI does
not implement, the system SHALL either honor that capability by other means or reject
the configuration that requires it. It SHALL NOT accept the setting and silently
discard it.

Each executor SHALL declare the CLI release its invocation surface is known to work
against, and the system SHALL verify the installed CLI at startup and refuse to start
on a mismatch, naming the agent, the expected release, and the installed one.

#### Scenario: Substituting an executor

- **WHEN** the configured agent for a repository is changed to a different
  registered executor
- **THEN** job orchestration, workspace handling, validation, and reporting behave
  identically

#### Scenario: Fake executor simulates outcomes

- **WHEN** tests configure the fake executor
- **THEN** it can simulate successful resolution, agent failure, timeout, no
  changes made, files modified, and validation failure

#### Scenario: Two agents registered at once

- **WHEN** two repositories name different agents and both have jobs
- **THEN** each job runs under its own repository's agent, and neither agent's
  invocation surface affects the other

#### Scenario: Unsupported capability is not silently dropped

- **WHEN** a repository configures a setting the selected agent's CLI has no way to
  accept
- **THEN** the system either enforces that setting itself or reports the entry as
  invalid at startup, and never runs the agent as though the setting were absent

#### Scenario: Installed CLI is not the probed release

- **WHEN** an agent's installed CLI reports a release other than the one its executor
  declares
- **THEN** startup fails naming the agent, the expected release, and the installed
  one, and no jobs are accepted

### Requirement: Bounded execution

Every agent invocation SHALL have a bounded retry allowance and MAY have a
configured maximum duration. When a duration is configured and exceeded, the
system SHALL terminate the agent process and fail the attempt with a timeout
reason. An unset or zero duration SHALL leave the agent running until it exits
or is cancelled.

The retry allowance and the maximum duration SHALL hold for every agent, whether or
not that agent's CLI implements them. Where a CLI does not, the system SHALL enforce
the bound itself.

Work left in the workspace by a timed-out agent SHALL be preserved for inspection
and SHALL NOT be committed or pushed.

#### Scenario: Agent exceeds its time limit

- **WHEN** an agent invocation runs longer than the configured maximum
- **THEN** the process is terminated, the attempt fails with a timeout reason, and
  nothing is published

#### Scenario: Agent CLI offers no retry allowance

- **WHEN** an attempt runs under an agent whose CLI has no retry option
- **THEN** the attempt is still bounded by the configured allowance, and repeated
  failures do not retry without limit

### Requirement: Isolated agent state per attempt

Each attempt SHALL run with agent state isolated from other concurrent attempts, so
that simultaneous runs do not share or corrupt mutable agent state.

Isolation SHALL be established by whatever means the agent's CLI provides, whether by
argument, by environment, or otherwise. The guarantee SHALL be the same regardless of
the mechanism, and an agent whose state location is directed by its environment SHALL
be isolated as completely as one directed by an argument.

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

#### Scenario: State location directed by environment

- **WHEN** two concurrent attempts run under an agent whose state location is chosen
  by its environment rather than by a command-line argument
- **THEN** each attempt reads and writes only its own state, and neither observes the
  other's session history

### Requirement: Agent credential source is configuration

Each configured agent SHALL declare the location holding the credentials
established by the operator when they authenticated that agent. The system SHALL
treat that location as read-only.

Each agent SHALL also declare the set of credential files to make available to an
attempt, since that set differs between agents. The system SHALL seed the set
declared for the agent the job is running under, and SHALL NOT apply one agent's set
to another.

The system SHALL verify at startup that the declared location exists and is
readable, and SHALL refuse to start with a configuration error naming the agent
and the location when it is not. It SHALL likewise verify that every file in the
agent's declared credential set is present, and SHALL name the agent and the missing
file when one is not. An unusable credential source SHALL NOT be reported as a
per-job agent failure.

#### Scenario: Missing credential source refuses startup

- **WHEN** the orchestrator starts with an agent whose declared credential source
  does not exist
- **THEN** startup fails with a configuration error naming the agent and the
  location, and no jobs are accepted

#### Scenario: Credential source is not modified

- **WHEN** any number of attempts run
- **THEN** the operator's authenticated agent installation is unchanged

#### Scenario: Each agent seeds its own credential set

- **WHEN** two agents with different credential file sets are configured and each
  runs an attempt
- **THEN** each attempt receives the set declared for its own agent, and neither
  fails for a file belonging to the other

### Requirement: Secrets are withheld from the agent

The system SHALL NOT expose orchestrator credentials to the agent process
environment, and SHALL NOT include credentials in the prompt.

Provider credentials the agent requires SHALL NOT be passed on the process
argument vector, where they would be visible to other users of the host, nor
through the process environment.

A filesystem location supplied to direct the agent's state or configuration is not a
credential value, and MAY be passed by argument or environment. The credential itself
SHALL remain material the system places on disk for the attempt.

#### Scenario: Agent environment excludes orchestrator token

- **WHEN** an agent process is launched
- **THEN** its environment does not contain the orchestrator's GitHub credential

#### Scenario: Provider credentials are not passed as arguments

- **WHEN** an agent process is launched for a repository whose provider requires
  authentication
- **THEN** no credential value appears in the process arguments or environment

#### Scenario: State location may be passed by environment

- **WHEN** an agent is launched whose per-attempt state location is set through its
  environment
- **THEN** that environment carries the location only, and no credential value

### Requirement: Authentication failure is distinguishable

An attempt that fails because the agent could not authenticate SHALL be recorded
with a reason distinct from an attempt whose agent ran and failed on the work
itself. The console SHALL show which occurred.

An attempt that fails because the provider accepted the credential but refused the
work for want of quota, credit, or a payment method SHALL be recorded with a reason
distinct from both. The system SHALL classify by the condition the provider reported,
not by the transport status or wording alone, so that a billing refusal carrying an
authentication status is not reported as an authentication failure.

#### Scenario: Authentication failure is reported as its own reason

- **WHEN** an agent exits because it could not authenticate with its provider
- **THEN** the attempt records an authentication reason, not a generic agent
  failure, and the operator can tell the two apart without reading the transcript

#### Scenario: Billing refusal is not an authentication failure

- **WHEN** an agent's credential is accepted but the provider refuses the request for
  want of credit or a payment method, reporting it with an unauthorized status
- **THEN** the attempt records a billing reason distinct from an authentication
  failure, and the console directs the operator to the account rather than to
  re-authenticating
