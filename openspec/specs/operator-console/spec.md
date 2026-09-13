# operator-console Specification

## Purpose
Gives the operator a local view of what the orchestrator is doing and why, and a
controlled set of manual actions, without requiring them to read terminal output or
inspect the database by hand.

## Requirements

### Requirement: Console access is restricted to the local host

The system SHALL bind its HTTP interface to a loopback address by default and SHALL
require an authentication token for every request that reads job data, reads
configuration or operational state, or invokes an operator action.

Binding to a non-loopback address SHALL require explicit configuration and SHALL
still require the authentication token.

The system MAY serve static presentation assets — styling and client script —
without a token, so that the sign-in view can be presented before authentication.
Such assets SHALL be fixed content that discloses no job data, configuration,
operational state or secret value, and SHALL NOT accept parameters that vary their
content.

#### Scenario: Request without a token

- **WHEN** a request is made to any console or API route that reads job data,
  configuration or operational state, or invokes an operator action, without a
  valid token
- **THEN** the request is rejected and no job data is disclosed and no action is
  performed

#### Scenario: Default binding is not externally reachable

- **WHEN** the orchestrator starts with default configuration
- **THEN** its HTTP interface is reachable only from the local host

#### Scenario: Unauthenticated request for a static asset

- **WHEN** a static presentation asset is requested without a token
- **THEN** it is served, and its content contains no job data, no configuration
  value, no operational state and no secret value

### Requirement: Dashboard overview

The console SHALL present, on a single view, the orchestrator's running state, the
configured repositories with their enabled state, currently running jobs, queued
jobs, and recent completed jobs distinguishing successes from failures.

The orchestrator's running state SHALL be derived from observed activity rather
than asserted. It SHALL include when the orchestrator last polled for events, and
SHALL indicate when that is older than the configured polling interval allows. It
SHALL include the number of queued jobs and the number of jobs currently executing
against the configured concurrency limit.

Successes and failures SHALL be distinguishable without reading the status text —
each terminal state SHALL carry a distinct visual treatment.

For each configured repository the console SHALL show the agent, model and effort
it will run, and the validation commands it will use, including when that list is
empty.

#### Scenario: Running work is visible

- **WHEN** jobs are running and queued
- **THEN** both are visible on the dashboard with their repository and pull request

#### Scenario: Polling has stalled

- **WHEN** the orchestrator has not polled for longer than the configured polling
  interval allows
- **THEN** the dashboard indicates that its view of events is stale rather than
  reporting the orchestrator as healthy

#### Scenario: Scanning outcomes at a glance

- **WHEN** an operator views a list of completed jobs
- **THEN** succeeded, failed, cancelled and interrupted jobs are distinguishable
  from one another without reading each status label

### Requirement: Job detail view

For any job the console SHALL present the repository, pull request, triggering
command and comment, the reconstructed review feedback, the ordered status timeline
with timestamps, the agent and model used, the workspace path, captured agent
output, validation results per command, the resulting commit when one exists, the
GitHub reporting outcome, and error detail when the job failed.

The status timeline SHALL show the elapsed time in each stage and the total elapsed
time for the job.

For each attempt the console SHALL additionally present the agent's exit code when
the agent exited, whether the resulting commit was pushed, whether uncommitted
changes were left in the workspace, and the head commit the workspace was prepared
against.

Validation results SHALL be presented per command with the command, its exit code
and its duration directly legible, and its captured output available. The status
timeline, validation results and structured log SHALL NOT be presented as
undifferentiated serialized data.

#### Scenario: Diagnosing a failure without a terminal

- **WHEN** an operator opens a failed job
- **THEN** the failing stage, the reason, the agent output, and the validation
  results are all available in the view

#### Scenario: Attempts are distinguishable

- **WHEN** a job has been retried
- **THEN** each attempt's output and outcome are viewable separately

#### Scenario: Identifying which validation command failed

- **WHEN** an attempt failed validation and more than one validation command ran
- **THEN** the operator can see which command failed, its exit code and its
  duration, without reading serialized data

#### Scenario: Work left behind in a workspace

- **WHEN** an attempt produced changes that were not committed or a commit that was
  not pushed
- **THEN** the console shows that state on the attempt

### Requirement: Live progress

The console SHALL reflect status changes and newly captured agent output for
running jobs without requiring a manual page reload.

Updates SHALL replace only the parts of the view whose content changed. An update
SHALL NOT discard the operator's position in the view, the sections they have
expanded, or text they have typed into a confirmation control.

The dashboard SHALL likewise reflect newly queued, started and completed jobs
without a manual page reload.

#### Scenario: Following a running job

- **WHEN** an operator views a running job
- **THEN** status transitions and new agent output appear as they occur

#### Scenario: Reading output while it is being appended

- **WHEN** an operator has scrolled through captured output, expanded a section, or
  typed into a confirmation control, and the job then changes
- **THEN** the changed content updates and the scroll position, the expanded
  section and the typed text are preserved

#### Scenario: Watching the queue drain

- **WHEN** an operator views the dashboard while queued jobs start and complete
- **THEN** those transitions appear without a manual page reload

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

### Requirement: The picker offers every provider a repository's agent can reach

For each repository, the console SHALL offer every provider its configured agent
can authenticate against, and for each such provider the models that provider
serves. A model an agent can reach SHALL NOT be selectable only by typing an
identifier into the custom free-text path.

Where an agent authenticates against more than one provider namespace, each
namespace SHALL be presented as its own provider entry, identified by name and by
how it is authenticated, and SHALL NOT be collapsed into a single entry. Two
namespaces sharing an agent, a credential file, or an identifier prefix are not
thereby the same provider.

The custom free-text path SHALL remain available for a provider the catalog does
not describe, and a selection made through it SHALL be accepted.

#### Scenario: Every namespace an agent authenticates against is offered

- **WHEN** an operator opens the settings for a repository whose agent
  authenticates against more than one provider namespace
- **THEN** each of those namespaces is offered as its own provider entry, and
  selecting one offers the models that namespace serves

#### Scenario: A reachable model needs no custom entry

- **WHEN** a repository's agent can reach a given model through one of its
  providers
- **THEN** that model is selectable from the catalog, without the operator typing
  a provider or model identifier

#### Scenario: A provider for another agent is not offered

- **WHEN** a repository's settings are opened
- **THEN** providers only another agent could authenticate against are not offered
  for that repository

#### Scenario: An undescribed provider is still reachable

- **WHEN** an operator selects the custom free-text path and supplies a provider
  and model the catalog does not describe
- **THEN** the selection is accepted and persisted

### Requirement: The offered providers do not depend on catalog availability

The set of providers offered for a repository SHALL be the same whether the
catalog is served from its live source or from the offline fallback. Refreshing
the catalog from its live source SHALL NOT remove a provider, and a provider
SHALL NOT be reachable only while the live source is unavailable.

#### Scenario: A refresh from the live source removes no provider

- **WHEN** the catalog is refreshed from its live source
- **THEN** every provider offered before the refresh is still offered afterwards,
  with the models it serves

#### Scenario: Offline and live agree on what is offered

- **WHEN** the catalog's live source is unavailable and the offline fallback is
  used
- **THEN** the providers offered for each repository are the same ones the live
  source would have offered

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
cancelling a queued or running job; enabling or disabling a repository; and
navigating to the pull request and the triggering comment on GitHub.

Every such action SHALL be invocable from the console's own interface. A control
presented for an action SHALL either invoke that action or state why it is
unavailable; the console SHALL NOT present a control that does nothing.

Each action SHALL be offered only where it applies to the target's current state,
and the console SHALL reflect the outcome of an invoked action without requiring
the operator to navigate elsewhere to discover whether it took effect.

Every operator action SHALL be recorded with its time and effect.

#### Scenario: Retry from the console

- **WHEN** an operator retries a failed job
- **THEN** a new attempt is created under that job and the action is recorded

#### Scenario: Disable a repository from the console

- **WHEN** an operator disables a repository
- **THEN** subsequent commands for it produce no jobs

#### Scenario: Every offered control works

- **WHEN** an operator views the controls offered for a job or a repository
- **THEN** each control either performs its action when used or states why it is
  unavailable

#### Scenario: Reaching the pull request and the comment

- **WHEN** an operator views a job
- **THEN** the console links both to the pull request and to the triggering review
  comment on GitHub

#### Scenario: An action that cannot be performed

- **WHEN** an operator invokes an action the orchestrator cannot perform
- **THEN** the console reports the refusal in the view rather than failing silently

### Requirement: Destructive actions are separated and confirmed

Actions that discard work — including discarding and recreating a workspace —
SHALL be visually and structurally separated from routine actions and SHALL require
an explicit confirmation step.

The confirmation step SHALL be reachable from the console: the operator SHALL be
able to supply the required confirmation and complete the action without leaving
the console. The action SHALL remain unavailable until the confirmation is
supplied, and the console SHALL make clear what confirmation is required.

#### Scenario: Workspace reset requires confirmation

- **WHEN** an operator requests that a workspace be discarded and recreated
- **THEN** the action is not performed until it is explicitly confirmed

#### Scenario: Destructive action is not adjacent to routine ones

- **WHEN** an operator views a job's available actions
- **THEN** destructive actions are presented separately from retry and cancel

#### Scenario: Confirming without leaving the console

- **WHEN** an operator supplies the required confirmation in the console
- **THEN** the destructive action becomes available and, when invoked, is performed
  and recorded

#### Scenario: Confirmation not yet supplied

- **WHEN** the required confirmation has not been supplied
- **THEN** the destructive action cannot be invoked from the console

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

Log entries presented in the console SHALL be individually legible, with their
time, level, event and fields distinguishable, and SHALL be filterable by level and
searchable by text within the entries shown.

#### Scenario: Correlating log entries to a job

- **WHEN** an operator filters the log by a job identifier
- **THEN** the entries for that job's full lifecycle are returned

#### Scenario: Logs are readable from the console

- **WHEN** an operator needs to understand what the orchestrator did
- **THEN** the relevant log entries are available in the console without reading a
  terminal

#### Scenario: Finding the relevant entry among many

- **WHEN** a job has produced many log entries and the operator is looking for
  errors
- **THEN** the operator can restrict the entries shown by level and by text
  without leaving the console

### Requirement: Command ingestion and authorization outcomes are visible

The console SHALL present the commands the orchestrator has observed and the
outcome it reached for each, including commands that produced no job. For each
observed command it SHALL show the repository, pull request, triggering comment,
the command text, the commenting author, the time observed, the outcome, and —
when the command was refused — the reason for refusal.

Where an observed command produced a job, the console SHALL provide navigation
from the command to that job.

#### Scenario: A command that produced no job

- **WHEN** an operator posts a command that is refused, and then opens the console
- **THEN** the command appears with its author, its outcome, and the reason it was
  refused, without the operator reading a terminal or querying the database

#### Scenario: Distinguishing refusal from a silent failure

- **WHEN** no job exists for a pull request an operator expected work on
- **THEN** the console distinguishes a command that was never observed from a
  command that was observed and refused, and gives the refusal reason in the
  second case

### Requirement: Operator action history is visible

The console SHALL present the recorded history of operator actions, showing for
each the time, the action, its target, and its effect.

#### Scenario: Reviewing what was done manually

- **WHEN** an operator needs to know whether a workspace was reset or a job retried
  by hand
- **THEN** that action, its target and its effect are visible in the console with
  the time it occurred
