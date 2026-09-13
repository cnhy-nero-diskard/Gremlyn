## 1. Admit a validation failure to the retained-workspace carve-out

- [x] 1.1 Extend `canResumeRetainedWorkspace` in `src/orchestrator/resolution.ts` to admit an attempt that failed at `publishing` with `validation-failed`, keeping the existing guards (recorded uncommitted changes, matching deterministic workspace path, matching recorded head) — verify by reading the predicate: the new case is enumerated by reason, not by stage alone
- [x] 1.2 Update the predicate's doc comment to say why a validation failure belongs beside the abrupt-run cases: the retained edits are this job's own agent's, made in this workspace against this head — verify the comment names provenance as the admission criterion rather than the failure's severity
- [x] 1.3 Confirm no other publishing block reason is admitted — verify `no-changes`, `head-changed`, `workspace-conflicted`, `workspace-invalid`, and `pull-request-closed` each still return false from the predicate

## 2. Carry the inherited failure into the prompt

- [x] 2.1 Add an inherited-validation-failure section to `buildResolutionPrompt` in `src/agent/prompt.ts`, taking the failing command and its captured output, delimited as data with an orchestrator-authored marker and placed outside the review context delimiters — verify the marker and the delimiters are distinct from `CONTEXT_START`/`CONTEXT_END`
- [x] 2.2 Truncate the carried output from the tail with the elision marked — verify a long output keeps its final lines and states how much was dropped
- [x] 2.3 Thread the failing run into the attempt in `src/orchestrator/resolution.ts`: read the prior attempt's failing `validation_runs` row and its `output_ref`, and pass it to the prompt only when the workspace was actually resumed — verify a retry that prepared a clean checkout builds a prompt with no such section
- [x] 2.4 Handle a missing or unreadable `output_ref` without failing the attempt — a retained artifact can have been reclaimed; verify the prompt then names the failing command with the output omitted rather than throwing

## 3. Tests

- [x] 3.1 Add a case to `tests/resolution-orchestrator.test.ts`: an attempt blocked at `publishing` with `validation-failed` that left uncommitted changes, retried — verify the retry prepares the same workspace, the edits survive, and the agent runs
- [x] 3.2 Add the negative case: the same shape blocked for a different publishing reason — verify the retry fails with `workspace-dirty` and the modifications are preserved
- [x] 3.3 Add a case asserting the head guard still bites: a validation-failed attempt whose recorded head has since moved — verify no resume
- [x] 3.4 Add prompt tests: the section is present, names the failing command, carries the output tail as delimited data outside the review context, and is absent for a clean-checkout attempt
- [x] 3.5 Run `npm run build`, `npm run lint`, and `npm test` — verify all pass

## 4. Operator-facing text

- [x] 4.1 Update the README's `workspace-dirty` troubleshooting entry so it no longer sends the operator to clean the workspace after a validation failure — verify it states that a retry resumes that case and names the reasons that still require the manual route

## 5. Land the specs

- [ ] 5.1 Sync the delta specs into `openspec/specs/workspace-isolation` and `openspec/specs/agent-execution`, then archive the change
