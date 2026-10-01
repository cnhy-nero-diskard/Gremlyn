## ADDED Requirements

### Requirement: Operator-managed OpenCode profiles are durable

The repository registry SHALL persist each OpenCode repository's dashboard-managed agent profile independently of provider, model, effort, and timeout. An existing repository's saved profile SHALL survive process restart and SHALL NOT be replaced by file configuration synchronization. The registry SHALL refuse profile creation, editing, or activation while the repository's configured executor is not OpenCode; a profile saved before an executor change MAY remain dormant for later reuse.

#### Scenario: Profile survives restart

- **WHEN** an operator saves an OpenCode profile and Gremlyn restarts
- **THEN** the same primary and subagent settings remain active for that repository

#### Scenario: File synchronization preserves the operator choice

- **WHEN** Gremlyn reloads repository entries from its configuration file
- **THEN** an existing dashboard-managed OpenCode profile remains unchanged

#### Scenario: Non-OpenCode repository refuses the profile

- **WHEN** an agent profile update targets a repository using another executor
- **THEN** the update is rejected and no profile is stored for that repository

### Requirement: Jobs retain the profile selected when created

The registry SHALL capture the effective OpenCode agent profile when a job is created. An operator edit SHALL affect later-created jobs only; queued or running jobs and their retries SHALL retain their captured profile. The captured profile identifier and revision SHALL be visible in job diagnostics without exposing full private instructions by default.

#### Scenario: Queued job keeps its selected profile

- **WHEN** a job is queued under profile A and the operator saves profile B before it runs
- **THEN** that job runs under profile A and the next new job runs under profile B

#### Scenario: Retry keeps the same profile

- **WHEN** an OpenCode attempt fails and its job is retried after the operator edits the repository profile
- **THEN** the retry uses the job's captured profile
