## Purpose

Gives every job a disposable, deterministic checkout of the target pull request
branch, and guarantees that automated work never mutates the developer's own
working directory.

## ADDED Requirements

### Requirement: Developer checkouts are never mutated

The system SHALL NOT modify the working tree, index, or checked-out branch of a
configured source repository. Operations against a source repository SHALL be
limited to those that do not alter its working tree, such as fetching remote refs
and creating or removing worktrees.

Destructive working-tree operations SHALL never be executed against a source
repository path.

#### Scenario: Source repository untouched by a job

- **WHEN** a job runs to completion for a repository
- **THEN** that repository's working tree, staged changes, and checked-out branch
  are unchanged

#### Scenario: Dirty source repository does not block jobs

- **WHEN** a source repository has uncommitted local changes
- **THEN** jobs still run, operating only in their own worktrees, and the local
  changes are neither committed, stashed, nor discarded

### Requirement: Deterministic per-pull-request workspace

Each pull request SHALL map to a deterministic workspace path derived from the
repository's configured workspace root and the pull request number. The path SHALL
NOT be derived from branch names, comment text, or other GitHub-supplied strings.

#### Scenario: Same pull request reuses its workspace

- **WHEN** two successive jobs run for the same pull request
- **THEN** both use the same workspace path

#### Scenario: Distinct pull requests are isolated

- **WHEN** jobs run for two different pull requests in the same repository
- **THEN** each operates in a separate workspace directory

### Requirement: Workspace preparation sequence

Before the agent runs, the system SHALL bring the workspace to a known state by
fetching current remote state for the source repository, resolving the pull
request's head branch and head commit, and creating or updating the workspace so
that it has that branch checked out at that commit.

The system SHALL record the head commit identifier observed during preparation.

#### Scenario: Fresh workspace

- **WHEN** no workspace exists for the pull request
- **THEN** one is created with the pull request's head branch checked out at its
  current head commit

#### Scenario: Existing clean workspace is refreshed

- **WHEN** a workspace exists, is clean, and is behind the remote head
- **THEN** it is updated to the current head commit before the agent runs

### Requirement: Unsafe workspace state halts the job

If the workspace cannot be brought to the expected state safely — it contains
uncommitted modifications from a previous attempt, is in a conflicted or detached
state, has diverged from the remote head, or is not a valid git worktree — the
system SHALL fail the job with a specific reason rather than discarding the
workspace contents.

Recovery from such a state SHALL require an explicit operator action.

#### Scenario: Leftover modifications from an interrupted attempt

- **WHEN** preparation finds uncommitted modifications in the workspace
- **THEN** the job fails with a reason identifying the unexpected state, the
  modifications are preserved, and no agent runs

#### Scenario: Conflicted worktree

- **WHEN** the workspace is in a conflicted merge state
- **THEN** the job fails with a specific reason and the state is left intact for
  inspection

#### Scenario: Operator resets a workspace explicitly

- **WHEN** an operator explicitly requests that a workspace be discarded and
  recreated
- **THEN** the workspace is removed and rebuilt, and the action is recorded

### Requirement: Destructive operations are confined and deliberate

Operations that discard working-tree contents SHALL execute only against paths
beneath a configured workspace root, and only as part of an explicitly requested
workspace reset. The system SHALL verify that a target path lies beneath a
configured workspace root before performing such an operation.

#### Scenario: Path outside workspace root is refused

- **WHEN** a workspace reset is requested for a path that does not lie beneath a
  configured workspace root
- **THEN** the operation is refused and recorded

### Requirement: Head commit is re-verified before publication

The system SHALL compare the pull request head commit observed during workspace
preparation against the remote head immediately before publishing results. If the
remote head has moved, the job SHALL fail with a specific reason rather than
publishing.

#### Scenario: Branch force-pushed during agent execution

- **WHEN** the pull request branch is updated remotely while the agent is running
- **THEN** publication is refused with a reason identifying the changed head, and
  the agent's work is retained in the workspace for inspection
