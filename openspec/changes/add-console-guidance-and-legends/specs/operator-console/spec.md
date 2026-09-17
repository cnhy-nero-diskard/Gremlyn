## ADDED Requirements

### Requirement: Contextual help is visible and available offline

Every authenticated console surface SHALL provide a visible Help entry point.
Job, repository configuration, command ingestion, and operator-audit surfaces
SHALL additionally link to the relevant help topic while preserving a safe path
back to the originating console context.

Help content, legends, and their required presentation assets SHALL be served by
the console and SHALL remain usable without internet access or an external
documentation service. Help routes SHALL require the same console authentication
as operational views and SHALL preserve redaction boundaries.

#### Scenario: Open help from a job

- **WHEN** an authenticated operator follows contextual help from a job detail
  view
- **THEN** the job lifecycle and action topic opens, and a visible link returns to
  that job without accepting an arbitrary external return URL

#### Scenario: Open general help without knowing a deep link

- **WHEN** an authenticated operator activates the visible Help entry point
- **THEN** an index exposes task guidance and every legend defined by this
  capability without requiring a shortcut

#### Scenario: Console has no internet access

- **WHEN** the local console is reachable but external network access is absent
- **THEN** all required help text, legends, navigation, and disclosure controls
  remain available

#### Scenario: Unauthenticated help request

- **WHEN** help or a contextual legend is requested without valid console
  authentication
- **THEN** the request is rejected and no operational context, configured value,
  count, or technical identifier is disclosed

### Requirement: Guidance is organized around operator tasks

The help surface SHALL explain how an operator reads and verifies authorization,
workspace isolation, validation, publication and GitHub reporting; and how they
approach retry, cancel, reset, and repository enablement. Each topic SHALL identify
where the authoritative evidence or control appears in the console and SHALL link
to that surface when a relevant context exists.

Guidance SHALL describe stable semantics and safety boundaries, not manufacture a
current success state, action eligibility, or recovery recommendation. Job
lifecycle truth SHALL remain owned by the safety/progress evidence, and the
current recommended action SHALL remain owned by contextual recovery feedback.
The help surface SHALL link to those authoritative presentations rather than
render a second rail or recommendation engine.

#### Scenario: Understand why a command did or did not run

- **WHEN** an operator opens authorization guidance from an observed command
- **THEN** the guidance explains executed, rejected, ignored, and duplicate
  outcomes and points to the command's recorded outcome and reason

#### Scenario: Verify isolation and validation

- **WHEN** an operator opens job guidance
- **THEN** the guidance explains how to locate authorization evidence, the actual
  workspace path and checkout type, per-command validation results, and retained
  work without asserting that those steps passed for the current job

#### Scenario: Distinguish publication from reporting

- **WHEN** an operator reads publication guidance
- **THEN** it explains that agent completion, validation, commit creation, push,
  and GitHub reply are separate facts and points to their authoritative job
  evidence

#### Scenario: Compare retry, cancel, and reset

- **WHEN** an operator opens action guidance
- **THEN** it explains that cancel stops active work, retry creates another
  attempt and may reuse only eligible retained work, and reset discards only the
  explicitly confirmed bounded workspace, then directs the operator to the
  current contextual recovery guidance and controls

#### Scenario: Shortcut help remains separately owned

- **WHEN** an operator follows a link about keyboard operation
- **THEN** general help links to the current shortcut reference without duplicating
  its key list or becoming an alternative shortcut registry

### Requirement: Plain-language meaning is paired with exact technical values

Where the console displays command outcomes, authorization reasons, job or
attempt failure reasons, audit action/effect identifiers, provider identifiers,
or other coded operational values, it SHALL present a stable plain-language label
or explanation together with the exact redacted raw value. The raw value SHALL
remain selectable and copyable, SHALL NOT exist only in a tooltip, and SHALL NOT
be replaced by the friendly label.

Technical identities including job, attempt, repository, pull request, comment,
commit, and workspace identifiers SHALL be named by type rather than presented as
unlabelled numbers or strings. Unknown future codes SHALL be shown as unrecognized
with their exact redacted value and SHALL NOT be silently omitted or assigned a
guessed meaning.

#### Scenario: Command reason has a known translation

- **WHEN** an observed command has a known raw reason identifier
- **THEN** the command view shows its plain-language meaning and the exact raw
  identifier together

#### Scenario: Failure reason is unknown to the console

- **WHEN** a job or attempt contains a reason code with no registered translation
- **THEN** the console labels it as unrecognized, preserves the exact redacted
  code, and does not infer a cause or recovery action

#### Scenario: Audit entry carries technical identifiers

- **WHEN** an operator inspects an audit entry with an action, target, effect, or
  detail identifier
- **THEN** each value is labelled by meaning or type and its exact redacted raw
  form remains available for correlation

#### Scenario: Copy a redacted value

- **WHEN** a displayed raw value was redacted before rendering
- **THEN** selecting or using a copy affordance yields only the displayed redacted
  value and never the underlying secret

### Requirement: Operational legends explain statuses and metadata without color alone

The console SHALL provide accessible legends for job and attempt statuses, model
metadata capsules, provider/authentication labels, and failure semantics. Each
legend entry SHALL show the same text marker used in the interface, a concise
plain-language definition, and any important distinction from similar entries.
Meaning SHALL NOT depend only on color, icon shape, hover, or position.

The status and failure legends SHALL distinguish queued and active stages from
terminal outcomes, agent stall from maximum-duration timeout, operator
cancellation from process interruption, validation failure from publication or
reporting failure, and local/unpushed work from published work. They SHALL point
to the job safety evidence and contextual recovery surfaces rather than recreate
their live state.

The model legend SHALL cover every metadata or tier capsule currently rendered,
including current-value and catalog-origin badges. The provider legend SHALL
distinguish configured agent/executor, provider namespace, authentication method,
model identifier, and reasoning effort so shared credentials or similar names are
not presented as interchangeable providers. Unknown future capsule or provider
labels SHALL retain their exact text with a neutral fallback explanation.

#### Scenario: Interpret a terminal job status

- **WHEN** an operator opens the status legend for a failed, cancelled, or
  interrupted job
- **THEN** the legend explains the distinct terminal meaning in text and links to
  the job's evidence for its specific cause

#### Scenario: Distinguish stall from timeout

- **WHEN** an operator compares a stalled attempt with one that exceeded its
  maximum duration
- **THEN** the legend describes the first as an inactivity outcome and the second
  as a duration outcome while preserving both raw identifiers

#### Scenario: Interpret a model capsule

- **WHEN** a picker displays a tier or metadata capsule such as recommended,
  free, pass, new, flagship, or current
- **THEN** the legend provides a textual definition for that exact capsule and
  does not imply provider availability or billing beyond the catalog metadata

#### Scenario: Interpret provider and authentication labels

- **WHEN** a provider option displays a namespace and authentication description
- **THEN** the legend explains which text names the provider, which describes how
  its agent authenticates, and where the exact provider and model identifiers are
  shown

### Requirement: Repository enablement consequences are explicit and consistent

Wherever repository enablement can be changed or reviewed, the console SHALL state
that disabling affects later observed commands, prevents them from creating jobs,
and does not queue them for replay when the repository is re-enabled. It SHALL
state that disabling does not cancel already-created queued or running jobs unless
the operator invokes a separately available action.

Enabling SHALL be described as accepting eligible later commands again, not as
replaying ignored commands or changing staged provider, model, effort, timeout,
or validation settings. These explanations SHALL appear before a disable action
is confirmed and SHALL remain reachable from the repository guidance topic.

#### Scenario: Review disabling a repository

- **WHEN** an operator is offered a single or bulk repository disable action
- **THEN** the console explains the effect on later commands, lack of replay, and
  non-cancellation of existing jobs before confirmation

#### Scenario: Re-enable a repository

- **WHEN** an operator is offered an enable action
- **THEN** the console explains that eligible future commands may create jobs
  again and that ignored past commands and staged settings are unchanged

#### Scenario: Existing job is active during disable

- **WHEN** an operator disables a repository that already has queued or running
  work
- **THEN** the guidance does not claim that work was cancelled and links to the
  separate job controls for any server-authorized cancellation

### Requirement: Progressive disclosure preserves expert auditability

Essential meaning, current state, and action consequence SHALL remain visible at
the point of use. Longer definitions, examples, related identifiers, and
cross-references MAY be placed in native progressive-disclosure controls, but
expanding them SHALL require no network access and SHALL preserve keyboard focus
and assistive-technology structure.

Disclosure state SHALL survive unrelated live-region updates while its containing
record remains present. Collapsing detail SHALL NOT remove the exact raw outcome,
reason, or identifier required to correlate the visible record with logs, audit
records, GitHub, or local workspace evidence.

#### Scenario: Novice reads the primary explanation

- **WHEN** an operator does not expand technical details
- **THEN** the primary label and consequence remain understandable without raw
  jargon or reference to color alone

#### Scenario: Expert expands technical detail

- **WHEN** an operator expands details for a command, failure, provider, model, or
  audit entry
- **THEN** exact redacted identifiers and relevant cross-references are available
  without replacing the primary explanation

#### Scenario: Live update occurs while detail is open

- **WHEN** an unrelated SSE update refreshes part of the page while a help or
  technical disclosure remains present
- **THEN** its expanded state and the operator's focus remain stable
