## MODIFIED Requirements

### Requirement: Console access is restricted to the local host

The system SHALL bind its HTTP interface to a loopback address by default and SHALL
require authentication for every request that reads job data, reads configuration
or operational state, or invokes an operator action. Authentication SHALL accept
the configured token directly as a bearer token and SHALL accept an unexpired
browser session that was created by successfully presenting that token.

Binding to a non-loopback address SHALL require explicit configuration and SHALL
still require authentication.

The system MAY serve the sign-in view and static presentation assets without
authentication. Such content SHALL be fixed, SHALL disclose no job data,
configuration, operational state, token, session handle, or secret value, and
SHALL NOT accept parameters that vary its content except a bounded non-secret
reason for returning to sign-in.

A successful browser sign-in SHALL create a finite-lived, unpredictable opaque
session handle. The browser cookie SHALL contain only that handle, SHALL be
unreadable to client script, and SHALL use same-site protection. The configured
token or submitted token value SHALL NOT be copied into a URL, rendered markup,
cookie, browser storage, log, operator audit record, or session record. The token
field SHALL be cleared after each sign-in attempt and SHALL never be backfilled.

Signing out SHALL invalidate the current browser session and expire its cookie.
An expired or invalid browser session SHALL disclose no protected data, SHALL be
cleared, and SHALL lead the operator to sign-in with a non-secret explanation.
Direct bearer-token authentication SHALL remain available and SHALL NOT
implicitly create or persist a browser session.

#### Scenario: Request without a token

- **WHEN** a request is made to any console or API route that reads job data,
  configuration or operational state, or invokes an operator action, without a
  valid bearer token or unexpired browser session
- **THEN** the request is rejected and no job data is disclosed and no action is
  performed

#### Scenario: Default binding is not externally reachable

- **WHEN** the orchestrator starts with default configuration
- **THEN** its HTTP interface is reachable only from the local host

#### Scenario: Unauthenticated request for a static asset

- **WHEN** a static presentation asset is requested without a token
- **THEN** it is served, and its content contains no job data, no configuration
  value, no operational state and no secret value

#### Scenario: Browser sign-in creates an opaque session

- **WHEN** an operator submits the correct console token through the sign-in form
- **THEN** the browser receives an opaque finite-lived session cookie that does not contain the configured token, and the token field is cleared

#### Scenario: Submitted token is not retained

- **WHEN** a browser sign-in succeeds or fails
- **THEN** the submitted token does not appear in a URL, response markup, cookie, browser storage, log, audit record, or server-side session record

#### Scenario: Direct bearer authentication remains available

- **WHEN** an API caller supplies the configured bearer token
- **THEN** the protected request is authorized without creating a browser-session cookie

#### Scenario: Operator signs out

- **WHEN** an authenticated operator invokes Sign out
- **THEN** the current browser session is invalidated, its cookie is expired, and a later protected request using it is rejected

#### Scenario: Browser session expires

- **WHEN** a protected navigation, mutation, or live-update connection uses an expired browser session
- **THEN** no protected data is returned, the obsolete cookie is cleared, and the operator is directed to sign-in with an expired-session explanation that contains no secret

### Requirement: Live progress

The console SHALL reflect status changes and newly captured agent output for
running jobs without requiring a manual page reload.

Updates SHALL reconcile content by stable identity and SHALL change only the
elements whose content or state changed. An update SHALL NOT discard the
operator's reading position, keyboard focus, text selection, form draft,
expanded sections, scroll position, or typed confirmation while the corresponding
item still exists. Stable landmarks and unchanged records SHALL remain in the DOM
so an assistive-technology virtual cursor is not reset by an unrelated update.

If an update removes the focused item, the console SHALL move focus to a stable,
logical fallback at the affected region and SHALL explain that removal once. The
dashboard SHALL likewise reflect newly queued, started and completed jobs without
a manual page reload.

Persistent visible state and assistive-technology announcements SHALL remain
separate. Meaningful connection transitions, invoked-action outcomes, validation
failures, and newly relevant operational-state changes SHALL be announced once in
the narrowest applicable status region. Routine heartbeats, elapsed-time ticks,
unchanged rerenders, transcript append noise, and repeated copies of an unchanged
message SHALL NOT be announced. An announcement SHALL NOT move focus unless the
focused item was removed.

#### Scenario: Following a running job

- **WHEN** an operator views a running job
- **THEN** status transitions and new agent output appear as they occur

#### Scenario: Reading output while it is being appended

- **WHEN** an operator has scrolled through captured output, expanded a section, or
  typed into a confirmation control, and the job then changes
- **THEN** the changed content updates and the scroll position, the expanded
  section and the typed text are preserved

#### Scenario: Watching the queue drain

- **WHEN** an operator views the dashboard while queued jobs start and complete
- **THEN** those transitions appear without a manual page reload

#### Scenario: Elapsed time advances while nothing else changes

- **WHEN** an operator watches a running job and no new status, output, or log
  activity is recorded
- **THEN** the job's elapsed duration and relative timestamps continue to advance

#### Scenario: Polling stops without any other activity

- **WHEN** repository polling stops producing results and no other activity is
  recorded
- **THEN** the console reports the orchestrator as stale without a manual reload

#### Scenario: Repository configuration changed elsewhere

- **WHEN** a repository's provider, model, reasoning effort, or timeout is changed
- **THEN** an open console reflects the new values without a manual reload

#### Scenario: Ingestion and audit views stay current

- **WHEN** a command is ingested or an operator action is recorded
- **THEN** the command ingestion view and the operator audit view show it without
  a manual reload

#### Scenario: Focused control survives an unrelated update

- **WHEN** an SSE update changes one record while the operator is focused in a different record or control that still exists
- **THEN** the focused DOM node, its value and selection, and its surrounding landmark remain stable

#### Scenario: Focused item is removed

- **WHEN** an SSE update removes the item containing keyboard focus
- **THEN** focus moves to the affected region's stable heading or next logical item and one visible, announced message identifies what changed

#### Scenario: Virtual-cursor context remains stable

- **WHEN** an assistive-technology user is reading an unchanged record and another keyed record updates
- **THEN** the unchanged record and containing landmark are not replaced and the reading context is not reset to the start of the region

#### Scenario: Heartbeat and timer updates stay quiet

- **WHEN** a heartbeat, elapsed-time tick, transcript append, or identical fragment arrives without a meaningful state transition
- **THEN** no ARIA live announcement is generated and persistent connection or action feedback is not replaced

#### Scenario: Meaningful transition is announced once

- **WHEN** connection health changes, an invoked action completes or fails, validation fails, or an operational state becomes newly actionable
- **THEN** one scoped announcement identifies the affected connection, action, validation, or state without moving focus

## ADDED Requirements

### Requirement: Sign-in and authenticated navigation are explicit and accessible

The sign-in control SHALL be a semantic form with a labelled password input and
submit button. Submitting with Enter or activating the button SHALL perform the
same POST operation. The token input SHALL receive initial focus, SHALL request no
application-managed persistence, and SHALL be associated with invalid-token and
expired-session errors through programmatic description and invalid state.

The unauthenticated sign-in page SHALL NOT render links to protected destinations
or a sign-out control. Authenticated pages SHALL provide a consistently named
primary navigation region, mark exactly the current destination with
`aria-current="page"`, and provide an explicit Sign out control.

#### Scenario: Sign-in submits with Enter

- **WHEN** focus is in the token input and the operator presses Enter
- **THEN** the sign-in form submits the token by POST exactly as the Sign in button does, without placing it in the URL

#### Scenario: Invalid token is associated with the input

- **WHEN** sign-in is refused
- **THEN** focus remains on or returns to the cleared token input, the input is marked invalid, and a non-secret error is programmatically associated with it

#### Scenario: Expired session returns to sign-in

- **WHEN** a browser session expires during authenticated use
- **THEN** the operator reaches the sign-in form with focus in the token input and an associated explanation that the session expired

#### Scenario: Protected navigation is absent before authentication

- **WHEN** an unauthenticated operator views sign-in
- **THEN** Dashboard, Commands, Audit, and Sign out controls are not rendered

#### Scenario: Current destination is exposed

- **WHEN** an authenticated operator views Dashboard, Commands, Audit, or a job detail page
- **THEN** the primary navigation identifies the applicable current destination with `aria-current="page"` and does not mark inactive destinations current

### Requirement: Operational data tables are structured and responsive

Commands, Operator Audit, and validation-result tables SHALL have a meaningful
caption and column headers with explicit scope. Their purpose and empty state SHALL
remain understandable without relying on visual position alone.

Each table SHALL be contained so long values cannot create horizontal scrolling
for the whole page. At narrow viewport widths the data SHALL reflow into readable
record cards whose visible field labels match the table headers, without omitting,
reordering ambiguously, or duplicating content for assistive technology. When
horizontal scrolling remains necessary for intrinsically wide content, only the
table container SHALL scroll and it SHALL be keyboard reachable with an
accessible name.

#### Scenario: Table structure is programmatically available

- **WHEN** an operator navigates the Commands, Audit, or validation results with table commands
- **THEN** the table exposes its purpose through a caption and each data cell is associated with a scoped column header

#### Scenario: Commands and Audit reflow at a narrow width

- **WHEN** the Commands or Audit view is rendered at 320 CSS pixels wide
- **THEN** each record becomes a labelled readable card, every original field remains available, and the page itself does not require horizontal scrolling

#### Scenario: Validation results reflow at a narrow width

- **WHEN** validation results are rendered at 320 CSS pixels wide or at 400 percent zoom from a 1280 CSS-pixel viewport
- **THEN** command, exit code, duration, and output controls remain labelled, readable, and operable without overlap or page-level horizontal scrolling

#### Scenario: Long content is contained

- **WHEN** a command, target, detail, model identifier, or validation output is wider than its available cell
- **THEN** it wraps or scrolls within the labelled record or table container without clipping controls or widening the page

### Requirement: Core console interaction has a concrete accessibility acceptance baseline

All console functionality SHALL remain operable by keyboard without a trap and
SHALL use native controls where a native semantic exists. Interactive controls
SHALL have an accessible name, logical focus order, and a visible focus indicator
that is not removed by live updates. Information and status SHALL be conveyed by
text in addition to color, shape, or motion.

Normal text SHALL meet a contrast ratio of at least 4.5:1, large text at least
3:1, and focus indicators and meaningful non-text UI boundaries at least 3:1
against adjacent colors. With reduced motion requested, nonessential animation
and smooth movement SHALL be removed without hiding state changes.

These checks SHALL be treated as WCAG 2.2 AA-oriented acceptance targets for the
implemented console surfaces; passing them SHALL NOT be presented as third-party
certification or exhaustive conformance.

#### Scenario: Keyboard-only operation

- **WHEN** an operator uses only sequential keyboard navigation and activation
- **THEN** sign-in, navigation, table details, repository controls, job actions, confirmations, and sign-out are reachable, visibly focused, and operable without a trap

#### Scenario: Status does not rely on color

- **WHEN** the console presents health, job, validation, connection, action, or failure state
- **THEN** a textual label or explanation conveys the state independently of color, icon shape, or animation

#### Scenario: Reduced motion is requested

- **WHEN** the user agent reports a reduced-motion preference
- **THEN** nonessential animation and smooth transitions are disabled while all state changes remain visible and understandable

#### Scenario: Contrast acceptance is checked

- **WHEN** default light or dark console colors and focus states are evaluated
- **THEN** text, focus indicators, and meaningful non-text UI meet their stated contrast thresholds
