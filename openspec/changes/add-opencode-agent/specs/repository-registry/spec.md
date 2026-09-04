## MODIFIED Requirements

### Requirement: Managed repository record

The system SHALL maintain a registry of managed repositories. Each entry SHALL
carry the GitHub owner and repository name, the local source repository path, the
workspace root for disposable worktrees, the agent identifier, the model
identifier, the reasoning effort level, an enabled flag, an ordered list of
validation commands, and optional repository-specific agent instructions.

Repository entries SHALL be the sole source of filesystem paths used by any job.
No path used for checkout, worktree creation, or agent execution may originate
from GitHub-supplied text.

Which of an entry's agent-facing settings are required, optional, or meaningless
depends on the agent the entry names. The system SHALL validate each entry against
the requirements of its own agent, and SHALL report an entry as invalid at startup
when it omits a setting that agent requires. An entry SHALL NOT be rejected for
omitting a setting its agent does not use.

#### Scenario: Registry supplies job configuration

- **WHEN** a job is created for a registered repository
- **THEN** the job records the agent, model, reasoning effort, workspace root, and
  validation commands resolved from that repository's entry at creation time

#### Scenario: Path never derives from GitHub content

- **WHEN** a GitHub comment, PR title, or branch name contains a filesystem path
- **THEN** that text is never used to select a source repository, worktree
  location, or agent working directory

#### Scenario: Setting required by one agent and unused by another

- **WHEN** two entries name different agents, and each omits a setting that only the
  other agent requires
- **THEN** both entries are accepted, and neither is rejected for a setting its own
  agent does not use

#### Scenario: Entry omits a setting its agent requires

- **WHEN** an entry omits a setting the agent it names requires in order to run
- **THEN** the entry is reported as invalid at startup and the repository produces
  no jobs
