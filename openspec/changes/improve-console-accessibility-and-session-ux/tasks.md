## 1. Opaque Browser Sessions

- [x] 1.1 Add the injectable eight-hour in-memory session store using random handles and digest-keyed records; verify unit tests cover create, validate, absolute expiry, revocation, lazy pruning, process-local clearing, and absence of configured/submitted token values from every session record.
- [x] 1.2 Replace raw-token cookie authentication with `gremlyn_console_session` cookie validation while retaining direct bearer authorization; verify route tests assert HttpOnly/SameSite/Path/Max-Age attributes, HTTPS-only Secure behavior, no token substring in the cookie, and no cookie minted by bearer requests.
- [x] 1.3 Support JSON and form-encoded `POST /auth` with generic constant-time token validation and opaque session creation; verify tests cover success, refusal, 303 browser redirect, JSON compatibility, empty response secrets, and no token in URLs, markup, headers other than the request, logs, audit records, or persisted data.
- [x] 1.4 Add POST sign-out, bounded public session-status probing, and expired-session handling for document, JSON/mutation, and SSE reconnect paths; verify fake-clock tests cover revocation, cookie expiry, protected-data refusal, non-secret `expired`/`signed-out` reasons, and direct bearer access after browser sign-out.
- [x] 1.5 Clear all in-memory sessions during console shutdown without changing SSE drain behavior; verify lifecycle tests close the server cleanly and previously issued session handles fail in a rebuilt server.

## 2. Sign-In and Navigation Semantics

- [x] 2.1 Render sign-in as a native POST form with labelled autofocus password input, no initial/backfilled value, `autocomplete="off"`, and an associated error element; verify markup tests and a keyboard acceptance check show Enter and button activation submit the same POST without placing the token in the URL.
- [x] 2.2 Re-render invalid-token and expired-session states with the token cleared, focus returned, `aria-invalid`, and programmatic error association; verify route/markup tests assert only whitelisted non-secret messages and no submitted token in the response.
- [x] 2.3 Split authenticated and unauthenticated shells so sign-in contains no protected links or sign-out control; verify unauthenticated HTML excludes Dashboard, Commands, Audit, job data, operational state, and session/token values.
- [x] 2.4 Add a consistently labelled primary navigation, current-section mapping, `aria-current="page"`, and native POST Sign out control to authenticated pages; verify Dashboard, job detail, Commands, and Audit rendering tests mark exactly the applicable link and keyboard order remains logical.

## 3. Accessible Responsive Data Tables

- [x] 3.1 Add a shared responsive table/container convention with visible captions, `scope="col"`, stable row keys, matching cell `data-label` values, and labelled overflow behavior; verify render-helper tests reject missing/duplicate labels or keys.
- [x] 3.2 Apply the convention to Commands and Operator Audit, including empty states and long reason/detail values; verify console tests assert complete field coverage, correct header associations, and unchanged links/status text.
- [x] 3.3 Apply the convention to validation results without breaking output `<details>`, exit-code text, command display, or redaction; verify validation-table tests cover empty, passed, failed, retained-output, missing-output, and secret-redacted rows.
- [x] 3.4 Add narrow-card and overflow containment CSS with safe wrapping and conditional keyboard focus for actual overflow; verify browser checks at 320 CSS pixels and 400 percent zoom show no page-level horizontal scroll, clipped controls, ambiguous labels, or duplicated assistive content on all three tables.

## 4. Stable Live Reconciliation

- [ ] 4.1 Add unique stable live keys and focus-fallback anchors to dashboard repositories/jobs, Commands, Audit, job attempts, validation rows, and shared live panels; verify server-render tests assert key uniqueness and deterministic identity from persisted ids.
- [ ] 4.2 Implement the dependency-free keyed fragment reconciler that reuses unchanged nodes and updates/inserts/removes keyed content in server order; verify a browser fixture proves an unchanged record and landmark keep object identity while a sibling changes.
- [ ] 4.3 Preserve focused controls, selection ranges, form/confirmation text, details state, and scroll anchors across keyed updates; verify browser scenarios cover job controls, reset confirmation, table details, log filters, and repository fields without focus jumps or lost input.
- [ ] 4.4 Add removal fallback behavior that focuses the next logical record or region heading only when the focused record disappears; verify the fixture removes a focused row, observes one contextual announcement, and confirms unrelated updates never move focus.
- [ ] 4.5 Expose reconciliation hooks for repository baseline/draft/latest state, contextual action feedback, and keyed job-safety steps; verify compatibility fixtures preserve a settings draft/conflict, local recovery message, and virtual-cursor context while related fragments update.

## 5. Scoped Status and Announcement Channels

- [ ] 5.1 Replace the shared mutation/heartbeat status node with persistent connection, local action/settings, and hidden operational announcement channels; verify markup tests assert correct roles, labels, and absence of nested or competing live regions.
- [ ] 5.2 Add deduplication keyed by semantic event and transition so connected/reconnecting/disconnected, action outcomes, validation failures, and newly actionable states announce once; verify unit tests cover repeated payloads and changed event keys.
- [ ] 5.3 Suppress announcements for heartbeats, elapsed-time refreshes, transcript appends, unchanged fragments, and repeated recovery recommendations; verify negative tests leave announcement text/event counts unchanged while persistent visible state remains accurate.
- [ ] 5.4 Route expired-session responses to sign-in before local action feedback and keep all other redacted failures beside their originating control; verify settings, toggle, retry, cancel, reset, and session-expiry scenarios do not overwrite connection status or one another.

## 6. AA-Oriented Acceptance and Regression

- [ ] 6.1 Add automated structural and color-token contrast checks for accessible names, one current navigation item, visible focus, 4.5:1 normal text, 3:1 large text/non-text/focus boundaries, text-bearing statuses, and reduced-motion overrides; verify the focused accessibility tests pass in light and dark themes.
- [ ] 6.2 Exercise keyboard-only sign-in, primary navigation, Commands/Audit records, validation details, repository editing, job actions, typed reset confirmation, and sign-out; verify every control is reachable, visibly focused, operable without a trap, and retains focus through representative SSE updates.
- [ ] 6.3 Exercise 320-pixel/400-percent reflow, reduced-motion emulation, session expiry, reconnect, action failure, and live-update removal in a real browser; record checked routes/states and describe results as AA-oriented acceptance rather than certification.
- [ ] 6.4 Run `node --import tsx --test tests/console.test.ts tests/provider-catalog.test.ts`, `npm run build`, `npm run lint`, `npm run format:check`, and `npm test`; verify all commands pass without adding a client framework, bundler, or runtime dependency.
- [ ] 6.5 Run `openspec validate improve-console-accessibility-and-session-ux --strict` and `git diff --check`; verify the change remains spec-valid and whitespace-clean after implementation.
