## Why

Operators leave Gremlyn running in Windows CMD or PowerShell while working elsewhere, but `npm start` currently exposes JSON logs rather than a scannable operational view and gives no audible completion signal. [Issue #13](https://github.com/cnhy-nero-diskard/Gremlyn/issues/13) calls for a lightweight terminal experience that remains useful without an open browser and without changing job execution or safety.

## What Changes

- Add a compact interactive-TTY startup banner and refresh-in-place dashboard showing observed daemon/connection health, configured and enabled repositories, latest poll, active/queued counts, and bounded job rows with repository, PR, lifecycle stage, elapsed duration, and last outcome. Keep updates quiet and localized; do not build a full-screen application.
- Select presentation automatically from terminal capabilities, with explicit terminal, plain, and JSON overrides. Redirected output, CI, and unsupported terminals use non-interactive output; respect no-color behavior. Preserve the existing positional configuration-path launch contract.
- Separate terminal presentation from detailed structured logging. Continue redaction and durable operational logs, retain an explicit machine-readable pathway, and provide a documented way to inspect details without interleaving routine JSON/poll noise with the dashboard.
- Report configuration, credential, version, connection, and other startup/preflight failures legibly with actionable next steps, including failures before the normal dashboard is ready. Preserve failure exit codes and data-directory ownership rules.
- Add opt-in, independently mutable sound enablement and mute controls, with distinguishable success/failure cues through a bounded Windows OS-level audio mechanism rather than relying solely on terminal BEL. Playback failures, unavailable helpers, and muted devices never block processing or change a job result.
- Trigger at most one playback request per newly observed committed success/failure transition while the daemon is running, not per poll, log line, agent exit, validation subprocess, or internal invocation retry. Establish a startup baseline without replaying historical outcomes; an explicit operator retry can produce a new terminal-transition cue. Cancelled/interrupted jobs are silent, and muting consumes observations without replaying them later.
- Keep the surface observational. Bound rendering and audio work, handle terminal resize/failure gracefully, and clean up timers, helpers, and terminal state during startup failure or shutdown without interfering with existing shutdown behavior.

## Capabilities

### New Capabilities

- `terminal-operator-experience`: Browser-independent terminal health/job presentation, presentation-mode selection, compatible detailed logging, actionable startup diagnostics, and optional deduplicated Windows outcome audio.

### Modified Capabilities

None. Existing job lifecycle, structured operational logging, redaction, and runtime ownership requirements remain authoritative.

## Impact

- Affects daemon/bootstrap integration in `src/index.ts`, logging sinks in `src/log/logger.ts`, configuration parsing in `src/config/loader.ts`, and launch documentation. Terminal/audio adapters are new presentation infrastructure; read-only projections in `src/console/queries.ts` and committed `status_events` in `src/store/jobs.ts` are reusable sources.
- Windows audio transport and any packaged cue assets will be selected and manually verified during design/implementation; distinct audible playback is not assumed from an API return value. Prefer a small isolated adapter over a general terminal framework or native-addon dependency.
- Tests cover TTY/CI/redirected selection, transition deduplication, retries, startup baseline, mute, redaction, audio/helper failures, terminal failure, resize, and shutdown. Document manual CMD/PowerShell verification with no browser open and with audio disabled/unavailable.
- Independently deliverable from `select-native-opencode-agent` (#14) and `observe-live-agent-delegation` (#15). No web-console redesign, terminal repository editor, custom audio-file picker, scheduled quiet-hours feature, or change to validation/publication policy is included.
