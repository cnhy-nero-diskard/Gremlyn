## Why

The console's core controls are native and visibly focused, but authentication, navigation, responsive data views, and live-region replacement still create avoidable barriers for keyboard and assistive-technology users. The same page-level status channel also announces routine heartbeats alongside meaningful outcomes, making the interface harder to follow during active operations.

## What Changes

- Turn sign-in into a semantic form that submits with Enter, autofocuses the token input, associates invalid/expired-session errors with it, and clears submitted secret text after an attempt.
- Render unauthenticated pages without authenticated navigation; add active-page navigation with `aria-current` and an explicit sign-out control after authentication.
- Replace the browser cookie that contains the configured console token with a finite-lived opaque server-side session handle, while preserving direct bearer-token authentication, loopback defaults, route protection, and redaction. Submitted token values are never placed in URLs, HTML, cookies, browser storage, logs, or audit records.
- Detect expired browser sessions, clear the obsolete cookie, and return the operator to sign-in with a non-secret explanation instead of leaving controls to fail silently.
- Add meaningful captions and scoped headers to Commands, Audit, and validation-result tables, contain wide tables, and transform rows into labeled readable cards at narrow widths without hiding data or requiring horizontal page scrolling.
- Reconcile SSE fragments by stable identity so focused controls, selection, expanded state, scroll context, and unchanged DOM landmarks survive updates; define a safe focus fallback only when the focused item is actually removed.
- Separate persistent visible state from narrowly scoped ARIA announcements. Announce meaningful connection transitions, action outcomes, validation failures, and newly relevant operational changes once; suppress heartbeats, elapsed-time ticks, unchanged rerenders, and duplicated messages.
- Preserve native controls, visible focus, reduced-motion behavior, text-bearing statuses, token authorization, loopback binding, output/secret redaction, and the framework-free server-rendered client with no new build system.
- Use WCAG 2.2 AA-oriented keyboard, focus, naming, structure, reflow, contrast, and status-message acceptance checks as concrete targets without claiming certification or exhaustive conformance.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Improve authentication/session UX, navigation semantics, accessible responsive data tables, live-update focus stability, and signal-focused announcements while preserving console security boundaries.

## Impact

- Authentication hooks and routes in `src/console/server.ts`, with an in-memory opaque session registry and explicit sign-out/expiry responses; no database migration or durable token storage.
- Shared layout, sign-in, Commands, Audit, validation-table, and responsive styles under `src/console/views/` and `src/console/assets.ts`.
- The shared SSE fragment reconciler and announcement helpers used by dashboard, job, Commands, and Audit surfaces. Repository-card drafts, job safety progress, and contextual recovery feedback from related active changes use the same keyed update and announcement conventions rather than separate global channels.
- Console tests for route protection, session lifecycle, secret non-disclosure, semantic markup, keyboard submission, responsive structure, focus preservation, and announcement deduplication.
- No client framework, bundler, external session service, authentication-provider change, or claim of WCAG certification.
