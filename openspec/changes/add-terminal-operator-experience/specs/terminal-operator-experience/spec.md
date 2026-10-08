## Purpose

Defines a lightweight browser-independent terminal operator surface and optional Windows outcome audio that preserve structured logging, secret redaction and existing job/shutdown safety.

## ADDED Requirements

### Requirement: Presentation mode follows terminal capability and explicit intent

The daemon SHALL offer automatic, terminal, plain and JSON presentation modes while retaining the existing optional positional configuration path. Automatic mode SHALL use a compact terminal surface only with a usable interactive terminal outside CI; redirected output, CI, explicit no-interaction and unsupported terminals SHALL use non-interactive presentation without cursor controls. No-color settings SHALL suppress color without erasing status labels. Explicit JSON mode SHALL retain machine-readable structured logs and SHALL NOT emit dashboard controls or incidental sound by default.

#### Scenario: Interactive Windows launch

- **WHEN** the operator runs npm start in a supported interactive CMD or PowerShell terminal
- **THEN** a minimal legible operator surface appears without requiring an open browser

#### Scenario: Output is redirected or CI is detected

- **WHEN** the presentation stream is non-TTY or the launch is non-interactive
- **THEN** output contains no terminal cursor/color controls and operation continues in a non-interactive mode

#### Scenario: Existing config-path invocation

- **WHEN** the operator supplies a positional configuration path with presentation options
- **THEN** the same configuration file is loaded without interpreting an option as the path

### Requirement: Terminal health and jobs reflect observed state

The terminal SHALL show startup readiness/connection state, configured/enabled repository counts, latest observed poll and freshness, active/queued counts, and a bounded set of lifecycle rows identifying repository, PR, stage, elapsed duration and last outcome. Health SHALL be derived from observations rather than optimistic readiness claims. Updates SHALL redraw only changed display content at a bounded cadence, adapt to terminal size, and avoid routine polling/log noise, excessive output or a full-screen application.

#### Scenario: Queue and lifecycle change

- **WHEN** committed jobs become queued, running, validating or terminal
- **THEN** counts and corresponding rows update accurately with scan-friendly textual states and durations

#### Scenario: Poll becomes stale

- **WHEN** the latest successful poll is older than the configured freshness allowance
- **THEN** the surface indicates stale/unknown health rather than reporting all connections healthy

#### Scenario: Terminal is narrow or resized

- **WHEN** the terminal cannot fit all configured rows/columns or changes size
- **THEN** the surface truncates/wraps safely with overflow information and remains usable without repeated full-screen clears

### Requirement: Human presentation preserves detailed logs and safe diagnostics

Redacted structured operational logs SHALL continue to be available independently of terminal rendering. The operator SHALL have a documented browser-independent way to inspect detailed logs. JSON mode SHALL preserve the existing structured stream pathway; plain mode SHALL provide bounded readable transition/diagnostic lines without repetitive unchanged polls. Startup/preflight failures SHALL show a safe cause, next action and nonzero failure outcome even before the dashboard/logger is ready. Untrusted dynamic output SHALL NOT inject terminal controls or expose known credentials.

#### Scenario: Dashboard replaces noisy JSON presentation

- **WHEN** terminal mode is active and routine log entries are recorded
- **THEN** detailed redacted entries remain available without each one disrupting the compact dashboard

#### Scenario: Startup fails before steady-state presentation

- **WHEN** configuration, credentials, GitHub identity, ownership or agent version preflight fails
- **THEN** the terminal shows an actionable redacted error, preserves the failure exit code and does not leave ownership or terminal state stranded

#### Scenario: Dynamic label contains terminal escapes

- **WHEN** a repository/diagnostic string contains escape or control characters
- **THEN** those characters cannot execute terminal control sequences or produce an incidental audible cue

### Requirement: Audio is opt-in and independent of browser focus

The daemon SHALL offer sound enablement and explicit mute with default sound disabled. Supported Windows playback SHALL use distinguishable success/failure cues through a bounded local OS-level mechanism without needing a browser or relying solely on BEL. Unavailable or muted audio, helper failure and playback timeout SHALL be handled without blocking jobs, changing results or repeatedly flooding diagnostics. Non-interactive modes SHALL remain silent unless audio is explicitly enabled; no setting SHALL claim audibility is proven solely by a successful helper return.

#### Scenario: Sound is disabled

- **WHEN** a job succeeds or fails with default sound settings
- **THEN** its visual/log outcome updates without invoking audio

#### Scenario: Sound-enabled launch has no browser

- **WHEN** actual success and failure transitions occur with Windows sound enabled and usable audio
- **THEN** distinguishable local cues are requested without any browser being open

#### Scenario: Audio helper or device is unavailable

- **WHEN** playback cannot complete or no audible output is available
- **THEN** processing and job outcomes are unchanged and safe limited diagnostics identify unavailable playback where detectable

### Requirement: Audio consumes committed terminal transitions without replay

Only newly observed committed job success/failure transitions during the current daemon run SHALL request outcome audio, at most once per transition. Agent exits, polling/log events, validation subprocesses, duplicate observations and internal invocation retries SHALL NOT request cues. Startup SHALL establish a history baseline; cancelled/interrupted outcomes SHALL be silent. Muted/disabled observations SHALL be consumed without later replay. A subsequent explicit job retry reaching a new terminal transition SHALL be eligible for its own cue, without replaying earlier attempts.

#### Scenario: Agent succeeds but validation fails

- **WHEN** an agent exits successfully and the job later fails validation
- **THEN** only the committed job failure is eligible for one failure cue and no success cue is requested

#### Scenario: Duplicate observation of success

- **WHEN** the same committed terminal transition is observed repeatedly
- **THEN** it requests no more than one playback during the daemon run

#### Scenario: Restart or unmute sees old outcomes

- **WHEN** the daemon starts with prior terminal history or sound is re-enabled after muted completions
- **THEN** those historical/consumed transitions are not replayed

#### Scenario: Explicit retry reaches another terminal result

- **WHEN** an operator retries a failed job and the new attempt later succeeds
- **THEN** the new committed terminal transition is eligible for one success cue distinct from the earlier failure

### Requirement: Presentation and audio are observational and shut down cleanly

Rendering, log inspection and sound SHALL NOT mutate job outcomes, delegate work, change isolation/redaction, or authorize publication. Rendering/audio failures SHALL degrade presentation safely while job processing continues. Resize/input listeners, display timers, log handles and audio helpers SHALL be disposed on startup failure and graceful shutdown without preventing store closure, lock release or repeated-stop escalation. Existing Ctrl+C behavior SHALL remain intact.

#### Scenario: Renderer fails during processing

- **WHEN** the terminal cannot accept refresh output
- **THEN** the daemon falls back to safe non-interactive diagnostics without failing the observed job

#### Scenario: Shutdown races with playback or resize

- **WHEN** the daemon is stopped with an audio helper or display update pending
- **THEN** presentation resources are released, terminal state is restored where possible and existing shutdown/ownership semantics still complete
