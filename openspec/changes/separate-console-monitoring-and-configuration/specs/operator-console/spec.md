## MODIFIED Requirements

### Requirement: Dashboard overview

The console SHALL present, on a single monitoring view, the orchestrator's
running state, compact configured-repository summaries, currently running jobs,
queued jobs, and recent completed jobs distinguishing successes from failures.
Health and job lanes SHALL remain the primary content and SHALL precede repository
summaries.

The orchestrator's running state SHALL be derived from observed activity rather
than asserted. It SHALL include when the orchestrator last polled for events, and
SHALL indicate when that is older than the configured polling interval allows. It
SHALL include the number of queued jobs and the number of jobs currently executing
against the configured concurrency limit.

Successes and failures SHALL be distinguishable without reading the status text -
each terminal state SHALL carry a distinct visual treatment.

For each configured repository the dashboard SHALL show a compact summary of its
enabled state, agent, provider and model, reasoning effort, agent timeout, and
validation-command count, including when no validation commands are configured.
The summary SHALL link directly to that repository on the configuration view and
SHALL NOT expose inline settings-edit controls.

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

#### Scenario: Repository summary does not become a settings wall

- **WHEN** an operator views configured repositories on the dashboard
- **THEN** each repository is represented by its compact operational summary and
  configuration link without provider, model, effort, timeout, validation, or
  enablement edit controls

## ADDED Requirements

### Requirement: Monitoring and repository configuration have distinct responsibilities

The console SHALL provide a monitoring view for observed health and job activity
and a separate authenticated repository-configuration view for changing future-job
behavior. Primary navigation SHALL link both views, identify the active view in
text and programmatic state, and describe each view's responsibility in plain
language.

The repository-configuration view SHALL present full repository settings and
SHALL host provider, model, reasoning effort, and timeout editing using the
repository-local draft, review, apply, cancel, conflict, and feedback contract.
It SHALL also host validation-command editing and the independent enable/disable
action. Moving these controls SHALL NOT change authoritative picker values,
provider availability, custom-provider behavior, effort tiers, semantic model
metadata, or the effects and auditing of enablement.

#### Scenario: Operator moves from monitoring to configuration

- **WHEN** an operator follows the configuration navigation from the dashboard
- **THEN** the authenticated configuration view opens, identifies itself as the
  active view, and presents repository settings without removing the path back to
  monitoring

#### Scenario: Dashboard remains operational

- **WHEN** an operator needs to assess health, queue pressure, or recent outcomes
- **THEN** those monitoring signals are available on the dashboard without opening
  repository configuration

#### Scenario: Staged settings workflow moves intact

- **WHEN** an operator edits provider, model, reasoning effort, or timeout on the
  configuration view
- **THEN** the draft is reviewed, applied, cancelled, conflicted, and reported
  within its repository exactly as required by the staged settings contract

#### Scenario: Configuration route requires authentication

- **WHEN** a request without a valid console token attempts to read repository
  configuration
- **THEN** the request is rejected and no repository setting is disclosed

### Requirement: Validation commands are edited as an explicit separate draft

The repository-configuration view SHALL allow an operator to add, remove, reorder,
and edit a repository's validation commands while preserving each command's
ordered argument boundaries. Validation-command edits SHALL remain a separate
draft from provider, model, reasoning effort, and timeout settings; applying or
cancelling one draft SHALL NOT implicitly apply or discard the other.

Before apply, the console SHALL show the current and proposed validation-command
lists and SHALL state that a successful change applies to jobs created afterward.
Apply SHALL validate and persist the complete proposed list atomically. An invalid,
stale, or failed apply SHALL leave the persisted command list unchanged, preserve
the draft for correction, and present repository-local feedback. A successful
apply SHALL be audited and SHALL update the running repository configuration once.

#### Scenario: Editing command arguments preserves structure

- **WHEN** an operator adds or edits a validation command with multiple arguments
- **THEN** the review and persisted value preserve the command and argument order
  without converting it to an ambiguous shell string

#### Scenario: Validation draft does not alter model settings

- **WHEN** an operator applies a validation-command draft while a provider/model
  settings draft also exists
- **THEN** only the validation commands are persisted and the other draft remains
  uncommitted

#### Scenario: Invalid validation draft is retained

- **WHEN** an operator applies a malformed or empty validation command
- **THEN** no validation command is persisted, the draft remains available for
  correction, and the refusal appears with that repository

#### Scenario: Validation changes affect future jobs

- **WHEN** a valid validation-command draft is applied
- **THEN** jobs created afterward use the new ordered commands while existing jobs
  retain their recorded execution evidence

### Requirement: Monitoring and configuration remain usable at scale

The monitoring view SHALL provide surface-local controls to filter job lanes by
repository and by a job query that can match a job identifier, pull request number,
or visible command. The repository-configuration view SHALL provide surface-local
controls to filter repositories by owner/name text and enabled state.

Filters SHALL operate against the persisted records in scope rather than only a
previously rendered unfiltered subset. Each view SHALL show the active criteria,
result count, an explicit no-results state, and a single action to clear its
filters. Filter values and operator-entered settings drafts SHALL survive relevant
live updates; a refresh SHALL NOT silently broaden the results or erase a draft.

These controls SHALL remain local to their view. They SHALL NOT introduce global
search, cross-surface results, a command palette, or keyboard shortcuts.

#### Scenario: Repository filter narrows every job lane

- **WHEN** an operator selects one repository on the monitoring view
- **THEN** running, queued, and recent lanes show only that repository's jobs while
  health remains visible

#### Scenario: Job query finds an older matching record

- **WHEN** a matching persisted job is outside the dashboard's ordinary recent
  unfiltered subset and the operator filters by its job or pull request identifier
- **THEN** the matching job is returned rather than excluded by the previous
  unfiltered limit

#### Scenario: Configuration repository filter

- **WHEN** an operator filters configuration by owner/name text or enabled state
- **THEN** only matching repository editors are shown and no setting is changed

#### Scenario: No filter matches

- **WHEN** active filters match no jobs or repositories
- **THEN** the view states that no results match, retains the criteria, and offers
  a clear-filter action rather than presenting the system as empty

#### Scenario: Live update preserves local filtering and drafts

- **WHEN** a relevant SSE update arrives while filters or an unsaved repository
  draft are active
- **THEN** the view refreshes matching authoritative data without clearing the
  filters, broadening the result set, or replacing the draft
