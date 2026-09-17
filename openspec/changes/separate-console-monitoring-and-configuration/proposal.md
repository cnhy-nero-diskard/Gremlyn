## Why

The dashboard's operational overview competes with full repository configuration controls, so scanning current work becomes slower as repository count grows. Monitoring and configuration need distinct, clearly navigable responsibilities while preserving the deliberate staged-edit workflow planned for repository settings.

## What Changes

- Keep the authenticated dashboard focused on observed orchestrator health plus running, queued, and recent job lanes as the primary operational overview.
- Reduce dashboard repository cards to compact summaries of enabled state, agent/provider/model, timeout, and validation coverage, with a direct link to configure that repository.
- Add a dedicated authenticated repository-configuration route that owns provider, model, reasoning effort, timeout, validation-command editing, and enable/disable controls.
- Host the `stage-repository-settings-edits` draft/review/apply/cancel/conflict workflow on the configuration surface without weakening authoritative picker semantics or repository-local feedback; validation commands use a separate explicit draft so the four-field settings transaction remains intact.
- Add surface-local repository filters to configuration and repository/job filters to monitoring, with empty-result and clear-filter states that remain usable as repository and job counts grow.
- Add explicit active navigation and plain-language page introductions so operators know where to watch work and where to change future-job behavior.
- Preserve server-rendered Fastify HTML, framework-free client enhancement, existing build/runtime dependencies, token protection, redaction, and SSE preservation of operator-entered state.
- Exclude global search, command palettes, keyboard shortcuts, and cross-surface power-user navigation; those belong to a separate change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Separate operational monitoring from repository configuration and add scalable surface-local filtering and navigation.

## Impact

- `src/console/views/dashboard.ts` will retain health and job lanes while rendering compact repository summaries and monitoring filters.
- A new server-rendered configuration view and authenticated route will host repository settings, staged editing, validation-command editing, enablement, and repository filters.
- `src/console/layout.ts`, `src/console/queries.ts`, `src/console/server.ts`, `src/console/stream.ts`, and `src/console/assets.ts` may gain navigation, filter models, route rendering, and scoped live-update support.
- Console tests will cover route authorization, navigation, compact summaries, filters, empty states, staged-editor preservation, authoritative pickers, and live updates.
- No persistence migration, frontend framework, build step, global search system, or orchestration behavior change is introduced.
