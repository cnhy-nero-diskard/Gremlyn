## Why

Selecting a model or an executor does not select an existing OpenCode agent: normal repository runs currently omit `--agent`, while the managed-team editor creates a different generated configuration. [Issue #14](https://github.com/cnhy-nero-diskard/Gremlyn/issues/14) requires repository-specific selection of actual discovered primary agents without silently bypassing managed-profile permissions or losing the choice across jobs and restarts.

## What Changes

- Add an OpenCode-only **Run with agent** control, distinct from executor, provider, model, effort, and timeout. Discover actual eligible primary-capable agents, including the operator's existing agents when present, rather than hardcoding names or a count. Show safe names/descriptions and origin labels only when supported by evidence; unavailable provenance remains unknown.
- Use one explicit, mutually exclusive primary source: **OpenCode default**, **existing OpenCode agent**, or **Gremlyn-managed team**. Existing saved profiles remain active on migration; repositories without one retain default selection. Switching sources requires a deliberate save and preserves any inactive managed profile for later reuse, never merging native selection with its generated primary or allowlist.
- Persist the selected source and native ID per repository, independently of file synchronization and other repository fields. Capture selection and any active managed-profile revision atomically at job creation; queued, running, and explicitly retried jobs retain that snapshot. Audit changes without recording private instructions.
- Perform bounded, read-only discovery using the configured executor alias's pinned binary, installation/environment context, and repository location. Revalidate the captured choice in the actual isolated attempt workspace before work starts, including cold-location discovery races and repository-specific configuration differences.
- Validate native IDs against the effective eligible inventory with a native-selection contract, while retaining the specialized generated-ID and managed permission checks. An unavailable, malformed, non-primary, or conflicting choice fails clearly without substituting `build` or another runner. Discovery failures preserve the saved choice and expose actionable feedback; Cline gets no OpenCode picker or arguments.
- Record requested selection separately from the actual effective runtime agent when observable. **OpenCode default** snapshots the policy of omitting an explicit agent, not an immutable external definition; native selection snapshots its ID, not copies of project/global instruction files. Explain this distinction and retain actual per-attempt evidence when external configuration changes.
- **BREAKING** for previously unchecked native/default delegated runs: apply the existing fail-closed child-quiescence contract to all OpenCode parent invocations, not only managed profiles. Include provably attributed descendants in timeout/cancellation and restart recovery; do not relaunch a parent, reuse its workspace, validate, or publish until its tree is confirmed stopped. Missing proof fails with preserved diagnostic evidence instead of continuing as unmanaged execution.
- Display configured primary source on repository summaries and captured/effective runner on job detail. Require deliberate apply, preserve unavailable current values and drafts across live updates, and coordinate with the pending staged-settings and separate-configuration workflows rather than introducing competing editors.

## Capabilities

### New Capabilities

- `opencode-agent-selection`: Effective native-agent discovery, eligibility, explicit primary-source selection, workspace-context revalidation, and requested-versus-effective runner semantics.

### Modified Capabilities

- `repository-registry`: Durable repository-scoped primary-source/native-ID settings that survive synchronization and restart independently of model/provider and saved profiles.
- `job-orchestration`: Immutable job selection snapshots across queued work and retries, with per-attempt effective-runner evidence and recovery attribution for native OpenCode trees.
- `opencode-agent-profiles`: Explicit activation/dormancy and non-conflicting switching between managed teams, native agents, and default behavior while preserving managed permission checks.
- `agent-execution`: Native primary selection and preflight, plus explicit invocation/retry/recovery handling under the existing delegated-work quiescence requirement for unmanaged as well as managed OpenCode runs.
- `operator-console`: OpenCode-only agent picker, deliberate source switching, unavailable/discovery feedback, effective-runner summaries, and privacy-safe audit information.

## Impact

- Extends `src/agent/managed-preflight.ts`, `src/agent/opencode.ts`, `src/agent/managed-sessions.ts`, `src/types.ts`, orchestration and attempt recovery, repository/job/profile stores, database migrations, and console routes/projections/views/client behavior. Discovery must not forward raw inventory, system prompts, credentials, or arbitrary file contents to the browser or logs.
- Tests prove real `--agent` selection and effective runtime identity, eligibility and fallback refusal, cross-repository/context isolation, profile switching, snapshot/restart/retry stability, unavailable APIs, background/nested-child settlement, and publication safety. No paid model calls are required in the normal suite; real-runtime acceptance remains explicit opt-in.
- Coordinate UI ownership with `stage-repository-settings-edits` and `separate-console-monitoring-and-configuration`. This change owns native execution safety; `observe-live-agent-delegation` (#15) consumes evidence without authorizing publication. No agent provisioning, instruction-file copying, executor switching UI, or live delegation tree is included.
