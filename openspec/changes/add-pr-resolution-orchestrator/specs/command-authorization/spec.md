## Purpose

Decides whether a detected command is permitted to execute at all, and defines how
GitHub-supplied text is treated everywhere it crosses into local execution.

## ADDED Requirements

### Requirement: Author allowlist

The system SHALL execute a command only when the command comment's author appears
in a configured allowlist of GitHub logins. Comparison SHALL be case-insensitive
and SHALL match the login, not the display name.

An unauthorized command SHALL NOT create a job, prepare a workspace, or invoke an
agent.

#### Scenario: Authorized author

- **WHEN** an allowlisted user issues `!RESOLVE` on an eligible review thread
- **THEN** authorization succeeds and a job is created

#### Scenario: Unauthorized author

- **WHEN** a user absent from the allowlist issues `!RESOLVE`
- **THEN** no job is created, no local operation occurs, and the event is recorded
  as unauthorized with the attempted login

#### Scenario: Display name spoofing

- **WHEN** an unauthorized user sets their display name to match an allowlisted
  user's display name and issues a command
- **THEN** authorization fails, because matching is performed on the login

### Requirement: Orchestrator identity is not self-authorizing

The identity the orchestrator uses to author its own GitHub comments SHALL NOT
appear in the author allowlist. Commands whose author is the orchestrator's own
identity SHALL be ignored.

#### Scenario: Orchestrator comment contains a command token

- **WHEN** a comment authored by the orchestrator's identity contains a command
  token at the start of a line
- **THEN** the command is ignored and no job is created

### Requirement: Complete precondition set

Before a command executes, the system SHALL verify all of the following. Failure of
any check SHALL prevent execution and SHALL be recorded with the specific failing
reason.

- The repository is present in the registry.
- The repository is enabled.
- The pull request belongs to the repository the event was observed in.
- The pull request is open.
- The pull request's head branch resides in the same repository as its base.
- The command is registered and eligible for its placement.
- The command occurrence has not already been processed.

#### Scenario: Closed pull request

- **WHEN** a command is issued on a pull request that is closed or merged
- **THEN** no job is created and the recorded reason identifies the pull request
  state

#### Scenario: Fork pull request

- **WHEN** a command is issued on a pull request whose head branch resides in a
  fork rather than the base repository
- **THEN** no job is created, a reply explains that fork pull requests are not
  supported, and the recorded reason is `fork-pull-request`

#### Scenario: Failure reason is specific

- **WHEN** any precondition fails
- **THEN** the recorded reason names the specific failing check rather than a
  generic failure

### Requirement: GitHub text is untrusted input

The system SHALL treat all GitHub-supplied text — comment bodies, pull request
titles and bodies, branch names, file paths, and author-controlled metadata — as
untrusted.

Untrusted text SHALL NOT be interpolated into shell command strings, used to
construct filesystem paths, used to select a repository or model, or used to derive
any argument to a git or agent process other than as opaque prompt content.

#### Scenario: Shell metacharacters in comment

- **WHEN** a comment body contains shell metacharacters, newlines, or command
  substitution syntax
- **THEN** the text reaches the agent only as prompt content, and no process is
  spawned via a concatenated shell string

#### Scenario: Path traversal in branch name

- **WHEN** a pull request branch name contains path traversal sequences
- **THEN** the worktree path is derived from registry configuration and the pull
  request number, not from the branch name

### Requirement: Command arguments are validated against configuration

Where a command accepts arguments, the system SHALL validate each argument against
values permitted by configuration. Arguments naming an agent, model, or path SHALL
be rejected unless they match a configured allowed value.

#### Scenario: Model override outside allowlist

- **WHEN** a command supplies a model argument that is not among the repository's
  configured allowed models
- **THEN** the command is rejected and no agent is invoked

### Requirement: Auditability of every command

The system SHALL record, for each command occurrence, the GitHub login, repository,
pull request number, comment identifier, command name, timestamp, authorization
outcome, and — when executed — the resulting job identifier.

#### Scenario: Tracing an executed command

- **WHEN** an operator inspects any completed job
- **THEN** the originating user, repository, pull request, comment, and time are
  recoverable from persisted records

#### Scenario: Tracing a rejected command

- **WHEN** a command is rejected for any reason
- **THEN** the rejection is persisted with the same identifying fields and the
  rejection reason
