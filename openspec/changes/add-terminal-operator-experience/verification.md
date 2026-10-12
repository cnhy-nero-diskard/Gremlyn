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
