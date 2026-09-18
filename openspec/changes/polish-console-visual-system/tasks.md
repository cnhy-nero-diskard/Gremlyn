## 1. Establish the visual foundation

- [x] 1.1 Replace all undeclared Inter references with the documented native sans and monospace stacks, then verify the served stylesheet contains no `Inter`, `@font-face`, remote URL, or font-loading request.
- [x] 1.2 Add the primitive type, line-height, weight, spacing, radius, border, shadow, and motion tokens to the shared stylesheet and verify a focused stylesheet test asserts the required token names and offline-safe values.
- [x] 1.3 Add light and dark semantic surface, text, divider, interaction, focus, and status triplets plus component aliases, then verify focused tests reject raw status colors in migrated component rules.

## 2. Apply hierarchy and rhythm

- [x] 2.1 Implement Peak, Panel, Quiet, and Inset presentation classes and map the current shell, dashboard, job detail, Commands, Audit, and sign-in regions to them; verify render tests show at most one Peak region per route fixture and the intended tier on forensic content.
- [x] 2.2 Normalize page titles, section titles, body copy, metadata, labels, controls, inline code, paths, and captured output to the shared type scale; verify representative render fixtures contain the expected presentation hooks and long content still wraps.
- [x] 2.3 Apply the spacing rhythm to page layout, panel stacks, fields, action groups, lists, rows, tables, and empty states; verify desktop and narrow route fixtures have no layout overlap or horizontal page overflow.

## 3. Complete interactive visual states

- [x] 3.1 Add stable default, hover, active, focus-visible, disabled, and busy styling for links, buttons, native inputs/selects, selectable rows, and disclosure controls; verify the state fixture distinguishes each state without geometry changes or animation-only meaning.
- [x] 3.2 Style the existing sibling-owned current-navigation hook independently from hover and focus, then verify Monitor, Repositories, job detail context, Commands, and Audit fixtures highlight exactly the destination their shell marks current.
- [x] 3.3 Integrate staged settings, search/filter, shortcut, bulk-action, recovery-feedback, and connection-state hooks as their owning changes land; verify each fixture can enter busy/disabled/error/success presentation without adding workflow logic to this change.

## 4. Normalize semantic accents

- [x] 4.1 Apply foreground/background/border triplets and existing non-color cues to job statuses, safety-rail steps, health/connection state, feedback, attention reasons, and terminal outcomes; verify every semantic fixture retains visible state text or another non-color marker.
- [x] 4.2 Preserve and normalize the text-bearing recommended, free-tier, current, unavailable, mismatch, and validation model capsules in both themes; verify provider/model picker fixtures retain their labels, categories, and authoritative selection behavior.
- [x] 4.3 Separate danger, failure, warning, progress/success, event-category, and structural border roles and remove decorative side accents that imply the wrong state; verify a combined danger/failure/event fixture uses distinct tokens and failure red appears only on actual destructive or failed roles.
- [x] 4.4 Strengthen the evidenced successful job end state as the page Peak treatment without changing success semantics; verify successful, pushed-but-report-failed, local-unpushed, validation-failed, cancelled, interrupted, timed-out, and stalled fixtures remain visually and textually distinct.

## 5. Preserve theme, motion, and responsive behavior

- [x] 5.1 Complete dark-theme overrides at the semantic-token layer and verify the light/dark contrast matrix and representative status/model/focus fixtures pass the AA-oriented checks owned by the accessibility change.
- [x] 5.2 Extend reduced-motion rules to every new transition, pulse, spinner, or live effect while keeping static busy/progress cues; verify reduced-motion emulation removes non-essential motion and leaves state labels and shapes intact.
- [x] 5.3 Reflow navigation, filters, settings editors, tables, feedback, safety rails, paths, and action groups at the supported narrow viewport; verify browser acceptance at 320 CSS pixels and 400% zoom has no page-level horizontal overflow, clipped evidence, or hidden focused control.

## 6. Verify integrated delivery

- [x] 6.1 Add a visual coverage matrix for current routes and all landed sibling states, then record light/dark desktop/narrow checks for focus, hover, active, disabled, busy, success, warning, failure, danger, and neutral event treatments.
- [x] 6.2 Run the focused console/render/style tests, `npm run build`, `npm run lint`, and the full automated test suite, and record that no external asset, framework, runtime dependency, route, database, or workflow behavior was introduced.
- [x] 6.3 Run `openspec validate polish-console-visual-system --strict` after implementation and reconcile the completed artifacts with any final sibling selector names while preserving this change's visual-only ownership boundary.
