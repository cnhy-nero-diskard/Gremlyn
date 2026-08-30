# operator-console Specification

## Purpose
Gives the operator a local view of what the orchestrator is doing and why, and a
controlled set of manual actions, without requiring them to read terminal output or
inspect the database by hand.

## Requirements

### Requirement: Console access is restricted to the local host

The system SHALL bind its HTTP interface to a loopback address by default and SHALL
require an authentication token for every request that reads job data or invokes an
operator action.

Binding to a non-loopback address SHALL require explicit configuration and SHALL
still require the authentication token.

#### Scenario: Request without a token

- **WHEN** a request is made to any console or API route without a valid token
- **THEN** the request is rejected and no job data is disclosed and no action is
  performed

#### Scenario: Default binding is not externally reachable

- **WHEN** the orchestrator starts with default configuration
- **THEN** its HTTP interface is reachable only from the local host

### Requirement: Dashboard overview

The console SHALL present, on a single view, the orchestrator's running state, the
configured repositories with their enabled state, currently running jobs, queued
jobs, and recent completed jobs distinguishing successes from failures.

#### Scenario: Running work is visible

- **WHEN** jobs are running and queued
- **THEN** both are visible on the dashboard with their repository and pull request

### Requirement: Job detail view

For any job the console SHALL present the repository, pull request, triggering
command and comment, the reconstructed review feedback, the ordered status timeline
with timestamps, the agent and model used, the workspace path, captured agent
output, validation results per command, the resulting commit when one exists, the
GitHub reporting outcome, and error detail when the job failed.

#### Scenario: Diagnosing a failure without a terminal

- **WHEN** an operator opens a failed job
- **THEN** the failing stage, the reason, the agent output, and the validation
  results are all available in the view

#### Scenario: Attempts are distinguishable

- **WHEN** a job has been retried
- **THEN** each attempt's output and outcome are viewable separately

### Requirement: Live progress

The console SHALL reflect status changes and newly captured agent output for
running jobs without requiring a manual page reload.

#### Scenario: Following a running job

- **WHEN** an operator views a running job
- **THEN** status transitions and new agent output appear as they occur

### Requirement: Operator actions

The console SHALL offer retrying a failed, cancelled, or interrupted job;
cancelling a queued or running job; enabling or disabling a repository;
configuring its agent timeout, including no limit; and navigating to the pull
request and the triggering comment on GitHub.

Every operator action SHALL be recorded with its time and effect.

#### Scenario: Retry from the console

- **WHEN** an operator retries a failed job
- **THEN** a new attempt is created under that job and the action is recorded

#### Scenario: Disable a repository from the console

- **WHEN** an operator disables a repository
- **THEN** subsequent commands for it produce no jobs

### Requirement: Destructive actions are separated and confirmed

Actions that discard work — including discarding and recreating a workspace —
SHALL be visually and structurally separated from routine actions and SHALL require
an explicit confirmation step.

#### Scenario: Workspace reset requires confirmation

- **WHEN** an operator requests that a workspace be discarded and recreated
- **THEN** the action is not performed until it is explicitly confirmed

#### Scenario: Destructive action is not adjacent to routine ones

- **WHEN** an operator views a job's available actions
- **THEN** destructive actions are presented separately from retry and cancel

### Requirement: Secrets are never rendered

The console SHALL NOT display credentials or token values in any view, including
job detail, captured agent output, configuration views, and error traces. Where
captured output may contain a configured secret value, it SHALL be redacted before
display.

#### Scenario: Secret present in captured output

- **WHEN** captured agent or command output contains a configured secret value
- **THEN** the value is redacted in the console

#### Scenario: Error trace containing configuration

- **WHEN** an error trace referencing configuration is displayed
- **THEN** no credential value appears in it

### Requirement: Structured operational log

The system SHALL emit a structured log covering at minimum: event observed, command
parsed, authorization outcome, job queued, workspace prepared, agent launched,
agent exited, validation started and completed, commit created, push completed,
GitHub reply posted, and job completed or failed. Entries relating to a job SHALL
carry its identifier.

Credentials SHALL NOT appear in log output.

#### Scenario: Correlating log entries to a job

- **WHEN** an operator filters the log by a job identifier
- **THEN** the entries for that job's full lifecycle are returned

#### Scenario: Logs are readable from the console

- **WHEN** an operator needs to understand what the orchestrator did
- **THEN** the relevant log entries are available in the console without reading a
  terminal
