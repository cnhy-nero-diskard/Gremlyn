## 1. Evidence Projection

- [ ] 1.1 Extend the redacted job-detail query model with the repository source path and parsed validation configuration needed by the progress projection, and verify `tests/console.test.ts` covers both values plus secret redaction without changing route or database contracts
- [ ] 1.2 Add a typed, pure six-step job-progress projection that selects the current attempt rather than inheriting an older retry's evidence, and verify focused tests cover current-attempt selection and the exact Authorized -> Workspace isolated -> Agent finished -> Validation passed -> Published -> GitHub reported order
- [ ] 1.3 Implement the persisted-evidence state matrix for pending, active, passed, failed, skipped, and not-applicable states, and verify focused fixtures cover queued, preparing, running, validating, publishing, reporting, succeeded, failed, cancelled, interrupted, zero-validation-command, and contradictory legacy rows
- [ ] 1.4 Map agent-stage failure evidence to plain-language outcomes in one place, preserving distinct nonzero-exit, timeout, cancellation, and `add-agent-stall-failsafe` stall semantics, and verify stalled and timed-out fixtures render different labels without changing watchdog behavior
- [ ] 1.5 Derive workspace and publication assurance only from the current attempt's recorded facts, and verify tests cover an ordinary isolated path, adopted non-source checkout, missing preparation evidence, source-path contradiction, no commit, local unpushed commit, pushed commit, pending report, posted report, and failed report

## 2. Job Peak State and Rail

- [ ] 2.1 Render a semantic terminal/in-progress outcome banner and ordered six-step rail before agent activity in `job-detail-region`, and verify the HTML has a labelled heading, visible text for every state, and `aria-current="step"` only on the active step
- [ ] 2.2 Render the exact workspace path, conditional “Source checkout untouched” reassurance, adopted-checkout qualification, commit SHA, and pushed/unpushed/reporting evidence in the peak state, and verify unsafe or incomplete evidence never produces a passed claim
- [ ] 2.3 Make successful, failed, cancelled/interrupted, local-unpublished, and pushed-but-reporting-failed terminal summaries explicit with an appropriate next action, and verify agent exit success alone never renders the job-success summary
- [ ] 2.4 Preserve the existing timeline, attempts, validation, review, activity, log, actions, and danger zone below the new summary, and verify existing job-detail assertions still find their forensic evidence and controls

## 3. Responsive and Live Behavior

- [ ] 3.1 Add rail and outcome styles using the existing console tokens, with non-color state cues, focus-safe links, reduced-motion behavior, and safe wrapping for long Windows paths and SHAs; verify desktop and narrow-width fixtures show a horizontal and vertical rail respectively with no clipped content or horizontal page overflow
- [ ] 3.2 Keep initial rendering and SSE fragment refreshes on the same server-side projection, applying updates through the keyed reconciler owned by `improve-console-accessibility-and-session-ux`; verify a live job advances through agent, validation, publication, and reporting states without reloading or losing expanded sections, scroll position, or typed reset confirmation
- [ ] 3.3 Verify all new copy and evidence is escaped and redacted before rendering, unauthenticated asset responses remain fixed and data-free, and `/jobs/:id` plus its stream still reject invalid tokens

## 4. Verification

- [ ] 4.1 Run the focused console tests and inspect representative running, successful, validation-failed, stalled, timed-out, cancelled, unpushed, and reporting-failed fixtures at desktop and narrow widths; verify the rail is scannable and the success peak names the pushed commit
- [ ] 4.2 Run `npm run lint`, `npm run build`, and `npm test`, and verify all checks pass without changing execution, publication, reporting, authentication, redaction, or persistence behavior
- [ ] 4.3 Run `openspec validate surface-job-safety-progress --type change` and verify the proposal, design, modified `operator-console` delta, and task checklist validate together
