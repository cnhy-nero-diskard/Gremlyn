## 1. Publication accepts and observes cancellation

- [x] 1.1 Add a `signal: AbortSignal` field to the `publishIfEligible` input and a
  third result kind `{ kind: "cancelled"; commitSha?: string }` to
  `PublicationResult` in `src/publish/policy.ts`; verify `npm run build` passes and
  every existing caller is forced to handle the new kind
- [x] 1.2 Check the signal after the preconditions pass and before `commitAll`,
  returning `{ kind: "cancelled" }` with no `commitSha`; verify with a unit test in
  `tests/validation-publication.test.ts` that an already-aborted signal produces no
  commit and no push
- [x] 1.3 Check the signal again after `commitAll` returns and before `pushHead`,
  returning `{ kind: "cancelled", commitSha }`; verify with a unit test that a
  signal aborted between the two steps leaves the commit in the workspace, performs
  no push, and reports the sha
- [x] 1.4 Verify the uncancelled path is unchanged: existing publication tests still
  pass with `npm test`

## 2. Orchestrator maps a cancelled publish to the cancellation path

- [x] 2.1 Pass the attempt's `signal` into `publishIfEligible` from the publishing
  stage in `src/orchestrator/resolution.ts`; verify `npm run build` passes
- [x] 2.2 Handle `{ kind: "cancelled" }` by raising the existing `job-cancelled`
  error rather than a `StageFailure`, so `cancelJob` records the outcome; verify no
  new entry is added to `FAILURE_REASONS` and a test asserts the attempt's
  `failure_reason` is null while its outcome is `cancelled`
- [x] 2.3 Verify with a test in `tests/resolution-orchestrator.test.ts` that a job
  cancelled during publishing reaches the `cancelled` status, records
  `pushed = 0`, and posts no publication-failure reply to the pull request

## 3. The attempt record distinguishes an unpushed commit

- [x] 3.1 Move the `recordPublication` call so the commit sha is stored as soon as
  the commit exists, leaving `pushed` to record whether it left the machine; verify
  a successful attempt still ends with both `commit_sha` set and `pushed = 1`
- [x] 3.2 Verify with a test that a cancel between commit and push produces
  `commit_sha != null AND pushed = 0`, and that `cancelJob` reports the workspace as
  holding an unpushed commit
- [x] 3.3 Verify with a test that a *failed* push now also retains the sha of the
  commit it was pushing, rather than losing it

## 4. Downstream readers of a recorded commit

- [x] 4.1 Audit every reader of `attempts.commit_sha` (operator console views,
  `src/publish/report.ts`, retry eligibility in `src/orchestrator/resolution.ts`)
  for the assumption that a recorded sha means a pushed commit; verify each either
  consults `pushed` or is documented as not needing to
- [x] 4.2 Extend the retry path so an attempt cancelled with an unpushed commit
  reuses that commit instead of re-creating one; verify with a test that retrying
  such a job does not produce a duplicate commit
- [x] 4.3 Verify the operator console renders a committed-but-unpushed attempt
  without implying the work was published

## 5. Verification

- [x] 5.1 Run `npm run build`, `npm test`, and `npm run lint` and verify all pass
- [x] 5.2 Verify against the spec deltas that every scenario in
  `specs/job-orchestration/spec.md` and `specs/resolution-publication/spec.md` has a
  corresponding test
- [x] 5.3 Run `openspec validate honor-cancel-during-publish --strict` and verify it
  reports no problems
