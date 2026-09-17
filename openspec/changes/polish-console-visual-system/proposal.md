## Why

Gremlyn's console is operationally specific but visually resembles a generic internal dashboard: most panels have equal weight, important state transitions lack a complete interaction treatment, and the CSS names Inter without providing it. A small, explicit visual system will make safety, progress, failure, and operator attention easier to scan while preserving the restrained, local-tool character and offline architecture.

## What Changes

- Replace the undeclared Inter preference with a documented, offline-safe native UI and monospace font stack that requires no download, bundled asset, or font build.
- Establish shared tokens for typography, spacing, radii, elevation, surfaces, borders, interactive states, and light/dark semantic colors.
- Define restrained panel-emphasis tiers so primary operational state, routine detail, and forensic/inset content no longer compete at the same visual weight.
- Give links, buttons, native form controls, repository/job rows, and sibling-proposal controls consistent hover, active, disabled, and visually busy treatments while retaining visible keyboard focus.
- Style the active primary navigation state supplied by the console shell and preserve responsive behavior across monitoring, configuration, job detail, Commands, Audit, and sign-in surfaces.
- Standardize semantic status accents and explicit rules for danger, failure, warning, success, neutral event/category borders, and the text-bearing colored model capsules.
- Preserve dark mode, reduced-motion behavior, non-color status cues, and the existing server-rendered Fastify/no-framework/no-new-build architecture.
- Keep functional accessibility/session behavior, information architecture, help content, action recovery, settings workflows, and job-safety semantics in their respective sibling changes; this change only supplies their shared visual presentation contract.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Add an offline-safe, tokenized visual presentation contract for hierarchy, interaction states, navigation emphasis, semantic accents, themes, and responsive console components.

## Impact

- Affects the shared console stylesheet and the presentation classes/attributes emitted by console view helpers in `src/console/`, plus focused render/style tests and visual acceptance fixtures.
- Must compose with `separate-console-monitoring-and-configuration`, `stage-repository-settings-edits`, `add-console-operator-power-tools`, `guide-operator-error-recovery`, `improve-console-accessibility-and-session-ux`, and `surface-job-safety-progress` without taking ownership of their behavior.
- Adds no external assets, CDN requests, framework, runtime package, database migration, public API, route, or build step.
