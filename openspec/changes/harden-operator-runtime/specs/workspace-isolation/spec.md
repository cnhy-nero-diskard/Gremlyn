## MODIFIED Requirements

### Requirement: Destructive operations are confined and deliberate

Operations that discard working-tree contents SHALL execute only against paths
beneath a configured workspace root, and only as part of an explicitly requested
workspace reset or an automatic reclamation that satisfies every condition in
"Unused workspaces are reclaimed". The system SHALL verify that a target path
lies beneath a configured workspace root before performing such an operation.

The system SHALL additionally verify that the target path is one the system
itself derives for a pull request under that workspace root. A path beneath a
workspace root that the system did not derive SHALL NOT be a target of any
destructive operation.

A checkout the system adopted rather than created SHALL NOT be a target of any
destructive operation, including an explicitly requested reset. Such a checkout
lies outside every configured workspace root and is not a path the system
derives, so the two verifications above already exclude it; this requirement
states the guarantee so that it cannot be lost.

Every destructive operation SHALL be recorded with its target and outcome,
including a refusal.

#### Scenario: Path outside workspace root is refused

- **WHEN** a workspace reset is requested for a path that does not lie beneath a
  configured workspace root
- **THEN** the operation is refused and recorded

#### Scenario: Unrecognized path beneath a workspace root is refused

- **WHEN** a destructive operation targets a path beneath a configured workspace
  root that is not a workspace path the system derives for a pull request
- **THEN** the operation is refused and recorded, and the path is left untouched

#### Scenario: Directories outside the workspace root are never candidates

- **WHEN** the operator keeps their own checkouts or worktrees outside the
  configured workspace roots
- **THEN** no reclamation or reset considers them, whatever their names

#### Scenario: An adopted checkout is never reset or reclaimed

- **WHEN** a reset or a reclamation sweep runs while an attempt has adopted an
  existing checkout the system did not create
- **THEN** that checkout is not a candidate, nothing in it is discarded, and a
  reset explicitly requested against it is refused and recorded

## ADDED Requirements

### Requirement: Unused workspaces are reclaimed

The system SHALL reclaim the disk occupied by a pull request workspace that is no
longer in use. A workspace SHALL be eligible for automatic reclamation only when
all of the following hold:

- it is a workspace path the system derives for a pull request beneath a
  configured workspace root;
- no job for that repository and pull request is in a non-terminal status;
- it contains no uncommitted or untracked changes;
- it has been inactive for at least a configured minimum age.

Reclamation SHALL succeed whether the workspace is a linked worktree or an
independent clone created by the fallback path, and SHALL leave the source
repository's worktree registry consistent afterwards.

Each reclamation and each refusal SHALL be recorded with its target and reason.

#### Scenario: Workspace for a finished pull request is reclaimed

- **WHEN** a workspace's pull request has no non-terminal job, the workspace is
  clean, and it has been inactive beyond the configured minimum age
- **THEN** the workspace is removed, the source repository's worktree registry is
  left consistent, and the reclamation is recorded

#### Scenario: Standalone fallback clone is reclaimed

- **WHEN** an eligible workspace is an independent clone rather than a linked
  worktree
- **THEN** it is reclaimed and the reclamation is recorded

#### Scenario: Active work is never reclaimed

- **WHEN** a job for a workspace's repository and pull request is queued, running,
  or otherwise non-terminal
- **THEN** that workspace is not reclaimed

#### Scenario: Recent workspace is retained

- **WHEN** an otherwise eligible workspace has been inactive for less than the
  configured minimum age
- **THEN** it is retained

### Requirement: Uncommitted work is never discarded by reclamation

Automatic reclamation SHALL NOT remove a workspace containing uncommitted or
untracked changes. Such a workspace SHALL be retained and reported so the
operator can inspect it and decide.

When eligibility cannot be determined, the workspace SHALL be retained.

#### Scenario: Dirty workspace is retained and reported

- **WHEN** an otherwise eligible workspace contains uncommitted changes
- **THEN** it is retained, it is reported as holding uncommitted work, and nothing
  is discarded

#### Scenario: Undeterminable state is retained

- **WHEN** the system cannot determine whether a workspace is clean or whether its
  pull request has active work
- **THEN** the workspace is retained and the indeterminate outcome is recorded

### Requirement: Reclamation can be previewed before it removes anything

The system SHALL offer a mode that reports which workspaces reclamation would
remove and why, without removing any of them.

#### Scenario: Operator previews reclamation

- **WHEN** an operator requests a reclamation preview
- **THEN** the eligible workspaces and the reason each is eligible or retained are
  reported, and no workspace is removed

### Requirement: Captured artifacts are retained under a bounded policy

The system SHALL bound the disk occupied by captured agent output, validation
artifacts, and per-attempt agent state through a configured retention policy.
Artifacts belonging to a job that is not in a terminal status SHALL NOT be
removed.

A job view whose captured artifacts have been removed under the retention policy
SHALL remain viewable, reporting the artifacts as no longer retained rather than
failing.

#### Scenario: Old artifacts are removed

- **WHEN** captured artifacts for terminal jobs exceed the configured retention
  policy
- **THEN** the excess artifacts are removed and the removal is recorded

#### Scenario: Artifacts of live jobs are retained

- **WHEN** the retention policy is applied while jobs are running
- **THEN** artifacts belonging to non-terminal jobs are retained

#### Scenario: Job remains viewable after its artifacts are removed

- **WHEN** an operator opens a job whose captured artifacts have been removed
- **THEN** the job's recorded detail is still presented and the missing artifacts
  are reported as no longer retained

### Requirement: A branch checked out elsewhere does not block a job

When the pull request's head branch is already checked out somewhere that
prevents a linked worktree from being created, the system SHALL resolve the
conflict rather than fail. Resolution SHALL proceed in this order:

1. Registrations whose directories no longer exist SHALL be pruned, since a stale
   registration holds a branch with no checkout behind it.
2. If the holder is the configured source repository, the workspace SHALL be an
   independent clone beneath the workspace root. The source repository SHALL NOT
   be adopted, switched, or otherwise mutated.
3. If the holder is any other checkout, and the repository has enabled adoption,
   and every adoption precondition holds, that checkout SHALL be adopted as the
   workspace for the attempt.
4. Otherwise the workspace SHALL be an independent clone beneath the workspace
   root.

The job SHALL fail with a reason identifying the held branch only when no
workspace of any shape can be produced.

The system SHALL record which outcome was taken and the path used, so that an
attempt which ran outside a workspace root is identifiable afterwards.

#### Scenario: Foreign worktree holds the branch and adoption is not enabled

- **WHEN** preparation finds the head branch held by a checkout that is neither
  the configured source repository nor the workspace path for the pull request,
  and the repository has not enabled adoption
- **THEN** an independent clone is created beneath the workspace root, the job
  proceeds, and the holding checkout is left untouched

#### Scenario: Stale registration does not block preparation

- **WHEN** the branch is held only by a registration whose directory no longer
  exists
- **THEN** the registration is pruned and an ordinary linked worktree is created

#### Scenario: Source repository holding the branch is never adopted

- **WHEN** the configured source repository itself has the head branch checked
  out and the repository has enabled adoption
- **THEN** an independent clone is created instead, and the source repository's
  working tree and checked-out branch are unchanged

#### Scenario: No workspace can be produced

- **WHEN** the branch is held elsewhere, adoption does not apply, and an
  independent clone cannot be created
- **THEN** the job fails with a reason identifying the held branch and naming the
  holding path

### Requirement: Adoption of an existing checkout is opt-in and conditional

Adopting a checkout the system did not create SHALL require the repository to
have opted in through configuration, and SHALL be disabled by default. Adoption
places an agent's edits in a directory outside every configured workspace root,
which is a deliberate departure from the isolation the system otherwise
guarantees, so it SHALL never be assumed.

Where adoption is enabled, the system SHALL adopt a holding checkout only when
all of the following hold:

- it has the pull request's head branch checked out and is not detached;
- it contains no uncommitted or untracked changes;
- it is not in a conflicted or unresolved merge state;
- it can reach the recorded pull request head by fast-forward.

A checkout that fails any precondition SHALL NOT be adopted, SHALL NOT be
modified in any way, and SHALL NOT have its contents discarded to make it
eligible. Preparation SHALL fall back to an independent clone instead.

Uncommitted changes in a holding checkout SHALL NOT be treated as retained edits
from an interrupted attempt. Resuming retained edits applies only to a workspace
this system created for a prior attempt of its own.

Each adoption and each refusal SHALL be recorded with the path and the deciding
condition.

#### Scenario: Clean holding worktree is adopted

- **WHEN** adoption is enabled and the holding checkout is clean, on the head
  branch, unconflicted, and fast-forwardable to the recorded head
- **THEN** it becomes the workspace for the attempt, it is brought to the
  recorded head, and the adoption is recorded with its path

#### Scenario: Dirty holding worktree is not adopted

- **WHEN** adoption is enabled and the holding checkout contains uncommitted or
  untracked changes
- **THEN** it is not adopted, nothing in it is modified or discarded, the refusal
  is recorded with its reason, and preparation falls back to an independent clone

#### Scenario: Another tool's edits are never resumed as retained work

- **WHEN** a retry that is permitted to resume retained edits prepares for a
  repository with adoption enabled, and the holding checkout is dirty
- **THEN** those edits are not resumed and the checkout is not adopted

#### Scenario: Adoption stays off unless configured

- **WHEN** a repository has not enabled adoption
- **THEN** no checkout outside a configured workspace root is adopted, whatever
  its state

### Requirement: An adopted checkout is claimed for the duration of an attempt

While an attempt is using an adopted checkout, the system SHALL publish a claim
that another tool operating in that checkout can discover, and SHALL release it
when the attempt ends, including when the attempt fails, times out, or is
cancelled.

The claim SHALL be stored outside the working tree, so that it neither appears as
an uncommitted change nor can be committed.

The system SHALL NOT adopt a checkout that already carries a live claim from
another attempt.

An adopted checkout SHALL be left on the branch it was adopted on, with the
attempt's work committed rather than left uncommitted.

The console SHALL identify an attempt running in an adopted checkout, and show
the path, so that work happening outside a workspace root is evident.

#### Scenario: Claim is visible and does not dirty the tree

- **WHEN** an attempt adopts a checkout
- **THEN** the claim is discoverable from within that checkout, and the checkout
  reports no uncommitted or untracked changes as a result of it

#### Scenario: Claim is released on every attempt outcome

- **WHEN** an attempt using an adopted checkout succeeds, fails, times out, or is
  cancelled
- **THEN** the claim is released

#### Scenario: A claimed checkout is not adopted twice

- **WHEN** preparation finds a holding checkout already carrying a live claim
- **THEN** it is not adopted and preparation falls back to an independent clone

#### Scenario: Adopted checkout is left tidy

- **WHEN** an attempt in an adopted checkout finishes
- **THEN** the checkout is still on the branch it was adopted on, the attempt's
  work is committed, and the checkout still exists

#### Scenario: Console identifies an adopted workspace

- **WHEN** an operator views an attempt that adopted an existing checkout
- **THEN** the attempt is shown as adopted, with the path it ran in
