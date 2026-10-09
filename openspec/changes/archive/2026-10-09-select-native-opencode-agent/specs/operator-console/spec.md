## ADDED Requirements

### Requirement: OpenCode execution-agent selection is distinct and deliberate

OpenCode repository configuration SHALL offer an accessible Run with agent control separate from executor, provider, model, effort and timeout, with default, eligible existing-agent and managed-team choices. It SHALL display the authoritative saved source, including unavailable native IDs, and require deliberate apply or cancel rather than autosaving exploration. Discovery, validation, stale-revision and persistence errors SHALL remain scoped to the affected repository and SHALL preserve unsaved drafts across live updates. Managed source SHALL clearly identify its controlling profile and provide an explicit edit/switch path. Cline repositories SHALL NOT render or accept an OpenCode primary picker.

#### Scenario: Active profile is visible instead of ambiguous override

- **WHEN** a repository is controlled by a managed profile
- **THEN** its primary-source control identifies that team and requires a deliberate source switch to select a native primary

#### Scenario: Saved native ID disappears from discovery

- **WHEN** refresh no longer offers the repository's saved native agent
- **THEN** that ID remains the displayed current choice with an unavailable explanation and no replacement is saved automatically

#### Scenario: Draft survives SSE refresh

- **WHEN** live updates arrive while an operator explores another primary source
- **THEN** the draft, focus and feedback remain intact and no setting changes without apply

#### Scenario: Cline configuration stays executor appropriate

- **WHEN** the repository's resolved executor is Cline
- **THEN** no OpenCode picker is offered and an attempted OpenCode source mutation is rejected

### Requirement: Requested and effective primary identities are diagnosable

Repository summaries SHALL distinguish executor from configured primary source. Job detail SHALL show captured source/native ID or managed-profile revision and separately show actual per-invocation primary identity when supported, including unknown identity explicitly. Source changes SHALL be audited with safe before/after identifiers and revisions but without private definitions. Default/native diagnostics SHALL explain that external instruction definitions are not snapshotted.

#### Scenario: Retried job differs from current repository choice

- **WHEN** a job captured native X but the repository now selects native Y
- **THEN** job detail still identifies X as its requested runner while the repository summary identifies Y

#### Scenario: Safe audit of a source switch

- **WHEN** an operator switches between managed, native or default source
- **THEN** the audit records the affected repository, sources and safe identifiers without profile instruction bodies or raw inventory
