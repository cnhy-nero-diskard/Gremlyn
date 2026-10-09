## MODIFIED Requirements

### Requirement: OpenCode profiles are optional and repository scoped

Each managed repository using the OpenCode executor SHALL be able to carry an optional dashboard-managed agent profile. A profile SHALL identify the primary agent and an ordered set of named subagents; each subagent SHALL have a description, optional instructions, optional model and step limit, enabled state, and explicit tool permissions. An omitted subagent model SHALL inherit the primary session model. The primary session model SHALL remain the repository's selected model. The profile SHALL control execution only when the job captured managed-team source; native/default selection SHALL neither materialize a dormant profile nor bypass an active profile's generated primary through a competing selector. Source changes SHALL require deliberate activation and SHALL retain dormant profile definitions.

#### Scenario: A configured profile selects an agent team

- **WHEN** an OpenCode job is created for a repository whose primary source selects a saved managed profile
- **THEN** that job records the selected primary agent and the enabled subagent definitions for its own attempts

#### Scenario: A child inherits the selected model

- **WHEN** an enabled subagent has no model override
- **THEN** OpenCode runs it with the primary session's model

#### Scenario: A repository has no dashboard profile

- **WHEN** an OpenCode repository has no saved dashboard-managed profile
- **THEN** Gremlyn follows its explicit native or default source without synthesizing an agent team

#### Scenario: Managed team has no competing native override

- **WHEN** a job captures managed-team source and its repository retains a dormant native ID
- **THEN** only its generated managed primary is selected and existing managed subagent permission checks remain enforced

#### Scenario: Editing a dormant profile does not activate it

- **WHEN** an operator saves changes to a dormant profile while native or default source is selected
- **THEN** the definition is retained for future deliberate activation and new jobs keep the current non-managed source
