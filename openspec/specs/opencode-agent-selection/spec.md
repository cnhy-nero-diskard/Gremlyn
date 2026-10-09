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
