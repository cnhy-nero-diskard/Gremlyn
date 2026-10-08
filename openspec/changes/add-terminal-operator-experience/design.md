## Context

See `proposal.md` and `specs/terminal-operator-experience/spec.md`. `main` treats its first argument as a configuration path, starts preflight before constructing the normal logger, and always writes logger JSON to stderr. SQLite already holds redacted `log_entries`, committed `status_events`, repositories and jobs; the console queries contain useful read-only projections. The daemon does not require a browser client, and presentation must not introduce that dependency.

This design is required because mode selection, bootstrap errors, terminal ownership, Windows helpers and shutdown cross multiple modules. No terminal framework, native audio addon or frontend build pipeline is needed.

## Goals / Non-Goals

**Goals:** One bounded observational terminal surface; precise committed-outcome cue semantics; useful startup errors; a browser-independent detail path; no noisy competition between logger and renderer; reversible shutdown resources.

**Non-Goals:** Full-screen alternate-buffer UI; terminal job/repository mutations; altering agent/process outcomes; scheduled quiet hours; arbitrary sound paths; new delegation telemetry; making muted hardware audible.

## Decisions

### D1. Parse explicit presentation options without changing positional config semantics

Use Node's argument parser before bootstrap to accept `--presentation auto|terminal|plain|json`, `--no-color`, `--no-interaction`, `--sound` and `--mute`, alongside the existing optional config path/environment fallback. Add an optional terminal configuration block with auto mode and sound disabled by default; command-line options override it. Invalid options fail safely with concise usage, not as a file-read error.

Own stderr for human presentation because existing JSON logs use stderr. Auto chooses terminal only when that stream is a usable TTY, CI/no-interaction is absent, and basic cursor handling is supported. Otherwise preserve JSON as the non-TTY default. Plain is an explicit readable append-only choice. Explicit terminal cannot override a known unsafe/non-interactive stream: degrade to plain without cursor codes and explain once. No-color is independent of interactivity and honors `NO_COLOR`; color never carries the only status meaning. Audio remains off unless explicitly enabled, including JSON/plain mode.

Alternative: assume `stdout.isTTY` proves rendering is safe. Rejected because stderr may be redirected independently and is the actual presentation owner.

### D2. Keep logs durable and presentation sinks injectable

Refactor Logger around one redacted record with injectable console sinks, preserving existing stderr-JSON defaults for unrelated callers/tests and database persistence at the configured level. Terminal mode does not write every operational record to stderr; its controller consumes safe health/lifecycle diagnostics. Plain emits meaningful transitions/warnings/errors without repeated unchanged polls; JSON emits the existing structured format. Render diagnostics through the same terminal owner so they cannot collide with refresh control sequences.

Provide a separate `npm run logs -- --data-dir <directory> --tail 100 [--follow] [--format plain|json]` entrypoint. It opens `gremlyn.db` read-only, never calls migrating `Store`, takes the daemon ownership lock or authenticates to GitHub, and tails bounded redacted persisted records by ID. Default data directory is documented; operators with a custom directory supply it explicitly. Missing/busy stores produce bounded safe errors rather than creating a database. This gives details on demand without a browser or destabilizing the dashboard.

Bootstrap errors use a small selected-mode reporter before the regular logger is ready. Acquire known configured secrets as soon as available and suppress raw config/env dumps or unknown error payloads; preserve actionable cause/category and exit status. Keep the existing npm pin/prestart workflow, but ensure its startup diagnostics do not masquerade as job outcome events or contend with a dashboard that has not started yet.

Alternative: discard/silence Logger entirely in terminal mode. Rejected because detailed operational evidence and machine compatibility are still required.

### D3. Render a bounded anchored region, not a full-screen TUI

Use read-only health/job projections, narrowed to safe display fields rather than exposing repository instructions. Track bootstrap readiness/connection failures explicitly; only observed successful polling supports healthy status. Render configured/enabled counts, last poll/freshness, active/queued counts and a bounded active/queued/recent row set ordered consistently. Give overflow counts instead of dumping an arbitrary backlog.

Use a single controller with an initial maximum four refreshes per second, data-signature change detection and once-per-second elapsed-time updates. Build display lines for the current terminal dimensions and update only differing anchored lines with owned cursor sequences. No alternate screen or clear-entire-screen loop. Sanitize dynamic control/escape characters before width/truncation; use plain ASCII state labels and an ASCII fallback if Unicode width support is not reliable. Color is optional enhancement. Serialize diagnostic writes through the controller and redraw the region safely; resize forces a bounded layout recalculation.

If writes/capability handling fail, restore cursor/line state where possible, release renderer ownership and fall back to plain. Display code never changes job or queue state. Health/count updates and stored transition observations remain available without a browser SSE subscription.

Alternative: reuse the browser HTML or add a large full-screen terminal framework. Rejected because neither fits the lightweight Windows/headless operating scene.

### D4. Cue committed job transitions through a run-local cursor

Set the status-event high-water mark after startup recovery but before accepting/polling new work. Scan ordered committed rows above it in bounded batches, advancing across every row even when sound is disabled/muted. Only `succeeded` and `failed` rows request cues. Deduplicate by event ID in the current run, not job ID: explicit retries can produce another valid terminal event, whereas internal invocation retries have no terminal job event. Never trigger on Logger messages or `recordAgentResult`.

Advance/claim an event before dispatching playback. Restarts establish a new high-water mark, so historical events never replay, including a crash after cue dispatch. This is at-most-once playback-request behavior, not guaranteed exactly-once audible delivery; device mute/crashes may prevent hearing a cue. No durable outbox/replay is added. Muting affects future dispatch only and never saves pending sound for unmute. Cancelled/interrupted rows are consumed silently.

Alternative: chime on agent exit code or deduplicate forever by job ID. Rejected because downstream failure would sound successful and an explicit retry's new outcome would be suppressed.

### D5. Use short packaged WAV cues through an isolated Windows helper

Package two small deterministic WAV assets with distinct ascending/descending patterns, under one second each. A fixed non-interactive, no-profile Windows PowerShell helper uses .NET `System.Media.SoundPlayer` to play only the selected packaged asset. Invoke it with an argument vector and fixed cue enum/path resolution, no shell interpolation of job/repository strings and no arbitrary operator file path. Synchronous playback happens only in the helper; the daemon dispatches it separately from the job flow.

Bound a helper to three seconds, limit concurrent playback to one and bound pending requests (initial maximum 16 with ten-second expiry). Treat timeout/unavailability/overload as best-effort audio failure, consume the event and rate-limit a safe warning. Do not retry old sounds, fall back to unexpected BEL, change the device mute state or probe audio by playing a cue at ordinary startup. Unsupported platforms use a safe no-op adapter. Verify audibility/distinction manually in CMD/PowerShell; successful helper exit alone proves no hardware result.

Support `[m]` to explicitly opt in/toggle mute only when stdin is a supported TTY and interaction is enabled. Show the current sound state textually. The input adapter restores original raw mode on disposal and routes Ctrl+C to the existing stop handler, including its second-request escalation. Non-interactive usage controls sound through config/flags only.

Alternative: Windows SystemSounds aliases. Rejected as the primary mechanism because user sound schemes can make the two aliases identical or silent. Alternative: BEL alone or an in-process native dependency. Rejected for unreliable audibility or unnecessary daemon/platform risk.

### D6. Tie presentation lifecycle to bootstrap and shutdown

Construct the reporter/controller before fallible preflight, then attach store-backed projections only after ownership/store initialization. Register one idempotent disposer for presentation timers, input/resize listeners, readonly log handles and any owned audio helper. Invoke disposal on startup failure and before store closure during graceful shutdown; a renderer/disposer exception cannot prevent the remaining shutdown/lock-release steps. Do not redefine how live agent jobs stop or how incomplete jobs are recovered.

Keep audio work independent from store-backed row collection so an in-flight helper cannot hold the database open. Repeated Ctrl+C still calls existing escalation logic. Tests inject clocks, streams and audio/process adapters; no normal test plays actual audio.

## Risks / Trade-offs

- Windows host capabilities differ across CMD, PowerShell, Windows Terminal and legacy consoles → Capability-gated terminal rendering, plain fallback and a manual matrix covering each supported host.
- Log output races with cursor rendering → One stderr owner and injectable sinks, with append-only recovery after renderer failure.
- Child audio helpers linger or cannot be launched → Fixed trusted script/assets, deadline, bounded dispatch and idempotent shutdown disposal.
- Bursty completions overload audible delivery → Bounded queue/expiry and documented best-effort at-most-once requests, without replaying stale cues.
- Terminal metadata contains malicious escapes or secrets → Whitelist display fields, sanitize control sequences and redact before any sink.
- Bootstrap/prestart fails before rich state exists → Safe selected-mode diagnostics and unchanged nonzero exit/ownership behavior.

## Migration Plan

1. Introduce backward-compatible optional config/flags and injectable presentation/logging seams. Existing positional launches still work; non-TTY default remains JSON and sound remains disabled.
2. Add read-only log inspection, terminal rendering, committed-event dispatch and Windows helper/assets; no job schema migration is needed.
3. Test fake streams/helpers, full lifecycle regressions and manual Windows audibility/no-browser operation. Verify `npm start` argument forwarding and prestart diagnostics without bypassing pin safety.
4. Rollback by selecting `--presentation json` and disabling sound; additive presentation infrastructure requires no data conversion. Remove/dispose helper resources without changing job history or ownership state.
