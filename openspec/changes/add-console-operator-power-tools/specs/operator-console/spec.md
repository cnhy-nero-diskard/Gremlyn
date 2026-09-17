## ADDED Requirements

### Requirement: Operators can search and filter jobs and repositories globally

The authenticated console SHALL provide one global search entry point that finds
jobs across retained job history and repositories across the configured registry,
not only items currently rendered on the page. Search SHALL match operator-facing
identifiers including repository owner/name, pull request number, job identifier,
and command name without searching captured output, review text, logs, credentials,
or other potentially sensitive free text.

The result set SHALL support combinable filters for job status, repository, and a
server-derived attention state. The attention state SHALL identify records that
require operator review or action, including unresolved failures and recorded
retained or unpublished work, without the browser inventing eligibility from
display text. Active filters and the query SHALL be visible, removable, and
preserved when the operator opens a result and returns.

#### Scenario: Search spans retained jobs and configured repositories

- **WHEN** an authenticated operator searches for a repository, pull request, or
  job that is not present in the currently rendered dashboard lanes
- **THEN** matching retained jobs and configured repositories are returned with
  their type, identity, current state, and attention state

#### Scenario: Filters combine

- **WHEN** an operator selects a repository, one or more statuses, and the
  requires-attention filter
- **THEN** results satisfy the query and every active filter, and each filter can
  be removed independently

#### Scenario: Search has no matches

- **WHEN** no job or repository matches the current query and filters
- **THEN** the console reports an empty result set, keeps the query and filters
  editable, and performs no mutation

#### Scenario: Sensitive operational text is not a search source

- **WHEN** a secret or arbitrary review, output, or log text appears only inside
  captured operational detail
- **THEN** searching for that text does not return a match or disclose it

#### Scenario: Unauthenticated global search request

- **WHEN** a global search or filter request is made without a valid console token
- **THEN** it is rejected and no job, repository, filter facet, or count is
  disclosed

### Requirement: Operators can move quickly across a job result context

Job search and filtered job collections SHALL provide visible, keyboard-operable
controls for opening the previous and next job in the operator's current ordered
result context. A job detail view reached from that context SHALL preserve the
query and filters and SHALL provide a visible path back to the same result set.

Navigation SHALL identify the adjacent job by repository, pull request, job
identifier, and status before it is opened. At either boundary the unavailable
direction SHALL be visibly disabled or absent and SHALL NOT wrap to the opposite
end without an explicit operator choice.

#### Scenario: Move to the next matching job

- **WHEN** an operator opens a job from filtered results and invokes Next job
- **THEN** the next job in that ordered result context opens and the query and
  filters remain available

#### Scenario: Reach a result boundary

- **WHEN** the current job is the first or last job in its result context
- **THEN** the corresponding previous or next control states that no adjacent job
  is available and does not navigate

#### Scenario: Live updates change the result set

- **WHEN** jobs update while an operator is reading a job reached from a result
  context
- **THEN** the current job remains open and any recomputed adjacent navigation is
  based on current server-authoritative results rather than moving focus or
  navigating automatically

### Requirement: Keyboard shortcuts are discoverable and context-safe

The console SHALL provide shortcuts for focusing global search, opening shortcut
help, and invoking previous or next job navigation where those actions are
available. Every shortcut action SHALL also have a visible, keyboard-operable
control and SHALL be listed in a shortcut reference reachable without using a
shortcut.

Unmodified printable-key shortcuts SHALL NOT fire while focus is in an input,
textarea, select, editable element, dialog interaction, or any other control that
accepts text or keys. The console SHALL NOT intercept browser, assistive-technology,
or operating-system conventions using Control, Command, Alt, or system-reserved
key combinations. Shortcut handling SHALL respect the current page and
server-authoritative action availability.

#### Scenario: Focus global search with a shortcut

- **WHEN** focus is not in an editable or interactive control and the operator
  invokes the documented search shortcut
- **THEN** focus moves to global search and its visible label remains available

#### Scenario: Type a shortcut character in a form control

- **WHEN** the operator types a documented shortcut character while editing a
  search, repository setting, model filter, confirmation, or other form control
- **THEN** the character is handled by that control and no shortcut action fires

#### Scenario: Discover shortcuts without knowing one

- **WHEN** an operator activates the visible keyboard-shortcuts control
- **THEN** a dismissible reference lists each available shortcut and its action,
  returns focus on close, and contains no unrelated workflow documentation

#### Scenario: Shortcut action is unavailable

- **WHEN** an operator invokes a navigation shortcut at a result boundary or on a
  page without that action
- **THEN** no navigation or mutation occurs and the console communicates that the
  action is unavailable without moving focus unexpectedly

### Requirement: Bulk repository enablement is reviewed and bounded

The console SHALL allow an operator to select multiple configured repositories
and request one enable or disable action for that explicit set. Selection alone
SHALL NOT mutate any repository. Before submission, a review step SHALL name every
selected repository, show its current enabled state and requested state, and state
the consequence of the action.

Disabling in bulk SHALL explicitly confirm that later commands for those
repositories will create no jobs and that commands ignored while disabled will
not be replayed. The batch request SHALL carry explicit repository identifiers
and the intended state; the server SHALL authenticate the request and revalidate
each target and its eligibility at invocation time.

Each repository SHALL produce an independent success, unchanged, or failure
result so one refusal does not hide successful targets. Every changed or refused
target SHALL be recorded in the operator audit with its target and effect, and
the batch result SHALL summarize counts without exposing secrets.

#### Scenario: Review a bulk disable

- **WHEN** an operator selects repositories and chooses Disable selected
- **THEN** no state changes until a review names the selected repositories,
  presents current and requested states, explains ignored-command behavior, and
  the operator explicitly confirms

#### Scenario: Server revalidates a stale selection

- **WHEN** repository state or eligibility changes after review but before the
  confirmed batch request is handled
- **THEN** the server evaluates the current state of each explicit target and
  reports changed, unchanged, and refused targets accurately

#### Scenario: Batch has partial failures

- **WHEN** some selected repositories can be changed and others are missing,
  ineligible, or refused
- **THEN** eligible repositories change, every target receives a visible result,
  refused repositories remain unchanged, and successful results are not reported
  as a total failure

#### Scenario: Batch results are audited

- **WHEN** a bulk enable or disable request completes with any mix of outcomes
- **THEN** each changed or refused repository has an audit record with the target
  and effect, and the console presents a redacted aggregate summary

#### Scenario: Repository settings draft is open

- **WHEN** a repository is selected for bulk enablement while it has an unsaved
  provider, model, effort, or timeout draft
- **THEN** the enablement action neither applies nor discards that settings draft
  and reports enablement independently

### Requirement: Large model catalogs can be filtered accessibly

When a repository's available model catalog is presented, the console SHALL offer
an explicitly labelled text filter that narrows the models shown using human-readable
name, exact identifier, description, provider, and semantic badge text. The
filtered result count and no-match state SHALL be exposed in text.

Filtering SHALL preserve native keyboard and assistive-technology semantics for
the model selection control. It SHALL NOT select or persist a model, alter the
provider, remove the persisted or staged current value, or remove the custom
free-text path. Clearing the filter SHALL restore every model available to that
repository's agent under the current catalog.

#### Scenario: Filter a large catalog

- **WHEN** an operator enters text matching a model name, identifier, description,
  provider, or badge
- **THEN** the native model control offers only matching catalog entries plus any
  required current/custom entries and announces the resulting count

#### Scenario: Filter has no catalog matches

- **WHEN** the filter text matches no catalog model
- **THEN** a textual no-match state is shown, the current persisted or staged
  value remains visible, and no value is selected or persisted

#### Scenario: Clear the model filter

- **WHEN** an operator clears the model filter
- **THEN** all models available for the current repository agent and provider are
  restored with their grouping and metadata, without changing the current value

#### Scenario: Catalog refresh occurs while filtering a draft

- **WHEN** catalog metadata refreshes while a model filter and unsaved repository
  settings draft are present
- **THEN** the filter is reapplied to the refreshed catalog while the query,
  staged selection, persisted baseline, and unapplied status remain intact

#### Scenario: Use the picker without filtering

- **WHEN** an operator does not use the optional model filter
- **THEN** the model picker remains usable through its ordinary visible native
  controls with no shortcut or advanced interaction required
