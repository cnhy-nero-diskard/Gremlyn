## ADDED Requirements

### Requirement: Executor-specific primary agent selection

The executor invocation contract SHALL allow an OpenCode attempt to carry its captured primary agent selection and profile without changing how another executor receives its existing options. The OpenCode executor SHALL select the captured primary agent in its non-interactive run. If the selected agent or generated configuration cannot be applied, the attempt SHALL fail with a distinct configuration reason and SHALL NOT fall back silently to another agent.

#### Scenario: OpenCode selects the captured primary

- **WHEN** a job with a dashboard-managed OpenCode profile starts
- **THEN** the OpenCode invocation uses that job's captured primary agent and effective definitions

#### Scenario: Another executor retains its contract

- **WHEN** a Cline repository runs
- **THEN** it receives its existing model, effort, prompt, environment, and cancellation behavior without OpenCode-specific arguments or configuration

### Requirement: Delegated work is quiescent before independent validation

An OpenCode attempt SHALL include its foreground and background child sessions within the attempt's timeout and cancellation boundary. Gremlyn SHALL not validate, commit, push, or report success while a child associated with the attempt can still modify its workspace. If a child cannot be confirmed complete or cancelled, the attempt SHALL fail without publication and preserve diagnostic evidence.

#### Scenario: Background child is still running

- **WHEN** the primary session finishes while one of its child sessions remains active
- **THEN** validation waits until the child finishes or is cancelled within the attempt boundary

#### Scenario: Child remains active after cancellation

- **WHEN** Gremlyn cannot confirm that a cancelled child has stopped
- **THEN** the attempt fails, no validation or publication occurs, and the unresolved child is recorded in diagnostics

#### Scenario: Timeout applies to delegated work

- **WHEN** the configured agent timeout expires while a child session is running
- **THEN** the child is cancelled with the attempt and no workspace changes are published
