## Context

See `proposal.md` - Why, and `specs/operator-console/spec.md` for the observable contract.

The redesigned console already separates redacted queries, pure server-rendered views, CSS/client assets, and fragment-based SSE updates. Job detail has all core attempt facts (`workspace_path`, `adopted`, `agent_exit_code`, `failure_stage`, `failure_reason`, `commit_sha`, `pushed`, and `report_status`), validation rows, and ordered status events, but renders them in separate panels. The repository source path and configured validation-command count are available in persistence but are not currently part of `JobDetail`.

This change overlaps an active `add-agent-stall-failsafe` proposal. Its future stall reason must be treated as an agent-stage failure distinct from the existing duration timeout; this design must not replace or weaken that proposal's watchdog, process-tree, configuration, or persistence decisions.

## Goals / Non-Goals

**Goals:**

- Produce one deterministic, testable lifecycle projection from persisted evidence.
- Put the safety contract and terminal outcome before live transcripts and forensic panels.
- Preserve the console's server-rendered, dependency-free, live-fragment architecture.
- Keep retry history legible while making the current attempt the source of current progress.

**Non-Goals:**

- No new job stages, persistence columns, route contracts, or orchestrator transitions.
- No change to authorization, workspace preparation, validation, publication, reporting, retry, cancellation, or stall detection behavior.
- No claim that an adopted checkout was created or isolated by Gremlyn.
- No SPA, client-side state machine, design-system rewrite, or broad dashboard redesign.

## Decisions

### D1: Derive a typed progress projection on the server

Add a pure console-side projection that turns `JobDetail` plus the repository's source path and validation configuration into:

- one overall outcome summary;
- six ordered steps with a stable key, human label, state, concise evidence, and optional detail;
- workspace assurance containing the recorded path and whether it was Gremlyn-created or adopted;
- publication evidence containing the commit SHA and pushed state; and
- the recommended next action for the terminal outcome.

The current attempt (`current_attempt`, falling back to the highest attempt number for older fixtures) drives the rail. Older attempts remain in the existing attempt cards and do not make a retry appear further progressed than it is.

The projection is derived before HTML rendering and is included in every job-detail fragment render. The keyed reconciler owned by `improve-console-accessibility-and-session-ux` applies that fragment while preserving stable job-step identity; the browser does not infer lifecycle state from DOM text or duplicate the state machine.

*Alternative considered:* derive the rail directly in `job.ts` or client JavaScript. That would make state rules harder to unit-test and would duplicate knowledge across initial and live rendering.

### D2: Use persisted evidence first, stage position only for active and pending states

Passed and failed states come from durable facts, not from visual optimism:

| Step | Passed evidence | Active evidence | Failed evidence |
|---|---|---|---|
| Authorized | The job exists for its executed processed command | Not applicable after job creation | Not representable as a job; refused commands remain in ingestion history |
| Workspace isolated | Current attempt has a recorded prepared workspace and head SHA | Job is preparing without a prepared path | Terminal failure at preparing |
| Agent finished | Recorded successful agent exit, excluding timeout/stall/cancellation | Job is running | Running-stage failure, including distinct stall and timeout reasons |
| Validation passed | All recorded commands passed, or the job advanced beyond validation with no commands configured | Job is validating | Validation-stage failure or any recorded nonzero validation exit |
| Published | `commit_sha` exists and `pushed === 1` | Job is publishing without a terminal publication fact | Publishing-stage failure; an existing SHA with `pushed === 0` is explicitly local/unpushed |
| GitHub reported | `report_status === "posted"` | Job is reporting without a recorded result | `report_status === "failed"` or reporting-stage failure |

Later steps are pending while reachable. After a terminal stop, untouched later steps become skipped. `not-applicable` is reserved for evidence-backed cases such as a zero-command validation configuration; it is not a euphemism for missing data or failure. Unexpected or contradictory legacy rows stay incomplete and expose neutral “evidence unavailable” copy rather than being promoted to passed.

*Alternative considered:* map each `JobStatus` directly to a number of completed steps. That would falsely call publication complete after a transition to reporting even when a commit remained local, and would erase reporting failure after a successful push.

### D3: Make source-checkout reassurance conditional and precise

Extend the redacted job projection with the repository `source_path` and parsed validation command count. Compare paths with the repository's existing platform-aware path normalization rather than string prefix checks.

For an ordinary prepared workspace distinct from the source, render the exact recorded workspace path and “Source checkout untouched.” For an adopted non-source checkout, render “Adopted existing checkout” with its path and separately preserve the source-checkout reassurance. Before a workspace is recorded, or if legacy/contradictory evidence identifies the source itself, render no reassurance and surface the uncertainty/failure instead.

*Alternative considered:* always display the reassurance because workspace isolation is a system invariant. The rail is intended to show evidence for this specific attempt, so it must not claim more than the stored row supports.

### D4: Treat terminal outcome as a separate peak state from agent completion

Place an outcome banner and the rail immediately below the existing job identity/actions band, ahead of agent activity. The banner has four semantic variants: in progress, succeeded, failed, and stopped (cancelled/interrupted). It names the stopping step and recommended action when unsuccessful.

Successful completion explicitly says the work was validated, pushed, and reported, and links the short commit SHA as the primary proof. If GitHub reporting fails after push, the banner says the commit remains pushed and recommends checking/retrying reporting rather than implying rollback. A local unpushed commit is named and described as remaining in the workspace.

*Alternative considered:* replace the existing status pill or timeline. Both remain useful at different resolutions: the pill is the compact database status and the timeline carries timestamps/durations; the banner and rail explain operational meaning.

### D5: Render the rail as responsive semantic HTML with textual state

Render the steps as an ordered list. Every item contains its number/name, visible state label, and evidence copy. The active step uses `aria-current="step"`; the whole summary has a labelled heading. Icons and status color reinforce but never replace the state text.

On wide screens the six steps form a connected horizontal rail. At narrow widths they become a vertical sequence without horizontal scrolling or truncated paths. Workspace paths and SHAs use the existing mono treatment with safe wrapping and copy-friendly text. Motion is limited to the existing reduced-motion-aware live treatment.

*Alternative considered:* reuse the existing timeline component. The timeline is event-oriented and chronological, whereas the new rail is a fixed safety contract whose skipped, failed, and evidence states must stay aligned across every job.

### D6: Preserve existing detail and security boundaries

The existing timeline, attempts, validation, activity, log, review, and danger-zone sections remain available below the summary. New values continue through `queries.ts` redaction and HTML escaping, and the job route and SSE endpoint retain their current loopback/token protection. No path or job evidence is added to unauthenticated assets.

## Risks / Trade-offs

- **Legacy or partially written rows can contain contradictory evidence** -> Favor explicit persisted facts, never promote uncertainty to passed, and add fixture coverage for incomplete combinations.
- **The rail can duplicate the timeline and attempt cards** -> Keep rail copy short and outcome-oriented; use existing panels for timestamps, raw output, and forensic detail.
- **Long Windows paths can break the peak layout** -> Use wrapping mono text and test narrow viewport markup/styles without hiding the full path.
- **Concurrent implementation of `add-agent-stall-failsafe` can rename its failure reason** -> Centralize reason-to-label mapping and test both timeout and the final stall vocabulary from that change; do not hard-code stall behavior in multiple renderers.
- **A retry can accidentally inherit evidence from an older attempt** -> Key validation and attempt facts to the current attempt and retain older evidence only in attempt history.

## Migration Plan

1. Extend the existing console query/view model without changing stored data or public routes.
2. Add the pure progress projection and state-matrix tests before rendering it.
3. Add the outcome banner and responsive rail to the existing `job-detail-region`, then verify initial and SSE-refreshed HTML use the same projection.
4. Deploy as a presentation-only console update. Rollback removes the projection and markup with no data migration or cleanup.
