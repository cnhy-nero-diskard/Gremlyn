## Context

See `proposal.md` for motivation. Gremlyn currently persists provider, model, effort, and timeout per repository, then runs the pinned OpenCode 2.0.16 CLI from an isolated PR worktree. Its argv has `-m` and `--auto`, but no `--agent` or managed agent definitions. The console is server-rendered Fastify HTML with framework-free client behavior; repository settings are presently on the dashboard. Two active sibling changes plan a staged editor and a dedicated `/repositories` configuration route.

The pinned OpenCode V2 contract is materially different from V1: named agents live under `agents` or `.opencode/agents/`, child access uses ordered `permissions` with action `subagent`, and child sessions can run in the background. OpenCode [discovers nested agent files from the current project](https://opencode.ai/v2/docs/agents), and its [config order](https://opencode.ai/v2/docs/config) makes project files relevant to every run. The `run` command [accepts `--agent`](https://opencode.ai/v2/docs/cli/commands/).

## Goals / Non-Goals

**Goals:**

- Make the browser console the source of truth for one active primary agent and its allowed subagents per OpenCode repository.
- Keep the existing repository model picker authoritative for the primary session; child models may inherit or override it.
- Make an attempt's profile reproducible, visible by revision, and contained within its existing workspace, timeout, validation, and publication gates.
- Preserve exact source bytes and avoid generated agent files in any published diff.

**Non-Goals:**

- A general OpenCode JSONC editor, plugin manager, MCP editor, or hosted agent service.
- Nested subagent delegation, multiple active primary agents for one repository, or a new Gremlyn scheduler for child agents.
- Editing Gremlyn's normal source checkout or storing provider credentials in the profile.

## Decisions

### D1: Store one versioned managed profile per OpenCode repository

Add a nullable, versioned profile row keyed by repository id, with an integer revision and canonical JSON. Version 1 contains one named primary definition and an ordered list of subagents. The primary carries an id, description, optional instructions and step limit, and supported tool permissions. Each child carries those fields plus an enabled flag and optional `provider/model[#variant]` override. A missing profile means the existing OpenCode invocation, including its normal project/global configuration, is used. Existing repositories therefore do not change behavior merely by migrating.

The console saves a whole profile through a compare-and-set mutation against its revision. IDs are unique, case-insensitive within the profile, and restricted to a safe single path segment; descriptions are required for children. Instructions and model IDs are validated as data, never interpolated into a shell command. The supported permission controls are workspace edit, shell, web access, and skill loading; external-directory access is explicitly denied for managed children. Children default to read-only. A managed child cannot spawn grandchildren. The active primary's model comes from the existing repository selection; an unspecified child model inherits it.

This uses a typed Gremlyn profile instead of exposing every OpenCode config field. The operator can manage the behavior requested here from the dashboard while Gremlyn can validate and display it reliably. OpenCode's general configuration files remain available for unrelated use.

### D2: Capture the profile in the same transaction that creates a job

Add a nullable profile snapshot and revision to the job record. The job-creation transaction reads the current repository profile and copies its canonical JSON, so a concurrent dashboard save cannot split one job between revisions. All attempts and retries for that job use its snapshot. A fresh job after a save uses the new revision. The existing configuration-file repository upsert does not update this table, matching the established operator-selection precedence for provider/model/effort.

The console and job detail show a short primary name, child count, and revision. The operator-action record stores those identifiers and the action outcome, not full instructions. If repository file configuration later switches the executor away from OpenCode, the saved profile is dormant and cannot be edited or launched until the repository is OpenCode again; it is not silently translated into another executor's options.

### D3: Materialize V2 agent files only in the disposable attempt worktree

For a job with a managed profile, generate V2 Markdown agent definitions beneath a unique, attempt-owned directory inside the prepared worktree's `.opencode/agents/`. Nested paths give each generated agent a unique runtime id, avoiding collisions with repository or global agent definitions. The primary file has `mode: primary`; children have `mode: subagent`. Its permissions deny all subagent targets and then allow only enabled generated children. Each child gets explicit tool rules and a final `subagent` deny. The executor passes the generated primary id with `--agent` while continuing to pass the repository's model through `-m`.

This uses OpenCode's project discovery rather than relying on V1 config environment variables, whose V2 behavior is not documented for the pinned CLI. A preflight under the same cwd and environment confirms the generated primary and children are effective before `run`; an absent or mismatched definition fails the attempt rather than allowing OpenCode to fall back to `build`. The first implementation task probes the pinned CLI's reliable agent inventory and config-load behavior before wiring it into production.

The generated directory is recorded in an attempt manifest outside the worktree. Creation refuses an existing path, writes atomically, and never overwrites tracked files. After every normal result or cancellation, Gremlyn first settles child sessions, then removes only its manifest-listed files and checks that the workspace matches its pre-generation state for those paths. Cleanup runs before validation and publication. Startup recovery removes a stale generated directory only after its owner attempt is known inactive; a workspace with uncertain child activity is quarantined from reuse and publication.

### D4: Keep child sessions inside the attempt boundary

OpenCode V2's [subagent tool](https://opencode.ai/v2/docs/tools/) allows foreground and background children. The parent CLI exiting does not by itself prove that background work has stopped. Record the parent session id and child session ids, then use the pinned OpenCode session surface to check completion and interrupt remaining children on cancellation or timeout. The implementation probe must establish a reliable status and interrupt route for 2.0.16; if it cannot, managed delegation fails closed before validation. A child that cannot be confirmed stopped leaves a failed, quarantined attempt and diagnostic evidence. The existing configured timeout covers parent plus child settlement, and Gremlyn's independent validation begins only after quiescence and generated-file cleanup.

This retains OpenCode as the delegation scheduler. Gremlyn manages the publication boundary rather than scheduling child prompts itself.

### D5: Add a repository-local editor without duplicating sibling UI work

The OpenCode section shows the active primary, callable children, each child's purpose, inherited or explicit model, and permission summary. Edit mode supports adding, editing, enabling, disabling, and removing children, and changing the primary definition. Review shows the changed names, models, and permissions; Apply saves atomically; Cancel discards the draft. Field errors and save feedback stay in the repository section. Live updates update the persisted snapshot and preserve drafts, following `stage-repository-settings-edits`' reconciliation pattern.

Implement this in the full repository settings surface: today's dashboard card, or `/repositories` once `separate-console-monitoring-and-configuration` lands. The dashboard retains a concise profile summary and direct Configure link after that move. The agent-profile draft is separate from the provider/model/effort/timeout draft so changing one never submits the other. Reuse existing session protection, HTML escaping, redaction, and operator-action logging.

## Risks / Trade-offs

- **V2 agent discovery or inventory differs from documentation** -> Probe `opencode 2.0.16` before implementation, pin the observed contract, and refuse managed runs if the generated agents cannot be verified.
- **A background child can write after the parent returns** -> Track and settle child sessions before cleanup, validation, and publication; failure to prove quiescence fails the attempt.
- **An agent edits its own generated file** -> Compare manifest-owned paths before cleanup, retain diagnostic evidence outside the worktree, remove managed files, and never include them in publication.
- **A crash leaves temporary files in a retained worktree** -> Journal ownership outside the worktree and recover only inactive attempts; quarantine uncertain workspaces.
- **A child model is unavailable or charged differently** -> Show the exact override in the editor and job diagnostics; inherit the selected primary model by default; report provider/model failures distinctly.
- **Sibling console changes move or stage repository controls** -> Build after them or rebase the OpenCode section onto their shared repository editor, preserving one source of UI state.

## Migration Plan

1. Add nullable profile storage and job snapshots with no default profile; existing OpenCode and Cline jobs keep their current behavior.
2. Land the verified V2 preflight, generated-file lifecycle, and child-session gate before enabling the console save path.
3. Add the OpenCode repository editor, audit/diagnostics, and documentation; deploy with current saved profiles empty.
4. Roll back by disabling managed-profile launch and editor routes. Stored profiles and job snapshots remain inert and can be read by a later version; no source checkout cleanup is required outside the attempt recovery procedure.
