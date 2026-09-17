## Why

Repository cards persist provider, model, effort, and timeout changes as soon as an operator changes an individual control. This makes exploratory selection risky, obscures which related values will be committed together, and routes every repository's save outcome through one page-level status message.

## What Changes

- Replace repository-setting autosave with an explicit per-repository edit mode whose draft can be applied or cancelled.
- Present a before/after summary and plain-language notice that applied values affect future jobs while already-created jobs retain their recorded configuration.
- Persist provider, model, reasoning effort, and timeout as one validated atomic update, preserving the currently authoritative stored values when validation or persistence fails.
- Keep save progress, success, validation errors, and retry guidance inside the repository card that initiated the action.
- Preserve agent-aware provider availability, live/offline catalog parity, unmatched current values, provider-agent mismatch warnings, custom providers, agent-bounded effort tiers, native select behavior, and semantic model metadata badges while editing.
- Detect repository settings changed elsewhere during an in-progress draft, preserve the operator's unsaved input, and require an explicit refresh or reviewed apply rather than silently overwriting either side.
- Explain enable/disable consequences next to that action. Keep enablement separate from the staged settings transaction so changing settings cannot accidentally change whether the repository accepts future commands.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Repository configuration becomes a deliberate, repository-local staged workflow with atomic apply, cancel, conflict handling, consequence copy, and scoped feedback.

## Impact

- Affects the server-rendered repository cards and client behavior in `src/console/views/dashboard.ts` and `src/console/assets.ts`.
- Replaces or consolidates repository-settings mutation handling in `src/console/server.ts` and `src/console/mutations.ts`; the resulting update continues to notify the running orchestrator once after a successful commit.
- Extends console tests for edit state, atomic persistence, validation failure, concurrent external updates, catalog refreshes, and enable/disable copy.
- Does not change repository-registry storage ownership or durability semantics, introduce a database migration, or fold enablement into the settings transaction.
