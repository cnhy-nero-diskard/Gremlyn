## Why

OpenCode can run primary agents that delegate work to subagents, but Gremlyn's browser console exposes only the repository's OpenCode model and effort. Operators cannot see or configure the agent team that will handle an authorized PR review request, and relying on external OpenCode files makes the effective behavior hard to audit.

## What Changes

- Add an OpenCode-only, per-repository agent configuration editor in Gremlyn's browser console. Operators can select the primary agent and create, edit, enable, disable, or remove named subagents with a purpose, instructions, optional model and step limit, and tool permissions.
- Show which subagents the primary agent may invoke. Save the reviewed configuration durably with repository-local feedback, conflict handling, and an operator action record. New jobs capture the selected configuration; editing it does not alter work already queued or running.
- Apply the saved configuration to each OpenCode attempt using the pinned OpenCode V2 agent format and select the primary agent for `opencode run`. Gremlyn remains responsible for the prepared workspace, timeout, validation, publication, and cancellation.
- Keep generated OpenCode configuration out of the developer's source checkout and published PR diff. Account for foreground and background child sessions before an attempt can validate or publish.
- Preserve existing behavior for repositories without a dashboard-managed profile and for non-OpenCode executors.

## Capabilities

### New Capabilities

- `opencode-agent-profiles`: Durable per-repository OpenCode primary and subagent configuration, effective run behavior, and child-session containment.

### Modified Capabilities

- `operator-console`: Configure and inspect OpenCode agent profiles in the authenticated repository settings UI.
- `repository-registry`: Preserve the operator's profile across restarts and capture the effective profile for each new job.
- `agent-execution`: Pass executor-specific agent selection and prevent delegated work from racing independent validation or publication.

## Impact

- OpenCode executor and attempt lifecycle, repository persistence and migrations, job configuration snapshots, operator actions, console queries/routes/views/client behavior, and configuration documentation.
- The editor belongs with repository settings. The active `stage-repository-settings-edits` and `separate-console-monitoring-and-configuration` changes own the generic staged editor and the future `/repositories` route; this change adds OpenCode controls to that surface without reimplementing their workflows.
- OpenCode 2.0.16 is the current executor pin. Its V2 `agents`, ordered `permissions`, and `subagent` action differ from V1 configuration, so this change uses the V2 contract.
