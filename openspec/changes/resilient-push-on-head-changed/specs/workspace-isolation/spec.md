## MODIFIED Requirements

### Requirement: Head commit is re-verified before publication

The system SHALL compare the pull request head commit observed during workspace preparation against the remote head immediately before publishing results. If the remote head has moved, the system SHALL enter the resilient-push loop (fetch, merge remote in, agent-assisted conflict resolution, re-validation, bounded retry) rather than failing immediately, and SHALL fail with a specific reason only if recovery exhausts its retry bound.

#### Scenario: Branch force-pushed during agent execution

- **WHEN** the pull request branch is updated remotely while the agent is running
- **THEN** publication enters the resilient-push loop, and refuses with a reason identifying the changed head only if recovery exhausts its retry bound; the agent's work is retained in the workspace for inspection either way

#### Scenario: Clean merge recovers on a moved head

- **WHEN** the remote head moved and merges cleanly into the workspace
- **THEN** the system re-validates and retries the push within the same attempt instead of recording `head-changed`
