## Why

The console exposes rich operational evidence but assumes operators already know
Gremlyn's lifecycle vocabulary, raw reason codes, model badges, provider labels,
and action consequences. A visible, offline help layer should make routine and
high-risk decisions understandable without hiding the exact values experts need
for audit and diagnosis.

## What Changes

- Add a visible authenticated Help entry point with contextual links from job,
  repository, command, audit, and configuration surfaces.
- Add concise task-focused guidance for authorization, workspace isolation,
  validation, publication/reporting, retry/cancel/reset, and repository
  enablement, linking back to the authoritative controls and evidence.
- Pair raw command outcomes, audit reasons, failure codes, job/attempt/repository
  identifiers, provider identifiers, and other technical values with stable
  plain-language labels while preserving exact copyable raw values.
- Add non-color-only legends for job statuses, model metadata capsules,
  provider/authentication labels, and failure semantics including stalled versus
  maximum-duration timeout.
- Explain repository enable/disable consequences consistently, including that
  disabled-time commands create no jobs and are not replayed on re-enable.
- Use progressive disclosure so essential meaning and consequence appear first,
  while raw identifiers, detailed definitions, and cross-references remain
  available on demand.
- Preserve token authentication, redaction, offline operation, and the existing
  server-rendered Fastify architecture with framework-free enhancement.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Add authenticated contextual guidance, terminology
  translations, legends, and progressive disclosure without replacing
  authoritative operational evidence or controls.

## Impact

- Shared authenticated layout and console views under `src/console/views/`, plus
  a server-rendered help route and reusable terminology/legend components.
- Presentation models may expose stable display labels beside existing redacted
  reason codes and technical identifiers; persisted values and APIs remain
  unchanged.
- Console styles and minimal client behavior for contextual links, disclosure,
  copy affordances, and return-to-context navigation.
- Console tests for authentication, offline rendering, terminology coverage,
  exact-value preservation, redaction, legends, and progressive disclosure.
- The job safety rail, contextual recovery recommendation, shortcut reference,
  page information architecture, and staged settings workflow remain owned by
  their sibling changes; this change links to them rather than duplicating them.
