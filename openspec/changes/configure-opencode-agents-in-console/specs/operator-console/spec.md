## ADDED Requirements

### Requirement: Operators configure OpenCode agents in repository settings

The authenticated console SHALL offer a repository-scoped OpenCode agent editor reachable from the dashboard. It SHALL show the active primary agent, each configured subagent and whether it is callable, model inheritance or override, and tool access in plain language. It SHALL let the operator select the primary agent and create, edit, enable, disable, or remove subagents, including their descriptions, instructions, model overrides, step limits, and supported permissions. The editor SHALL be absent for repositories using another executor.

#### Scenario: OpenCode repository is configurable from the browser

- **WHEN** an operator opens settings for an OpenCode repository
- **THEN** the console shows the effective profile and controls to edit it without requiring manual OpenCode file edits

#### Scenario: Another executor has no OpenCode controls

- **WHEN** an operator opens settings for a Cline repository
- **THEN** the console does not offer OpenCode primary or subagent controls

#### Scenario: Model inheritance is explained

- **WHEN** a subagent has no model override
- **THEN** the editor identifies that it will use the repository's selected OpenCode model

### Requirement: Agent profile edits are reviewed and conflict safe

The console SHALL keep agent profile edits in a repository-local draft until the operator applies them. Apply SHALL present the changed primary agent and subagent definitions for review, validate the entire profile, save it atomically, and record one operator action without logging full instruction text. Cancel SHALL discard only the draft. If another writer changes the profile after editing began, the console SHALL preserve the unsaved draft and show a conflict before any overwrite. Live updates SHALL preserve a draft in progress.

#### Scenario: Apply a valid profile

- **WHEN** an operator reviews and applies a valid changed profile
- **THEN** the saved profile changes atomically, repository-local feedback confirms it, and the console states that only later-created jobs use it

#### Scenario: Cancel an edit

- **WHEN** an operator cancels a profile draft
- **THEN** the persisted profile remains unchanged and the draft is discarded

#### Scenario: Another session changes the profile

- **WHEN** an operator tries to apply a draft whose saved baseline has changed
- **THEN** the console reports the conflict, keeps the draft, and does not overwrite the newer profile

#### Scenario: Live refresh during an edit

- **WHEN** a live repository update arrives while the operator edits a profile
- **THEN** the draft remains intact and the displayed persisted value remains accurate

### Requirement: Agent profile errors are actionable

The console SHALL identify invalid agent names, missing descriptions, malformed model IDs, invalid limits, and unsupported permissions beside the relevant control. An unavailable OpenCode primary or subagent discovered at execution time SHALL appear in the affected job's diagnostics with a specific configuration reason.

#### Scenario: Invalid subagent model

- **WHEN** an operator enters a model ID outside OpenCode's accepted provider/model format
- **THEN** the editor identifies that subagent's model field and refuses to save the draft
