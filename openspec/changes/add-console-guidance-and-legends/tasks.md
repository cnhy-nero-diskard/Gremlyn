## 1. Terminology and Semantic Values

- [ ] 1.1 Add typed registries for job/attempt statuses, command outcomes and authorization reasons, failure stages/reasons, audit action/effect identifiers, and model tags/tiers; verify coverage tests enumerate every exported known value and active stalled-versus-timeout vocabulary while allowing a neutral unknown fallback.
- [ ] 1.2 Add provider/authentication and technical-identifier terminology helpers that distinguish agent, provider namespace, authentication method, model, effort, job, attempt, repository, PR, comment, commit, and workspace values; verify unit tests produce explicit type labels without changing the raw values.
- [ ] 1.3 Implement a shared semantic-value renderer with a visible plain label, visible exact raw `<code>` value, type label, optional Help link, and neutral unrecognized state; verify view tests cover known/unknown values, long paths/SHAs, keyboard selection, and no tooltip-only content.
- [ ] 1.4 Ensure terminology and copy affordances receive only query-layer-redacted values and copy the rendered node rather than hidden source data; verify secret-bearing fixtures expose and copy only the redacted representation.

## 2. Authenticated Offline Help

- [ ] 2.1 Implement allow-listed contextual topic and return-target parsing for dashboard, configuration, job, Commands, Audit, and search routes; verify tests reject schemes, hosts, protocol-relative URLs, traversal, unknown paths, and malformed job ids and fall back safely.
- [ ] 2.2 Add the token/session-protected server-rendered Help route, topic index, stable anchors, and safe Back to context link; verify authenticated route tests cover general/deep links and unauthenticated tests disclose no help context or operational identifiers.
- [ ] 2.3 Add task guides for authorization, isolation, validation, publication/reporting, retry/cancel/reset, and repository enablement that link to authoritative landmarks without computing live state or action eligibility; verify content tests cover every topic and assert no duplicate safety rail, action controls, recovery recommendation, or shortcut list.
- [ ] 2.4 Render full status/failure, model metadata/tier, and provider/authentication legends from the shared terminology data with exact markers and non-color-only definitions; verify legend tests cover terminal distinctions, stalled versus timed out, local versus published work, known catalog capsules, and neutral future-tag fallback.
- [ ] 2.5 Keep all required Help HTML, CSS, disclosure, and navigation local with no external request dependency; verify help-page tests find no required remote asset or external documentation URL and remain functional with client scripting disabled.

## 3. Contextual Guidance Integration

- [ ] 3.1 Add the visible Help entry to the final authenticated navigation owned by `separate-console-monitoring-and-configuration` and surface-local topic links without changing its page responsibilities; verify every authenticated surface has Help and the unauthenticated sign-in layout does not expose protected navigation.
- [ ] 3.2 Render friendly command outcomes and authorization reasons beside exact raw codes in Commands, including unknown-code fallback and authorization Help; verify `node --import tsx --test tests/console.test.ts` covers executed, rejected, ignored, duplicate, and unknown fixtures.
- [ ] 3.3 Render named action, target, effect, and detail values beside exact redacted raw audit values and contextual Help; verify Audit fixtures remain correlatable by raw identifiers and never expose configured secrets.
- [ ] 3.4 Apply semantic identifiers, failure translations, and compact status/failure legend links to job and attempt presentation while linking rather than duplicating the safety rail and recovery panel; verify running, successful, failed, cancelled, interrupted, stalled, timed-out, unpushed, and reporting-failed fixtures.
- [ ] 3.5 Apply provider/authentication/model/effort terminology and model-capsule legend links to repository settings while preserving native selects, exact ids, staged drafts, and catalog filtering; verify live/offline catalogs, provider mismatch, custom provider, current-only model, and unknown badge fixtures.

## 4. Shared Enablement Consequences

- [ ] 4.1 Define single-source enable and disable consequence content covering future commands, no replay, existing-job non-cancellation, eligible future work, and settings-draft independence; verify content tests assert the complete safety meaning once.
- [ ] 4.2 Reuse the shared consequence content in single-repository controls, bulk enablement review, and the Help topic without changing their eligibility or mutation ownership; verify combined tests show consistent copy before disable confirmation and preserve open settings drafts.

## 5. Progressive Disclosure and Interaction

- [ ] 5.1 Use stable keyed native `<details>` for long definitions, related identifiers, and cross-references while leaving primary meaning and audit-critical raw codes visible when collapsed; verify keyboard and markup tests cover summary naming, focus order, and collapsed-state auditability.
- [ ] 5.2 Integrate disclosure open state with the keyed SSE reconciler from `improve-console-accessibility-and-session-ux`, preserving focus and state across unrelated updates but removing state with deleted records; verify client-behavior tests cover Commands, Audit, job, and repository fragments.
- [ ] 5.3 Add responsive, non-color-only styles for semantic values, legends, long paths, and help topics plus progressive Copy feedback through the shared scoped announcer; verify narrow-width fixtures contain long values and copy success is announced once without moving focus.

## 6. Compatibility and Verification

- [ ] 6.1 Run combined fixtures with `surface-job-safety-progress`, `guide-operator-error-recovery`, `stage-repository-settings-edits`, `add-console-operator-power-tools`, `separate-console-monitoring-and-configuration`, and `improve-console-accessibility-and-session-ux`; verify guidance links to each owned surface without duplicating its state, controls, or shortcut definitions.
- [ ] 6.2 Run `npm run build`, `npm run lint`, `npm run format:check`, and `npm test`, then run `openspec validate add-console-guidance-and-legends --type change --strict --no-interactive`; record and resolve every failure attributable to this change.
