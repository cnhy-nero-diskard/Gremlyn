## Context

The dashboard server-renders repository cards, then replaces the repositories region from the event stream. Each picker stores its persisted provider, model, effort, and timeout in `data-saved-*` attributes. Client-side `change` handlers currently post immediately: provider/model use one grouped route, while effort and timeout use separate routes. Save and connection messages share the page-level live-status node.

Persisted repository values are authoritative and durable. Provider choices are filtered by the configured agent; an unmatched persisted model remains selectable as `CURRENT`; known provider-agent mismatches are reported without correction; unknown providers use a custom free-text path; and a live Cline refresh augments rather than replaces the bundled multi-provider catalog. The edit workflow must preserve those contracts and continue using native selects with the existing external model metadata and badges.

## Goals / Non-Goals

**Goals:**

- Make each repository card own a deliberate view/edit/apply/cancel lifecycle.
- Commit provider, model, effort, and timeout in one validation and database transaction.
- Prevent a stale draft from overwriting settings changed through another console session or route.
- Reconcile event-stream and catalog refreshes without freezing unrelated repository cards or losing a draft.
- Keep settings feedback local and accessible while leaving connection health in the page-level live region.

**Non-Goals:**

- Changing repository-registry ownership, persistence precedence, schema, or job snapshot semantics.
- Editing the repository's agent, validation commands, paths, or instructions from this card.
- Folding enabled state into the staged settings payload or changing enable/disable behavior.
- Replacing native form controls, the catalog source, model IDs, provider authentication semantics, or semantic badge taxonomy.
- Removing existing field-specific mutation routes in this change; they may remain for compatibility and act as concurrent writers.

## Decisions

### 1. Model the repository card as a local state machine

Each card will render a compact persisted summary and an `Edit settings` action. Edit mode owns three snapshots keyed by repository id:

- `baseline`: the persisted values against which the edit began or was last reviewed;
- `draft`: the operator-controlled provider, model, effort, and normalized timeout;
- `latest`: the most recent values observed from the server.

The card moves through `view`, `editing`, `saving`, `saved`, `error`, and `conflict` presentation states. Apply is disabled until the draft differs from the baseline and is locally complete. Cancel discards only the draft. Controls use a form/fieldset and native select/input elements; names, descriptions, exact IDs, badges, mismatch text, and custom-provider controls stay outside option-label tricks so they remain legible and accessible.

This is preferable to retaining per-control autosave with extra confirmations because a confirmation after each selection would still split a logically coupled provider/model/effort/timeout decision and would not provide one reviewable outcome.

### 2. Use one optimistic, atomic settings mutation

Add a console mutation route such as `POST /repos/:id/settings` with this logical body:

```json
{
  "expected": {
    "provider": "cline",
    "model": "anthropic/claude-sonnet-5",
    "effort": "high",
    "timeoutSeconds": null
  },
  "settings": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "effort": "xhigh",
    "timeoutSeconds": 3600
  }
}
```

The server will normalize the timeout (`null` for no limit), validate provider-required behavior and the agent's supported effort tiers using the same agent-aware rules as today, require a non-empty model, and validate the timeout before writing. Inside one SQLite transaction it will read the current four values, compare them with `expected`, and update all four only on an exact match. A mismatch returns HTTP 409 with `error: "repository-settings-conflict"` and the current normalized settings; validation errors return 400; neither path writes anything.

One successful transaction produces one `repository-settings` operator action, invokes `repositorySettingsChanged` once after commit, and returns the committed settings. The endpoint does not accept `enabled`, so apply cannot toggle the repository. Existing routes can remain compatible concurrent writers; the expected snapshot protects the new editor from them.

This snapshot compare avoids a database migration for a revision column. A revision would distinguish a change-away-and-back sequence, but when all four authoritative values again equal the reviewed baseline there is no state that this apply can accidentally erase.

### 3. Register repository draft state with the shared keyed reconciler

The current client skips the entire repositories-region swap while any picker is focused or saving. Repository settings will register its baseline/draft/latest state by repository id with the keyed reconciler owned by `improve-console-accessibility-and-session-ux`. If implemented before that shared primitive lands, this change may use a narrowly compatible repository-keyed adapter, which the shared reconciler must absorb rather than duplicate. Incoming cards reconcile independently:

- cards not being edited adopt the incoming persisted values normally;
- an editing card restores its exact draft and focus-related UI state;
- incoming values update `latest`;
- when `latest` differs from `baseline`, the card enters conflict state and Apply is disabled until review;
- unrelated cards still receive live updates.

Catalog refresh rebuilds available provider/model options around the draft rather than around the persisted baseline. If the draft model is absent, it receives the same `CURRENT` treatment used for an unmatched persisted value. Refresh may change descriptive metadata but never the four draft values.

On conflict, `Load current values` discards the draft and adopts `latest` without a mutation. `Review my draft` promotes `latest` to the comparison baseline while retaining the draft, then recomputes the before/after summary so every value that would overwrite newer state is explicit. Apply still sends the reviewed baseline, so another intervening change produces another 409 rather than a lost update.

### 4. Keep review, consequences, and feedback inside the card

Edit mode shows only changed rows in a before/after summary, with explicit `No limit` timeout formatting and exact provider/model IDs where labels could be ambiguous. Apply copy states: “Used for jobs created after this save. Existing jobs keep their recorded settings.”

Each card gets its own `role="status"` node for saving/success and an assertive error association for validation or conflict feedback. Saving disables that card's Apply button, not the entire repository grid. A failure leaves controls and the draft intact. The page-level live region remains responsible for stream connection/reconnection only, eliminating competition between unrelated mutation messages.

### 5. Keep enablement immediate, separate, and explicit

The enable/disable control remains outside the settings form and continues to use its dedicated action. Adjacent copy explains that disabling prevents later commands from creating jobs and those ignored commands are not replayed after re-enable. `add-console-guidance-and-legends` owns the shared wording across single and bulk controls; this change owns its required placement and the transactional separation. Toggling it neither applies nor cancels an open settings draft; settings Apply never sends or changes `enabled`.

This separation avoids an accidental availability change hidden among model edits and preserves the existing audit action and registry behavior.

## Risks / Trade-offs

- **[Server-rendered swaps can recreate focused controls]** → Key edit state by repository id, restore the draft after reconciliation, and test focus/input preservation across dashboard events.
- **[A live catalog refresh can make a draft look invalid]** → Preserve the selected identifier as a synthetic current option, retain custom mode, and distinguish catalog absence from server-side validity.
- **[Concurrent legacy endpoints can race with Apply]** → Compare the full expected snapshot inside the same transaction as the update and return the current snapshot on 409.
- **[Conflict review can feel verbose]** → Show the banner and extra actions only when the baseline actually differs; ordinary edits retain a short before/after summary.
- **[Four-field payloads could accidentally change untouched settings]** → Initialize the draft from the authoritative snapshot, show every baseline-to-draft difference, and require exact baseline matching before the atomic update.
- **[Card-local status may be missed after focus moves]** → Associate feedback with the form, use appropriate live-region semantics, and place it adjacent to Apply/Cancel.

## Migration Plan

1. Add and test the atomic compare-and-set mutation while leaving existing routes operational.
2. Render the view/edit structure, normalized baseline data, review summary, consequence copy, card-local feedback, and independent enablement explanation.
3. Switch client behavior from change-triggered writes to draft state plus explicit Apply/Cancel, then add live-fragment and catalog reconciliation.
4. Verify focused console/provider-catalog tests, the full build and lint, strict OpenSpec validation, and manual keyboard flows for ordinary, mismatch, custom-provider, unmatched-model, failure, and conflict states.

Rollback can restore the previous client and card rendering while the additive settings route remains unused. No database or stored repository data needs migration or reversal.
