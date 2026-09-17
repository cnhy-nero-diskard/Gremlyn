## Context

See `proposal.md` - Why, and `specs/operator-console/spec.md` for the observable contract.

The console is Fastify-rendered HTML with pure view functions, TypeScript string assets, and server-rendered fragment updates over a shared SSE ticker. The dashboard query currently loads every repository plus the newest 50 jobs, and `dashboard.ts` owns both operational lanes and all provider/model/effort/timeout picker rendering. Navigation has no active state.

Three sibling proposals constrain this design:

- `stage-repository-settings-edits` defines the authoritative four-field repository draft, atomic compare-and-set apply, conflict handling, card-local feedback, and live reconciliation. This change relocates that workflow; it does not replace it.
- `surface-job-safety-progress` owns the job-detail peak state and safety rail. Dashboard filters link to job detail but do not duplicate that evidence.
- `guide-operator-error-recovery` separates connection health from contextual action feedback. The new configuration view follows that separation.

## Goals / Non-Goals

**Goals:**

- Give monitoring and configuration separate URLs, headings, navigation state, data projections, and live regions.
- Keep active work and health faster to scan than repository settings.
- Make filtered results complete within their persisted scope rather than filtering an already truncated list.
- Move staged settings without changing picker authority, conflict safety, or client-state preservation.
- Add validation-command editing without expanding the four-field settings transaction.

**Non-Goals:**

- No global search, command palette, keyboard shortcut system, or cross-surface result index.
- No SPA router, client template layer, frontend framework, dependency, or build step.
- No changes to job execution stages, job-detail information architecture, catalog sourcing, authentication, redaction, or audit retention.
- No editing of source paths, workspace roots, agents, allowed-model lists, instructions, or workspace seed files.

## Decisions

### D1: Add `/repositories` as the dedicated configuration surface

The dashboard stays at `/` and is labelled `Monitor`; the new authenticated `/repositories` route is labelled `Repositories`. Using the authenticated-shell/current-section contract owned by `improve-console-accessibility-and-session-ux`, this change registers the Monitor and Repositories destinations and maps job detail to Monitor; the shell renders `aria-current="page"` on exactly one primary link. Commands and Audit retain their existing surfaces.

Dashboard repository rows become compact, read-only summaries with a `Configure` link to `/repositories#repository-<id>`. The full editor, independent enablement control, model metadata, validation commands, and repository-local feedback move into a new repository configuration view. A short introduction on each page explains “watch current work” versus “change future-job behavior.”

*Alternative considered:* keep editors in collapsible dashboard cards. Disclosure would reduce initial height but would leave monitoring and configuration competing in one region, complicate dashboard filtering, and keep the dashboard's live update reconciler responsible for every settings draft.

### D2: Extract repository presentation instead of duplicating it

Move provider/model/effort/timeout rendering and the repository editor state hooks from `dashboard.ts` into configuration-specific view components. Keep compact repository summary rendering separately in the dashboard module. Catalog helpers and semantic badge renderers may move to a shared repository component module, but there is one implementation of provider availability, unmatched `CURRENT` values, custom providers, agent effort tiers, and metadata badges.

The staged-settings change should land first or be incorporated as the baseline of this change. Its view/edit/apply/cancel/conflict state machine is rehomed under `/repositories`; no temporary second autosaving editor remains on the dashboard.

*Alternative considered:* render the same full card on both pages and hide controls on the dashboard with CSS. That duplicates interactive state in the DOM and makes hidden controls and live announcements harder to reason about.

### D3: Keep validation commands in a separate compare-and-set draft

Add a validation editor beside, but outside, the staged four-field settings form. Represent commands as an ordered list of ordered argument inputs; never parse or serialize a shell command string. The mutation accepts:

```json
{
  "expected": [["npm", "test"]],
  "commands": [["npm", "run", "lint"], ["npm", "test"]]
}
```

The server normalizes strings, rejects an empty executable or empty argument, compares the full current list with `expected`, and updates `validation_commands` atomically. A stale baseline returns 409 with the current list; malformed input returns 400; neither writes. Success records one `repository-validation-commands` operator action and invokes `repositorySettingsChanged` once after commit. The runtime callback expands its current reload to include validation commands, so only later-created jobs use the new list.

Validation draft state is keyed separately from the four-field settings draft. Each has its own review, Apply, Cancel, conflict, and local feedback, so applying one cannot implicitly include the other.

*Alternative considered:* add validation commands to the four-field atomic settings endpoint. That would contradict the staged-settings contract, make ordinary model changes carry a complex unrelated list, and enlarge the conflict surface.

### D4: Query monitoring lanes independently and apply filters before limits

Introduce typed dashboard filters parsed from the URL:

- `repository=<id>` for repository scope;
- `job=<text>` for job id, pull request number, or visible command matching.

Without a job query, read active and queued jobs independently from recent terminal jobs, limiting only the recent lane. This prevents a busy history from pushing running work out of the current shared 50-row window. With a job query, apply normalized SQL predicates before a bounded result limit, so a persisted older match remains discoverable. Parameterized SQL and escaped `LIKE` input keep filters data-only.

The configuration route uses `q=<owner/name text>` and `enabled=all|enabled|disabled`, also applied before rendering. Both views retain criteria in the URL and render counts, filter summaries, clear links, and distinct “configured empty” versus “no matches” states.

*Alternative considered:* client-filter the current DOM. That is simple for repositories but cannot find jobs outside the initial 50 and would present an incomplete result as authoritative.

### D5: Make filtered SSE rendering route-aware and state-preserving

Dashboard and configuration each get a surface-specific stream URL carrying the normalized filter query. Their render closures rerun the same filtered query used for the initial response. When filters change with JavaScript available, the client updates the URL, restarts only that surface's `EventSource`, and applies a snapshot fragment; ordinary GET form submission remains the no-script fallback.

The configuration view extends the shared keyed reconciler from `improve-console-accessibility-and-session-ux` with the repository state hooks specified by `stage-repository-settings-edits`. It preserves both settings drafts and validation drafts for repositories hidden and later revealed by a filter, updates authoritative `latest` snapshots, and detects conflicts without creating a second fragment-replacement engine. Connection state uses the page-level region; apply and validation feedback remain inside the repository editor as required by `guide-operator-error-recovery`.

*Alternative considered:* one global stream that sends both dashboard and configuration fragments. It would run irrelevant queries, blur surface responsibilities, and increase the chance that a dashboard event disturbs a configuration draft.

### D6: Keep filtering local and deliberately modest

Filter controls are labelled forms associated with their result region. The monitor has a repository select and job text field; configuration has repository text and enabled-state controls. They do not register global keyboard handlers, search Commands/Audit/log content, or render mixed result types.

This boundary leaves a future power-user navigation change free to introduce global search or shortcuts without inheriting ad hoc behavior from these operational filters.

## Risks / Trade-offs

- **Two active changes touch repository card markup and client reconciliation** -> Implement or rebase on `stage-repository-settings-edits` first, then move its completed editor as a unit and preserve its tests.
- **Validation editing changes live execution policy** -> Use a separate audited compare-and-set mutation, reload runtime configuration only after commit, and state that existing jobs keep recorded evidence.
- **Filtered streams can drift from the visible URL** -> Normalize filters once, reuse them for initial and stream queries, and restart the stream whenever history state changes.
- **Drafts for filtered-out repositories can consume client memory** -> Keep state only for repositories touched in the current page session and clear it after successful apply or explicit cancel.
- **Additional lane queries increase SQLite reads per live tick** -> Query only regions relevant to the connected surface, retain bounded recent results, and continue using the single shared ticker.
- **Moving controls can break deep links or test selectors** -> Give repository editors stable ids, redirect no existing route, and update tests to assert behavior and accessible labels rather than dashboard-specific nesting.

## Migration Plan

1. Land or reconcile the staged repository settings workflow so its server contract and state machine are the source of truth.
2. Add filtered query models, active navigation, `/repositories`, and its scoped stream while keeping the existing dashboard operational.
3. Move the staged settings editor and independent enablement action to the configuration view; replace dashboard cards with compact summaries and links.
4. Add the separate validation-command compare-and-set editor and runtime refresh.
5. Enable URL-backed filters and route-aware live fragment updates, then remove dashboard-only editor handlers that no longer have controls.

Rollback restores full repository cards to the dashboard and removes the additive configuration and validation routes. The validation list remains valid existing repository data; no database migration or cleanup is required.
