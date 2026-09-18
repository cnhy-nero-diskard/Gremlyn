## Context

See `proposal.md` — Why and `specs/operator-console/spec.md` for observable behavior. The console is server-rendered Fastify HTML with one framework-free client script. Authentication currently accepts a bearer token or a cookie containing that same configured token; bearer requests also mint the raw-token cookie. Sign-in is a labelled password input plus click handler rather than a form, every layout renders protected navigation, and there is no sign-out or finite server-side browser session.

Commands, Audit, and validation results are semantic tables but lack captions, scoped headers, and narrow-width treatment. SSE fragments are installed with region-wide `innerHTML`, followed by manual restoration of some form, details, and scroll state. One global status node mixes heartbeats, connection failure, action progress, and mutation results.

Three active proposals share this boundary: `stage-repository-settings-edits` needs repository-keyed draft preservation and card-local feedback; `guide-operator-error-recovery` needs persistent contextual action feedback plus deduplicated meaningful announcements; `surface-job-safety-progress` adds a live-updating keyed job rail. This design provides shared reconciliation and announcement primitives rather than parallel global mechanisms.

## Goals / Non-Goals

**Goals:**

- Remove the configured token from browser persistence while keeping token-based authorization and loopback defaults.
- Make session creation, expiry, and sign-out explicit, testable, and secret-safe.
- Establish one layout/navigation contract for authenticated and unauthenticated views.
- Give all three tabular surfaces reusable semantic and responsive rendering conventions.
- Replace destructive region swaps with a small stable-key reconciler that other active console work can extend.
- Establish scoped visible feedback and deduplicated announcement channels with concrete keyboard, reflow, contrast, and reduced-motion checks.

**Non-Goals:**

- Replacing the configured console token, adding user accounts, roles, OAuth, CSRF tokens, or a durable/external session service.
- Persisting browser sessions across orchestrator restarts or extending them on activity.
- Adding a client framework, bundler, hydration layer, accessibility widget, or runtime accessibility dependency.
- Reworking operator authorization, action availability, redaction, repository settings semantics, job evidence, or recovery policy owned by related changes.
- Claiming WCAG certification or exhaustive conformance from focused acceptance checks.

## Decisions

### D1 — Use finite, in-memory opaque browser sessions

Introduce a console-local session store backed by a `Map` keyed by a SHA-256 digest of a 32-byte cryptographically random handle. The raw handle exists only in the HttpOnly browser cookie; the session record contains its digest and absolute expiration, never the configured token. Sessions use a fixed eight-hour absolute lifetime, do not slide on activity, disappear on process restart, and are lazily pruned during lookup/creation. Inject clock and randomness for deterministic tests.

Rename the browser cookie to `gremlyn_console_session` and set `HttpOnly`, `SameSite=Strict`, `Path=/`, and a matching `Max-Age`; add `Secure` when the console is served over HTTPS without making loopback HTTP unusable. A sign-out POST deletes the digest and returns an expired cookie. A server close clears the in-memory map.

The request hook accepts either an exact configured bearer token or a valid session handle. Bearer authorization does not mint a cookie. Compare submitted/bearer token bytes without logging or interpolating them, and keep all error messages generic. This preserves API usage while preventing the browser from retaining the configured secret.

*Alternative considered:* encrypt or hash the configured token into a long-lived cookie. That still makes possession of the cookie equivalent to the configured credential indefinitely and provides no revocable finite browser-session lifecycle.

### D2 — Make authentication work as an ordinary POST form

Render sign-in with `<form method="post" action="/auth">`, an autofocus password input, `autocomplete="off"`, an initially empty `value`, and an associated error element. Accept both form-encoded and existing JSON POST bodies so tests/API compatibility remain intact. A successful browser form submission creates the session and responds with a 303 redirect to `/`; failure re-renders sign-in with a generic associated error, `aria-invalid="true"`, the input cleared, and focus returned through `autofocus`. Client enhancement may submit with `fetch`, but Enter and non-scripted form submission remain authoritative.

Use only a whitelist of server-chosen sign-in reasons (`invalid`, `expired`, `signed-out`) and never echo arbitrary query text. Protected document navigation with an expired session clears the cookie and redirects to `/auth?reason=expired`; protected JSON/mutation requests return a redacted 401 code. When an SSE connection errors, the client probes a public session-status endpoint that reveals only active/expired/absent and redirects on expiry. No token or session handle is returned by that probe.

Sign out is a native POST form. It invalidates a valid session if present, always expires the cookie, and redirects to the signed-out sign-in state. Direct bearer callers remain stateless.

*Alternative considered:* keep JSON-only sign-in and attach a submit listener to a form. That satisfies Enter only while JavaScript initializes and leaves the semantic form incapable of its declared action.

### D3 — Render authenticated and unauthenticated shells explicitly

Extend the layout input with an authentication state and a current section (`dashboard`, `commands`, or `audit`). The unauthenticated shell renders product identity and `<main>` only. The authenticated shell renders one `<nav aria-label="Primary">`, marks exactly one applicable section with `aria-current="page"` (job detail maps to Dashboard), and includes the POST Sign out form.

Page titles and one top-level heading remain route-specific. This is preferable to hiding protected links with CSS because absent controls cannot be discovered or focused before authentication.

### D4 — Standardize semantic responsive tables

Add a small server-side table wrapper/convention used by Commands, Audit, and validation results:

- a visible, purpose-specific `<caption>`;
- `<th scope="col">` headers;
- stable row keys for live reconciliation;
- `data-label` on each data cell matching its header;
- an accessible labelled overflow container; and
- unchanged single-source content—no duplicate desktop/mobile table.

At narrow widths, CSS visually preserves the header row offscreen and lays each body row out as a bordered record card. Cells become label/value grids using `data-label`; explicit table/row/cell roles remain available if display changes would otherwise weaken browser accessibility mappings. Long code, identifiers, targets, and detail wrap with `overflow-wrap:anywhere`; preformatted validation output scrolls inside its own bounded container. The wrapper owns any remaining horizontal scroll and is keyboard focusable only when overflow exists, toggled by a small resize/overflow check.

*Alternative considered:* render a separate `<dl>` card list for mobile. Duplicate DOM would repeat content to assistive technology, complicate SSE keys, and create two render paths that can drift.

### D5 — Reconcile live HTML by stable identity

Replace region-wide `innerHTML` assignment with a dependency-free keyed reconciler. Server views assign `data-live-key` to repositories, jobs, command rows, audit rows, attempts, validation rows, safety-rail steps, and other repeatable live records. The client parses the incoming fragment in a detached template and reconciles matching element type/key pairs in place, updating attributes and changed descendants while retaining unchanged nodes. New keys are inserted and absent keys removed in server order.

Before reconciliation, capture the active element's stable key/path, text selection, scroll anchors, open details, and registered surface state. Afterward:

- if that exact node still exists, its identity and focus remain untouched;
- if its keyed record remains but the control must be replaced, restore focus and selection to the matching control;
- if the record was removed, focus the region's `data-focus-fallback` heading (temporarily focusable) or the next logical keyed item and announce the removal once;
- unchanged landmarks and records are never replaced solely because a sibling changed.

Expose narrow hooks for stateful surfaces. Repository settings registers its baseline/draft/latest state and reconciles incoming persisted values without losing the draft. Contextual action feedback remains inside its action scope. The job safety rail uses keyed steps so one state label can change without replacing the whole summary.

*Alternative considered:* keep snapshot/restore around `innerHTML`. It can restore values and focus by selector, but still destroys DOM identity and virtual-cursor context for every unchanged node.

### D6 — Separate persistent status from announcements

Use three explicit channels:

1. a persistent visible connection status with a polite live region updated only on connected/reconnecting/disconnected transitions;
2. persistent action/settings feedback beside the originating controls, using polite status for progress/success and assertive alert only for a newly introduced failure; and
3. one visually hidden operational announcer for meaningful non-action state transitions that lack a local channel.

Provide a small `announce(channel, eventKey, message, priority)` helper that suppresses duplicate event keys/messages. Heartbeats update internal freshness only; elapsed timers, transcript appends, identical fragment renders, and repeated recommendations do not call the announcer. Job/status changes announce only when the semantic state changes, not when evidence text rerenders. Visible feedback remains after announcement according to the error-recovery contract.

Mutation 401/session-expired responses short-circuit local action messaging, clear client-only transient state, and redirect to sign-in. Other action failures remain local. This composes with `guide-operator-error-recovery` and `stage-repository-settings-edits` without recreating a global action-status node.

### D7 — Treat AA-oriented checks as an acceptance matrix, not a certification

Retain native controls, the current 3px focus outline, text-bearing status pills, and the reduced-motion media query. Add automated structural assertions for form/nav/table/live-region markup and a small contrast test over committed color-token pairs. Use browser acceptance at 320 CSS pixels and 400% zoom, keyboard-only navigation, and reduced-motion emulation for the named routes and states.

The acceptance report records checked surfaces, viewport/theme/state, and any limitation. It must say “AA-oriented checks passed” rather than “WCAG compliant/certified,” because the focused project checks are not an exhaustive conformance audit.

## Risks / Trade-offs

- **[In-memory sessions end on restart]** → Treat restart as expiry, show the same non-secret sign-in explanation, and keep direct bearer access available for automation.
- **[Eight-hour sessions may expire during long monitoring]** → Redirect cleanly on the next protected request/stream failure and preserve no token; require deliberate reauthentication rather than sliding indefinitely.
- **[Keyed reconciliation can miss an unstable or duplicate key]** → Define keys from persisted identifiers, assert uniqueness in render tests, and fall back to bounded subtree replacement with explicit focus restoration only for the affected subtree.
- **[CSS card tables can weaken semantics in some browser/accessibility combinations]** → Keep one native table DOM, captions/scopes, explicit roles where required, and verify both desktop table navigation and narrow visual reflow manually.
- **[Multiple active proposals touch the client script]** → Land shared reconciliation and announcement primitives first; have repository settings, recovery feedback, and the safety rail register with them rather than implementing their own swap or global-status logic.
- **[Aggressive announcements can recreate the original noise]** → Announce semantic transitions only, deduplicate by event key, and add negative tests for heartbeat, timer, append, and unchanged-render paths.
- **[Autofocus can surprise users returning through browser history]** → Limit it to the dedicated sign-in page and error/expiry rerenders, where the token is the only primary task.

## Migration Plan

1. Add the in-memory session store, opaque cookie, dual bearer/session authorization, form-compatible sign-in, expiry handling, and sign-out while retaining JSON auth compatibility.
2. Split authenticated/unauthenticated shells and add current-section navigation semantics.
3. Add captions, header scope, stable row keys, data labels, and responsive containment/cards to Commands, Audit, and validation results.
4. Introduce the keyed fragment reconciler and migrate existing dashboard/job/commands/audit regions, then expose hooks needed by active repository-settings, recovery, and job-rail changes.
5. Split connection, local action, and operational announcement channels and remove heartbeat/timer/unchanged-render announcements.
6. Run structural, security, live-update, contrast, keyboard, zoom/reflow, reduced-motion, and secret-non-disclosure acceptance checks.

Rollback can restore stateless raw-token-cookie browser authentication only as a code rollback; no session or token data requires migration because new sessions are memory-only. A safer partial rollback keeps the opaque session layer and reverts presentation/reconciliation independently.
