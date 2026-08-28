# resolution-publication Specification

## Purpose
Independently judges whether an agent's work is fit to publish, commits and pushes
it when it is, and reports a concise outcome back to the pull request either way.

## Requirements

### Requirement: Agent success is not command success

The system SHALL evaluate the outcome of an attempt independently of the agent's
own report. A successful agent exit SHALL NOT by itself authorize publication.

#### Scenario: Agent reports success but changed nothing

- **WHEN** the agent exits successfully but the workspace has no modifications
- **THEN** nothing is committed or pushed, and the outcome records that no changes
  were made

#### Scenario: Agent reports success but validation fails

- **WHEN** the agent exits successfully and configured validation fails
- **THEN** nothing is pushed and the attempt is recorded as failed at validation

### Requirement: Independent workspace inspection

After the agent exits, the system SHALL inspect the workspace to determine whether
files were modified, whether the repository is in a valid state, whether the
expected branch is still checked out, and whether conflict markers or a conflicted
merge state are present.

#### Scenario: Branch changed during the run

- **WHEN** inspection finds a branch other than the pull request head branch
  checked out
- **THEN** the attempt fails with a specific reason and nothing is published

#### Scenario: Conflicted state after the run

- **WHEN** inspection finds the workspace in a conflicted state
- **THEN** the attempt fails with a specific reason and nothing is published

### Requirement: Repository-defined validation

The system SHALL run the validation commands configured for the repository in the
prepared workspace, recording each command's exit status, output, and duration. It
SHALL NOT substitute built-in or inferred commands when none are configured.

#### Scenario: Validation results recorded per command

- **WHEN** a repository configures multiple validation commands and one fails
- **THEN** each command's individual outcome is recorded, and the failing command
  is identifiable

### Requirement: Publication preconditions

The system SHALL publish results only when all of the following hold. If any fails,
nothing SHALL be committed or pushed.

- The agent exited successfully.
- The workspace contains modifications.
- Workspace inspection found no inconsistent state.
- All configured validation commands succeeded.
- The pull request head commit is unchanged from workspace preparation.
- The pull request is still open.

#### Scenario: Any precondition failure blocks publication

- **WHEN** any publication precondition is not satisfied
- **THEN** no commit is pushed and the recorded outcome names the precondition that
  failed

### Requirement: Commit and push policy

When publication proceeds, the system SHALL create a commit in the workspace with a
deterministic, attributable message that references the originating review comment,
and SHALL push it to the existing pull request head branch. The resulting commit
identifier SHALL be recorded.

The system SHALL NOT force-push, SHALL NOT rewrite existing history, SHALL NOT
create or delete branches, and SHALL NOT merge the pull request.

Commit author name and email SHALL come from explicit configuration independently
of both the dedicated GitHub API identity and the Git transport credentials used
to push. This SHALL permit published commits to be attributed to a configured
human whose email is verified by GitHub.

#### Scenario: Successful publication

- **WHEN** all publication preconditions hold
- **THEN** a commit is created and pushed to the pull request head branch and its
  identifier is recorded on the attempt

#### Scenario: Human attribution with bot publication

- **WHEN** the orchestrator uses a dedicated bot for GitHub API operations and the
  commit author is configured as a human developer
- **THEN** the commit records the configured human name and email while the bot
  remains the identity that polls and reports through the GitHub API

#### Scenario: Push rejected

- **WHEN** the push is rejected by the remote
- **THEN** the attempt fails with a reason identifying the rejection, no history is
  rewritten, and no force-push is attempted

#### Scenario: Pull request is never merged

- **WHEN** an attempt succeeds
- **THEN** the pull request remains unmerged

### Requirement: Outcome reported to GitHub

The system SHALL post a reply to the originating review thread describing the
outcome. The reply SHALL be concise and SHALL distinguish at minimum: a successful
resolution, a failed attempt, and an attempt where the agent judged the feedback
should not be implemented.

A success reply SHALL include the commit identifier, a summary of what changed, and
the validation outcome. A failure reply SHALL identify the stage at which the
attempt failed, give the reason, and state that no changes were pushed.

The reply SHALL NOT contain raw agent transcripts, and SHALL NOT contain
credentials or secret values.

#### Scenario: Successful attempt reported

- **WHEN** an attempt publishes a commit
- **THEN** the reply names the commit, summarizes the change, and reports
  validation results

#### Scenario: Failed attempt reported

- **WHEN** an attempt fails
- **THEN** the reply names the failing stage and reason and states that nothing was
  pushed

#### Scenario: Agent declined the feedback

- **WHEN** the agent concluded the feedback should not be implemented
- **THEN** the reply conveys that no change was pushed and gives the agent's stated
  reason, referencing the local job for full detail

#### Scenario: Transcripts stay local

- **WHEN** an attempt produces extensive agent output
- **THEN** the GitHub reply does not include it and the full output remains
  available locally

### Requirement: Review thread state is not modified

The system SHALL NOT mark a review thread resolved. Publishing a fix and replying
SHALL be the full extent of its interaction with thread state.

#### Scenario: Thread remains unresolved after a successful fix

- **WHEN** an attempt successfully publishes a fix
- **THEN** the review thread's resolution state is unchanged and remains for a
  human to decide

### Requirement: Reporting failure does not corrupt job state

If posting the GitHub reply fails, the system SHALL record the reporting failure
separately from the resolution outcome, and SHALL NOT retract, revert, or re-push
work that was already published.

#### Scenario: Comment posting fails after a successful push

- **WHEN** the commit is pushed but the reply cannot be posted
- **THEN** the job records the push as successful and reporting as failed, and the
  commit is not reverted
