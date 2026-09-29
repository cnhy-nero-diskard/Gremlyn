## 1. Confirm the pinned OpenCode contract and UI baseline

- [x] 1.1 Probe OpenCode 2.0.16 with temporary nested `.opencode/agents/` primary and child definitions; record how `debug agents`, `run --agent`, model inheritance, and ordered `subagent` permissions behave, and verify the generated IDs are discoverable before a model run.
- [x] 1.2 Probe foreground and background child sessions on the pinned CLI; identify a reliable status and interrupt surface, and verify a cancelled child can no longer edit the workspace before implementing the publication gate.
- [ ] 1.3 Reconcile the current repository settings surface with `stage-repository-settings-edits` and `separate-console-monitoring-and-configuration`; verify the OpenCode editor is added to one full settings surface with a direct dashboard entry point.

## 2. Persist and validate repository profiles

- [x] 2.1 Define the versioned OpenCode profile type and field validation for safe unique IDs, descriptions, instructions, optional model/variant, positive step limits, enabled state, and supported permissions; verify invalid input yields field-specific errors without changing the prior profile.
- [x] 2.2 Add an additive migration for the repository profile, revision, and job snapshot; verify old databases migrate with no active profiles and existing Cline/OpenCode rows remain loadable.
- [x] 2.3 Save profiles with an atomic revision compare-and-set mutation and scoped operator action; verify stale writes conflict, non-OpenCode repositories reject updates, and audit details omit full instruction text.
- [x] 2.4 Snapshot the profile and revision in the job-creation transaction, leaving file-config synchronization unable to overwrite the operator choice; verify a queued job and its retry retain profile A after profile B is saved, while a new job uses B.

## 3. Apply a managed profile to an isolated attempt

- [x] 3.1 Serialize profile definitions into pinned V2 Markdown agent files with a unique attempt namespace and explicit parent allowlist/child permissions; verify generated content encodes arbitrary instruction text as data and child model omission inherits the primary model.
- [x] 3.2 Materialize only attempt-owned files in the disposable worktree, journal their paths outside it, and restore/remove them before validation; verify untouched tracked OpenCode files are byte-identical and no generated file enters the publishable diff after success, failure, or cancellation.
- [x] 3.3 Preflight the effective generated agents under the same cwd and environment as `run`; verify a missing primary, blocked child, or config-load mismatch fails with a configuration reason before agent edits and never falls back silently.
- [x] 3.4 Extend the common run options and OpenCode executor with the captured primary ID while leaving Cline's argv unchanged; verify contract checks assert `--agent <id>` only for managed OpenCode attempts.
- [x] 3.5 Track parent and child session IDs, wait for child quiescence, and interrupt children on timeout or cancellation; verify validation and publication cannot begin while a child can still write and an unknown child state fails closed.
- [x] 3.6 Recover stale generated files on restart only for inactive attempts and quarantine uncertain workspaces; verify an interrupted attempt cannot leak an old profile into a later run or publish its generated files.

## 4. Configure and inspect profiles in the browser console

- [ ] 4.1 Add OpenCode-only repository projections and a readable summary of primary, callable children, model inheritance/overrides, and permission presets; verify a Cline repository has no OpenCode controls and an unconfigured OpenCode repository shows its current default behavior.
- [ ] 4.2 Add a repository-local draft editor for primary and subagent definitions with Apply, Cancel, review, inline validation, and accessible labels; verify adding, editing, enabling, disabling, and removing children without editing OpenCode files manually.
- [ ] 4.3 Wire an authenticated compare-and-set save route and live-update reconciliation; verify one applied profile yields one audit action and runtime refresh, while a stale edit or SSE update preserves the operator's unsaved draft.
- [ ] 4.4 Show the captured profile name/revision, delegated agent outcomes, and specific configuration or unsettled-child failures in job detail; verify full private instructions are absent from ordinary audit and status projections.

## 5. Document and validate the integrated behavior

- [ ] 5.1 Document the dashboard workflow, profile defaults, child model inheritance, permissions, job snapshot timing, and generated-file cleanup; verify the documented labels and route match the implemented console.
- [ ] 5.2 Run a real OpenCode 2.0.16 resolution fixture with a callable subagent and an isolated Git workspace; verify a child is invoked, completion precedes validation, and the final diff contains only the intended review fix.
- [ ] 5.3 Run the relevant repository checks and `openspec validate configure-opencode-agents-in-console --strict`; verify the change is valid and report any live-agent acceptance that remains unverified rather than marking it complete.
