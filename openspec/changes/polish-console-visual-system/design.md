## Context

See `proposal.md` — Why, and `specs/operator-console/spec.md` for the observable contract.

The console is server-rendered by Fastify and shares one stylesheet and enhancement script from `src/console/assets.ts`. Current CSS already provides light/dark colors, a monospace stack, visible focus, reduced-motion handling, text-bearing status pills, responsive rules, and a restrained blue-gray operator aesthetic. It also repeats ad hoc sizes and borders, assigns nearly every section the same white card treatment, omits several interaction states, and declares Inter even though no font is loaded. The resulting native fallback varies silently by machine.

Several active changes add or relocate visible components. `separate-console-monitoring-and-configuration` owns Monitor/Repositories structure and supplies current-navigation semantics; `improve-console-accessibility-and-session-ux` owns session behavior, focus/reconciliation behavior, semantics, and accessibility acceptance; `stage-repository-settings-edits` owns editor state; `guide-operator-error-recovery` owns feedback and recovery content; `add-console-operator-power-tools` owns search, shortcuts, and bulk behavior; `surface-job-safety-progress` owns safety-rail evidence and state; `add-agent-stall-failsafe` owns stall semantics. This design styles the states those changes expose and does not redefine them.

## Goals / Non-Goals

**Goals:**

- Make the shared stylesheet a durable visual source of truth with a small, named token vocabulary and component-state rules.
- Keep Gremlyn quiet and utilitarian while making authorization, isolation, progress, validation, publication, reporting, failure, and operator attention visually specific.
- Give old and sibling-proposal components predictable light, dark, reduced-motion, and responsive presentation.
- Allow incremental migration without changing routes, data contracts, or the server-rendered architecture.

**Non-Goals:**

- Defining navigation destinations, page responsibility, help content, recovery advice, action eligibility, or workflow state machines.
- Changing authentication/session mechanics, ARIA ownership, live announcements, focus restoration, or responsive table semantics.
- Adding illustration, decorative branding, a theme toggle, web fonts, icon packages, CSS/JavaScript frameworks, bundlers, or runtime dependencies.
- Replacing native controls or text-bearing model/status capsules with custom widgets or color-only marks.

## Decisions

### D1: Use an explicit native Windows-first typography stack

Define `--font-sans` as `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` and `--font-mono` as `"Cascadia Mono", "SFMono-Regular", Consolas, monospace`. Apply the sans token to all interface copy, including log-event metadata that currently repeats Inter, and reserve mono for paths, identifiers, SHAs, timestamps where alignment matters, and captured output. The type scale uses a bounded set of rem-based roles—caption, metadata, body, control, section title, page title—with named line-height and weight companions.

This makes Windows rendering deliberate while remaining offline and readable on other development hosts. It also removes the false impression that Inter is a provided dependency.

*Alternative considered:* bundle Inter or another variable font. Rejected because it adds an asset, loading/fallback work, cache and licensing maintenance, and little operational value for a loopback console.

### D2: Organize tokens by primitive, semantic role, and component contract

Keep the token source in the static stylesheet prelude so the console still ships as one fixed presentation asset. Define three layers:

1. Primitives: a short spacing scale, type scale, radii, border widths, shadow strengths, motion durations, and native font stacks.
2. Semantic roles: canvas, surface, raised, inset, text, muted text, divider, interactive accent, focus ring, and success/progress/warning/failure/cancelled/neutral foreground-background-border triplets in both themes.
3. Component aliases: panel tiers, controls, navigation, pills/capsules, feedback, safety steps, tables, event rows, and danger zones consume semantic roles rather than raw palette values.

Dark mode overrides semantic roles under `prefers-color-scheme: dark`; component selectors do not carry parallel hard-coded dark colors. Repeated literal values are migrated when touched so the new vocabulary becomes authoritative without requiring a separate CSS toolchain.

*Alternative considered:* expose only raw palette variables. Rejected because components would continue assigning colors by appearance, allowing warning, failure, danger, and event borders to drift.

### D3: Use four restrained emphasis tiers instead of a card for every section

Map content to four tiers:

- **Peak:** one page-local operational outcome or safety summary, using the strongest surface contrast, heading scale, and restrained edge/accent treatment.
- **Panel:** ordinary grouped controls or records with the standard surface and border.
- **Quiet:** secondary metadata grouped primarily by spacing/dividers, without obligatory elevation.
- **Inset:** logs, diffs, commands, paths, validation evidence, and other forensic material on a recessed surface with mono treatment where appropriate.

The job success/end state and fixed safety rail may use Peak when present; monitoring health and active work use Peak/Panel according to page priority; repository settings, filters, search, and routine history remain Panel/Quiet; raw evidence remains Inset. A page can contain multiple panels but normally only one peak region. These are visual mappings only: sibling changes decide what content exists and its order.

*Alternative considered:* increase shadows and border accents on every card. Rejected because it retains equal-weight competition and makes the local console feel decorative rather than precise.

### D4: Style a complete state matrix on semantic hooks

Use native pseudo-classes for hover, active, focus-visible, checked/selected, and disabled. Consume existing semantic attributes and narrowly added presentation hooks for busy and current state, such as `[aria-busy="true"]`, `[aria-current="page"]`, and stable `data-visual-state` values emitted by the owning workflow. Busy controls combine text/state copy with a static progress cue; optional motion is an enhancement and is removed under reduced motion. Disabled controls reduce emphasis without making their labels illegible. Hover and active effects change color, border, or inset shadow without moving layout.

This change supplies styling only. The sibling that owns a workflow remains responsible for setting/removing busy, disabled, current, error, and success semantics and for announcing them.

*Alternative considered:* infer state from button text or route URLs in CSS/client code. Rejected because wording and IA can change, and visual state would drift from authoritative semantics.

### D5: Adopt a semantic accent and border matrix

Status components use paired foreground, subtle background, and border tokens plus their existing visible label or non-color marker. Model capsules keep their current text-bearing semantic categories; this change normalizes contrast, padding, type, and theme mapping without collapsing categories.

Border accents follow a narrow rule set:

| Role | Use | Border rule |
| --- | --- | --- |
| Danger | Destructive-action container or trigger | Reserved danger border/edge plus explicit destructive copy |
| Failure | Recorded failed result or current error feedback | Failure inline/edge accent plus failure label/message |
| Warning | Recoverable attention or risk | Warning treatment, never danger red |
| Progress/success | Active stage or evidenced completion | Semantic progress/success treatment with text |
| Event category | Reasoning, tool, text, audit, or ordinary stage category | Neutral/category token; failure token only for a failed event |
| Structure | Generic panels, rows, tables, and separators | Neutral divider only; no semantic implication |

This removes decorative “side-tab” ambiguity and prevents neutral lanes or category borders from resembling failures.

*Alternative considered:* remove colored accents entirely. Rejected because color is valuable redundant information and model/status capsules are already useful, provided text, shape, and labels retain the same meaning.

### D6: Treat responsive and theme behavior as token-preserving transformations

Existing breakpoints remain the starting point, but component rules use flexible grids, wrapping, `minmax(0, 1fr)`, safe word breaking for Windows paths/IDs, and container overflow only where the accessibility change's native table contract requires it. At narrow widths, peak/panel/quiet/inset relationships remain visible through spacing, surface, headings, and semantic labels rather than fixed horizontal layouts. The job rail may become vertical, editor actions may wrap, and dense metadata may stack without truncating evidence.

Theme overrides and reduced-motion rules live after base tokens/states so every new sibling component inherits them. Focus rings use a theme-safe ring plus offset and remain visible against semantic surfaces. Motion is limited to short state feedback and never carries meaning alone.

*Alternative considered:* create separate mobile or dark markup. Rejected because duplicate render paths would complicate SSE reconciliation and invite behavioral drift.

### D7: Integrate sibling changes through a visual coverage matrix

Implementation maintains a small test fixture or route-fixture matrix covering the states siblings introduce: Monitor and Repositories active navigation, filters and global search, staged editor clean/dirty/saving/conflict states, local recovery feedback, connection states, attention/bulk controls, and all job safety-rail terminal combinations. Tests assert stable semantic hooks and absence of external assets; browser acceptance captures representative desktop/narrow, light/dark, keyboard-focus, busy/disabled, success, warning, and failure states.

This matrix verifies presentation composition without duplicating behavioral assertions owned by each sibling proposal. If changes land in a different order, styling selectors tolerate absent components; integration fixtures are enabled as their owning markup lands.

*Alternative considered:* validate only the current dashboard snapshot. Rejected because the largest visual regressions are likely at the boundaries between concurrent proposals and terminal/edge states.

## Risks / Trade-offs

- **[Native font metrics vary slightly across Windows versions and fallback hosts]** → Use robust line heights, flexible control sizing, and wrap tests rather than pixel-perfect text dimensions.
- **[A large token migration can produce broad incidental churn]** → Introduce the token layers first, migrate by component family, and keep behavior changes out of the same checkpoints.
- **[Semantic hooks could be mistaken for ownership of workflow state]** → Document each hook's owning sibling and test only visual consumption here.
- **[Too many emphasis tiers can become another inconsistent vocabulary]** → Limit the system to Peak, Panel, Quiet, and Inset, with shared examples and one-peak-per-page guidance.
- **[Dark theme accents can lose contrast or appear more saturated]** → Maintain explicit theme-specific semantic triplets and run the sibling accessibility change's contrast matrix over committed pairs.
- **[Concurrent changes can conflict in `assets.ts` and shared render helpers]** → Land token foundations early, rebase component selectors onto final semantic hooks, and keep this change free of route or state-machine edits.

## Migration Plan

1. Add the native font decision and primitive/semantic/component token layers while mapping existing selectors to equivalent values.
2. Apply the four emphasis tiers and shared type/spacing rhythm to the current shell and routes without changing their structure.
3. Add the interaction-state and navigation visual matrix, consuming semantics supplied by the accessibility and IA changes.
4. Normalize status, model-capsule, feedback, danger/failure/event, focus, dark-theme, reduced-motion, and responsive rules.
5. Cover current and sibling-proposal states with focused render/style tests and representative browser acceptance at desktop and narrow widths.

Rollback restores the prior stylesheet and presentation classes. There is no database, configuration, session, route, or persisted-data migration to reverse.
