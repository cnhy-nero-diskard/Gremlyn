# opencode-agent-selection Specification

## Purpose
Defines how a repository selects an existing OpenCode primary agent independently of its executor and model, with effective-context validation and honest requested-versus-observed identity.

## Requirements

### Requirement: Effective discovery is repository scoped and privacy safe

The system SHALL discover effective OpenCode agents using the repository's configured binary, pinned version, execution environment and installation context. Discovery SHALL be bounded and observational, SHALL expose only safe identity, description, eligibility and evidenced origin metadata, and SHALL NOT expose private instructions, credentials or arbitrary configuration contents. Eligible choices SHALL include visible agents whose supported mode permits primary execution. Results for one repository SHALL NOT authorize a selection for another repository. Missing origin evidence SHALL be labeled unknown rather than inferred from the agent name.

#### Scenario: Multiple existing agents are discovered

- **WHEN** three eligible operator-configured agents are effective for a repository
- **THEN** all three are offered with their actual IDs and available names/descriptions rather than a hardcoded roster

#### Scenario: Non-primary or hidden agent is returned

- **WHEN** discovery returns a subagent-only or hidden definition
- **THEN** it is not offered as an eligible primary and a submitted selection of it is rejected

#### Scenario: Discovery is unavailable

- **WHEN** the discovery operation fails or exceeds its bound
- **THEN** the operator receives a safe actionable error, the stored selection remains unchanged, and an empty successful inventory is not fabricated

#### Scenario: Repository contexts differ

- **WHEN** an agent exists in repository A but not repository B
- **THEN** discovery and selection validation for B do not reuse A's authorization result

### Requirement: Primary source is explicit and exclusive

Each OpenCode repository SHALL have exactly one effective primary source: OpenCode default, an existing native agent, or a Gremlyn-managed team. Native mode SHALL require one eligible native ID; managed mode SHALL require a valid saved profile. The system SHALL reject contradictory or stale source updates without changing state. Default mode SHALL omit explicit primary selection. Saving a choice SHALL NOT change the executor, provider, model, effort, timeout or enablement.

#### Scenario: Existing agent is selected independently of model

- **WHEN** an operator applies a valid native agent selection
- **THEN** new jobs capture that source and ID while the repository's other settings remain unchanged

#### Scenario: OpenCode default is selected

- **WHEN** a job captures the default source
- **THEN** its invocation omits an explicit agent selection and does not synthesize a managed team

#### Scenario: Conflicting update is rejected

- **WHEN** an update requests competing primary sources or uses an obsolete selection revision
- **THEN** the update fails with scoped feedback and the previously stored source remains authoritative

### Requirement: Explicit selection is revalidated in the attempt workspace

Before agent work begins, the system SHALL validate an explicit captured selection against the effective inventory of the actual isolated attempt workspace using the same binary and environment as execution. Native ID validation SHALL remain distinct from managed generated-ID and permission validation. Invalid identifiers, unavailable or ineligible agents, wrong-context inventories and unresolved discovery races SHALL fail with an actionable configuration reason before agent work, without silently substituting another agent.

#### Scenario: Selected native agent is launched

- **WHEN** the captured native ID remains eligible in the prepared workspace
- **THEN** execution explicitly selects that ID and runtime acceptance verifies the actual effective primary

#### Scenario: Source-checkout choice is absent in the worktree

- **WHEN** an ID discovered in the source checkout is unavailable in the isolated workspace
- **THEN** the attempt fails before agent work instead of copying private configuration or falling back to another primary

#### Scenario: Cold inventory does not converge

- **WHEN** inventory for the attempt remains empty or incomplete throughout the bounded discovery wait
- **THEN** the attempt fails with a discovery/configuration reason and no agent edits or publication occur

### Requirement: Selection snapshots do not claim immutable external definitions

The system SHALL distinguish the captured source/native ID or managed-profile revision from the actual runtime primary identity when observed. Default source SHALL represent the policy of allowing OpenCode to resolve its default for the attempt; a native ID SHALL NOT imply a captured copy of external instructions. The system SHALL display unavailable actual identity as unknown and SHALL NOT overwrite requested selection with observed identity.

#### Scenario: External native definition changes

- **WHEN** an agent's external definition changes after job creation but its captured ID remains eligible
- **THEN** the job retains its ID, execution uses the effective external definition, and diagnostics do not claim that its instructions were frozen

#### Scenario: Actual identity is unavailable

- **WHEN** the runtime exposes no attributable primary identity
- **THEN** diagnostics show the captured selection and unknown actual identity without fabricating a successful identity check

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
