# Console visual coverage matrix

This matrix records the presentation contract owned by `polish-console-visual-system`.
The current route rows use server-rendered view fixtures. Sibling rows record the
stable hooks that this stylesheet is ready to consume; their workflows, markup,
and state transitions remain owned by the named sibling change.

Legend:

- **R**: current server-rendered route or component fixture.
- **H**: semantic selector or presentation hook covered by the focused style tests.
- **N**: narrow reflow rule covers 320 CSS px and 400% zoom constraints through
  flexible tracks, wrapping, and overflow-safe text treatment.
- **L/D**: light and dark semantic-token variants are checked by the contrast
  and theme assertions in `console-accessibility.test.ts` and `console-visual.test.ts`.

## Route and sibling-state matrix

| Surface or state family | Fixture or stable hook | Desktop L/D | Narrow L/D | Focus, hover, active | Disabled / busy | Semantic outcomes and evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Sign-in | `authLayout`, `.signin.presentation-peak` | R + H | N | H | H | Validation/error copy remains text-bearing |
| Shared shell and navigation | `layout`, `[aria-current="page"]` | R + H | N | H | n/a | Current destination is distinct from hover/focus |
| Monitor dashboard | `dashboardView`, `.lane`, `.repo-card` | R + H | N | H | H | Health, connection, progress, and neutral rows |
| Job detail in progress | `jobView`, `.activity-panel`, `[data-visual-role="progress"]` | R + H | N | H | H | Progress labels, active rail steps, live evidence |
| Job detail succeeded | `.job-outcome-success`, `[data-visual-role="success"]` | R + H | N | H | n/a | Peak success treatment with visible outcome text |
| Job detail failed, cancelled, or interrupted | Status-pill role hooks | R + H | N | H | n/a | Failure, cancellation, and interruption remain distinct |
| Commands | `commandsView`, `.presentation-inset` | R + H | N | H | H | Captured commands read as forensic evidence |
| Audit | `auditView`, event/category hooks | R + H | N | H | n/a | Neutral/category borders do not imply danger or failure |
| Repository settings editor | `[data-visual-state]`, `[data-state]` | H | N | H | H | Clean, dirty, saving, saved, error, and conflict states |
| Search, filters, shortcuts, and bulk actions | `.filter-bar`, `[data-search]`, `[data-shortcut]`, `[data-bulk-action]` | H | N | H | H | Selected, disabled, busy, and attention cues retain labels |
| Recovery and action feedback | `[data-action-feedback]`, `.recovery-advice` | H | N | H | H | Local success/failure/warning feedback stays separate from connection health |
| Connection health | `[data-connection-status]`, `.console-status` | H | N | H | n/a | Connected, reconnecting, and disconnected states have text |
| Job safety rail | `.safety-rail`, `.job-safety-step`, `[data-safety-state]` | H | N | H | H | Pending, active, passed, skipped, failed, and not-applicable steps |
| Stall and timeout outcomes | Failure/outcome hooks | H | N | H | n/a | Stall, timeout, cancellation, and nonzero failure remain named outcomes |
| Model/provider capsules | `.model-badge-*`, `.model-picker-*` | R + H | N | H | H | Recommended, current, free, pass, validation, new, unavailable, mismatch |

## State treatment matrix

| Treatment | Primary hooks | Non-color evidence required | Light | Dark | Desktop | Narrow |
| --- | --- | --- | --- | --- | --- | --- |
| Focus | `:focus-visible`, `--focus-ring` | Visible ring and offset | pass | pass | pass | pass |
| Hover | `:hover` | Border/surface change without layout shift | pass | pass | pass | pass |
| Active / selected | `:active`, `[aria-selected="true"]`, `[data-visual-state="selected"]` | Pressed or selected surface/border | pass | pass | pass | pass |
| Disabled | `:disabled`, `[aria-disabled="true"]` | Legible label plus reduced emphasis | pass | pass | pass | pass |
| Busy / progress | `[aria-busy="true"]`, `[data-state="busy"]` | Static progress cue and state copy | pass | pass | pass | pass |
| Success | `[data-visual-role="success"]`, `.job-outcome-success` | Visible success label/outcome | pass | pass | pass | pass |
| Warning / attention | `[data-visual-role="warning"]`, `.attention-marker` | Warning or attention copy/marker | pass | pass | pass | pass |
| Failure | `[data-visual-role="failure"]`, `[data-visual-state="error"]` | Failure label or error feedback | pass | pass | pass | pass |
| Danger | `[data-visual-role="danger"]`, `.danger-zone` | Explicit destructive copy and action | pass | pass | pass | pass |
| Neutral event | `[data-visual-role="neutral"]`, `.event-row` | Event/category text and structure | pass | pass | pass | pass |

## Verification record

- `tests/console-visual.test.ts`: offline-safe typography, token layers, panel
  tiers, route composition, interaction hooks, semantic status roles, reduced
  motion, theme overrides, and narrow reflow selectors.
- `tests/console-accessibility.test.ts`: light/dark contrast pairs, focus
  visibility, status text, responsive table semantics, and scoped live regions.
- Narrow coverage is intentionally CSS-contract based: flexible `minmax()` tracks,
  wrapping, safe path/identifier breaks, stacked safety rails, and narrow action
  groups are asserted without adding a browser or screenshot dependency.
- No external asset, framework, runtime dependency, route, database, or workflow
  state machine is introduced by this visual change.
