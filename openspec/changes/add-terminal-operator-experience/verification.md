# Terminal operator experience verification

## Automated evidence

Focused tests cover configuration/flags and stderr-based capability resolution;
legacy JSON, redaction, durable logging and read-only log inspection; bounded
health/job projections and anchored refreshes; committed-event baselines,
deduplication, retries and mute suppression; fixed packaged assets, bounded
injected helpers; raw-mode restoration; startup failure and ownership cleanup;
and fixture-orchestrator validation/publication and shutdown behavior.

The integration fixture uses real local Git repositories, the production
orchestrator and status-event store, fixture GitHub and a controlled executor.
It exercises timer-driven terminal refresh and persists detail logs without a
browser. Audio launchers/clocks are injected: the normal automated suite never
plays actual audio or calls a paid agent or external GitHub API.

Final automated acceptance results:

- `npm test`: 1,095 tests; 1,092 passed, zero failed, three skipped
  (189.67 seconds). An earlier full run also passed with the same totals.
- The skips are the Windows-inapplicable owner-only credential permission
  check and two explicitly opt-in live OpenCode model acceptance checks
  (`GREMLYN_LIVE_OPENCODE_MODEL` and `GREMLYN_LIVE_NATIVE_OPENCODE_MODEL`
  were unset). No paid/live agent run was requested by these checks.
- `npm run build`: passed.
- `npm run lint`: passed repository-wide.
- `npx prettier --check <explicit changed textual paths>`: passed across all
  checkpoints and final documentation. Binary WAV assets and the PowerShell
  helper were excluded because Prettier does not format those file types.
- Focused final affected-area tests: 29 passed, zero failed.
- `git diff --check` and staged-diff whitespace checks: passed.

README launch examples retain the positional config path after npm's `--`,
the existing pinned `prestart` is unchanged, and the example terminal block
keeps sound disabled by default. These results do not substitute for the
manual Windows acceptance task.

## Terminal UX refinement evidence (approved scope)

An approved compact-surface refinement changed the default terminal layout: the
dashboard now prioritizes bounded current active/queued work plus at most one
`Latest:` completion, instead of listing many recent rows. History stays in the
read-only detail logs; the manual Windows task 5.3 remains unchecked.

Focused refinements and regressions added and passing (terminal suites: 34
projection/renderer/integration tests plus 97 options/input/audio/logging/
startup tests, zero failures):

Final refinement checks: full `npm test` passed with 1,106 tests, 1,103
passed, zero failed and the same three expected skips (182.47 seconds).
Repository-wide `npm run lint`, `npm run build`, changed-file Prettier checks
and `git diff --check` also passed. A read-only review found no concrete
correctness or safety gaps. The sample idle layout was additionally rendered
through the real `snapshotLines` function with the screenshot's 3/3 repository
and zero active/queued state; this is not an interactive desktop verification.

- An idle daemon with 240 stored completions (mixed failures and successes)
  shows the idle waiting line and exactly one latest completion: zero history
  rows and zero overflow (`overflow` counts current work only).
- The single latest completion is ordered by finish time, so a newer committed
  success supersedes an older failure; a genuinely newest failure still
  surfaces naturally.
- Current-work overflow: with 50 active, 50 queued and 200 terminal jobs and a
  row limit of ten, the surface lists only current rows and reports
  `overflow === 90` (terminal history never enters the count).
- Colliding repository names: two displayed repos named `widgets` under
  different owners render `owner/name`; a lone displayed `widgets` shortens.
  Repeated rows of the same repository keep the short label.
- Layout: internal job ids are not rendered, stage-identical outcomes are not
  repeated, `... N more active/queued` labels overflow, and a narrow row budget
  truncates current rows while still labeling the backlog. Renderer
  sanitization, geometry/fallback, single-owner anchoring and the no-full-clear
  rule are unchanged (existing renderer cases still green).
- Overflow is exact at tight budgets: the summary slot is reserved before rows
  are placed (never fabricated by replacing a rendered row), so a budget of one
  body line reports the full `active + queued` backlog, an orphaned `Active (N)`
  heading never appears without its rows, multiple truncated lanes keep one
  exact summary line, and the single latest completion is emitted only when it
  really fits.
- Colliding `owner/name` concatenations are re-sanitized, so a combined label is
  still bounded by the single-label length limit and printable-ASCII contract;
  a test drives 300-char owners through the bound.
- The sound hint is action-oriented: `Sound: disabled [m: enable]` and
  `Sound: enabled [m: mute]` asserts are green (a hand-written sample previously
  showed a misleading `disabled [m: mute]`; the controller's `soundLabel` was
  already correct and is now locked by a renderer test).
- Redaction/sanitization coverage still asserts ASCII fallback, secret
  redaction and instruction omission on the new short labels.

Sample renders (24-row budget) produced by the approved layout:

```text
=== IDLE (240 historical jobs) ===
Gremlyn | ready | connection: healthy
Repos: 1/1 enabled | Active: 0 | Queued: 0
Poll: 4s ago | Sound: disabled [m: enable] | Details: npm run logs -- --data-dir <directory>
Idle. Waiting for authorized review commands.
Latest: widgets PR #1239 | succeeded | 1s

=== BUSY (3 active, 12 queued, 241 history) ===
Gremlyn | ready | connection: healthy
Repos: 1/1 enabled | Active: 3 | Queued: 12
Poll: 4s ago | Sound: enabled [m: mute] | Details: npm run logs -- --data-dir <directory>
Active (3)
  widgets PR #2002 | running | 40s
  widgets PR #2001 | running | 35s
  widgets PR #2000 | running | 30s
Queued (12)
  widgets PR #3000 | queued | 9s
  ...
... 7 more active/queued
Latest: widgets PR #1239 | succeeded | 1s
```

## Windows shell smoke checks performed

| Case | Result | Evidence boundary |
| --- | --- | --- |
| CMD `npm start -- <config-path> --presentation json` argument forwarding | Pass | Real npm lifecycle ran `prestart` and forwarded both path and options to `src/index.ts`; a deliberately missing fixture config produced one safe JSON error and exit 1. |
| Preserve pinned prestart | Pass | Fixture-only `cline.cmd`/`opencode.cmd` reported the existing pinned versions through PATH; `prestart` remained enabled. Agent sources/pins and README bytes were unchanged by the smoke launch. This does not exercise a production agent invocation. |
| Redirected stderr, auto mode | Pass | Windows non-TTY entrypoint launch failed safely at configuration preflight with JSON and no cursor/color/BEL characters. |
| CI, auto mode | Pass | Same non-TTY launch with `CI=1`; safe nonzero failure without control codes or audio. Interactive CI gating is additionally covered by fake-stream tests. |
| `NO_COLOR`, auto mode | Pass | Non-TTY entrypoint launch with `NO_COLOR=1`; safe nonzero failure without control codes or audio. Interactive style suppression is covered by fake-stream tests. |
| Forced terminal on redirected stderr | Pass | Plain fallback explanation appeared once, followed by the actionable configuration error; no terminal controls or audio. |
| Plain with `--no-interaction` | Pass | Actionable append-only configuration failure; no controls or audio. |

These launches deliberately stop before credentials, network connectivity or
job acceptance. Steady-state lifecycle behavior is covered by the fixture
integration, not claimed as a production connectivity check.

## Manual Windows matrix still required (task 5.3)

**Not verified:** interactive CMD/PowerShell/Windows Terminal rendering and
resize behavior, actual audible success/failure distinction, and device mute
or output-routing behavior. The execution tools provide redirected process
streams, not an attached interactive desktop console or a hearing observer.
Fake TTY/process tests and successful helper returns cannot prove these cases.
Task 5.3 remains unchecked; do not archive the change as accepted yet.

An operator with a Windows desktop/audio output should run the following with
no browser open and a safe fixture/test repository (never a production PR for
acceptance-only work):

1. In CMD and PowerShell, both standalone and inside Windows Terminal, run
   `npm start -- .\gremlyn.yaml`; retain the real pinned prestart and preflight.
   Observe startup readiness, unknown health before successful polling, fresh
   and stale/failed poll states, and enabled/configured repository counts.
2. Exercise queued/running/validating/terminal job states. Resize from wide to
   narrow and back, and shorten terminal height. Check bounded rows, overflow,
   readable states, intact scrollback and no repeated full-screen clearing.
3. Repeat with `--no-color`, a non-empty `NO_COLOR`, stderr redirected to a
   file, `CI=1`, `--presentation plain`, and `--presentation json
   --no-interaction`. Verify JSON/plain have no cursor or styling sequences.
4. Launch with sound omitted: terminal outcomes must be silent. Launch with
   `--sound`, then complete one success and one validation failure. **Listen**
   for distinct short ascending/descending cues. An agent's successful exit
   followed by failed validation must request only failure sound.
5. Press `m` to mute, complete work, unmute, and verify suppressed/pending cues
   never replay. Explicitly retry a failed job and verify the new terminal
   transition can cue; restart with history and verify no replay.
6. Test `--sound --mute`, device mute and unavailable audio output. Separately
   make the helper unavailable in a disposable installation (not this checkout)
   and verify safe rate-limited warnings without changed job results. Record
   helper/process evidence separately from what was actually heard.
7. Press Ctrl+C during refresh/playback, and repeat during shutdown. Confirm
   raw mode restored, helpers/timers disposed, store closed and ownership
   released, with the existing repeated-stop escalation intact.

Record host/terminal, observed rendering, each cue heard/not heard, device
mute/routing state and helper limitations. **Do not infer audibility from exit
code 0.** Only mark task 5.3 complete after this full matrix has real results.
