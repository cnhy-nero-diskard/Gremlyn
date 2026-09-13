## Why

The operator console satisfies its spec at the level of "the string appears in the
response body" but not at the level of "an operator can use it". It ships no
stylesheet, so it renders in browser-default serif with successes and failures
visually indistinguishable; its retry, cancel, repository-toggle and workspace-reset
controls are decorative (the `data-action` buttons have no handler and the reset
button is permanently `disabled`, so every operator action is reachable only by
`curl`); its live-progress mechanism reloads the whole page on every agent write;
and the richest diagnostic data already in SQLite — attempt durations, agent exit
codes, push state, per-command validation results, poll freshness, and the entire
command-rejection path — is either dumped as raw JSON or never surfaced at all.

Now, because the rejection-reply work in `9f1879a` closed the loop on GitHub while
leaving the console blind to the same events: an operator watching the console
still cannot see that a command arrived and was refused.

## What Changes

- Add a real presentation layer: a served stylesheet, a status color system that
  distinguishes `succeeded` / `failed` / `cancelled` / `interrupted` at a glance,
  light and dark themes, viewport meta, and cross-page navigation (job detail is
  currently a dead end with no link back to the dashboard).
- Make every operator action invocable from the browser: wire retry and cancel,
  give each repository an inline enable/disable control, and give workspace reset a
  real confirmation input inside a visually separated danger zone instead of a
  disabled button. Add a direct pull-request link alongside the existing
  triggering-comment link.
- Replace the hardcoded `Orchestrator status: running` string with real health:
  last poll time, a staleness indicator derived from the configured poll interval,
  queue depth, and active-versus-configured concurrency.
- Replace `JSON.stringify` dumps with structured views: the status timeline as a
  stepper with timestamps and per-stage durations, validation runs as a table of
  command / exit code / duration with collapsible output, and the structured log as
  a filterable viewer.
- Surface attempt diagnostics the console currently hides: `started_at`/`ended_at`
  durations, `agent_exit_code`, `pushed`, `has_uncommitted_changes`, and
  `head_sha_at_prepare`.
- Add a command-ingestion view over `processed_commands` answering "why did my
  `!RESOLVE` do nothing?" — command observed, author, authorization outcome, and
  refusal reason — plus a view of the `operator_actions` audit trail, which is
  written today and never read.
- Replace the fake SSE endpoint (a 20-second SQLite long-poll that emits one event
  and closes) with a held-open connection that pushes on each change, and replace
  `location.reload()` with targeted region updates so scroll position, expanded
  sections and typed confirmation text survive an update. Extend live updates to
  the dashboard.
- Restructure `src/console/` from one 424-line file into routing, queries, assets
  and view modules. No new runtime dependencies and no new build step.
- **BREAKING** (test-facing only): two assertions in `tests/console.test.ts` pin
  markup this change necessarily replaces — the literal
  `Orchestrator status: <strong>running</strong>` and the copy `typing RESET`. Both
  are revised as a stated consequence. No configuration, HTTP route, or database
  contract is removed.

## Capabilities

### New Capabilities

None. Every change lands inside the existing operator-console capability.

### Modified Capabilities

- `operator-console`: strengthens five existing requirements whose UI half was
  never built — *Dashboard overview* (real orchestrator health rather than a
  literal string), *Job detail view* (durations, exit code, push state, per-command
  validation results), *Live progress* (no full-page reload; dashboard included),
  *Operator actions* (invocable from the browser, plus a pull-request link), and
  *Destructive actions are separated and confirmed* (a reachable confirmation
  instead of a disabled button) — and adds one new requirement covering console
  visibility of command-ingestion and authorization outcomes.

## Impact

- `src/console/server.ts` is decomposed into `server.ts` (routing and auth),
  `queries.ts`, `stream.ts`, `assets.ts`, and `views/`.
- `ConsoleOptions` gains the poll interval and concurrency needed to compute real
  health, so `src/index.ts` passes them at construction. This is the only edit
  outside `src/console/`.
- Two new unauthenticated asset routes (`/assets/app.css`, `/assets/app.js`) are
  exempted from the console auth hook so the pre-auth sign-in page can be styled;
  they serve no job data. New authenticated routes for the command-ingestion and
  audit views.
- `GET /jobs/:id/stream` keeps its `?snapshot=1` mode but its payload becomes HTML
  fragments rather than JSON.
- `tests/console.test.ts` gains coverage for action wiring, health, and ingestion
  visibility, and revises the two markup assertions named above.
- No new dependencies. Reads only from existing tables; no migration.
