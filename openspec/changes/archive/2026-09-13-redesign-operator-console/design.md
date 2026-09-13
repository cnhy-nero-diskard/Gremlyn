## Context

See `proposal.md` — Why.

Constraints that shape the approach:

- `src/console/server.ts` is a single 424-line file holding routing, auth, SQL,
  HTML templating and inline client script. `page()` emits no stylesheet, no
  viewport meta and no navigation.
- The build is bare `tsc -p tsconfig.json`; development runs on `tsx`. There is no
  bundler, no asset pipeline and no static-file plugin. `package.json` runtime
  dependencies are `better-sqlite3`, `execa`, `fastify`, `octokit`, `yaml`.
- The console binds loopback by default. A CDN reference would introduce a network
  dependency into a tool that is otherwise entirely local.
- Every value rendered today passes through `createRedactor(options.secrets)` and
  `escapeHtml`. The *Secrets are never rendered* requirement makes that
  non-negotiable for every view added here.
- `GET /jobs/:id/stream` is not a stream: `waitForJobChange` polls SQLite every
  250 ms for up to 20 s, emits one `job-update` event and ends the response. The
  client's only reaction is `location.reload()`.
- The existing console tests drive the app through `app.inject`, which buffers a
  complete response. A genuinely held-open response cannot be tested that way.
- All data these views need already exists in `repositories`, `jobs`, `attempts`,
  `status_events`, `validation_runs`, `log_entries`, `processed_commands`,
  `operator_actions` and `ingestion_state`. No schema change is required.

## Goals / Non-Goals

**Goals:**

- A presentation layer good enough that an operator diagnoses a failure in the
  console rather than in SQLite, with zero new runtime dependencies and no new
  build step.
- Separation of routing, data access, presentation and client behaviour so that
  view work does not touch SQL and vice versa.
- A live-update path that never destroys view state.
- Keep every existing HTTP route, request contract and redaction guarantee intact.

**Non-Goals:**

- No change to the authentication model beyond the static-asset carve-out in D2.
  No sessions, no users, no roles.
- No database migration, no new table, no retention or metrics history. Views are
  read-only projections of what is already stored.
- No editing configuration from the console. Repository enable/disable already
  exists and stays the only mutation of repository state.
- No client-side routing, no virtual DOM, no component framework.
- No accessibility audit beyond the basics (semantic elements, focus visibility,
  colour not carrying meaning alone). Not a claim of WCAG conformance.

## Decisions

### D1: Decompose `src/console/` into modules rather than growing one file or adopting a client framework

```
src/console/
  server.ts      routing + auth hook only
  queries.ts     all SQL; returns typed models
  stream.ts      change detection + SSE transport
  assets.ts      CSS and client JS as exported strings
  views/
    layout.ts    page shell, nav, theme tokens
    dashboard.ts
    job.ts
    commands.ts  processed_commands + operator_actions views
    components.ts status pill, duration, relative time, kv table, danger zone
```

Views are pure functions from model to HTML string, so they are directly testable
without a server and without a database.

*Alternatives considered.* Keeping everything inline in `server.ts` — smallest
diff, but the file reaches roughly 900 lines mixing four languages, and the
existing 424-line version is already the reason the presentation layer was never
maintained. A JSON API with a client-rendered SPA — requires a bundler (new build
step, breaks the `tsx` dev path), a CDN (network dependency in a loopback-only
tool), or vendoring a minified library into the repository; all three buy
capability this console does not need, since the server already has every value in
hand at render time.

### D2: Serve static presentation assets unauthenticated

The `onRequest` hook currently rejects every path except `/auth`. `/auth` is the
pre-authentication sign-in view, so it cannot reference an authenticated
stylesheet. `/assets/app.css` and `/assets/app.js` are therefore added to the hook's
exemption list.

This is safe because both are fixed content: they are string constants compiled
into the binary, they take no parameters, and they contain no job data,
configuration value, operational state or secret. The spec change in
`specs/operator-console/spec.md` states that constraint normatively rather than
leaving the carve-out implicit, because the previous requirement's scenario said
*any* console route without a token is rejected.

*Alternatives considered.* Inlining a second copy of the CSS into the sign-in page
so `/assets/*` stays authenticated — keeps the "everything but `/auth` is authed"
invariant, at the cost of two divergent copies of the design tokens and no
browser caching. Authenticating assets and accepting an unstyled sign-in page —
rejected as the sign-in page is the first thing an operator sees.

### D3: Replace the pseudo-SSE with a held-open connection, keeping `?snapshot=1` as the testable path

`stream.ts` hijacks the reply (`reply.hijack()` and writes to `reply.raw`), emits an
initial event, then emits further events as changes are detected until the client
disconnects. `request.raw.on("close")` tears down the subscription. A periodic
comment frame keeps the connection alive through idle periods.

`?snapshot=1` is retained and still returns exactly one event and closes. It is the
mode the test suite exercises, because `app.inject` buffers the whole response and
would hang forever against a held-open stream. Tests of the streaming loop itself
need a real `listen` on an ephemeral port with a timeout, and are scoped in
`tasks.md` accordingly.

Change detection moves from per-connection polling to a single shared ticker over
the database, with connections subscribing to it. With per-connection polling, two
operators watching two jobs means two independent 250 ms SQLite poll loops; the
shared ticker keeps that at one regardless of viewer count.

*Alternatives considered.* Keeping the 20-second long-poll and only replacing
`location.reload()` with fragment swaps — smaller change, but the roughly 3-second
`EventSource` reconnect gap between cycles makes agent output arrive in visible
bursts. WebSockets — bidirectional transport for a one-directional problem, and a
new dependency.

### D4: Push rendered HTML fragments, swap them into named regions

The server owns rendering, so the SSE payload carries HTML for the regions that
changed, keyed by region id. The client script looks up each id and assigns
`innerHTML`. That is roughly 60 lines of hand-written JavaScript and needs no
templating on the client, which is what makes D1's "no framework" position hold.

Because only changed regions are replaced, scroll position outside those regions,
`<details>` expansion state and typed confirmation text all survive — which is what
the *Live progress* requirement now demands. Output regions preserve scroll
position explicitly and re-pin to the bottom only when the operator was already at
the bottom.

Transport detail: an SSE `data:` field cannot contain a raw newline, and HTML
fragments do contain newlines. The payload is therefore a single JSON object,
`JSON.stringify`-encoded onto one `data:` line, whose values are the fragment
strings. This also preserves the existing test's ability to match substrings such
as `reporting` and `new live output` in the response body.

*Alternatives considered.* Pushing JSON models and rendering on the client —
duplicates every view function in a second language and a second escaping regime,
with redaction logic on both sides of the wire. Server-sent morph instructions or a
diffing algorithm — unnecessary at this data volume.

### D5: Thread health inputs through `ConsoleOptions`

Reporting real health needs the configured polling interval (to judge staleness)
and the concurrency limit (to render "2 of 3 busy"). `ConsoleOptions` gains
`pollIntervalSec` and `concurrency`; `src/index.ts` passes them at construction.
Everything else — last poll time, queue depth, in-flight count — is read from
`ingestion_state` and `jobs`.

This is the only edit outside `src/console/`.

*Alternatives considered.* Persisting configuration into a table so the console can
query it — a schema change and a second source of truth for values the process
already holds. Hardcoding thresholds in the console — reintroduces exactly the kind
of asserted-not-observed value this change removes.

### D6: CSS and client JS live as TypeScript string exports, served from routes

`assets.ts` exports the stylesheet and client script as template literals, served
with a long `cache-control` and a content hash in the URL for invalidation. No
static-file plugin, no files to copy, and `tsc` output stays self-contained, which
keeps `npm run start:built` working from `dist/` unchanged.

*Alternatives considered.* Real `.css` and `.js` files plus `@fastify/static` — a
new dependency and a copy step `tsc` does not perform, so `dist/` would ship
without assets.

### D7: Theme via CSS custom properties and `prefers-color-scheme`

Colour tokens are declared once on `:root`, overridden in a
`@media (prefers-color-scheme: dark)` block. Status treatment pairs colour with a
non-colour cue (shape and label) so terminal states remain distinguishable without
relying on hue.

No theme toggle and no persistence: that would need client storage and a
preference surface, for a tool one person runs on one machine.

### D8: The reset confirmation gates the control client-side; the server contract is unchanged

`POST /workspaces/:id/reset` keeps requiring `confirm: "RESET"` and a valid
`prNumber`, and keeps returning 400 otherwise. The console adds the input that
produces that body: an operator types `RESET` in the danger zone, which enables the
button. The server-side check remains the authority — the client gate is
usability, not enforcement.

The danger zone stays a separate `<section>` with its own visual treatment, per the
*Destructive actions* requirement.

### D9: Log filtering happens on the client over the existing endpoint

`GET /jobs/:id/log` already returns the job's redacted entries as JSON. The log
viewer fetches it and filters by level and text in the browser. A job's entry count
is bounded by its own lifecycle, so this needs no pagination and no new query
parameters.

*Alternatives considered.* Server-side filter parameters — more routes and more SQL
for a list that is already small and already fetched.

### D10: Every new query path goes through the redactor

`queries.ts` returns models already passed through `createRedactor`, rather than
leaving redaction to the views. Each new surface — command ingestion (author logins,
refusal reasons), operator actions (`detail` JSON), attempt fields — is a new path
that could leak a configured secret, and the current code applies redaction at
several different call sites. Centralising it in the query layer makes the
guarantee structural instead of per-call-site discipline.

## Risks / Trade-offs

- **Two existing test assertions pin markup this change necessarily replaces** —
  `tests/console.test.ts:176` matches the literal
  `Orchestrator status: <strong>running</strong>` (replaced by real health per D5)
  and `tests/console.test.ts:208` matches the copy `typing RESET` (replaced by the
  actual confirmation control per D8). → Both revisions are declared in
  `proposal.md` and scheduled as explicit tasks, not discovered during
  implementation. Every other assertion in that file — `Attempt 1`, `Attempt 2`,
  `Review feedback`, `Validation results`, `Structured log`,
  `Destructive actions`, `agent-nonzero-exit`, `validation-failed`, `workspace-2`,
  `abc123`, `discussion_r101`, and both redaction assertions — is preserved by
  keeping those headings and strings in the redesigned views.
- **The unauthenticated asset routes widen the pre-auth surface** → Constrained
  normatively in the spec (fixed content, no parameters, no data) and structurally
  by D6: the responses are compile-time constants, so there is no code path by
  which request state could reach them.
- **A held-open SSE connection can leak resources if teardown is missed** →
  Subscription removal on `close` and on `error`, a single shared ticker rather
  than per-connection loops (D3), and an assertion that the ticker stops when the
  last subscriber disconnects.
- **`reply.hijack()` bypasses Fastify's lifecycle, including the error handler** →
  Stream writes are wrapped so a write failure detaches the subscriber rather than
  raising into an unhandled rejection; the `onRequest` auth hook still runs before
  hijack, so authentication is unaffected.
- **The streaming loop is not reachable by `app.inject`** → `?snapshot=1` remains
  the injected path and keeps its coverage; the held-open behaviour is covered by a
  separate test against a real ephemeral listener with a timeout, so the untestable
  gap is the transport, not the change detection.
- **A new view could bypass redaction and render a secret** → D10 moves redaction
  into the query layer, and the existing "no secret appears in the body" assertions
  are extended to the new routes.
- **More client JavaScript means more that can break with the page still rendering**
  → Views render complete and correct without the script: fragment swapping and log
  filtering are enhancements over server-rendered HTML, and the reset control fails
  closed (the button stays disabled) rather than open.
- **A redesign is a large diff over a working console** → The HTTP contract is held
  constant except where the specs change, so the change is reviewable route by
  route; `queries.ts` extraction lands before any view work so data access and
  presentation are not rewritten in the same step.

## Migration Plan

No data migration and no configuration change. `gremlyn.yaml` is untouched; the
console keeps its host, port and `token_env` settings.

Rollback is reverting the commit — the database is only read, so a rolled-back
console reads the same rows the redesigned one did.

The `README.md` connectivity-check section describes the dashboard an operator
should see after signing in and needs updating to match the redesigned views.
