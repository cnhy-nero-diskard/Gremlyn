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

The console SHALL additionally keep current, without a manual page reload, every
surface an operator monitors: the orchestrator health summary including poll
freshness and staleness, the repository list including each repository's
provider, model, reasoning effort, timeout and enabled state, the job lanes,
validation results, the command ingestion view, and the operator audit view.

Displays derived from elapsed time — relative timestamps, in-progress durations,
and poll age — SHALL advance as time passes, and SHALL NOT depend on unrelated
recorded activity to update.

#### Scenario: Following a running job

- **WHEN** an operator views a running job
- **THEN** status transitions and new agent output appear as they occur

#### Scenario: Elapsed time advances while nothing else changes

- **WHEN** an operator watches a running job and no new status, output, or log
  activity is recorded
- **THEN** the job's elapsed duration and relative timestamps continue to advance

#### Scenario: Polling stops without any other activity

- **WHEN** repository polling stops producing results and no other activity is
  recorded
- **THEN** the console reports the orchestrator as stale without a manual reload

#### Scenario: Repository configuration changed elsewhere

- **WHEN** a repository's provider, model, reasoning effort, or timeout is changed
- **THEN** an open console reflects the new values without a manual reload

#### Scenario: Ingestion and audit views stay current

- **WHEN** a command is ingested or an operator action is recorded
- **THEN** the command ingestion view and the operator audit view show it without
  a manual reload

### Requirement: Wall-clock times are rendered in local time

The console SHALL render wall-clock times in the operator's local timezone, and
SHALL accept a configured timezone that overrides that default. Rendered
wall-clock times SHALL be unambiguous about which timezone they are expressed
in.

Persisted timestamps SHALL remain in UTC and SHALL be unchanged by this
rendering. Every rendered wall-clock time SHALL remain accompanied by its exact
underlying UTC instant, so a value copied out of the console is unambiguous.

#### Scenario: Log and timeline times read as local time

- **WHEN** an operator views a job's status timeline, agent activity, or log
  entries
- **THEN** the displayed times correspond to the operator's local timezone, not
  UTC

#### Scenario: Configured timezone overrides the default

- **WHEN** a timezone is configured for the console
- **THEN** wall-clock times render in that timezone

#### Scenario: Underlying instant remains available

- **WHEN** an operator inspects a rendered wall-clock time
- **THEN** the exact UTC instant it was derived from is available

#### Scenario: Stored timestamps are unaffected

- **WHEN** times are rendered in local time
- **THEN** the timestamps recorded in the database and in captured output remain
  in UTC

### Requirement: Repository configuration edits persist exactly what was edited

An edit to one repository configuration field SHALL persist that field only, and
SHALL NOT alter any other field of that repository.

#### Scenario: Changing reasoning effort leaves the model alone

- **WHEN** an operator changes a repository's reasoning effort
- **THEN** the reasoning effort is persisted and the repository's provider and
  model are unchanged

#### Scenario: Changing the model leaves the effort alone

- **WHEN** an operator changes a repository's model
- **THEN** the model is persisted and the repository's reasoning effort is
  unchanged

### Requirement: The persisted repository selection is authoritative in the picker

The console SHALL present each repository's persisted provider, model and
reasoning effort as its current selection, and SHALL NOT substitute a different
value when the available choices change — including when the model catalog is
refreshed from its live source, when a live-update refresh replaces the view, or
when the persisted value is absent from the catalog.

A persisted value that is not offered by the catalog SHALL be presented as the
current selection and identified as such.

No selection change SHALL be persisted unless the operator made it.

#### Scenario: Catalog refresh does not change the selection

- **WHEN** the console loads a repository's persisted model and the model catalog
  is then refreshed from its live source, in which that model is ordered
  differently or absent
- **THEN** the repository's persisted model remains the displayed selection and
  nothing is persisted

#### Scenario: Live-update refresh does not change the selection

- **WHEN** a live update replaces the repository list while an operator is not
  editing it
- **THEN** each repository's displayed provider, model and reasoning effort still
  match what is persisted

#### Scenario: Persisted model is absent from the catalog

- **WHEN** a repository's persisted model does not appear in the catalog for its
  provider
- **THEN** that model is still shown as the current selection, identified as the
  current value, and is not replaced by another catalog entry

#### Scenario: Substituted value is never written back

- **WHEN** an operator edits any repository configuration field on a repository
  whose displayed selection could not be matched to the catalog
- **THEN** only the edited field is persisted, and no unselected provider or model
  is written

### Requirement: A provider unavailable to a repository's agent is reported

When a repository's persisted provider is not one the repository's configured
agent can use, the console SHALL identify that mismatch and offer the providers
the agent does support, rather than presenting the persisted provider as an
ordinary custom value.

#### Scenario: Provider does not match the agent

- **WHEN** a repository's persisted provider belongs to an agent other than the
  one the repository is configured to use
- **THEN** the console reports the mismatch for that repository and offers the
  providers its configured agent supports

#### Scenario: Mismatch is not silently corrected

- **WHEN** the console reports such a mismatch
- **THEN** the persisted provider is left unchanged until the operator selects a
  replacement

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
