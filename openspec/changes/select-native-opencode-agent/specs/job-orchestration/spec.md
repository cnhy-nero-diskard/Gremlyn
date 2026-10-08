## ADDED Requirements

### Requirement: Jobs capture OpenCode primary selection atomically

OpenCode jobs SHALL capture primary source, native ID when applicable, selection revision, and active managed-profile snapshot/revision in the same atomic operation that claims their triggering command. The capture SHALL survive restart, remain unchanged across all attempts and invocation retries, and SHALL NOT be refreshed from current repository settings during retry. Legacy jobs SHALL derive managed source from their own captured profile and default source otherwise, never from a later repository selection.

#### Scenario: Repository changes while work is queued

- **WHEN** job A captures native agent X and the repository is changed to agent Y before A starts
- **THEN** every invocation of A retains X while later-created jobs capture Y

#### Scenario: Retry follows a restart

- **WHEN** a failed job is retried after restart and repository selection changes
- **THEN** a new attempt is recorded using the original captured primary source and ID

#### Scenario: Save races with command capture

- **WHEN** a primary-source/profile update overlaps job creation
- **THEN** the job captures one coherent committed source/profile revision rather than mixed old and new values

### Requirement: OpenCode invocation ownership and recovery are durable

Every launched OpenCode parent invocation SHALL have durable attempt/workspace ownership evidence and, when available, its attributed parent session and actual primary identity recorded separately from requested selection. A second parent invocation within an attempt SHALL preserve the first invocation's evidence. Interrupted native/default trees SHALL undergo the same proof-of-quiescence admission rules as managed trees before workspace reuse; unavailable ownership or termination proof SHALL preserve diagnostics and quarantine the workspace rather than imply that marking a job interrupted stopped its service-owned sessions.

#### Scenario: Failed invocation is relaunched

- **WHEN** a native OpenCode invocation fails and another invocation is permitted after proven quiescence
- **THEN** both parent sessions remain associated with their own invocation and the same attempt without overwriting history

#### Scenario: Native background child survives daemon restart

- **WHEN** the daemon restarts after a native invocation with potentially live child sessions
- **THEN** it marks the job interrupted, preserves ownership evidence, and refuses workspace reuse until the attributed tree is proven stopped

#### Scenario: Parent identity was never captured

- **WHEN** a launched OpenCode attempt ends without provable parent-session ownership
- **THEN** diagnostics retain the uncertainty and its workspace is quarantined without guessing ownership from unrelated sessions
