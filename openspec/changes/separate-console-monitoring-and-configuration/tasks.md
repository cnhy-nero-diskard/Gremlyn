## 1. Navigation and Query Foundations

- [ ] 1.1 Reconcile this implementation onto the completed `stage-repository-settings-edits` contract, treating its four-field compare-and-set endpoint and repository-keyed client state machine as the baseline; verify all staged-settings focused tests pass before moving any editor markup
- [ ] 1.2 Register explicit Monitor and Repositories destinations with the authenticated-shell/current-section contract from `improve-console-accessibility-and-session-ux`, and verify route rendering tests assert exactly one `aria-current="page"` link on dashboard, job-detail, repository, Commands, and Audit views
- [ ] 1.3 Add normalized typed filter models for dashboard `repository`/`job` criteria and repository `q`/`enabled` criteria, and verify unit tests cover absent, valid, malformed, repeated, whitespace-only, and escaped wildcard input
- [ ] 1.4 Split dashboard job reads into complete active and queued queries plus a bounded recent-terminal query, applying repository and job predicates before limits; verify a seeded older job is returned by identifier/PR filtering while unfiltered recent history remains bounded

## 2. Monitoring-First Dashboard

- [ ] 2.1 Replace full dashboard editors with compact read-only repository summaries showing enabled state, agent, provider/model, effort, timeout, validation count, and a stable `/repositories#repository-<id>` Configure link; verify rendering tests assert the facts and absence of settings/enablement form controls
- [ ] 2.2 Keep observed health followed by running, queued, and recent lanes as the dashboard's primary order, and verify existing health/staleness and per-status lane assertions remain valid after repository controls move
- [ ] 2.3 Add labelled repository and job filter controls with active criteria, result counts, clear action, and distinct configured-empty/no-match states; verify route tests cover repository scoping across all lanes, job/PR/command matching, empty results, and clearing criteria
- [ ] 2.4 Add concise monitoring-versus-configuration guidance and responsive compact-summary styles, and verify desktop and narrow-width fixtures remain scannable without horizontal overflow or hidden status text

## 3. Repository Configuration Surface

- [ ] 3.1 Add authenticated `/repositories` and `/repositories/stream` routes with a dedicated server-rendered view, filtered repository projection, redaction, and stable repository anchors; verify invalid tokens disclose no repository settings and valid requests render the requested filter state
- [ ] 3.2 Extract and move the staged provider/model/effort/timeout editor plus independent enablement action from the dashboard to the repository view without duplicating implementations; verify authoritative/current/mismatch/custom provider cases, effort tiers, metadata capsules, staged Apply/Cancel, conflict review, and enablement tests all pass on the new route
- [ ] 3.3 Add owner/name and enabled-state configuration filters with active criteria, result count, clear action, and no-match state; verify filtering changes no setting and a repository hidden then revealed retains its session draft
- [ ] 3.4 Keep repository-local settings and enablement feedback separate from page-level connection health as required by `guide-operator-error-recovery`; verify mutation failures, conflicts, saves, toggles, reconnects, and heartbeats update only their designated visible/live regions

## 4. Validation-Command Editing

- [ ] 4.1 Add a normalized validation-command snapshot and atomic compare-and-set mutation separate from provider/model/effort/timeout, and verify mutation tests cover add/remove/reorder, argument-boundary preservation, empty executable/argument rejection, stale baseline, and no cross-setting writes
- [ ] 4.2 Add an authenticated repository validation-command endpoint returning 404/400/409/success outcomes, current commands on conflict, one audit record, and exactly one post-commit runtime notification; verify endpoint tests assert no audit or callback on refused writes
- [ ] 4.3 Extend the runtime repository refresh to load validation commands after a successful apply, and verify a newly created job uses the new list while an existing job's recorded validation evidence remains unchanged
- [ ] 4.4 Render an independent validation-command draft with structured argument inputs, reorder/add/remove controls, before/after review, Apply/Cancel, conflict recovery, future-job consequence copy, and repository-local feedback; verify applying or cancelling either repository draft leaves the other draft intact

## 5. Filtered Live Updates and State Preservation

- [ ] 5.1 Make dashboard and repository streams carry normalized surface filters and rerun the same filtered queries as their initial routes, and verify snapshot tests prove SSE fragments never broaden active criteria or return records outside them
- [ ] 5.2 Restart only the current surface's EventSource when filters change, update the visible URL, and preserve a no-script GET fallback; verify browser/client tests cover filter navigation, stream replacement, connection status, and back/forward restoration
- [ ] 5.3 Extend the shared keyed reconciler from `improve-console-accessibility-and-session-ux` with the repository hooks from `stage-repository-settings-edits` to preserve both four-field settings drafts and validation drafts across relevant SSE updates and temporary filter exclusion while still detecting newer authoritative values; verify focus, input, conflict, and unrelated-repository refresh behavior without a second reconciliation engine
- [ ] 5.4 Remove obsolete dashboard editor listeners and selectors without adding global search or keyboard handlers, and verify client tests find no settings mutation path on the dashboard and no filtering behavior outside its owning surface

## 6. Verification

- [ ] 6.1 Run `node --import tsx --test tests/console.test.ts tests/provider-catalog.test.ts` and verify focused navigation, monitoring, filtering, configuration, catalog, validation-editing, stream, auth, redaction, and accessibility coverage passes
- [ ] 6.2 Exercise Monitor and Repositories with keyboard-only input at desktop and narrow widths, and verify active navigation, filters, Configure links, staged settings, validation argument controls, conflicts, empty states, focus preservation, and local announcements are usable
- [ ] 6.3 Run `npm run build`, `npm run lint`, `npm run format:check`, and `npm test`; verify every command exits successfully without weakening job detail, recovery, authorization, redaction, or authoritative-picker behavior
- [ ] 6.4 Run `openspec validate separate-console-monitoring-and-configuration --strict` and `git diff --check`; verify the change artifacts and implementation diff pass strict specification and whitespace checks
