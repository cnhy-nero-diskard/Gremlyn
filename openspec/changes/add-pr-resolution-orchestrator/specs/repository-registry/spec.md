## Purpose

Defines the set of GitHub repositories the orchestrator is permitted to act on, and
the per-repository settings — local paths, agent, model, and validation commands —
that every job for that repository inherits.

## ADDED Requirements

### Requirement: Managed repository record

The system SHALL maintain a registry of managed repositories. Each entry SHALL
carry the GitHub owner and repository name, the local source repository path, the
workspace root for disposable worktrees, the agent identifier, the model
identifier, an enabled flag, an ordered list of validation commands, and optional
repository-specific agent instructions.

Repository entries SHALL be the sole source of filesystem paths used by any job.
No path used for checkout, worktree creation, or agent execution may originate
from GitHub-supplied text.

#### Scenario: Registry supplies job configuration

- **WHEN** a job is created for a registered repository
- **THEN** the job records the agent, model, workspace root, and validation
  commands resolved from that repository's entry at creation time

#### Scenario: Path never derives from GitHub content

- **WHEN** a GitHub comment, PR title, or branch name contains a filesystem path
- **THEN** that text is never used to select a source repository, worktree
  location, or agent working directory

### Requirement: Independent repository locations

The system SHALL NOT assume that managed repositories share a common local parent
directory, nor that a repository's workspace root is inside its source repository.

#### Scenario: Repositories in unrelated locations

- **WHEN** two repositories are registered with source paths on different drives
  and workspace roots under a third unrelated directory
- **THEN** both repositories are usable and neither path is inferred from the other

### Requirement: Repository enablement

Each registry entry SHALL carry an enabled flag. A disabled repository SHALL NOT
produce jobs. Commands arriving for a disabled repository SHALL be recorded as
ignored with the reason, and SHALL NOT be retried automatically when the
repository is later enabled.

#### Scenario: Command for disabled repository

- **WHEN** an authorized user issues a command on a PR in a registered but
  disabled repository
- **THEN** no job is created, and the event is recorded as ignored with reason
  `repository-disabled`

#### Scenario: Re-enabling does not replay history

- **WHEN** a disabled repository is enabled again
- **THEN** commands that arrived while it was disabled are not executed

### Requirement: Unregistered repositories are inert

The system SHALL ignore all GitHub activity for repositories absent from the
registry, without creating a job, posting a comment, or performing any local
filesystem or git operation.

#### Scenario: Activity in unregistered repository

- **WHEN** a command appears in a repository that is not in the registry
- **THEN** the event is discarded and no local operation occurs

### Requirement: Per-repository validation commands

Validation commands SHALL be configured per repository as an ordered list of
executable command specifications. The system SHALL NOT infer validation commands
from repository contents, and SHALL NOT fall back to a built-in default command
set when the list is empty.

#### Scenario: Configured validation runs in order

- **WHEN** a repository configures validation commands `[typecheck, test]`
- **THEN** validation runs `typecheck` first and `test` second, recording each
  command's exit status separately

#### Scenario: No validation configured

- **WHEN** a repository has an empty validation command list
- **THEN** validation performs worktree inspection only, and the job records that
  no repository validation commands were configured

### Requirement: Model and agent values are validated

The system SHALL accept agent and model identifiers only from registry
configuration, and SHALL reject a registry entry naming an agent for which no
executor is available.

#### Scenario: Unknown agent identifier

- **WHEN** a repository entry names an agent with no registered executor
- **THEN** the entry is reported as invalid at startup and the repository produces
  no jobs
