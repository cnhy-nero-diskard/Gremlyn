## MODIFIED Requirements

### Requirement: Managed repository record

The system SHALL maintain a registry of managed repositories. Each entry SHALL
carry the GitHub owner and repository name, the local source repository path, the
workspace root for disposable worktrees, the agent identifier, the provider
identifier, the model identifier, the reasoning effort level, an enabled flag, an
ordered list of validation commands, and optional repository-specific agent
instructions.

Repository entries SHALL be the sole source of filesystem paths used by any job.
No path used for checkout, worktree creation, or agent execution may originate
from GitHub-supplied text.

#### Scenario: Registry supplies job configuration

- **WHEN** a job is created for a registered repository
- **THEN** the job records the agent, provider, model, reasoning effort, workspace
  root, and validation commands resolved from that repository's entry at creation
  time

#### Scenario: Path never derives from GitHub content

- **WHEN** a GitHub comment, PR title, or branch name contains a filesystem path
- **THEN** that text is never used to select a source repository, worktree
  location, or agent working directory

## ADDED Requirements

### Requirement: Operator selections are durable and outrank file configuration

The provider, model and reasoning effort an operator selects for a registered
repository SHALL be durable per-repository state. For an existing registry entry
these values SHALL survive process restart, and file configuration SHALL NOT
overwrite them.

File configuration SHALL supply these values only when a registry entry is first
created.

#### Scenario: Selection survives a restart

- **WHEN** an operator selects a provider, model and reasoning effort for a
  repository, and the orchestrator is then restarted
- **THEN** that repository still carries the selected provider, model and
  reasoning effort, and jobs created for it use them

#### Scenario: File configuration does not overwrite a selection

- **WHEN** the configuration file names a different provider or model than the one
  an operator selected for an existing repository
- **THEN** the operator's selection is retained and the file value is ignored for
  that entry

#### Scenario: First registration seeds from configuration

- **WHEN** a repository is registered for the first time
- **THEN** its provider, model and reasoning effort are taken from the
  configuration file

### Requirement: A repository's provider is reconciled against its agent

The system SHALL determine whether a registry entry's provider is usable by the
agent that entry names, and SHALL report an entry whose provider its agent cannot
use. Such an entry SHALL be reported rather than silently reassigned to a
different provider or model.

#### Scenario: Agent changed under an existing selection

- **WHEN** a repository's configured agent is changed to one that cannot use the
  provider previously selected for that repository
- **THEN** the mismatch is reported and neither the provider nor the model is
  silently replaced

#### Scenario: Provider is usable by the agent

- **WHEN** a registry entry's provider is one its configured agent can use
- **THEN** no mismatch is reported and jobs for that repository run with that
  provider
