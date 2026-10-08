## 1. Presentation configuration and bootstrap

- [ ] 1.1 Add optional presentation/sound configuration and parse presentation, no-color, no-interaction, sound and mute flags alongside the existing config path; verify configuration/argument tests preserve positional and environment fallback behavior and reject unknown options safely.
- [ ] 1.2 Implement mode resolution against the actual presentation stream, CI, terminal capability and interaction settings; verify fake-stream tests cover interactive CMD/PowerShell, redirected stderr, explicit JSON/plain, unsafe forced terminal and NO_COLOR without emitting control codes in non-interactive modes.
- [ ] 1.3 Add an early selected-mode diagnostic reporter with bounded redacted causes and next actions; verify configuration, credentials, ownership, GitHub and version-preflight failures retain nonzero exits and do not leave terminal/lock resources acquired.

## 2. Structured logging and detail inspection

- [ ] 2.1 Introduce injectable Logger presentation sinks around the same redacted record while preserving database persistence and legacy JSON defaults; verify log-level/redaction tests and that terminal mode does not interleave routine JSON with display output.
- [ ] 2.2 Implement bounded meaningful plain-mode transition/warning/error output through a single presentation owner; verify unchanged poll noise is suppressed and diagnostics remain visible without cursor or color sequences.
- [ ] 2.3 Add a separate read-only log-tail entrypoint and npm script with data-directory, tail, follow and format options; verify it cannot migrate/create a database, claim daemon ownership or authenticate to GitHub, and handles missing/busy stores and follow shutdown safely.

## 3. Compact terminal surface

- [ ] 3.1 Build safe read-only startup/health/repository/job projections with observed poll freshness and bounded active/queued/recent rows; verify unknown/stale connections, disabled repositories, accurate counts/stages/durations and overflow fixtures.
- [ ] 3.2 Implement the anchored line renderer with dimension-aware layout, sanitization, optional color and bounded change-only refreshes; verify injected-clock/stream snapshots cover narrow/resized terminals, malicious escapes, ASCII fallback and no alternate-screen/full-clear loops.
- [ ] 3.3 Route diagnostics through the renderer and degrade write/capability failures to plain output; verify concurrent diagnostics cannot corrupt the region and renderer errors cannot change job processing or outcomes.

## 4. Committed outcome dispatch and Windows audio

- [ ] 4.1 Establish the post-recovery status-event baseline and consume new committed rows in bounded ordered batches; verify historical outcomes, duplicate reads, rollback/uncommitted rows, cancelled/interrupted events and internal retries never request cues.
- [ ] 4.2 Dispatch at most once per eligible success/failure event independently of job execution; verify downstream validation failure requests only failure, explicit retries can cue again, and restart/muted/disabled periods cannot replay consumed events.
- [ ] 4.3 Package distinct short success/failure WAV assets and a fixed Windows PowerShell SoundPlayer helper with a no-op unsupported-platform adapter; verify asset resolution and injected process tests prevent arbitrary path or repository-string interpolation and normal tests play no actual audio.
- [ ] 4.4 Bound playback concurrency, pending requests, expiry and helper timeout with safe rate-limited diagnostics; verify helper absence/failure/hang, queue overload and shutdown leave job results unchanged and do not retry stale cues.
- [ ] 4.5 Add independent enable/mute state and the supported TTY sound-control key with textual feedback; verify explicit opt-in, non-interactive exclusion, pending-cue suppression on mute, raw-mode restoration and existing Ctrl+C escalation.

## 5. Lifecycle integration and acceptance

- [ ] 5.1 Attach presentation to bootstrap/store readiness and dispose timers, resize/input listeners, log handles and audio helpers idempotently before store closure; verify startup exceptions, renderer/disposer errors and repeated stop requests still release ownership and close the store.
- [ ] 5.2 Add a fixture daemon integration spanning queued/running/validating/succeeded/failed/retried/interrupted work with no browser; verify terminal counts, detail logs, exact cue requests and unchanged execution/publication behavior.
- [ ] 5.3 Run a manual Windows matrix for npm-start forwarding, CMD/PowerShell/Windows Terminal resizing, redirected/CI/NO_COLOR launches and opt-in audible cue distinction; record results including muted-device/helper limitations without claiming audibility from helper exit alone.
- [ ] 5.4 Run full tests, build, lint and changed-file format checks; verify configuration, logging/redaction, startup ownership, shutdown and publication regressions remain green without real audio in the automated suite.
- [ ] 5.5 Document presentation overrides, browser-independent logs, sound opt-in/mute, at-most-once best-effort cue semantics and JSON rollback; verify examples preserve the existing config-path launch and pinned prestart safety.
