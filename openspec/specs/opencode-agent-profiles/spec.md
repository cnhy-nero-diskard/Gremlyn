# opencode-agent-profiles Specification

## Purpose

Defines how an operator's saved OpenCode primary and subagent configuration becomes a bounded, auditable agent team for one managed repository and its resolution jobs.

## Requirements

### Requirement: OpenCode profiles are optional and repository scoped

Each managed repository using the OpenCode executor SHALL be able to carry an optional dashboard-managed agent profile. A profile SHALL identify the primary agent and an ordered set of named subagents; each subagent SHALL have a description, optional instructions, optional model and step limit, enabled state, and explicit tool permissions. An omitted subagent model SHALL inherit the primary session model. The primary session model SHALL remain the repository's selected model.

#### Scenario: A configured profile selects an agent team

- **WHEN** an OpenCode job is created for a repository with a saved profile
- **THEN** that job records the selected primary agent and the enabled subagent definitions for its own attempts

#### Scenario: A child inherits the selected model

- **WHEN** an enabled subagent has no model override
- **THEN** OpenCode runs it with the primary session's model

#### Scenario: A repository has no dashboard profile

- **WHEN** an OpenCode repository has no saved dashboard-managed profile
- **THEN** Gremlyn launches it with its existing OpenCode behavior and does not synthesize an agent team

### Requirement: Profile validation prevents ambiguous or unsupported runs

The system SHALL reject duplicate or unsafe agent identifiers, missing subagent descriptions, malformed model identifiers, non-positive step limits, and unsupported permission values without changing the saved profile. A saved profile SHALL be checked against the effective OpenCode V2 agent configuration before agent work begins. An unavailable selected primary agent or a profile that cannot be applied SHALL fail the attempt with a configuration reason before agent edits or publication.

#### Scenario: Invalid profile edit is rejected

- **WHEN** an operator submits two subagents with the same identifier or a non-positive step limit
- **THEN** the save fails with a field-specific error and the previous profile remains active

#### Scenario: Effective primary agent is unavailable

- **WHEN** an attempt cannot resolve its saved primary agent in OpenCode
- **THEN** the attempt fails before agent work and no changes are validated or published

### Requirement: Dashboard-managed delegation is explicit

For an active dashboard-managed profile, the primary agent SHALL be allowed to invoke only enabled subagents named in that profile. Disabled and unrelated OpenCode subagents SHALL not be invocable through the managed primary. Each child SHALL receive its own configured permissions; nested child delegation SHALL be denied unless a later change explicitly adds it.

#### Scenario: Enabled subagent is callable

- **WHEN** the managed primary invokes an enabled named subagent
- **THEN** OpenCode starts that child with its configured instructions, model choice, and permissions

#### Scenario: Disabled or unrelated subagent is blocked

- **WHEN** the managed primary requests a disabled or unlisted subagent
- **THEN** the request is denied and that child does not run

### Requirement: Managed OpenCode configuration stays out of source and publication

Gremlyn SHALL apply a saved profile only inside the job's isolated attempt context. Its profile materialization and cleanup SHALL NOT change the developer's source checkout, overwrite tracked OpenCode configuration in the pull request, or include generated profile files in validation input or a published commit. Agent edits to tracked OpenCode files SHALL remain ordinary workspace changes subject to independent validation. A failed, cancelled, or interrupted attempt SHALL leave recoverable evidence without leaving generated profile content in a later run's effective configuration.

#### Scenario: Generated configuration is removed before validation

- **WHEN** an attempt using a dashboard-managed profile finishes agent work
- **THEN** generated configuration is removed or restored before the workspace is validated or committed

#### Scenario: Existing project configuration is preserved

- **WHEN** the pull request already contains OpenCode configuration files
- **THEN** Gremlyn's profile materialization and cleanup preserve their bytes unless the agent itself edits them
