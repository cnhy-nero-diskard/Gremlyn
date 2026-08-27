## Purpose

Reconstructs the review feedback a command refers to, turns it into a bounded
resolution prompt, and runs the configured coding agent behind a replaceable
executor that the orchestrator controls.

## ADDED Requirements

### Requirement: Review context reconstruction

Before invoking the agent, the system SHALL gather the context needed to make the
feedback actionable. It SHALL include the repository, pull request number and
title, head branch, head commit, the triggering comment, the review thread the
comment belongs to, the file path the thread is anchored to, and the associated
line or diff hunk.

The system SHALL NOT include the full repository metadata or the complete pull
request diff when a narrower excerpt conveys the feedback, since the agent can
inspect the checked-out workspace directly.

#### Scenario: Thread context assembled

- **WHEN** a command is issued on a review thread with several comments
- **THEN** the assembled context includes the whole thread in order, the anchored
  file path, and the relevant diff hunk

#### Scenario: Context is bounded

- **WHEN** the pull request has a very large diff
- **THEN** the assembled context does not include the entire diff

### Requirement: Replaceable executor abstraction

Agent invocation SHALL occur behind an executor interface that receives the working
directory, model, prompt, execution options, environment, and a cancellation
signal. Adding or substituting an executor SHALL NOT require changes to the job
lifecycle, workspace management, validation, or reporting.

The system SHALL provide an executor for the configured coding agent CLI and a
fake executor usable in tests.

#### Scenario: Substituting an executor

- **WHEN** the configured agent for a repository is changed to a different
  registered executor
- **THEN** job orchestration, workspace handling, validation, and reporting behave
  identically

#### Scenario: Fake executor simulates outcomes

- **WHEN** tests configure the fake executor
- **THEN** it can simulate successful resolution, agent failure, timeout, no
  changes made, files modified, and validation failure

### Requirement: Structured process invocation

The system SHALL launch agent processes using an argument vector rather than a
concatenated shell command string. The prompt SHALL be passed as a discrete
argument or via a non-shell channel.

The system SHALL only invoke non-interactive agent operations, and SHALL NOT invoke
agent subcommands that require a terminal.

#### Scenario: Prompt containing shell syntax

- **WHEN** the reconstructed context contains quotes, newlines, or shell
  metacharacters
- **THEN** the agent receives the text intact and no shell interpretation occurs

#### Scenario: Non-interactive execution

- **WHEN** the agent is invoked with no terminal attached
- **THEN** execution proceeds without prompting and terminates on its own

### Requirement: Orchestrator owns the working directory

The system SHALL pass the workspace path prepared for the job as the agent's
working directory, and SHALL NOT delegate workspace or checkout selection to the
agent, including through agent features that create their own worktrees.

#### Scenario: Agent worktree feature not used

- **WHEN** the agent offers to create its own isolated checkout
- **THEN** that feature is not used, and the agent runs in the workspace the
  orchestrator prepared

### Requirement: Isolated agent state per attempt

Each attempt SHALL run with agent state isolated from other concurrent attempts, so
that simultaneous runs do not share or corrupt mutable agent state.

#### Scenario: Concurrent attempts do not interfere

- **WHEN** two attempts for different pull requests run at the same time
- **THEN** neither attempt observes or overwrites the other's agent session state

### Requirement: Bounded execution

Every agent invocation SHALL have a configured maximum duration and a bounded
retry allowance. On exceeding the duration the system SHALL terminate the agent
process and fail the attempt with a timeout reason.

Work left in the workspace by a timed-out agent SHALL be preserved for inspection
and SHALL NOT be committed or pushed.

#### Scenario: Agent exceeds its time limit

- **WHEN** an agent invocation runs longer than the configured maximum
- **THEN** the process is terminated, the attempt fails with a timeout reason, and
  nothing is published

### Requirement: Captured execution result

The system SHALL capture, for every invocation, the standard output, standard
error, exit status, start and end times, and structured output when the agent
provides it. Captured output SHALL be retained and associated with the attempt.

#### Scenario: Output retained after failure

- **WHEN** an agent invocation exits non-zero
- **THEN** its output, error stream, and exit status are retained and viewable for
  that attempt

### Requirement: Resolution prompt content

The generated prompt SHALL instruct the agent to inspect the surrounding
implementation before modifying code, to make the smallest correct change
consistent with existing conventions, to leave unrelated functionality alone, to
avoid merging the pull request, to run relevant validation for the affected area,
and to report what it changed, which files it touched, what validation it
performed, and whether it considers the feedback resolved.

The prompt SHALL instruct the agent that where feedback is incorrect, obsolete,
ambiguous, or cannot be implemented safely, it must explain the problem rather than
invent a change.

Repository-specific instructions from the registry SHALL be appended when present.

#### Scenario: Prompt discourages unrelated change

- **WHEN** a resolution prompt is generated
- **THEN** it constrains the agent to the smallest correct change and forbids
  altering unrelated functionality

#### Scenario: Agent declines unsound feedback

- **WHEN** the agent determines the feedback should not be implemented
- **THEN** its explanation is captured and the attempt does not publish a change

### Requirement: Secrets are withheld from the agent

The system SHALL NOT expose orchestrator credentials to the agent process
environment, and SHALL NOT include credentials in the prompt.

#### Scenario: Agent environment excludes orchestrator token

- **WHEN** an agent process is launched
- **THEN** its environment does not contain the orchestrator's GitHub credential
