## ADDED Requirements

### Requirement: OpenCode primary-source selections are durable

The registry SHALL persist a revisioned OpenCode primary source and any selected native ID per repository independently of provider, model, effort, timeout and stored managed profiles. Existing selections SHALL survive restart and SHALL NOT be overwritten by file synchronization. Migration SHALL select managed mode for an OpenCode repository with an existing non-null profile and default mode otherwise, without synthesizing profiles. Non-OpenCode executors SHALL reject source activation and SHALL preserve dormant choices for later reuse.

#### Scenario: Native selection survives restart and synchronization

- **WHEN** a native primary is saved and Gremlyn restarts with differing file defaults
- **THEN** the same source and native ID remain authoritative for that repository

#### Scenario: Existing profile is migrated

- **WHEN** an existing OpenCode repository has a saved managed profile
- **THEN** migration preserves its bytes and revision and selects managed mode without replacing its primary

#### Scenario: Repository without a profile is migrated

- **WHEN** an existing OpenCode repository has no saved managed profile
- **THEN** migration selects OpenCode default and does not invent a native selection or managed team

#### Scenario: Executor is no longer OpenCode

- **WHEN** activation of a saved OpenCode selection targets a Cline repository
- **THEN** activation is rejected and any dormant selection remains unchanged

## MODIFIED Requirements

### Requirement: Operator-managed OpenCode profiles are durable

The repository registry SHALL persist each OpenCode repository's dashboard-managed agent profile independently of provider, model, effort, timeout and primary-source selection. An existing repository's saved profile SHALL survive process restart and SHALL NOT be replaced by file configuration synchronization. A saved profile SHALL be active only when the primary source selects a managed team; switching to native or default mode SHALL preserve it as dormant. The registry SHALL refuse profile creation, editing, or activation while the repository's configured executor is not OpenCode; a profile saved before an executor change SHALL remain dormant for later reuse. Saving a dormant profile SHALL NOT silently activate it.

#### Scenario: Profile survives restart

- **WHEN** an operator saves an active OpenCode profile and Gremlyn restarts
- **THEN** the same primary and subagent settings remain active for that repository

#### Scenario: File synchronization preserves the operator choice

- **WHEN** Gremlyn reloads repository entries from its configuration file
- **THEN** an existing dashboard-managed OpenCode profile and its activation state remain unchanged

#### Scenario: Non-OpenCode repository refuses the profile

- **WHEN** an agent profile update targets a repository using another executor
- **THEN** the update is rejected and no profile is stored for that repository

#### Scenario: Native selection preserves a dormant team

- **WHEN** an operator deliberately switches an active managed repository to a native primary
- **THEN** the stored profile is retained but is not materialized for later-created native jobs

### Requirement: Jobs retain the profile selected when created

The registry SHALL capture the effective OpenCode primary source and, only for managed source, its agent profile when a job is created. An operator edit SHALL affect later-created jobs only; queued or running jobs and their retries SHALL retain their captured source and profile. The captured profile identifier and revision SHALL be visible in job diagnostics without exposing full private instructions by default. A dormant repository profile SHALL NOT be substituted for a job that captured native or default mode.

#### Scenario: Queued job keeps its selected profile

- **WHEN** a job is queued under active profile A and the operator saves profile B before it runs
- **THEN** that job runs under profile A and the next new managed job runs under profile B

#### Scenario: Retry keeps the same profile

- **WHEN** an OpenCode attempt fails and its job is retried after the operator edits the repository profile
- **THEN** the retry uses the job's captured source and profile

#### Scenario: Dormant profile does not override native capture

- **WHEN** a native job is queued and the repository later activates a managed profile
- **THEN** the queued job still uses its captured native ID and does not materialize the managed profile
