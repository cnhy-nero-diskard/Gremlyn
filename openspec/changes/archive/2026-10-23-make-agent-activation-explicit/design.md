## Context

See `proposal.md` for motivation and scope. The current dashboard independently renders a primary-source picker and a saved-profile summary. `opencodeAgentsSection` labels an enabled child callable solely from its enabled flag. The profile editor saves through `/repos/:id/opencode-profile`, while activation requires `/repos/:id/opencode-selection`. The successful profile-save notice does not identify whether the team controls new jobs.

Profiles and primary selections already have independent revision counters and durable stores. `JobStore` atomically captures source and, for managed source only, profile bytes/revision at job creation. Queued jobs and retries use this capture. Invocation records separately persist requested selection and actual primary identity; delegation observations provide bounded, sometimes incomplete child evidence. None of those execution contracts needs to change.

The current checkout is a Fastify-rendered, framework-free console. Existing SSE reconciliation preserves keyed client state, and the action ticker notices committed operator actions. Other planned changes move repository configuration off the dashboard and add a job lifecycle rail; this change must be implementable independently and reusable on those surfaces.

## Goals / Non-Goals

**Goals:**

- Derive workflow state once from authoritative profile and selection records and render it consistently in initial and live HTML.
- Make inactive definitions actionable without changing a source merely because a profile was saved.
- Coordinate two revisioned resources in one explicit activation transaction.
- Separate future-job settings, immutable job captures, and attributed runtime evidence.

**Non-Goals:**

- No automatic activation, changes to existing local database rows on deployment, forced delegation, starter-profile changes, or autoshipper.
- No alteration of OpenCode execution/preflight, child settlement, validation, publication, GitHub reporting, or job/retry capture semantics.
- No global design-system replacement or dependency on the unimplemented configuration-page or lifecycle-rail changes.

## Decisions

### D1: One repository agent-workflow projection and visible summary

Extend the redacted repository projection in `src/console/queries.ts` with a typed workflow summary using the resolved executor kind, stored selection, safe profile summary, and most recent launched invocation. Do not infer activation from a profile's presence, primary name, enabled children, or displayed draft.

| Stored state | Prominent text | Main next action |
| --- | --- | --- |
| Default/native, no team | No saved team; new jobs use the selected default/native source | Configure team or change agent |
| Default/native, saved team | Saved team: INACTIVE; new jobs use the selected source | Activate this team |
| Managed, valid team | Team: ACTIVE FOR NEW JOBS; named primary and profile revision | Edit active team |
| Managed, missing/corrupt team | Selected team unavailable; new jobs cannot safely use it | Repair team or change agent |

Use a full-width status sentence and action within each repository summary, visible even when detailed configuration is collapsed. Amber background/border and a text label reinforce the inactive-team notice, using existing semantic tokens rather than creating a new visual system. Explicit default/native choices without a stored team are normal, not failures. A native orchestrator can delegate through its own configuration; an inactive Gremlyn team does not imply all OpenCode delegation is disabled.

Combine the existing team section and source control visually under **Agent workflow**, keeping native discovery and source switching available as **Change agent**. Detailed child tools/model fields remain subordinate. An inactive enabled child reads **Enabled in saved team**; an active enabled child reads **Available to orchestrator**; a disabled child reads **Disabled**. An active team with zero enabled children explicitly says so. Selection denotes intended availability, not a successful runtime preflight or observed invocation.

Example inactive summary:

```text
BACKLOGIUM - AGENT WORKFLOW
Saved team: INACTIVE
New jobs use: OpenCode default
Most recent launch: build - Job #221

Your orchestrator team is saved but is not selected.
[Activate this team] [Edit team] [Change agent]
```

The job number and identity above illustrate layout only; production values come from the same repository's records. Use **Not observed** if that latest launch has no actual identity, or **No recorded launch** if no invocation exists. Do not promise that OpenCode default means build.

*Alternative considered:* add a help tooltip to the existing selector. Rejected because the critical state would remain split across controls, easy to overlook, and incorrectly labeled in the team summary.

### D2: Explicit save-only, combined activation, and saved-team activation

Keep the existing profile-save endpoint as save-only and the existing selection endpoint as a deliberate source switch. Add an authenticated repository-local activation endpoint, proposed as `POST /repos/:id/opencode-team-activation`, with a strictly discriminated body:

- `mode: activate-saved`, expected profile revision, expected selection revision; no candidate is accepted. Activate exactly the already-reviewed saved profile.
- `mode: save-and-activate`, expected profile revision, expected selection revision, candidate profile. Save the reviewed candidate and select it together.

The editor baseline must include both revision counters, read from a coherent snapshot; enrich its existing GET response with safe selection/revision context. The review step names the submitted operation and its consequence. Offer **Save team** and **Save and activate** while a team is inactive, and **Save team** when it is already active. Saving an active team's changes affects new managed jobs, so the review and success notices explicitly name that consequence. A new unsaved starter template stays a draft until one of these operations succeeds.

For combined activation, a coordinated store operation opens one transaction, rechecks repository existence and the resolved OpenCode executor kind (including aliases), checks both revisions, validates the full candidate, and writes profile plus selection. Validation, revision mismatch, executor change, or any persistence/audit failure rolls back the entire operation. Never compose two separate HTTP writes: their intermediate state could be captured by job creation.

Increment the profile revision when saving; increment the selection revision when its source changes. Even if it is already managed, a combined request checks the submitted selection baseline. A direct activation of an already-active matching team is an idempotent no-op rather than producing duplicate audit rows. It must still reject a stale baseline.

Record one safe operator action for each successful activation operation with mode, before/after source identifiers, resulting revisions, primary ID, and child IDs, without descriptions, instructions, raw profile bodies, or inventory. Combined activation is one action, not a misleading successful profile-save action followed by a failed source action. Preserve the old endpoint audit semantics for save-only and source switching. The ticker already reacts to operator-action changes; ensure audit presentation can render the new action.

After commit, issue at most one repository-settings notification for the activation operation and return authoritative safe workflow state/revisions. A notification failure must not masquerade as a rolled-back save or trigger blind resubmission: reconcile committed state and report a scoped refresh problem. New-job capture continues reading the durable stores and cannot see half of a combined operation.

*Alternative considered:* activate every newly saved profile by default. Rejected because it would silently change deliberate native/default selections and contradict durable inactive-profile semantics.

### D3: Persisted status and drafts remain distinct during live updates

Save-only feedback reflects the source authoritative at the transaction's outcome: **Team saved. It remains inactive.** with activation action, or **Active team updated for new jobs.** An activation notice says **Team active for new jobs. Existing jobs and retries keep their recorded selection.** Source switches immediately make any saved team visibly inactive and retain its bytes.

Maintain keyed per-repository drafts for profile editing and source selection. Capture baseline revisions when the user begins the operation; SSE updates may update the persisted status but never silently rebind an activation draft to newer revisions. A conflict retains fields, target operation, focus, and review context; require a deliberate reload/review before retry. An activation from the saved-team summary must not silently submit an unsaved profile or discard its draft: make clear it activates the saved revision, with **Save and activate** available in the editor for the draft.

Feedback stays beside the affected repository, with accessible status/error announcements only for meaningful outcomes. Preserve focus when swapping fragments or closing a successful editor, preserve other repository drafts, and avoid announcing elapsed-time ticks.

*Alternative considered:* treat any successful response or browser dropdown value as current activation. Rejected because concurrent updates and unsaved selection drafts would produce false active banners.

### D4: Define historical runtime evidence precisely

For each repository, query the most recently launched OpenCode parent invocation by recorded launch time, with a stable invocation-ID tie-breaker. Join by repository through its job/attempt and include the job link, attempt/invocation reference, time, and attributed actual primary. Exclude preparation failures without a launch. Keep the query bounded and batched with the dashboard query rather than one CLI call or transcript scan per card.

If the newest invocation's primary is unknown, show that unknown; do not fall back to an older known identity and label it the latest. Legacy jobs without invocation evidence remain unobserved. A historical name remains historical even when the current source changes. Redact and escape all safe projected identities through existing boundaries. No private instructions or session transcript need to enter repository HTML.

Near the job title, render the job's captured source, requested native ID or managed primary/revision, and actual identity for the current attempt's latest invocation. Before launch say **Not started**; after launch without identity say **Not observed**. Keep earlier attempts/invocations in existing history. If the current repository source or managed revision differs, state that current settings affect new jobs and retrying retains this job's capture. Compare captured settings to current settings; never decorate an old default/native job with the current team roster.

An explicit native/managed request observed as a different primary is a visible discrepancy. Default source resolving to build is ordinary behavior. Job summaries must reuse existing trustworthy capture resolution, including legacy managed snapshots, and avoid inventing a capture for unsupported/unknown rows.

*Alternative considered:* display the currently selected primary as the last job's runner. Rejected because requested configuration is not runtime identity and repository edits cannot rewrite history.

### D5: Keep delegation availability and evidence separate

Reuse existing delegation projections and attributed observation trees. Put a concise observed-delegation line beside job workflow identity, with expandable existing detail below. For healthy observation and zero children say **No delegations observed**; for incomplete/unavailable evidence disclose that state rather than asserting zero execution. Non-OpenCode executors retain their limited-data wording and no activation controls.

Available children are definitions; running/completed counts come only from observed child sessions. Never count the parent as a child or promote configured/active roster entries into completed agents. Default/native jobs can have real delegated children even without a managed profile. Explain in team help that activation makes enabled children available and the primary decides when to delegate; this change does not impose delegation on every task.

*Alternative considered:* show a green delegation indicator as soon as a team is activated. Rejected because it would perpetuate the original confusion between configuration and execution.

## Risks / Trade-offs

- Two-resource activation can lose an update if a check occurs outside the transaction -> enforce both compare-and-set baselines, executor resolution, writes, and audit in the same transaction; fault-injection tests verify rollback.
- More prominent state adds repository-card height -> show one compact workflow status and action first, keep roster/tool details subordinate, and verify mobile widths and 200% zoom.
- Default source cannot reliably predict a future actual primary -> show the default policy and clearly dated last-launch evidence rather than a fabricated future identity.
- Independent profile and selection drafts can describe different baselines -> preserve each baseline and operation intent during SSE; explain conflicts instead of silently choosing one.
- Active selection can be mistaken for successful delegation/preflight -> use **Active for new jobs**, **Available**, and separately observed execution/coverage.
- Notification failure after persistence can cause duplicate submissions -> reconcile the committed revisions and report partial refresh failure without claiming rollback.
- Future configuration-page and job-safety changes touch these views -> keep workflow projections/components reusable; no new route relocation or lifecycle rail is required here.

## Migration Plan

1. Add projection and atomic activation support using existing tables; deploy with no data migration or automatic source changes.
2. Replace misleading team labels and expose the coordinated actions and job identity summary on the current console. Existing save-only/source-switch clients retain their semantics.
3. Verify existing inactive rows stay inactive until the operator activates them; queued jobs and retries keep their capture across restart and source changes.
4. Rollback by restoring previous console/store code. Existing profile and selection rows remain compatible; any explicitly activated selection remains an operator choice and is not automatically reset.

Acceptance uses temporary stores, fixture agents, and browser fixtures, with no live model invocation, GitHub mutation, or publication. Validate desktop/mobile, keyboard activation and conflict recovery, screen-reader status announcements, and SSE draft/focus preservation.
