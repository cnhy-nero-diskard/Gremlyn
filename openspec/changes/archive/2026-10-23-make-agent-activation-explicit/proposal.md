## Why

Operators can save an orchestrator team and see its children labeled callable while new jobs still use OpenCode's default primary. The console must make the selected workflow, inactive saved teams, and actual execution unmistakable, with a direct way to activate the team the operator just reviewed.

## What Changes

- Combine primary-source selection and saved-team status into a prominent repository agent-workflow summary: what new jobs use, whether the saved team is active, and the actual primary observed in the most recent launched job invocation.
- Show an actionable inactive-team notice when a saved team exists but the repository selects default or native source; label its enabled children as enabled in the saved team rather than callable by the current runner.
- Offer explicit **Save team**, **Save and activate**, and **Activate this team** actions. Save and activate atomically persists the reviewed profile and selects managed source, with revision checks on both resources.
- Keep source switching deliberate, retain inactive definitions, and state that queued/running jobs and retries keep their captured selection.
- Put captured workflow and actual per-invocation primary near the job title, separately from observed child execution and partial/unavailable telemetry. Activation never claims that a child ran or guarantees delegation on every task.
- Preserve authenticated routes, scoped feedback, repository-local drafts, keyboard access, and focus/expansion during live updates.
- Exclude autoshipper, changes to the starter roster or delegation policy, executor behavior, publication, commits/pushes, and automatic activation or modification of existing repository settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Make saved-team activation and future-job selection prominent; distinguish save from activation and captured configuration from runtime evidence.
- `opencode-agent-selection`: Add an explicit atomic save-and-activate operation and direct activation of a reviewed saved profile with conflict-safe revisions and audit semantics.

## Impact

- `src/console/queries.ts`, `src/console/views/dashboard.ts`, `src/console/views/job.ts`, `src/console/assets.ts`, and existing live-update fragments gain workflow summaries, accurate state labels, activation actions, and historical-versus-current selection context.
- `src/console/server.ts`, `src/store/opencode-profiles.ts`, `src/store/opencode-selections.ts`, and the existing runtime notification seam gain coordinated activation without changing the independent save-only and source-switch semantics.
- Existing profile/selection/job-capture/console tests gain transaction rollback, stale-revision, truthful rendering, live-interaction, and executor-alias coverage. Browser acceptance covers desktop/mobile and keyboard use without paid model runs.
- Reuse existing profile, selection, job, invocation, and delegation stores; no database migration, new frontend framework, or dependency is planned. The change works on the current dashboard and can later move with `separate-console-monitoring-and-configuration`.
