## Why

As job and repository counts grow, operators must scan cards, open jobs one at a
time, and repeat repository actions individually. The console needs efficient,
accessible tools for finding work and acting on a reviewed set without making
the default experience harder for occasional operators.

## What Changes

- Add authenticated global search across jobs and configured repositories, with
  filters for job status, repository, and server-derived attention state.
- Add fast cross-job navigation that preserves the operator's current result or
  filter context and exposes ordinary visible controls as well as shortcuts.
- Add discoverable keyboard shortcuts for search, navigation, and shortcut help;
  shortcuts do not fire from editable controls or override browser/platform
  conventions.
- Add safe bulk repository enable/disable actions with an explicit review step,
  confirmation of disable consequences, server-side eligibility checks, audit
  records, and per-repository partial-failure results.
- Add accessible catalog filtering to large model pickers while preserving the
  persisted selection, provider grouping, custom model path, and staged settings
  workflow owned by `stage-repository-settings-edits`.
- Preserve token authentication, server-authoritative state and action gating,
  secret redaction, native control semantics, and the existing server-rendered
  Fastify architecture without a frontend framework.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Add global discovery, contextual filters, keyboard and
  cross-job navigation, reviewed bulk repository actions, and accessible model
  catalog filtering for experienced operators.

## Impact

- Console queries, authenticated routes, server-rendered views, CSS, and shared
  client behavior under `src/console/`.
- Repository enablement mutation handling and operator-action audit output for
  reviewed batches; no new repository lifecycle state is introduced.
- Provider/model picker rendering and client-side catalog filtering; model
  availability and persistence rules remain unchanged.
- Console integration, accessibility, keyboard, search/filter, and bulk-action
  tests.
- Dashboard-versus-configuration information architecture remains owned by
  `separate-console-monitoring-and-configuration`; general legends and workflow
  education remain outside this change except the shortcut reference required
  to discover these controls.
