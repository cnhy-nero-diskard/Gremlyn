## 1. Instance lock and shutdown

- [x] 1.1 Change the claim file to a parseable record carrying the owner process id, and treat an unparseable or unreadable claim as abandoned; verify a new unit test in `tests/orchestration.test.ts` covers a well-formed claim, a bare-legacy-id claim, and a garbage claim
- [x] 1.2 Make `acquire` probe the recorded owner with signal `0`, reclaim a dead or unparseable claim, and still refuse a live owner; verify tests assert reclamation succeeds for a dead pid and `InstanceLockError` is still thrown for the current process's own pid
- [x] 1.3 Make `release` idempotent and error-tolerant — report and swallow its own failures, never throw; verify a test calls `release` twice and against an already-deleted claim file without throwing
- [x] 1.4 Add a stream registry to the console server that tracks every open live-update stream and exposes ending them all; verify a test opens two streams, ends them via the registry, and asserts both responses completed
- [x] 1.5 Reorder shutdown to end registered streams before awaiting `close()`; verify a test opens a live-update stream, requests shutdown, and asserts shutdown resolves rather than hanging
- [x] 1.6 Escalate a second stop request to process termination instead of returning on the `stopping` guard, attempting release first; verify a test drives two stop requests and asserts the escalation path ran
- [x] 1.7 Wrap everything after `acquire` in `main` with `try/finally` so a startup failure releases the claim; verify a test forces a post-claim startup failure (unusable agent binary or mismatched authenticated login) and asserts the claim file is gone afterwards
- [x] 1.8 Register a synchronous best-effort release on `exit`, `uncaughtException` and `unhandledRejection`, and widen the signal set to include `SIGHUP` and `SIGBREAK`; verify a test spawns a child that throws from a timer and asserts no claim file remains
- [x] 1.9 Add `unlock` to the setup CLI: release a claim without starting the orchestrator, requiring explicit confirmation when the recorded owner is live; verify `tests/setup.test.ts` covers the dead-owner, live-owner-declined, and live-owner-confirmed cases

## 2. Repository provider and model fidelity

- [x] 2.1 Make `data-saved-provider`/`data-saved-model`/`data-saved-effort` the sole render input for the picker, so first paint, catalog refresh, and live-update swap all derive the selection from the persisted values and never from the controls being rewritten; verify a `tests/console.test.ts` case renders, applies a catalog whose ordering differs, and asserts the selection is unchanged
- [x] 2.2 Remove the first-option substitution: a saved model with no matching option for its provider is added as an explicit current option; verify a test uses a saved model absent from the catalog and asserts it is the selected option and is marked as the current value
- [x] 2.3 Add an effort-only save endpoint and route the effort control to it, so changing effort cannot write a provider or model; verify a test posts an effort change and asserts the repository's provider and model rows are untouched
- [x] 2.4 Keep provider and model as one atomic save and confirm no code path posts a DOM-scraped provider or model on an unrelated edit; verify a test changes the timeout and the effort in turn and asserts neither writes provider or model
- [x] 2.5 Exclude picker controls from the generic input-restore path and suppress repository-region re-render while a picker has focus or a save in flight; verify a test swaps the region mid-interaction and asserts the operator's in-progress selection survives and no save is issued
- [x] 2.6 Report a repository whose persisted provider its configured agent cannot use — on the card and at startup — without reassigning the provider or model; verify tests cover the console rendering and the startup report for a `cline` repository holding an `opencode` provider
- [x] 2.7 Add the provider to the repository record's documented fields and confirm operator selections survive restart while file configuration seeds only a first registration; verify `tests/runtime-repositories.test.ts` asserts a differing configured provider does not overwrite an existing entry's selection

## 3. Local time rendering

- [x] 3.1 Emit every timestamp as an element carrying its exact UTC instant and its display format (clock, relative, elapsed), with the server rendering the initial text; verify `tests/console.test.ts` asserts each rendered time carries the underlying instant and its format
- [x] 3.2 Reimplement `clockTime` and `logClock` with `Intl.DateTimeFormat`, defaulting to the host timezone; verify unit tests assert a known instant formats to the expected local time and no longer to the UTC field
- [x] 3.3 Add an optional `console.timezone` setting that overrides the host zone, and document it in `config.example.yaml` and `README.md`; verify `tests/config.test.ts` and `tests/config-example.test.ts` cover the setting and its absence
- [x] 3.4 Make rendered wall-clock times unambiguous about their zone; verify a test asserts the zone is identifiable from the rendered output

## 4. Proactive console updates

- [x] 4.1 Give the ticker a heartbeat that emits at least once per second while it has a subscriber, tagged distinctly from a change emission; verify a test asserts a heartbeat arrives with no database activity and carries its kind
- [x] 4.2 Have each region declare whether a heartbeat re-renders it — health yes, job lanes and repositories and job detail no; verify a test asserts a heartbeat re-renders only the health region
- [x] 4.3 Add a one-second client tick that re-derives relative and elapsed text from each element's carried instant, and re-run it after every region swap; verify a test asserts elapsed text advances with no new database activity
- [x] 4.4 Widen the change signature to cover each repository's provider, model, effort and timeout, and `validation_runs` rows; verify tests assert a signature change for each of those mutations
- [x] 4.5 Narrow the signature to non-terminal jobs and attempts plus a bounded window of recent rows, keeping the ticker's interface unchanged; verify a test asserts detection still fires for live and recent work and that the query no longer scans the whole job table
- [x] 4.6 Add live-update streams to the command-ingestion and audit routes; verify tests assert a newly ingested command and a newly recorded operator action each reach an open stream
- [x] 4.7 Move the dashboard header's status pill and summary inside the health region; verify a test asserts both change on a health emission
- [x] 4.8 Confirm staleness surfaces without a reload when polling stops; verify a test advances the clock past the poll interval with no other activity and asserts the console reports stale

## 5. Workspace reclamation

- [x] 5.1 Add a reclamation module that enumerates candidates using `workspacePathFor` and `isBeneath` only, so no path the system did not derive is ever a candidate; verify `tests/workspace-safety.test.ts` asserts sibling directories outside the root and unrecognized names inside it are never candidates
- [x] 5.2 Implement the eligibility conjunction — derived path, no non-terminal job for that repository and pull request, clean tree via `statusEntries`, older than the configured minimum age — with every predicate failing closed; verify tests cover each predicate refusing individually and an error in each predicate retaining the workspace
- [x] 5.3 Implement removal for both shapes: `git worktree remove --force` first, then direct removal with `git worktree prune`; verify tests reclaim a linked worktree and a standalone fallback clone and assert the source repository's worktree registry is consistent afterwards
- [x] 5.4 Record every reclamation and refusal through `OperatorActionStore` with its target and reason; verify a test asserts an audit row for a reclaimed workspace and for a refused dirty one
- [x] 5.5 Report a dirty workspace instead of removing it; verify a test asserts an eligible-but-dirty workspace is retained, reported as holding uncommitted work, and left byte-for-byte unchanged
- [x] 5.6 Add a preview mode that reports what would be reclaimed and why, removing nothing; verify a test asserts the preview lists eligible and retained workspaces with reasons and that no directory was removed
- [x] 5.7 Wire a startup sweep beside the existing stale-attempt cleanup and a periodic sweep on the poll timer, both disabled by default; verify a test asserts no sweep runs under default configuration and that both run when enabled
- [x] 5.8 Add the reclamation settings to the config loader with documentation in `config.example.yaml` and `README.md`; verify `tests/config.test.ts` and `tests/config-example.test.ts` cover them

## 6. Artifact retention

- [x] 6.1 Add age-and-total-size retention for captured output, validation artifacts and per-attempt state, restricted to terminal jobs; verify tests assert artifacts of non-terminal jobs are retained and that the ceiling trims oldest-first
- [x] 6.2 Report trimmed artifacts in the job view as no longer retained rather than presenting an empty panel, leaving `output_ref` in place; verify a test opens a job whose output file was trimmed and asserts the recorded detail still renders with an explicit not-retained notice
- [x] 6.3 Add the retention settings to the config loader with documentation in `config.example.yaml` and `README.md`; verify the config tests cover them

## 7. A branch already checked out elsewhere

- [x] 7.1 Extend `createWorkspaceCheckout` so a holder that is neither the source checkout nor the workspace path falls back to `createStandaloneCheckout` instead of raising `workspace-branch-in-use`; verify `tests/worktree.test.ts` replaces its current branch-in-use assertion with one that prepares successfully against a foreign worktree and asserts the holding worktree is byte-for-byte unchanged
- [x] 7.2 Narrow `workspace-branch-in-use` to the case where no workspace of any shape can be produced, and report a source holder with no usable `origin` under that reason rather than `workspace-diverged`; verify a test asserts the reason for a source holder whose `origin` is missing
- [x] 7.3 Add a per-repository adoption setting to the config loader, defaulting to off, documented in `config.example.yaml` and `README.md`; verify `tests/config.test.ts` and `tests/config-example.test.ts` cover the setting, its absence, and the default
- [x] 7.4 Implement the adoption preconditions — on the head branch, not detached, no unmerged entries or merge in progress, clean per `statusEntries`, fast-forwardable to the recorded head — reusing the checks preparation already performs; verify tests cover each precondition individually refusing adoption and falling back to a clone with the holding checkout untouched
- [x] 7.5 Confirm a dirty holding checkout can never route into `resumeDirtyWorkspace`, so another tool's work in progress is never resumed, committed, or pushed; verify a test drives an abrupt-run retry against a repository with adoption enabled and a dirty foreign worktree and asserts no adoption and no resumed edits
- [x] 7.6 Write the attempt claim into the directory `git rev-parse --git-dir` reports for the adopted checkout, carrying the attempt id and owning process id; verify a test adopts a checkout and asserts the claim is discoverable from within it while `statusEntries` still reports the tree clean
- [x] 7.7 Release the claim on every attempt outcome — success, failure, timeout, cancellation — and reclaim a claim whose recorded process is not alive, reusing the liveness probe from 1.2; verify tests cover each outcome releasing the claim and a dead-owner claim being reclaimed
- [x] 7.8 Refuse adoption of a checkout already carrying a live claim and fall back to a clone; verify a test asserts the second attempt clones and the first attempt's checkout is untouched
- [x] 7.9 Leave an adopted checkout on the branch it was adopted on with the attempt's work committed, and confirm publication's head re-verification still runs against it; verify a test asserts branch, cleanliness, and continued existence after an attempt ends
- [x] 7.10 Record adoption and every refusal through `OperatorActionStore` with the path and the deciding condition; verify tests assert an audit row for an adoption and for each refusal reason
- [x] 7.11 Confirm `resetWorkspace` and the reclamation module of 5.1 both refuse an adopted path, with explicit coverage rather than reliance on the `isBeneath`/`workspacePathFor` guards refusing it incidentally; verify `tests/workspace-safety.test.ts` asserts a reset requested against an adopted path is refused and recorded and that a sweep never lists one
- [x] 7.12 Show an attempt running in an adopted checkout as adopted in the console, with its path; verify `tests/console.test.ts` asserts the marker and path render for an adopted attempt and not for an ordinary one

## 8. Verification

- [ ] 8.1 Run `npm run build`, `npm test`, `npm run lint` and `npm run format:check` and confirm all pass
- [x] 8.2 Start the orchestrator against a scratch data directory, open the console, confirm live updates and local times, then stop with a single interrupt and confirm the process exits and the claim file is gone
- [x] 8.3 Change a repository's effort, then its model, then reload and navigate away and back, and confirm the persisted provider and model are unchanged throughout and the audit records only the edits made
- [x] 8.4 Run the reclamation preview against the development workspace roots and confirm it reports the accumulated `pr-*` directories, retains any dirty ones, and lists no path outside the configured roots
- [ ] 8.5 With adoption off, issue a command on a pull request whose branch is held by an operator worktree and confirm the job runs in an independent clone and the operator worktree is unchanged; then enable adoption, clean that worktree, and confirm the next attempt runs in it, publishes from it, leaves it on its branch, and leaves no claim behind
- [x] 8.6 Run `openspec validate harden-operator-runtime --strict` and confirm the change is valid
