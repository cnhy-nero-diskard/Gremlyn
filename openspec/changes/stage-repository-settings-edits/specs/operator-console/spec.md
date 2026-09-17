## MODIFIED Requirements

### Requirement: Repository configuration edits persist exactly what was edited

The console SHALL treat a repository's persisted provider, model, reasoning effort,
and agent timeout as the authoritative baseline for an explicit repository-local
edit session. Changing a control SHALL update only the draft and SHALL NOT persist
any value until the operator applies the reviewed draft.

Applying a draft SHALL validate provider, model, reasoning effort, and timeout as
one coherent settings set and SHALL persist the reviewed set atomically. If any
value is refused or persistence fails, none of the settings SHALL change and the
operator's draft SHALL remain available for correction or cancellation.

Cancelling an edit SHALL discard the draft and restore the current persisted
values. A successful apply SHALL make the returned persisted values the new
baseline.

#### Scenario: Exploring a different provider does not save it

- **WHEN** an operator enters edit mode and changes the provider or model without applying the draft
- **THEN** the repository's persisted provider, model, reasoning effort, and timeout remain unchanged

#### Scenario: Applying a coherent settings set

- **WHEN** an operator reviews and applies valid provider, model, reasoning effort, and timeout values
- **THEN** all four values are committed together and become the displayed persisted settings

#### Scenario: One invalid value rejects the whole draft

- **WHEN** an operator applies a draft whose provider, model, reasoning effort, or timeout is invalid
- **THEN** none of the four persisted settings change, and the draft remains visible with the refusal associated with that repository

#### Scenario: Cancelling an edit

- **WHEN** an operator cancels a repository settings edit
- **THEN** no draft value is persisted and the card again shows the current persisted values

#### Scenario: Changing reasoning effort leaves the model alone

- **WHEN** an operator changes only a repository's reasoning effort and applies the draft
- **THEN** the reasoning effort is persisted and the repository's provider, model, and timeout remain equal to the reviewed baseline

#### Scenario: Changing the model leaves the effort alone

- **WHEN** an operator changes only a repository's model and applies the draft
- **THEN** the model is persisted and the repository's provider, reasoning effort, and timeout remain equal to the reviewed baseline

## ADDED Requirements

### Requirement: Repository settings changes are reviewed in context

The console SHALL show a before/after summary for a repository's draft before it
can be applied. The summary SHALL identify every value that will change and SHALL
state that the applied settings govern jobs created after the apply succeeds;
already-created jobs retain the settings recorded when they were created.

The editing controls SHALL retain native keyboard and assistive-technology
semantics. Model name, exact identifier, description, and semantic status or tier
badges SHALL remain distinguishable while the operator reviews a draft.

#### Scenario: Reviewing changes before apply

- **WHEN** an operator changes one or more repository settings in edit mode
- **THEN** the card shows the persisted and proposed values for every changed field before Apply is invoked

#### Scenario: Understanding which jobs are affected

- **WHEN** an operator reviews a repository settings draft
- **THEN** the card explains that a successful apply affects jobs created afterward and does not rewrite settings already recorded on existing jobs

#### Scenario: Reviewing a catalog model accessibly

- **WHEN** an operator selects a catalog model while editing with a keyboard or assistive technology
- **THEN** the native selection control remains operable and the selected model's name, exact identifier, description, and semantic badges remain available outside the option label

### Requirement: Repository settings feedback stays with its repository

The console SHALL present saving, success, validation, conflict, and persistence
failure feedback within the repository card that initiated the settings action.
The feedback SHALL identify whether the draft was saved, preserved for correction,
or superseded by newer persisted values, and SHALL be announced without relying on
color alone.

#### Scenario: Apply is in progress

- **WHEN** a repository settings apply request is pending
- **THEN** that repository card indicates saving, prevents a duplicate apply, and leaves unrelated repository controls usable

#### Scenario: Apply succeeds

- **WHEN** a repository settings draft is committed successfully
- **THEN** that repository card confirms the save and displays the returned values as its persisted baseline

#### Scenario: Apply is refused

- **WHEN** a repository settings apply is refused or fails
- **THEN** that repository card explains the failure, preserves the draft, and provides a retry or correction path

### Requirement: Concurrent repository settings changes do not silently overwrite a draft

While a repository settings edit is in progress, a live update or catalog refresh
SHALL NOT replace the operator's draft. If the repository's persisted provider,
model, reasoning effort, or timeout changes from the draft's baseline, the console
SHALL identify the newer persisted values and require the operator to review them
before the draft can be applied against that baseline.

The settings mutation SHALL reject a stale baseline atomically and return the
current persisted settings. The console SHALL preserve the draft and SHALL offer
explicit paths to discard it in favor of the current values or review it against
the current values. A stale apply SHALL NOT overwrite the newer settings.

#### Scenario: Live update arrives during an edit

- **WHEN** repository settings change elsewhere while an operator has an unsaved draft
- **THEN** the draft remains intact, the card reports the newer persisted values, and Apply requires review against the newer baseline

#### Scenario: Stale draft reaches the server

- **WHEN** an apply request names a baseline that no longer matches the repository's persisted settings
- **THEN** the request is rejected without changing any setting and returns the current persisted values for conflict review

#### Scenario: Operator loads the newer settings

- **WHEN** an operator chooses to discard a conflicted draft and load the current values
- **THEN** the current persisted values replace the draft and become its baseline without issuing a settings mutation

#### Scenario: Catalog refresh occurs during an edit

- **WHEN** the live catalog refreshes while an operator has an unsaved draft
- **THEN** catalog metadata and available choices may refresh, but the draft's provider, model, reasoning effort, and timeout are not changed or persisted

### Requirement: Repository enablement remains an explicit independent action

The console SHALL explain beside the enable/disable control that disabling a
repository prevents later commands from creating jobs and that ignored commands
are not replayed when the repository is re-enabled. Enablement SHALL remain
independent from the staged provider, model, reasoning effort, and timeout draft;
neither action SHALL implicitly apply the other.

#### Scenario: Reviewing disable consequences

- **WHEN** an operator is offered the action to disable a repository
- **THEN** the console explains the effect on later commands and the lack of replay before the action is invoked

#### Scenario: Toggling enablement with an unsaved settings draft

- **WHEN** an operator enables or disables a repository while its settings draft is unsaved
- **THEN** enablement changes independently and none of the draft settings are persisted or discarded

#### Scenario: Applying settings does not change enablement

- **WHEN** an operator applies a repository settings draft
- **THEN** the repository's enabled state remains unchanged
