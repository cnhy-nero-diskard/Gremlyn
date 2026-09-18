## ADDED Requirements

### Requirement: The console has an offline-safe visual foundation

The console SHALL use one coherent visual foundation across authenticated and unauthenticated surfaces, with a documented type scale, spacing rhythm, panel-emphasis levels, shape, border, and surface treatments. Its primary text and monospace typography SHALL resolve entirely from operating-system fonts and SHALL NOT require a network request, external asset host, JavaScript framework, runtime package, asset build, or undeclared font.

#### Scenario: Console renders without network access

- **WHEN** the console is opened on the supported local Windows environment with external network access unavailable
- **THEN** all text uses the declared native fallback stacks and the complete visual hierarchy renders without a missing font or external presentation asset

#### Scenario: Shared rhythm spans console surfaces

- **WHEN** the operator moves among sign-in, monitoring, repository configuration, job detail, Commands, and Audit surfaces
- **THEN** headings, body copy, metadata, controls, gaps, and panel tiers use the same type and spacing hierarchy

### Requirement: Visual hierarchy prioritizes operational meaning

The console SHALL visually distinguish primary operational state, ordinary grouped content, quiet supporting detail, and forensic or inset evidence without giving every region equal panel weight. Interactive elements SHALL have perceptible default, hover, active, disabled, and busy visual states appropriate to their action, and the current primary navigation destination SHALL be visually distinct when the shell identifies it as current.

#### Scenario: Primary and supporting panels coexist

- **WHEN** a page contains a primary operational summary alongside routine metadata and forensic detail
- **THEN** the primary summary has the strongest panel emphasis, routine content remains legible but quieter, and forensic detail reads as inset evidence rather than another competing primary card

#### Scenario: Pointer interaction states are visible

- **WHEN** the operator hovers and activates an enabled link, button, form control, or selectable row
- **THEN** the element presents a consistent hover treatment and a distinct pressed or active treatment without shifting the surrounding layout

#### Scenario: Disabled and busy states are visually distinct

- **WHEN** an existing control is disabled or marked busy by its owning workflow
- **THEN** it remains identifiable, its unavailable or in-progress state is visually distinct, and the busy treatment does not rely on animation alone

#### Scenario: Current navigation is visible

- **WHEN** the shared shell marks one primary navigation destination as the current page
- **THEN** that destination has an active treatment distinguishable from both an idle link and a transient hover state

### Requirement: Semantic accents follow consistent visual roles

The console SHALL use semantic foreground, background, and border treatments consistently for success, active progress, warning, failure, cancellation or interruption, neutral information, and disabled state. Every semantic treatment SHALL retain visible text or another non-color cue. Colored model capsules SHALL remain text-bearing and SHALL preserve their distinct recommendation, cost, availability, or compatibility meaning.

Danger styling SHALL be reserved for destructive-action regions and controls; failure styling SHALL identify recorded failed outcomes or error feedback; event/category borders SHALL use neutral or category-specific accents and SHALL NOT resemble danger or failure unless the event itself is a failure.

#### Scenario: Status can be understood without color

- **WHEN** a status pill, job-safety step, connection state, attention marker, or action result uses a semantic accent
- **THEN** its visible label, shape, icon, or accompanying copy communicates the same state when color differences are unavailable

#### Scenario: Model metadata keeps semantic capsules

- **WHEN** a model option or selected model has recommendation, free-tier, current, unavailable, mismatch, or validation metadata
- **THEN** the console presents the applicable colored capsules with concise visible text rather than reducing the metadata to color or unlabelled decoration

#### Scenario: Border meaning remains unambiguous

- **WHEN** danger actions, failed outcomes, and ordinary event categories appear on the same surface
- **THEN** destructive boundaries, failure accents, and neutral/category event borders use distinct visual roles, and decorative borders do not falsely imply danger or failure

### Requirement: Visual treatment adapts without losing meaning

The visual system SHALL support light and dark operating-system preferences, visible keyboard focus, reduced-motion preferences, narrow viewports, long Windows paths, identifiers, tables, filters, staged editors, feedback blocks, and job-progress rails. Theme and responsive variants SHALL preserve hierarchy, contrast, semantic distinctions, complete text, and usable control states.

#### Scenario: Dark preference is active

- **WHEN** the operating system requests a dark color scheme
- **THEN** the console uses the dark semantic palette while preserving panel hierarchy, focus visibility, model-capsule meanings, and distinct status roles

#### Scenario: Reduced motion is active

- **WHEN** the operating system requests reduced motion
- **THEN** non-essential transitions, pulses, and activity effects are suppressed while busy, live, and status states remain understandable from static treatment and text

#### Scenario: Console is viewed narrowly

- **WHEN** a console route is viewed at the supported narrow-width acceptance viewport
- **THEN** panels, controls, navigation, tables, paths, identifiers, safety steps, and feedback reflow or wrap without horizontal page overflow, clipping essential text, or losing their emphasis and semantic cues

#### Scenario: Keyboard focus moves through styled controls

- **WHEN** the operator navigates interactive elements with the keyboard
- **THEN** every focused element retains a clearly visible focus indicator that is distinct from hover, active, selected, error, and busy styling in both themes
