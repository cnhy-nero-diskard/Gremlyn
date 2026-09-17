## Context

See `proposal.md` — Why. The console is Fastify-served HTML with database reads in
`src/console/queries.ts`, view functions under `src/console/views/`, and one shared
client script in `src/console/assets.ts`. The dashboard currently reads all
repositories but only bounded running, queued, and recent job lanes. Repository
enablement is a single-target toggle; model choices are rebuilt from the provider
catalog into native selects.

Three sibling changes constrain this design. `stage-repository-settings-edits`
owns edit/apply/cancel drafts and treats enablement as an independent action.
`separate-console-monitoring-and-configuration` owns where monitoring and settings
live. `guide-operator-error-recovery` owns contextual mutation feedback. These
power tools must compose with those contracts rather than introduce a competing
settings workflow, page hierarchy, or error channel.

## Goals / Non-Goals

**Goals:**

- Add bounded server-side discovery over historical jobs and configured
  repositories with an explicit, reusable attention classifier.
- Make search, filters, neighboring-job navigation, and bulk actions work without
  JavaScript where practical, then enhance them with shortcuts and retained UI
  state.
- Make bulk enablement idempotent, independently reportable per repository, and
  safe under stale browser state.
- Keep large catalogs manageable while retaining a native select and the sibling
  settings draft as the only persistence boundary.

**Non-Goals:**

- Choosing whether monitoring and configuration share a page or navigation item.
- Adding a repository pause lifecycle distinct from existing enabled/disabled
  behavior.
- Adding general onboarding, legends, status education, or a command palette.
- Searching review feedback, captured output, structured logs, or arbitrary
  database text.
- Adding a frontend framework, client-side router, or client-owned eligibility
  rules.

## Decisions

### D1 — Use a protected server-rendered search route with URL-owned state

Add a typed search query to the console query layer and an authenticated GET route
that accepts a text query, repeated status values, repository id, attention
value, limit, and opaque cursor. Render grouped job and repository results with a
normal GET form; client behavior may submit or refresh it faster but is not
required for correctness.

The SQL selects an allow-list of fields: job id, repository owner/name, pull
request number, command, and status, plus the data needed for attention. It never
joins or matches review context, output references, log messages, validation
output, or secrets. Results use a fixed maximum page size and a deterministic
`created_at DESC, id DESC` job order; repositories use owner/name/id order.

Query and filters live in the URL. This provides refresh/back/forward behavior,
bookmarking on the authenticated local console, and a stable handoff to job
detail without adding console session state. Unknown filters are rejected or
ignored consistently and values are always parameterized.

*Alternative considered:* load all jobs into the browser and filter them there.
Rejected because the current dashboard intentionally bounds history, the payload
would grow without limit, and the browser would become responsible for deciding
attention state.

### D2 — Centralize attention as a server-side projection, not a new job state

Introduce a console-only attention projection with explicit reasons. A job needs
attention when authoritative persisted facts show an unresolved failed,
cancelled, or interrupted outcome; uncommitted changes; a created but unpushed
commit; or failed reporting. A repository can need attention when its configured
agent/provider relationship is invalid under the same definitions used by the
settings renderer. Other records are `no-immediate-action`.

Search filters and result badges consume that projection. It does not alter job
status, create a database column, or imply that a particular mutation is
eligible; the action controls and recovery presenter continue to decide that
from current server state. Reasons are human-readable, non-color-only, and
redacted.

*Alternative considered:* infer attention from CSS classes or status labels in
the client. Rejected because retained/unpublished work spans several persisted
fields and would drift from server action gating.

### D3 — Recompute adjacent jobs from the encoded result context

Links from search results carry only the validated search/filter parameters, not
an arbitrary return URL. Job detail uses those parameters and the current job id
to ask the same query layer for previous and next matches, then renders visible
links plus a server-built Back to results link. This prevents open redirects and
keeps navigation correct when data changes.

Live updates never auto-navigate. If an adjacent job changes or disappears, the
next user invocation follows a freshly rendered/revalidated link; a stale target
returns normal not-found behavior and preserves the route back to results.

*Alternative considered:* store a result id array in local storage. Rejected
because it becomes stale across tabs, exposes more history to browser storage,
and cannot reflect server-authoritative filters.

### D4 — Treat shortcuts as guarded progressive enhancement

The server renders a visible global search form, previous/next links, and a
Keyboard shortcuts button. The client adds only three unmodified printable-key
bindings: `/` focuses global search, `?` opens the shortcut reference, and the
documented previous/next keys activate an existing adjacent link.

The key handler exits when the event is composed, already handled, modified, or
originates in any input, textarea, select, button, link, editable element, open
dialog control, or widget. It also exits when the matching visible action is
absent or disabled. The shortcut reference uses a native dialog when supported,
restores focus to its opener, and lists only shortcuts supplied by the current
page.

*Alternative considered:* add Control/Command combinations or a full command
palette. Rejected because browser/platform conflicts are harder to avoid and a
palette would absorb search, navigation, and general-help scope into a parallel
information architecture.

### D5 — Submit explicit desired enablement and report every target

Add an explicit setter beside the current toggle mutation and a protected bulk
endpoint accepting a deduplicated, bounded array of repository ids plus desired
`enabled` state. Invalid request shape is rejected before any mutation. For a
valid request, the server reads and processes every named repository in request
order, returning `changed`, `unchanged`, or `failed` with a stable redacted reason.

The review UI is a native form/dialog built from selected repository cards. It
names every target and displays current versus desired state; bulk disable places
the shared ignored-command/no-replay warning owned by the guidance-and-legends
change inside that review. On
confirmation, the endpoint re-reads each target. Already-desired state is an
idempotent `unchanged`, missing or ineligible targets fail, and eligible targets
continue so partial success is explicit rather than rolled back or hidden.

Each changed or refused target is written through the existing operator-action
audit store. A batch summary contains only action, counts, and stable reason
codes. Per-repository feedback uses the contextual feedback channel introduced by
`guide-operator-error-recovery` when present. Repository setting drafts are keyed
separately and are neither submitted nor discarded by the batch.

*Alternative considered:* repeatedly call the single toggle route from the
browser. Rejected because toggles are not idempotent under stale state, there is
no authoritative batch review result, and network failure can leave the browser
unable to explain which targets changed.

### D6 — Filter catalog data, then rebuild the native select

Each repository model editor gains a labelled filter input and result-count
status associated with its existing picker. The full provider catalog remains the
source of truth in memory. On input, the client normalizes the query and filters
the current provider's catalog records by display name, exact id, description,
provider, and badge text, then rebuilds the same grouped native select.

The renderer always injects the persisted or staged current option when it is not
in the filtered matches, keeps the custom path, and restores the selected value
without dispatching a change event. Filter text and draft selection join the
existing picker state preserved across SSE/catalog refreshes. A debounced polite
status reports result count; clearing restores the unfiltered provider catalog.

This component attaches to the picker wherever the sibling information-architecture
change places repository settings. It does not decide that location and does not
submit settings.

*Alternative considered:* replace the select with a custom ARIA combobox.
Rejected because it would reimplement focus, selection, grouping, and
assistive-technology behavior already supplied by the native control.

### D7 — Keep layout integration through shared fragments

Global search and the shortcut trigger belong in shared authenticated layout
markup so they remain available whichever monitoring/configuration routes the
sibling IA change adopts. Search results, bulk selection, and model filtering are
independent view helpers with stable data attributes rather than assumptions
about a specific dashboard section order.

*Alternative considered:* make the power-tools change create dedicated dashboard
and settings navigation. Rejected because that would conflict directly with
`separate-console-monitoring-and-configuration` and make the two changes archive
and implement in a fixed order.

## Risks / Trade-offs

- **Historical search becomes slow as local history grows.** → Select only
  allow-listed columns, cap page size, use cursor pagination and deterministic
  ordering, inspect query plans in tests, and add indexes only when measurements
  justify a schema migration.
- **Attention semantics become a second status system.** → Model attention as a
  projection with explicit reasons, never persist it, and never use it to bypass
  action eligibility.
- **Single-key shortcuts surprise keyboard or assistive-technology users.** →
  Bind only unmodified keys outside every interactive/editable context, provide
  visible equivalents, and make the shortcut reference discoverable and
  dismissible.
- **A large bulk action overwhelms the page or server.** → Bound and deduplicate
  target ids, require an explicit reviewed set, process deterministically, and
  return a compact per-target result plus aggregate counts.
- **Partial success is mistaken for total success.** → Never collapse mixed
  results to one green confirmation; show changed, unchanged, and failed counts
  and associate failures with named repositories.
- **Model filtering loses a staged selection during catalog refresh.** → Keep
  catalog, filter query, persisted baseline, and staged value as separate state;
  always reinsert the current staged/persisted option before restoring selection.

## Migration Plan

1. Add typed search/filter/attention queries and route-level tests without
   changing existing dashboard reads.
2. Render global search and context-preserving job navigation through shared
   layout/view helpers, then add guarded shortcut enhancement and behavior tests.
3. Add explicit repository enablement setting and the bounded bulk endpoint,
   audit/results contract, review UI, and partial-failure tests.
4. Add model filter state and rendering to the existing picker, integrating with
   staged drafts and catalog/SSE restoration tests.
5. Integrate with the final route placement from
   `separate-console-monitoring-and-configuration`; no persisted-data migration
   is required. Rollback removes additive routes and controls while leaving job,
   repository, settings, and audit data unchanged.
