## MODIFIED Requirements

### Requirement: Publication preconditions

The system SHALL publish results only when all of the following hold. If any fails, nothing SHALL be committed or pushed, except that a moved pull request head SHALL enter the resilient-push loop instead of blocking immediately.

- The agent exited successfully.
- The workspace contains modifications.
- Workspace inspection found no inconsistent state.
- All configured validation commands succeeded.
- The pull request head commit is unchanged from workspace preparation, or the resilient-push loop reconciles it within its retry bound.
- The pull request is still open.

#### Scenario: Any precondition failure blocks publication

- **WHEN** any publication precondition is not satisfied
- **THEN** no commit is pushed and the recorded outcome names the precondition that failed

#### Scenario: Moved head enters recovery instead of blocking

- **WHEN** the pull request head commit differs from workspace preparation but the pull request is still open
- **THEN** the system enters the resilient-push loop (fetch, merge remote in, re-validate, retry push) instead of recording `head-changed`, and records `head-changed` only if recovery exhausts its retry bound

### Requirement: Commit and push policy

When publication proceeds, the system SHALL create a commit in the workspace with a deterministic, attributable message that references the originating review comment, and SHALL push it to the existing pull request head branch. The resulting commit identifier SHALL be recorded.

The system SHALL NOT force-push, SHALL NOT rewrite already-pushed history, SHALL NOT create or delete branches, and SHALL NOT merge the pull request. Integrating the moved remote head by merging it into the workspace (a local merge commit that is then pushed normally) is permitted and SHALL NOT count as merging the pull request.

Commit author name and email SHALL come from explicit configuration independently of both the dedicated GitHub API identity and the Git transport credentials used to push. This SHALL permit published commits to be attributed to a configured human whose email is verified by GitHub.

#### Scenario: Successful publication

- **WHEN** all publication preconditions hold
- **THEN** a commit is created and pushed to the pull request head branch and its identifier is recorded on the attempt

#### Scenario: Human attribution with bot publication

- **WHEN** the orchestrator uses a dedicated bot for GitHub API operations and the commit author is configured as a human developer
- **THEN** the commit records the configured human name and email while the bot remains the identity that polls and reports through the GitHub API

#### Scenario: Push rejected

- **WHEN** the push is rejected by the remote as non-fast-forward
- **THEN** the system enters the resilient-push loop instead of failing immediately, and fails with a reason identifying the rejection only if recovery exhausts its retry bound; no history is rewritten and no force-push is attempted at any point

#### Scenario: Pull request is never merged

- **WHEN** an attempt succeeds
- **THEN** the pull request remains unmerged

## ADDED Requirements

### Requirement: Resilient push on moved head

The system SHALL attempt recovery when the pull request head moved or the push was rejected as non-fast-forward. Recovery SHALL fetch the current remote head, merge it into the workspace, re-run workspace inspection and all configured validation commands, and retry the push. The loop SHALL be bounded to 3 push attempts total (the initial push plus 2 retries). Cancellation SHALL be observed before each merge, each re-validation, and each retry push, and a cancel SHALL remain distinguishable from a publication block.

#### Scenario: Clean merge recovers without the agent

- **WHEN** the remote head moved and merges cleanly into the workspace
- **THEN** the system re-validates, retries the push, and records the recovery with the new head identifier

#### Scenario: Retry bound exhausted

- **WHEN** every push attempt in the bound fails with a moved head or a rejection
- **THEN** the attempt fails with `head-changed` or `push-rejected`, no history is rewritten, and no force-push is attempted

#### Scenario: Cancel during recovery stops recovery

- **WHEN** the operator cancels while recovery is merging, re-validating, or about to retry the push
- **THEN** recovery stops at the next boundary between operations and the attempt is recorded as cancelled rather than as a blocked publication

### Requirement: Agent resolves merge conflicts

When the resilient-push merge leaves the workspace conflicted, the system SHALL keep the attempt's agent context available and re-invoke the same attempt's agent with conflict context (the list of unmerged files and conflicting hunks) to resolve the conflicts while preserving both the agent's fix intent and the remote changes. The system SHALL then re-run workspace inspection and all configured validation commands before retrying the push, within the same retry bound.

#### Scenario: Agent resolves conflicts and push succeeds

- **WHEN** the merge conflicts and the re-invoked agent resolves them with validation passing
- **THEN** the system commits the resolution, retries the push, and records the agent-assisted recovery

#### Scenario: Agent cannot resolve within the bound

- **WHEN** conflicts remain or validation keeps failing through the final retry
- **THEN** the attempt fails with `push-rejected` or `head-changed`, the conflicted state is preserved for inspection, and nothing is force-pushed
