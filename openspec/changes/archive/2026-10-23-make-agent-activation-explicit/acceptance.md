# Agent activation acceptance

## PR 19 source-selection follow-up (2026-10-23)

Both findings from review 5617636946 are addressed:

- Source switches to managed now parse and validate the complete saved profile
  inside the selection transaction, after checking the reviewed revisions.
  Corrupt definitions return a safe HTTP 422 without changing the selection,
  profile bytes, or audit, and without notifying the runtime. The source picker
  preserves the refused draft and offers team replacement or another source.
- Runtime notification failures after a source change commits now return
  success with authoritative selection/revision context and a scoped refresh
  warning. The client reconciles the saved baseline, reports the refresh
  problem, and leaves Apply disabled until another deliberate edit; it does
  not claim the save failed or require a stale resubmission.

Three new regressions exercise malformed and schema-invalid profiles under
default/native sources, the dashboard source-picker refusal flow for both
sources, and rejecting runtime notification for default/native/managed changes.
The selection/store/client batch passed **44/44**, and the related workflow,
activation, job-capture, and profile-console batch passed **98/98**.
The full suite passed **1,242 tests, 3 skipped, 0 failed** (1,245 total).
Build, lint, scoped Prettier, strict OpenSpec validation, and whitespace checks
passed. No GitHub Actions runs or commit status checks were attached to the
reviewed PR head; validation results are local.

Browser acceptance and live provider delegation were not repeated for this
follow-up. The client-flow tests run the shipped script against an offline
Fastify server and temporary stores. The retained checkout also contains
pre-existing uncommitted CLI-pin updates in `README.md` and `src/agent/cline.ts`;
those changes are preserved and excluded from this follow-up.

## PR 19 review follow-up (2026-10-23)

Both findings from review 5617417367 are addressed:

- Workflow presentation now forwards the roster's active flag, and immediate
  activation/source changes update enabled-child labels and availability tokens
  together. Disabled children stay disabled, without waiting for SSE.
- A corrupt profile still returns a scoped HTTP 422, with coherent revision and
  selection context plus a replacement template. The editor explicitly warns
  that replacement discards the corrupt definition, requires review and a
  **Replace team** or **Replace and activate** confirmation, and preserves the
  selected source for replacement-only saves. Opening/canceling writes nothing.
  Raw corrupt bytes are never returned. Conflicts preserve the draft and require
  deliberate baseline reload; live updates retain the replacement warning.

Five new regressions cover both roster transitions, refusal without authoritative
recovery context, and corrupt default/managed replacement with save-only or
combined activation, authentication, cancellation, conflicts, and live swaps.
The final editor/dashboard batch passed **77/77** tests, and the selection-console
suite passed **29/29**. The full suite passed **1,239 tests, 3 skipped, 0 failed**
(1,242 total). Build, lint, scoped Prettier, strict OpenSpec validation, and
whitespace checks passed.

No browser was connected in this session, so visual acceptance was not repeated.
The new flows execute the shipped client script against an offline Fastify server
and temporary stores; they do not establish live provider/delegation acceptance.

## Scope and fixtures

Acceptance uses temporary SQLite stores, fixture agent definitions, and an
offline console. No live provider invocation, GitHub mutation, publication,
starter-roster change, or external OpenCode-definition change is exercised or
claimed. Browser fixtures, profiles, logs, and screenshots are kept under the
approved external temporary directory, not in the repository.

## Automated verification

- Baseline suite: 1,117 passed, 3 skipped, 0 failed (1,120 total).
- Workflow-query suite: 23/23 passed. Covers alias-aware activation state,
  corrupt/missing definitions, repository-isolated latest launched identity,
  unknown identities, deterministic ordering, immutable legacy capture,
  current-attempt identity, explicit-primary discrepancies, and redaction.
- Backend activation and offline integrated flow: 27/27 passed. Covers both
  baselines, full validation, transactional write/audit rollback, executor
  revalidation, strict authenticated/scoped requests, no-op activation,
  authoritative save-only feedback, notification failure after commit,
  complete before/after captures, and old managed-job retry after restart.
- Job identity/query/delegation/selection batch: 93/93 passed, including 13 new
  job-view tests. Covers captured/default/native/managed identity, current retry
  not started, newest unknown identity, discrepancies, unavailable current
  settings, observed child counts, parent exclusion, incomplete observation,
  non-OpenCode limited data, and preserved invocation history.
- Full suite after review fixes: **1,231 passed, 3 skipped, 0 failed** (1,234 total).
  Subsequent reload-serialization and readable-team refinements added three
  regressions and were verified by the final focused batch, build, and lint.
- Final dashboard/reflow/stream/integrated-flow/profile-console batch:
  **61/61 passed**. These include frozen dual baselines, operation intent,
  explicit conflict recovery, scoped feedback, in-flight state identity,
  unrelated SSE-region draft preservation, stable focus actions, and live
  launch/identity/model refresh without unrelated writes.

## Browser acceptance

The first browser pass used a headless Chrome CDP session with an authenticated
offline console. Desktop light/dark screenshots showed the visible workflow
status, historical identity, and activation/edit/change actions without opening
configuration details.

That pass found defects requiring correction before acceptance:

- Profile drafts were erased when unrelated partial SSE regions restored a
  globally captured editor map.
- Very narrow layout reflow overflowed because source selectors retained a
  14rem minimum width; nested horizontal padding also left the workflow too
  narrow to read comfortably.
- Author display rules overrode the HTML `hidden` state on conditional controls.

The completed Chrome 154 offline confirmation matrix used physical widths
1,440 and 360 in both themes at scale 1 and scale 2, emulating 200% layout zoom
with a halved CSS viewport and doubled device scale (720 and 180 CSS px).
This tests reflow; CSS body zoom or pinch zoom alone is not counted as
layout-zoom acceptance. All eight cases had no document overflow or clipped
workflow text/actions. At the most constrained 180-CSS-pixel viewport, workflow
cards measured 113 CSS pixels wide with 95 CSS pixels of paragraph space;
long primary names wrap rather than forcing horizontal scrolling. Screenshot
review confirmed readable status and action text, with substantial vertical
scrolling expected at this extreme width.

Keyboard acceptance passed review, combined activation, conflict refusal,
deliberate baseline reload, and activate-saved while an unsaved draft remained
intact. Successful outcomes use scoped status announcements. Actual SSE updates
preserved fields, frozen baselines, focus, and feedback; live job-model evidence
updates preserved expanded invocation details and summary focus. An old default
job continued to show captured default and actual `build` after activation.

Additional defects corrected during confirmation included disabled conflict
recovery after a response, loss of in-flight state-object identity during SSE,
unstable workflow action focus, and missing ticker refresh for late invocation
identity/model evidence. Automated regressions cover these corrections.

Final read-only review also found stale-DOM activation baseline reload and
source-conflict recovery incorrectly dependent on successful native discovery.
Activation reload now fetches coherent authoritative revisions and names the
stored primary/source; an absent saved team remains refused. Selection reload
uses persisted context even if advisory discovery fails or is pending, preserves
the draft, and serializes pending reloads against apply/cancel. Editor mounting
trusts authoritative inactive state rather than stale DOM, and immediate workflow
updates synchronize the visual-state token. These final corrections were tested
automatically; the browser matrix and keyboard run preceded them.

Limits: acceptance uses fixture-only data and CDP keyboard interaction, not a
screen-reader session or a physical mobile device. It establishes accessible
status markup, keyboard recovery, and layout reflow, not live delegation.

## Final handoff checks

Build, lint, strict OpenSpec validation, and whitespace checks passed. Prettier
passed for authored assets/stream, new tests, README, and this evidence file.
The authored dashboard workflow/roster range was formatted; whole-file formatting
failures for dashboard and the existing profile-console test were reproduced
from HEAD and were not expanded into unrelated churn.

The Impeccable mechanical detector was run once over assets, dashboard, and job
views. It reported three existing side-accent-border warnings (failure/status
and invocation styling), not activation correctness or reflow errors; these
unrelated styles were retained. Temporary fixture processes are stopped at
handoff; no fixture assets or screenshots are committed.
