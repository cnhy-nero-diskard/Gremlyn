## 1. Atomic Repository Settings Mutation

- [ ] 1.1 Add normalized repository-settings snapshot and compare-and-set mutation logic for provider, model, effort, and timeout; verify mutation tests prove valid values commit together while invalid or stale requests leave all four stored values unchanged.
- [ ] 1.2 Add the authenticated `POST /repos/:id/settings` route with agent-aware validation, 404/400/409 responses, and current settings in conflict responses; verify focused endpoint tests cover required/optional providers, unsupported effort, invalid timeout, missing repository, success, and stale baseline.
- [ ] 1.3 Record one grouped operator action and invoke `repositorySettingsChanged` exactly once after a successful commit, never on validation/conflict failure; verify endpoint tests assert database values, audit history, callback count, and unchanged enabled state.
- [ ] 1.4 Preserve the existing field-specific routes as compatible concurrent writers for this change; verify their existing tests pass and a write through one route causes a subsequent stale grouped apply to return 409 instead of overwriting it.

## 2. Repository Card Edit and Review UI

- [ ] 2.1 Render each repository card with a compact persisted settings summary, explicit `Edit settings` action, disabled-by-default editor fieldset, and Apply/Cancel controls; verify dashboard rendering tests assert the state structure and that no control implies autosave.
- [ ] 2.2 Render repository-local status/error regions, future-job consequence copy, and before/after review containers with explicit timeout and identifier formatting; verify rendering tests assert accessible associations, exact consequence text, and distinct persisted/proposed values.
- [ ] 2.3 Keep native provider/model/effort controls and external model name, description, exact ID, mismatch text, custom-provider path, and semantic badges in edit mode; verify dashboard/provider-catalog tests cover live and fallback catalogs, unmatched current models, provider-agent mismatches, provider-optional agents, and custom values.
- [ ] 2.4 Place the shared enable/disable consequence content owned by `add-console-guidance-and-legends` beside the independent toggle and keep it outside the settings form; verify rendering and mutation tests show settings Apply cannot change enablement and toggle cannot submit or discard a draft.

## 3. Client Draft, Conflict, and Live-Update Behavior

- [ ] 3.1 Replace change-triggered writes with a repository-keyed baseline/draft/latest state machine and explicit Edit, Apply, and Cancel handlers; verify client behavior tests show selection changes issue no request, Cancel restores persisted values, and Apply sends one complete settings payload.
- [ ] 3.2 Generate the changed-field before/after summary and local completeness state from the draft; verify tests cover provider-driven model defaults, effort-only/model-only edits, no-limit timeout normalization, no-op drafts, and custom provider/model input.
- [ ] 3.3 Keep saving, success, validation failure, and network failure inside the initiating card while preventing duplicate Apply only there; verify tests show a failed draft remains editable/retryable and another repository remains operable.
- [ ] 3.4 Handle HTTP 409 by preserving the draft, displaying the returned current snapshot, disabling Apply until explicit review, and supporting `Load current values` and `Review my draft`; verify tests cover discard, reviewed overwrite, and a second intervening conflict without any silent write.
- [ ] 3.5 Register repository baseline/draft/latest state with the keyed reconciler owned by `improve-console-accessibility-and-session-ux` (or a narrowly compatible adapter if it has not landed) so unedited cards refresh while an editing card retains its draft and detects baseline changes; verify tests cover focus/input preservation, unrelated-card updates, and enablement changes during an open draft without introducing a second global reconciliation path.
- [ ] 3.6 Rebuild live-catalog options around the draft rather than the baseline, retaining synthetic `CURRENT` models, custom providers, mismatch reporting, clean option labels, and semantic metadata capsules; verify catalog-refresh tests prove metadata can update without changing or persisting draft values.
- [ ] 3.7 Reserve the page-level live status for connection health and route settings/toggle outcomes to their repository card; verify accessibility assertions cover status/error announcements and non-color-only saving, conflict, success, and failure labels.

## 4. Integration and Acceptance

- [ ] 4.1 Run `node --import tsx --test tests/console.test.ts tests/provider-catalog.test.ts` and verify all focused repository settings, catalog, stream, and accessibility regressions pass.
- [ ] 4.2 Run `npm run build`, `npm run lint`, `npm run format:check`, and `npm test`; verify every command exits successfully without weakening unrelated coverage.
- [ ] 4.3 Exercise the dashboard with keyboard-only input across ordinary catalog, custom provider, unmatched current model, provider-agent mismatch, save failure, and concurrent-change states; verify Apply/Cancel focus flow, visible review, preserved drafts, card-local announcements, and independent enablement behavior.
- [ ] 4.4 Run `openspec validate stage-repository-settings-edits --strict` and `git diff --check`; verify the change artifacts and implementation diff pass strict specification and whitespace checks.
