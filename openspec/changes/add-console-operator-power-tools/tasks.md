## 1. Global Search and Attention Projection

- [ ] 1.1 Define typed, normalized search parameters for query text, repeated statuses, repository, attention, cursor, and bounded page size; verify unit tests reject or normalize malformed, duplicate, unknown, and over-limit values.
- [ ] 1.2 Implement the server-only attention projection with explicit reasons for unresolved terminal jobs, retained edits, unpushed commits, reporting failures, and invalid repository agent/provider relationships; verify focused tests distinguish attention from ordinary status and never use it to authorize an action.
- [ ] 1.3 Add parameterized, cursor-paginated job and repository search queries over only allow-listed identity/state fields; verify query tests find records outside dashboard limits, preserve deterministic ordering, combine all filters, and cannot match review context, logs, captured output, or secret fixtures.
- [ ] 1.4 Add the authenticated server-rendered search route, grouped results, visible removable filters, paging, and no-results state; verify `node --import tsx --test tests/console.test.ts` covers result identity, filter preservation, empty results, and zero disclosure without a valid token.

## 2. Context-Preserving Job Navigation

- [ ] 2.1 Build validated result-context serialization that accepts only known search/filter fields and generates server-owned result and job URLs; verify tests reject arbitrary return URLs and round-trip every supported filter.
- [ ] 2.2 Query previous and next jobs from the same current search context and deterministic ordering; verify focused tests cover middle records, first/last boundaries, records leaving the result set, and live status changes without automatic navigation.
- [ ] 2.3 Render visible labelled previous/next and Back to results controls on contextual job detail views, including adjacent repository/PR/job/status summaries; verify view tests cover keyboard operability, disabled boundaries, no wrapping, and an ordinary direct job link with no result context.

## 3. Discoverable Context-Safe Shortcuts

- [ ] 3.1 Add global search and a visible Keyboard shortcuts trigger through shared authenticated layout/view helpers without choosing dashboard-versus-configuration navigation; verify every authenticated console surface renders usable visible controls and the sign-in surface discloses no operational data.
- [ ] 3.2 Render a dismissible current-page shortcut reference containing only search/help/available job-navigation bindings and restoring focus to its opener; verify markup and behavior tests cover visible discovery, native dialog semantics or fallback, Escape/close, and focus return.
- [ ] 3.3 Implement guarded unmodified-key handling that exits for modifiers, composition, handled events, form/editable/widget/dialog interaction, absent actions, and disabled actions; verify client-behavior tests prove shortcuts work from neutral page focus and never fire while editing search, settings drafts, model filters, or confirmations.

## 4. Reviewed Bulk Repository Enablement

- [ ] 4.1 Add an explicit idempotent repository enablement setter returning changed, unchanged, or not-found instead of composing bulk behavior from toggles; verify mutation tests cover stale desired state and leave provider/model/effort/timeout untouched.
- [ ] 4.2 Add a token-protected bulk enablement endpoint with request-shape validation, target-count bound, id deduplication, per-target current-state revalidation, redacted results, and deterministic partial processing; verify route tests cover invalid all-or-nothing request rejection plus mixed changed/unchanged/missing/refused outcomes.
- [ ] 4.3 Record every changed or refused target through the existing operator-action audit store and return aggregate counts without secrets; verify audit tests correlate each repository target/effect, avoid duplicate records, and redact secret-bearing failure fixtures.
- [ ] 4.4 Add repository selection and a review/confirmation form that names each target, current/requested state, and disable/no-replay consequence before submission; verify view/client tests prove selection alone does nothing, confirmation uses explicit ids and desired state, and cancel leaves all repositories unchanged.
- [ ] 4.5 Present mixed bulk results per named repository and through the contextual feedback surface while leaving unrelated controls and staged repository settings drafts intact; verify integration tests cover partial success, retryable failures, SSE rerender, and an unsaved provider/model/effort/timeout draft.

## 5. Accessible Model Catalog Filtering

- [ ] 5.1 Add a labelled model-filter input, clear action, textual result count, and no-match state beside the existing native model select wherever repository settings are rendered; verify view tests associate labels/status text and preserve the unfiltered novice path.
- [ ] 5.2 Filter the current provider catalog by model name, exact id, description, provider, and badge text, then rebuild grouped native options while always retaining the current persisted/staged option and custom path; verify client-behavior tests cover matches, no matches, clearing, grouping, keyboard selection, and zero change/persistence events from filtering alone.
- [ ] 5.3 Preserve model filter text, staged selection, persisted baseline, and unapplied state independently across catalog refreshes and SSE fragment replacement, with deduplicated polite count announcements; verify regression tests cover a live refresh during an unsaved settings draft and a persisted model absent from filtered catalog results.

## 6. Compatibility and Verification

- [ ] 6.1 Integrate power-tool view helpers with the final surfaces from `separate-console-monitoring-and-configuration`, the draft contract from `stage-repository-settings-edits`, and contextual feedback from `guide-operator-error-recovery` without duplicating their navigation, help, apply, or error flows; verify combined console fixtures exercise all four contracts together.
- [ ] 6.2 Run `npm run build`, `npm run lint`, `npm run format:check`, and `npm test`, then run `openspec validate add-console-operator-power-tools --type change --strict --no-interactive`; record and resolve every failure attributable to this change.
