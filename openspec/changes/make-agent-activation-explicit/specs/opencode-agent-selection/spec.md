## ADDED Requirements

### Requirement: Managed team activation is explicit and atomic

The system SHALL offer separate save-only, save-and-activate, and activate-saved-team operations for an OpenCode repository. Save-only SHALL retain the current primary source. Save-and-activate SHALL validate and save the reviewed complete profile and select managed source as one atomic operation, checking both the profile revision and primary-selection revision the operator reviewed. It SHALL support creating a first saved profile without requiring a pre-existing definition. Activate-saved-team SHALL select exactly the reviewed saved profile and SHALL check both revisions without editing its definition; a missing or corrupt saved definition SHALL prevent this activation-only operation. Validation errors, obsolete revisions, an executor that is no longer OpenCode, or persistence failure SHALL leave both resources and their audit state unchanged. Jobs created concurrently SHALL capture either the state before the operation or the fully committed state, never an intermediate combination. Existing queued/running jobs and their retries SHALL retain their captured selection/profile.

These operations SHALL be authenticated and repository scoped and SHALL resolve executor aliases by their actual executor kind. They SHALL NOT modify provider, model, reasoning effort, timeout, repository enablement, other repositories, or external OpenCode definitions. Deployment SHALL NOT activate existing inactive profiles automatically.

#### Scenario: Save an inactive team without activating it

- **WHEN** an operator saves a valid profile while the repository selects default or native source
- **THEN** the profile is saved and the current source remains authoritative for new jobs

#### Scenario: Save and activate a reviewed new team

- **WHEN** an operator explicitly saves and activates a valid candidate using current profile and selection revisions
- **THEN** the profile and managed source become authoritative together and later-created jobs capture that profile

#### Scenario: Activate the reviewed saved team

- **WHEN** an operator activates an existing valid profile using matching profile and selection revisions
- **THEN** the repository selects that saved team without modifying its bytes or profile revision

#### Scenario: Profile baseline changed

- **WHEN** the stored profile revision changes after the operator reviewed the activation operation
- **THEN** activation conflicts without changing either resource or recording a successful activation

#### Scenario: Selection baseline changed

- **WHEN** another writer changes the primary selection after the operator reviewed save-and-activate
- **THEN** the combined operation conflicts and the submitted profile is not saved

#### Scenario: Candidate or transaction fails

- **WHEN** the candidate is invalid or a persistence/audit failure prevents a combined operation from completing
- **THEN** neither profile nor selection is changed and no partial success is observable

#### Scenario: Saved team cannot be used

- **WHEN** activate-saved-team targets a missing or corrupt profile
- **THEN** the operation returns an actionable repository-local refusal without switching source

#### Scenario: Executor changes before activation

- **WHEN** the repository no longer resolves to OpenCode at the time activation is committed
- **THEN** activation is rejected and its saved profile and selection are preserved

#### Scenario: An OpenCode alias is activated

- **WHEN** the repository uses an alias that resolves to the OpenCode executor and all activation checks pass
- **THEN** activation succeeds without requiring the alias to be literally named opencode

#### Scenario: Job creation crosses activation

- **WHEN** a job is created concurrently with save-and-activate
- **THEN** its capture represents either the previous complete workflow or the new managed source with the committed candidate profile

#### Scenario: Existing job is retried after activation

- **WHEN** a job created under default, native, or an earlier managed profile is retried after team activation
- **THEN** the retry keeps that job's original capture rather than using the newly selected team

#### Scenario: Repeated activation of the same saved team

- **WHEN** an operator activates an already-active team using current matching revisions
- **THEN** the system reports it already active without changing revisions or duplicating a successful activation audit

### Requirement: Activation outcomes are authoritative and safely audited

A successful state-changing activation SHALL record one scoped operator action containing safe operation/source identifiers, primary/child identifiers, and resulting profile/selection revisions, without instruction text, descriptions, raw profile bodies, credentials, or inventory. Its response SHALL identify the committed selection, saved profile revision, and whether that team is active for new jobs. Runtime refresh notification SHALL follow persistence and SHALL occur at most once per successful activation operation. A refresh failure after commit SHALL be distinguishable from a rejected or rolled-back save; the committed outcome SHALL remain discoverable without requiring a blind resubmission. Existing save-only and source-switch operations SHALL retain their independent semantics.

#### Scenario: Combined activation is audited once

- **WHEN** save-and-activate commits successfully
- **THEN** one repository-local action records the operation and resulting revisions without exposing private definitions

#### Scenario: Runtime refresh fails after commit

- **WHEN** activation commits but subsequent runtime refresh notification fails
- **THEN** the operator can recover the committed workflow state and receives refresh-specific feedback rather than a claim that the save rolled back

#### Scenario: Failed activation has no successful audit

- **WHEN** activation is refused or its transaction rolls back
- **THEN** no successful activation action or runtime refresh notification is produced
