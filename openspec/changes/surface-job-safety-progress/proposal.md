## Why

The job detail view records the facts needed to prove safe execution, but scatters them across status, timeline, attempt, validation, and log panels. Operators therefore have to reconstruct whether work was authorized, isolated, validated, published, and reported—and a finished agent can be mistaken for a fully successful job.

## What Changes

- Add a prominent, ordered safety/progress rail to job detail covering authorization, workspace isolation, agent completion, validation, publication, and GitHub reporting.
- Give each rail step an explicit pending, active, passed, failed, skipped, or not-applicable meaning derived from persisted job evidence rather than optimistic presentation state.
- Keep agent completion distinct from terminal job success; success is reserved for completion of every applicable downstream step.
- Surface the exact workspace path alongside explicit reassurance that the configured normal checkout was not used or modified, when isolation evidence supports that claim.
- Surface commit and pushed/unpushed state in the primary progress summary, including clear terminal semantics for work that remains local or unpublished.
- Strengthen the completed-job peak state with an unambiguous outcome summary and next action, while retaining detailed timeline, attempt, validation, log, and recovery evidence below it.
- Preserve the active inactivity-failsafe contract by distinguishing stalled, timed-out, cancelled, and other failed attempts within the agent step and terminal outcome.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-console`: Make job safety and end-to-end lifecycle progress explicit, evidence-backed, and scannable on the job detail view.

## Impact

- `src/console/queries.ts` and related view models may derive normalized lifecycle evidence from existing jobs, attempts, status events, validation runs, commits, pushes, and reporting records.
- `src/console/views/job.ts`, shared view components, and `src/console/assets.ts` will render and live-update the rail, isolation assurance, publication state, and terminal outcome summary.
- Console-focused tests and fixtures will cover running, successful, failed, stalled, timed-out, cancelled, skipped/not-applicable, unpublished, retried, and incomplete-reporting states.
- No route, authentication, redaction, persistence, executor, publication, or GitHub-reporting behavior changes are intended; the implementation remains server-rendered Fastify HTML with framework-free client enhancement.
