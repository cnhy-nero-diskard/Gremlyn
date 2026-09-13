## 1. Extract data access without changing behaviour

- [x] 1.1 Create `src/console/queries.ts` and move every SQL statement out of `src/console/server.ts` into named functions returning typed models (`readDashboard`, `readJobDetail`, `readJobLog`), keeping the existing shapes exactly; verify `npm test` passes with `tests/console.test.ts` unmodified
- [x] 1.2 Move redaction into the query layer per design D10 so every returned model is already redacted, and remove the per-call-site redaction from the route handlers; verify the existing "no secret appears in the body" assertions in `tests/console.test.ts` still pass and `response.body.includes(SECRET)` remains false
- [x] 1.3 Add `pollIntervalSec` and `concurrency` to `ConsoleOptions` and pass them from `src/index.ts` per design D5; verify `npm run build` succeeds and `npm run lint` is clean

## 2. Presentation foundation

- [x] 2.1 Create `src/console/assets.ts` exporting the stylesheet and client script as string constants with a content hash for the URL, and serve them at `/assets/app.<hash>.css` and `/assets/app.<hash>.js` with a long `cache-control`; verify both routes return 200 with the correct content type
- [x] 2.2 Exempt the asset routes from the `onRequest` auth hook per design D2; verify a new test asserts both asset routes return 200 without a token, that their bodies contain no secret value, and that every other route in the existing 401 test still returns 401
- [x] 2.3 Define the colour token system in the stylesheet on `:root` with a `prefers-color-scheme: dark` override per design D7, including a distinct treatment per terminal status pairing colour with a non-colour cue; verify each of `succeeded`, `failed`, `cancelled`, `interrupted` resolves to a distinct token
- [x] 2.4 Create `src/console/views/layout.ts` replacing `page()` with a shell carrying viewport meta, the asset links, and cross-page navigation between dashboard, commands and audit views; verify job detail renders a link back to the dashboard and that `escapeHtml` is still applied to the title
- [x] 2.5 Create `src/console/views/components.ts` with status pill, duration, relative timestamp, key-value table and danger-zone helpers as pure functions; verify unit tests cover each helper's escaping and its rendering of absent or null values
- [x] 2.6 Restyle the `/auth` sign-in view against the shared stylesheet; verify it renders styled without a token and still returns 401 on a wrong token and sets the `HttpOnly` cookie on a correct one

## 3. Dashboard

- [x] 3.1 Add a health query reading last poll time from `ingestion_state`, queue depth and in-flight count from `jobs`, and judge staleness against the configured poll interval; verify unit tests cover a fresh poll, a stale poll and no poll recorded
- [x] 3.2 Create `src/console/views/dashboard.ts` rendering the health strip and replace the hardcoded `Orchestrator status: running` string; verify a new test asserts the real health values render and revise the assertion at `tests/console.test.ts:176` that pins the old literal markup, as declared in `proposal.md`
- [x] 3.3 Render repositories as cards showing agent, model, effort and validation commands including the empty case, each with an inline enable/disable control; verify a test asserts the model and effort appear and that a repository with no validation commands states so rather than rendering blank
- [x] 3.4 Render the running, queued and recent job lanes with per-status visual treatment, created and finished times and elapsed duration; verify a test asserts a succeeded and a failed job carry different status markup and that the `Running`, `Queued` and recent-section headings the existing test matches are preserved

## 4. Job detail

- [x] 4.1 Create `src/console/views/job.ts` rendering the status timeline from `status_events` as a stepper with per-stage and total elapsed time; verify a test asserts stage durations render and that the timeline is no longer a `JSON.stringify` block
- [x] 4.2 Render validation runs as a table of command, exit code and duration with collapsible output; verify a test asserts the failing command is identifiable per the spec scenario and that `Validation results` and `validation failed: [redacted]` still appear
- [x] 4.3 Render each attempt with agent, model, effort, workspace path, outcome, failure stage and reason, commit, report status, plus `agent_exit_code`, `pushed`, `has_uncommitted_changes` and `head_sha_at_prepare`; verify a test asserts the new fields render and that `Attempt 1`, `Attempt 2`, `agent-nonzero-exit`, `validation-failed`, `workspace-2` and `abc123` still appear
- [x] 4.4 Render the review context as structured content — pull request title, branch, file path and monospace diff hunk with the comment thread — instead of a raw serialized block; verify the existing escaping assertion `/&lt;script&gt;\[redacted\]&lt;\/script&gt;/` still passes
- [x] 4.5 Add a direct pull-request link alongside the existing triggering-comment link; verify a test asserts both links are present and that `discussion_r101` still appears
- [x] 4.6 Replace the serialized log block with a log viewer filtering by level and text on the client over `GET /jobs/:id/log` per design D9; verify a test asserts individual entries render with time, level, event and fields distinguishable and that `Structured log` still appears

## 5. Command ingestion and audit views

- [x] 5.1 Add queries over `processed_commands` and `operator_actions` returning redacted models; verify unit tests cover a refused command with a reason, a command that produced a job, and redaction of a secret appearing in an action's `detail`
- [x] 5.2 Create `src/console/views/commands.ts` and add an authenticated route rendering observed commands with repository, pull request, comment, command, author, time, outcome and refusal reason, linking to the job where one exists; verify a test asserts a refused command shows its reason and that the route returns 401 without a token
- [x] 5.3 Render the operator action history with time, action, target and effect; verify a test asserts a recorded retry and a recorded workspace reset both appear with their effect

## 6. Live progress

- [x] 6.1 Create `src/console/stream.ts` with a single shared change-detection ticker that connections subscribe to, replacing the per-connection `waitForJobChange` loop; verify a unit test asserts the ticker starts on first subscriber and stops when the last one disconnects
- [x] 6.2 Convert `GET /jobs/:id/stream` to a held-open SSE response per design D3, with keepalive frames and teardown on `close` and `error`, retaining `?snapshot=1` as the single-event mode; verify the existing snapshot test at `tests/console.test.ts:219` still passes unchanged through `app.inject`
- [x] 6.3 Change the stream payload to JSON-encoded HTML fragments keyed by region id on one `data:` line per design D4; verify the snapshot test's `reporting` and `new live output` matches still pass and that no raw newline appears inside a `data:` field
- [x] 6.4 Add the client fragment-swap script replacing `location.reload()`, preserving scroll position, `<details>` state and typed input, and re-pinning output to the bottom only when already at the bottom; verify a test asserts no `location.reload()` remains in any served script
- [x] 6.5 Add a dashboard stream and region ids so newly queued, started and completed jobs appear without a reload; verify a test asserts the dashboard stream route requires a token and emits a fragment when a job's status changes
- [x] 6.6 Add a test for the held-open behaviour against a real ephemeral listener with a timeout, asserting a second event arrives on the same connection after a second change; verify it passes and terminates without leaving the listener open

## 7. Operator actions become invocable

- [x] 7.1 Wire the retry and cancel controls in the client script to their existing routes, showing the outcome in the view and surfacing a 501 or error response as a visible refusal rather than silence; verify a test asserts the served script binds both `data-action` values and that the routes still record their actions
- [x] 7.2 Offer retry only for `failed`, `cancelled` and `interrupted` jobs and cancel only for `queued` and running jobs, stating why an action is unavailable rather than rendering an inert control; verify a test asserts a succeeded job offers neither and a queued job offers cancel
- [x] 7.3 Wire the repository enable/disable control to `POST /repos/:id/toggle` and reflect the new state in place; verify a test asserts the toggle route is bound from the dashboard markup and that the recorded action's effect matches the resulting state
- [x] 7.4 Replace the permanently disabled reset button with a danger zone containing a pull-request number input and a `RESET` confirmation input that gates the control per design D8; verify a test asserts the control is gated until the confirmation is supplied, that the server still returns 400 for a wrong confirmation, and revise the assertion at `tests/console.test.ts:208` that pins the `typing RESET` copy, as declared in `proposal.md`

## 8. Verification and documentation

- [x] 8.1 Confirm `src/console/server.ts` contains only routing and the auth hook, with no SQL, no HTML templating and no inline client script; verify by inspection that its remaining imports are the new modules and that `npm run build` succeeds
- [x] 8.2 Extend the redaction assertions to every new route — commands, audit, dashboard stream and asset routes — asserting the configured secret appears in none of their bodies; verify the new assertions pass
- [x] 8.3 Run `npm run lint`, `npm run format:check`, `npm run build` and `npm test` and verify all four are clean
- [x] 8.4 Update the `README.md` connectivity-check section to describe the redesigned dashboard an operator should see after signing in, including the health strip and the commands view; verify the described views match what the console renders
- [x] 8.5 Start the orchestrator against a real configuration, sign in, and walk one job from queued to a terminal state confirming live updates arrive without a reload, retry and cancel are invocable, a repository toggles, and a refused command appears in the commands view; verify each observation and record any deviation

> Verification note: task 8.5 completed against the real `gremlyn.yaml`: sign-in returned 200 with an HttpOnly cookie; dashboard, commands, audit, job details, and dashboard SSE snapshot returned successfully; job 1 was retried and cancelled (both actions returned 200, ending in `cancelled`); the held-open job stream delivered an initial and second event on the same connection; repository 1 was toggled off and back on; audit showed retry/cancel/toggle actions; and the commands view showed an existing ignored/refused command. One deviation was found and fixed during the walk: the client sent an empty JSON body for bodyless POST actions, which Fastify rejected with 400; the client now omits the JSON content type and body when no payload is required.
