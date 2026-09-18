# operator-console Specification

## Purpose
Gives the operator a local view of what the orchestrator is doing and why, and a
controlled set of manual actions, without requiring them to read terminal output or
inspect the database by hand.

## Requirements

### Requirement: Console access is restricted to the local host

The system SHALL bind its HTTP interface to a loopback address by default and SHALL
require authentication for every request that reads job data, reads configuration
or operational state, or invokes an operator action. Authentication SHALL accept
the configured token directly as a bearer token and SHALL accept an unexpired
browser session that was created by successfully presenting that token.

Binding to a non-loopback address SHALL require explicit configuration and SHALL
still require authentication.

The system MAY serve the sign-in view and static presentation assets without
authentication. Such content SHALL be fixed, SHALL disclose no job data,
configuration, operational state, token, session handle, or secret value, and
SHALL NOT accept parameters that vary its content except a bounded non-secret
reason for returning to sign-in.

A successful browser sign-in SHALL create a finite-lived, unpredictable opaque
session handle. The browser cookie SHALL contain only that handle, SHALL be
unreadable to client script, and SHALL use same-site protection. The configured
token or submitted token value SHALL NOT be copied into a URL, rendered markup,
cookie, browser storage, log, operator audit record, or session record. The token
field SHALL be cleared after each sign-in attempt and SHALL never be backfilled.

Signing out SHALL invalidate the current browser session and expire its cookie.
An expired or invalid browser session SHALL disclose no protected data, SHALL be
cleared, and SHALL lead the operator to sign-in with a non-secret explanation.
Direct bearer-token authentication SHALL remain available and SHALL NOT
implicitly create or persist a browser session.

#### Scenario: Request without a token

- **WHEN** a request is made to any console or API route that reads job data,
  configuration or operational state, or invokes an operator action, without a
  valid bearer token or unexpired browser session
- **THEN** the request is rejected and no job data is disclosed and no action is
  performed

#### Scenario: Default binding is not externally reachable

- **WHEN** the orchestrator starts with default configuration
- **THEN** its HTTP interface is reachable only from the local host

#### Scenario: Unauthenticated request for a static asset

- **WHEN** a static presentation asset is requested without a token
- **THEN** it is served, and its content contains no job data, no configuration
  value, no operational state and no secret value

#### Scenario: Browser sign-in creates an opaque session

- **WHEN** an operator submits the correct console token through the sign-in form
- **THEN** the browser receives an opaque finite-lived session cookie that does not contain the configured token, and the token field is cleared

#### Scenario: Submitted token is not retained

- **WHEN** a browser sign-in succeeds or fails
- **THEN** the submitted token does not appear in a URL, response markup, cookie, browser storage, log, audit record, or server-side session record

#### Scenario: Direct bearer authentication remains available

- **WHEN** an API caller supplies the configured bearer token
- **THEN** the protected request is authorized without creating a browser-session cookie

#### Scenario: Operator signs out

- **WHEN** an authenticated operator invokes Sign out
- **THEN** the current browser session is invalidated, its cookie is expired, and a later protected request using it is rejected

#### Scenario: Browser session expires

- **WHEN** a protected navigation, mutation, or live-update connection uses an expired browser session
- **THEN** no protected data is returned, the obsolete cookie is cleared, and the operator is directed to sign-in with an expired-session explanation that contains no secret

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

Updates SHALL reconcile content by stable identity and SHALL change only the
elements whose content or state changed. An update SHALL NOT discard the
operator's reading position, keyboard focus, text selection, form draft,
expanded sections, scroll position, or typed confirmation while the corresponding
item still exists. Stable landmarks and unchanged records SHALL remain in the DOM
so an assistive-technology virtual cursor is not reset by an unrelated update.

If an update removes the focused item, the console SHALL move focus to a stable,
logical fallback at the affected region and SHALL explain that removal once. The
dashboard SHALL likewise reflect newly queued, started and completed jobs without
a manual page reload.

Persistent visible state and assistive-technology announcements SHALL remain
separate. Meaningful connection transitions, invoked-action outcomes, validation
failures, and newly relevant operational-state changes SHALL be announced once in
the narrowest applicable status region. Routine heartbeats, elapsed-time ticks,
unchanged rerenders, transcript append noise, and repeated copies of an unchanged
message SHALL NOT be announced. An announcement SHALL NOT move focus unless the
focused item was removed.

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

#### Scenario: Focused control survives an unrelated update

- **WHEN** an SSE update changes one record while the operator is focused in a different record or control that still exists
- **THEN** the focused DOM node, its value and selection, and its surrounding landmark remain stable

#### Scenario: Focused item is removed

- **WHEN** an SSE update removes the item containing keyboard focus
- **THEN** focus moves to the affected region's stable heading or next logical item and one visible, announced message identifies what changed

#### Scenario: Virtual-cursor context remains stable

- **WHEN** an assistive-technology user is reading an unchanged record and another keyed record updates
- **THEN** the unchanged record and containing landmark are not replaced and the reading context is not reset to the start of the region

#### Scenario: Heartbeat and timer updates stay quiet

- **WHEN** a heartbeat, elapsed-time tick, transcript append, or identical fragment arrives without a meaningful state transition
- **THEN** no ARIA live announcement is generated and persistent connection or action feedback is not replaced

#### Scenario: Meaningful transition is announced once

- **WHEN** connection health changes, an invoked action completes or fails, validation fails, or an operational state becomes newly actionable
- **THEN** one scoped announcement identifies the affected connection, action, validation, or state without moving focus

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

### Requirement: Sign-in and authenticated navigation are explicit and accessible

The sign-in control SHALL be a semantic form with a labelled password input and
submit button. Submitting with Enter or activating the button SHALL perform the
same POST operation. The token input SHALL receive initial focus, SHALL request no
application-managed persistence, and SHALL be associated with invalid-token and
expired-session errors through programmatic description and invalid state.

The unauthenticated sign-in page SHALL NOT render links to protected destinations
or a sign-out control. Authenticated pages SHALL provide a consistently named
primary navigation region, mark exactly the current destination with
`aria-current="page"`, and provide an explicit Sign out control.

#### Scenario: Sign-in submits with Enter

- **WHEN** focus is in the token input and the operator presses Enter
- **THEN** the sign-in form submits the token by POST exactly as the Sign in button does, without placing it in the URL

#### Scenario: Invalid token is associated with the input

- **WHEN** sign-in is refused
- **THEN** focus remains on or returns to the cleared token input, the input is marked invalid, and a non-secret error is programmatically associated with it

#### Scenario: Expired session returns to sign-in

- **WHEN** a browser session expires during authenticated use
- **THEN** the operator reaches the sign-in form with focus in the token input and an associated explanation that the session expired

#### Scenario: Protected navigation is absent before authentication

- **WHEN** an unauthenticated operator views sign-in
- **THEN** Dashboard, Commands, Audit, and Sign out controls are not rendered

#### Scenario: Current destination is exposed

- **WHEN** an authenticated operator views Dashboard, Commands, Audit, or a job detail page
- **THEN** the primary navigation identifies the applicable current destination with `aria-current="page"` and does not mark inactive destinations current

### Requirement: Operational data tables are structured and responsive

Commands, Operator Audit, and validation-result tables SHALL have a meaningful
caption and column headers with explicit scope. Their purpose and empty state SHALL
remain understandable without relying on visual position alone.

Each table SHALL be contained so long values cannot create horizontal scrolling
for the whole page. At narrow viewport widths the data SHALL reflow into readable
record cards whose visible field labels match the table headers, without omitting,
reordering ambiguously, or duplicating content for assistive technology. When
horizontal scrolling remains necessary for intrinsically wide content, only the
table container SHALL scroll and it SHALL be keyboard reachable with an
accessible name.

#### Scenario: Table structure is programmatically available

- **WHEN** an operator navigates the Commands, Audit, or validation results with table commands
- **THEN** the table exposes its purpose through a caption and each data cell is associated with a scoped column header

#### Scenario: Commands and Audit reflow at a narrow width

- **WHEN** the Commands or Audit view is rendered at 320 CSS pixels wide
- **THEN** each record becomes a labelled readable card, every original field remains available, and the page itself does not require horizontal scrolling

#### Scenario: Validation results reflow at a narrow width

- **WHEN** validation results are rendered at 320 CSS pixels wide or at 400 percent zoom from a 1280 CSS-pixel viewport
- **THEN** command, exit code, duration, and output controls remain labelled, readable, and operable without overlap or page-level horizontal scrolling

#### Scenario: Long content is contained

- **WHEN** a command, target, detail, model identifier, or validation output is wider than its available cell
- **THEN** it wraps or scrolls within the labelled record or table container without clipping controls or widening the page

### Requirement: Core console interaction has a concrete accessibility acceptance baseline

All console functionality SHALL remain operable by keyboard without a trap and
SHALL use native controls where a native semantic exists. Interactive controls
SHALL have an accessible name, logical focus order, and a visible focus indicator
that is not removed by live updates. Information and status SHALL be conveyed by
text in addition to color, shape, or motion.

Normal text SHALL meet a contrast ratio of at least 4.5:1, large text at least
3:1, and focus indicators and meaningful non-text UI boundaries at least 3:1
against adjacent colors. With reduced motion requested, nonessential animation
and smooth movement SHALL be removed without hiding state changes.

These checks SHALL be treated as WCAG 2.2 AA-oriented acceptance targets for the
implemented console surfaces; passing them SHALL NOT be presented as third-party
certification or exhaustive conformance.

#### Scenario: Keyboard-only operation

- **WHEN** an operator uses only sequential keyboard navigation and activation
- **THEN** sign-in, navigation, table details, repository controls, job actions, confirmations, and sign-out are reachable, visibly focused, and operable without a trap

#### Scenario: Status does not rely on color

- **WHEN** the console presents health, job, validation, connection, action, or failure state
- **THEN** a textual label or explanation conveys the state independently of color, icon shape, or animation

#### Scenario: Reduced motion is requested

- **WHEN** the user agent reports a reduced-motion preference
- **THEN** nonessential animation and smooth transitions are disabled while all state changes remain visible and understandable

#### Scenario: Contrast acceptance is checked

- **WHEN** default light or dark console colors and focus states are evaluated
- **THEN** text, focus indicators, and meaningful non-text UI meet their stated contrast thresholds

### Requirement: The console has an offline-safe visual foundation

The console SHALL use one coherent visual foundation across authenticated and unauthenticated surfaces, with a documented type scale, spacing rhythm, panel-emphasis levels, shape, border, and surface treatments. Its primary text and monospace typography SHALL resolve entirely from operating-system fonts and SHALL NOT require a network request, external asset host, JavaScript framework, runtime package, asset build, or undeclared font.

#### Scenario: Console renders without network access

- **WHEN** the console is opened on the supported local Windows environment with external network access unavailable
- **THEN** all text uses the declared native fallback stacks and the complete visual hierarchy renders without a missing font or external presentation asset

#### Scenario: Shared rhythm spans console surfaces

- **WHEN** the operator moves among sign-in, monitoring, repository configuration, job detail, Commands, and Audit surfaces
- **THEN** headings, body copy, metadata, controls, gaps, and panel tiers use the same type and spacing hierarchy

### Requirement: Visual hierarchy prioritizes operational meaning

The console SHALL visually distinguish primary operational state, ordinary grouped content, quiet supporting detail, and forensic or inset evidence without giving every region equal panel weight. Interactive elements SHALL have perceptible default, hover, active, disabled, and busy visual states appropriate to their action, and the current primary navigation destination SHALL be visually distinct when the shell identifies it as current.

#### Scenario: Primary and supporting panels coexist

- **WHEN** a page contains a primary operational summary alongside routine metadata and forensic detail
- **THEN** the primary summary has the strongest panel emphasis, routine content remains legible but quieter, and forensic detail reads as inset evidence rather than another competing primary card

#### Scenario: Pointer interaction states are visible

- **WHEN** the operator hovers and activates an enabled link, button, form control, or selectable row
- **THEN** the element presents a consistent hover treatment and a distinct pressed or active treatment without shifting the surrounding layout

#### Scenario: Disabled and busy states are visually distinct

- **WHEN** an existing control is disabled or marked busy by its owning workflow
- **THEN** it remains identifiable, its unavailable or in-progress state is visually distinct, and the busy treatment does not rely on animation alone

#### Scenario: Current navigation is visible

- **WHEN** the shared shell marks one primary navigation destination as the current page
- **THEN** that destination has an active treatment distinguishable from both an idle link and a transient hover state

### Requirement: Semantic accents follow consistent visual roles

The console SHALL use semantic foreground, background, and border treatments consistently for success, active progress, warning, failure, cancellation or interruption, neutral information, and disabled state. Every semantic treatment SHALL retain visible text or another non-color cue. Colored model capsules SHALL remain text-bearing and SHALL preserve their distinct recommendation, cost, availability, or compatibility meaning.

Danger styling SHALL be reserved for destructive-action regions and controls; failure styling SHALL identify recorded failed outcomes or error feedback; event/category borders SHALL use neutral or category-specific accents and SHALL NOT resemble danger or failure unless the event itself is a failure.

#### Scenario: Status can be understood without color

- **WHEN** a status pill, job-safety step, connection state, attention marker, or action result uses a semantic accent
- **THEN** its visible label, shape, icon, or accompanying copy communicates the same state when color differences are unavailable

#### Scenario: Model metadata keeps semantic capsules

- **WHEN** a model option or selected model has recommendation, free-tier, current, unavailable, mismatch, or validation metadata
- **THEN** the console presents the applicable colored capsules with concise visible text rather than reducing the metadata to color or unlabelled decoration

#### Scenario: Border meaning remains unambiguous

- **WHEN** danger actions, failed outcomes, and ordinary event categories appear on the same surface
- **THEN** destructive boundaries, failure accents, and neutral/category event borders use distinct visual roles, and decorative borders do not falsely imply danger or failure

### Requirement: Visual treatment adapts without losing meaning

The visual system SHALL support light and dark operating-system preferences, visible keyboard focus, reduced-motion preferences, narrow viewports, long Windows paths, identifiers, tables, filters, staged editors, feedback blocks, and job-progress rails. Theme and responsive variants SHALL preserve hierarchy, contrast, semantic distinctions, complete text, and usable control states.

#### Scenario: Dark preference is active

- **WHEN** the operating system requests a dark color scheme
- **THEN** the console uses the dark semantic palette while preserving panel hierarchy, focus visibility, model-capsule meanings, and distinct status roles

#### Scenario: Reduced motion is active

- **WHEN** the operating system requests reduced motion
- **THEN** non-essential transitions, pulses, and activity effects are suppressed while busy, live, and status states remain understandable from static treatment and text

#### Scenario: Console is viewed narrowly

- **WHEN** a console route is viewed at the supported narrow-width acceptance viewport
- **THEN** panels, controls, navigation, tables, paths, identifiers, safety steps, and feedback reflow or wrap without horizontal page overflow, clipping essential text, or losing their emphasis and semantic cues

#### Scenario: Keyboard focus moves through styled controls

- **WHEN** the operator navigates interactive elements with the keyboard
- **THEN** every focused element retains a clearly visible focus indicator that is distinct from hover, active, selected, error, and busy styling in both themes
