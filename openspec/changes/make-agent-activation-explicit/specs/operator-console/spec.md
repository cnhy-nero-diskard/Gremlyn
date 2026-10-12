## ADDED Requirements

### Requirement: Repository agent workflow state is prominent and actionable

Each OpenCode repository summary SHALL visibly identify what primary source new jobs use, whether its saved managed team is active, and the actual primary observed in its most recent launched parent invocation when available. These facts SHALL remain visible without opening detailed configuration. The most recent launch SHALL be scoped to the same repository, ordered by launch time with a deterministic tie-breaker, and linked to its job. An unknown identity for that launch SHALL stay unknown instead of being replaced with an older known identity. No recorded launch SHALL be distinguishable from a launch with unobserved identity. The default source SHALL describe OpenCode's default-resolution policy without predicting a particular future primary.

A saved team under default or native source SHALL display a prominent textual inactive notice explaining that it is not selected, alongside **Activate this team** and **Edit team** actions and a source-switch path. Managed selection with a valid profile SHALL read **Active for new jobs** and identify its primary and profile revision. Missing/corrupt managed definitions SHALL show an unavailable/repair state instead of a successful active-team indicator. An ordinary default/native selection with no saved team SHALL NOT be presented as an error. Text and actionable placement SHALL carry the meaning independently of color, hover, icons, or hidden help, including at narrow widths and 200 percent zoom.

#### Scenario: Saved team is inactive under default source

- **WHEN** a repository has a saved orchestrator team but its source is default
- **THEN** the visible summary says the team is inactive, names OpenCode default for new jobs, and offers activation without requiring the operator to discover a separate selector

#### Scenario: Native source retains a saved team

- **WHEN** a repository selects a native primary and retains a saved managed team
- **THEN** the summary names the native selection and the inactive saved team without claiming the native agent cannot delegate

#### Scenario: Team is active without runtime evidence

- **WHEN** a valid managed team is selected but no invocation is recorded
- **THEN** the summary identifies it as active for new jobs and separately states there is no recorded launch, without claiming its primary or children ran

#### Scenario: Newest identity is unknown

- **WHEN** the latest launched invocation has no actual primary identity but an older invocation has a known identity
- **THEN** the summary reports the latest launch's identity as not observed and does not substitute the older primary

#### Scenario: Latest preparation never launched

- **WHEN** a newer attempt failed before launching and an earlier invocation did launch
- **THEN** the historical runtime summary references the most recent actual launch and its job rather than treating the preparation failure as observed execution

#### Scenario: Active definition is unavailable

- **WHEN** managed source is selected but its saved definition is missing or corrupt
- **THEN** the summary reports the selected team unavailable and offers repair or source switching instead of an active-success indication

#### Scenario: Different repositories have different last runners

- **WHEN** repository A and repository B have different launched invocation histories
- **THEN** each summary shows only its own latest launch and preserves redaction and escaped identity text

## MODIFIED Requirements

### Requirement: Operators configure OpenCode agents in repository settings

The authenticated console SHALL offer a repository-scoped OpenCode agent editor reachable from the dashboard within a coherent agent-workflow presentation. It SHALL distinguish the selected primary source for new jobs from a saved team definition and show each configured subagent's enabled state, model inheritance or override, and tool access in plain language. Enabled children of an inactive team SHALL be labeled **Enabled in saved team**; enabled children of an active team SHALL be labeled **Available to orchestrator**; disabled children SHALL be labeled **Disabled**. A selected team with no enabled children SHALL disclose that state. These labels SHALL NOT imply successful runtime preflight or observed execution. The console SHALL explain that activation makes children available and the primary decides when to delegate.

The editor SHALL let the operator select the primary agent and create, edit, enable, disable, or remove subagents, including their descriptions, instructions, model overrides, step limits, and supported permissions. The editor and activation controls SHALL be absent for repositories whose resolved executor is not OpenCode.

#### Scenario: OpenCode repository is configurable from the browser

- **WHEN** an operator opens settings for an OpenCode repository
- **THEN** the console shows the saved profile, whether it controls new jobs, and editing controls without requiring manual OpenCode file edits

#### Scenario: Another executor has no OpenCode controls

- **WHEN** an operator opens settings for a Cline repository
- **THEN** the console does not offer OpenCode primary, subagent, or activation controls

#### Scenario: Model inheritance is explained

- **WHEN** a subagent has no model override
- **THEN** the editor identifies that it will use the repository's selected OpenCode model when invoked

#### Scenario: Inactive children are enabled definitions

- **WHEN** a saved team has enabled children but is not selected
- **THEN** those children are labeled enabled in the saved team rather than callable by the current runner

#### Scenario: Active team has no enabled children

- **WHEN** an active managed team contains only disabled children or no children
- **THEN** the console explicitly states that no children are enabled without presenting activation as actual delegation

### Requirement: Agent profile edits are reviewed and conflict safe

The console SHALL keep agent profile edits in a repository-local draft until the operator saves them. It SHALL offer explicit **Save team** and, for an inactive or new team, **Save and activate** operations. Review SHALL present changed primary/subagent definitions, the chosen operation, and whether that operation changes what new jobs use. Save-only SHALL validate and persist the whole profile atomically without switching primary source. Save-and-activate SHALL use the atomic activation contract and check both reviewed profile and selection baselines. A successful state-changing operation SHALL record one operator action without logging full instruction text.

Save-only success SHALL say whether the resulting team remains inactive or is an updated active team. Activation success SHALL state that the team is active for new jobs and that existing jobs and retries keep their recorded selection. Cancel SHALL discard only the draft. If another writer changes a baseline relevant to the chosen operation, the console SHALL preserve the unsaved draft and operation intent, explain the conflict, and require deliberate reload/review before retrying. Live updates SHALL preserve draft fields, reviewed baselines, focus, and scoped feedback while keeping authoritative persisted status accurate. Activating a saved revision while an unsaved draft exists SHALL neither submit nor discard that draft silently.

#### Scenario: Apply a valid profile

- **WHEN** an operator reviews and saves a valid changed profile without activation
- **THEN** the profile changes atomically, its current primary source remains unchanged, and repository-local feedback identifies whether the team remains inactive or affects later-created managed jobs

#### Scenario: Save and activate a new team

- **WHEN** an operator reviews a new valid team and explicitly chooses save-and-activate
- **THEN** the reviewed definition and managed source are persisted together and feedback states that only newly created jobs use the activated team

#### Scenario: Cancel an edit

- **WHEN** an operator cancels a profile draft
- **THEN** the persisted profile and primary source remain unchanged and the draft is discarded

#### Scenario: Another session changes the profile

- **WHEN** an operator tries to save a draft whose saved profile baseline has changed
- **THEN** the console reports the conflict, keeps the draft, and does not overwrite the newer profile

#### Scenario: Another session changes the source during combined review

- **WHEN** a source switch occurs after the operator began save-and-activate review
- **THEN** the console preserves the draft and intent, reports the stale selection baseline, and saves neither resource

#### Scenario: Live refresh during an edit

- **WHEN** a live repository update arrives while the operator edits a profile or activation draft
- **THEN** the draft and its baseline remain intact, focus is preserved, and the persisted status remains accurate without silently rebinding the draft

#### Scenario: Activate saved revision while draft exists

- **WHEN** an operator chooses the saved-team activation action while an unsaved profile draft is present
- **THEN** the action explicitly targets the saved revision, preserves the draft, and offers save-and-activate separately for using the draft

#### Scenario: Saved team remains inactive

- **WHEN** save-only succeeds for a team under default or native source
- **THEN** feedback says the team remains inactive and provides an accessible action to activate the saved revision

### Requirement: Requested and effective primary identities are diagnosable

Repository summaries SHALL distinguish executor, selected primary source for new jobs, saved-team activation, and historical actual primary evidence. Job detail SHALL prominently show near the job title its captured source/native ID or managed primary and profile revision, separately from actual per-invocation primary identity. The current attempt's latest invocation SHALL drive the prominent actual identity while previous attempts and invocations remain in history. Before an invocation launches, the identity SHALL be shown as not started; after launch without attributable identity, it SHALL be shown as not observed. Default/native diagnostics SHALL explain that external instruction definitions are not snapshotted.

When the repository's current source, native ID, or managed revision differs from the job's capture, the console SHALL explain that current settings affect new jobs and retries keep this job's original selection. It SHALL NOT substitute a current team roster or a current primary name for historical capture or runtime identity. An observed primary different from an explicitly requested native/managed primary SHALL be distinguishable as a discrepancy; default resolution to an observed primary SHALL NOT itself be treated as a mismatch. Source changes SHALL be audited with safe before/after identifiers and revisions but without private definitions.

#### Scenario: Retried job differs from current repository choice

- **WHEN** a job captured native X but the repository now selects native Y
- **THEN** job detail still identifies X as its requested runner, identifies observed actual execution separately, and explains that retry keeps X while new jobs select Y

#### Scenario: Safe audit of a source switch

- **WHEN** an operator switches between managed, native or default source
- **THEN** the audit records the affected repository, sources and safe identifiers without profile instruction bodies or raw inventory

#### Scenario: Default job predates team activation

- **WHEN** an operator opens a default-source job after activating a managed team for its repository
- **THEN** the prominent job summary retains default source and its actual observed primary, explains the new-job boundary, and does not display the current team as that job's captured runner

#### Scenario: Retry has not launched yet

- **WHEN** a new current attempt is preparing while an earlier attempt has a recorded actual primary
- **THEN** the current actual-identity summary says not started and preserves the earlier observed identity in history

#### Scenario: Explicit selection differs from observed identity

- **WHEN** an invocation explicitly requested native or managed primary X but attributed runtime evidence identifies primary Y
- **THEN** the console shows both values and identifies their discrepancy without overwriting either

#### Scenario: Default source resolves to build

- **WHEN** a default-source invocation is observed using build
- **THEN** the console shows default as the requested policy and build as actual execution without presenting that default resolution as a selection mismatch

### Requirement: Delegation summaries and attempt trees are live and truthful

The dashboard SHALL expose an unobtrusive per-running-job delegation summary with observed active/completed child counts and partial/unavailable coverage where applicable. Job detail and live preview SHALL place concise observed delegation status alongside captured workflow and actual primary identity and offer an expandable parent-to-child execution view with actual identity when known, session identity, state, elapsed time and last observable activity. The view SHALL distinguish saved/available agent definitions, no delegations observed yet, and delegation not observable; separate attempts and root invocations SHALL remain distinguishable. Child counts SHALL come only from attributable observed child sessions, never from an activated roster or the parent session. Cline and unsupported runtimes SHALL show limited-data states without masquerading as managed OpenCode teams.

Default/native jobs SHALL be able to display observed delegated children without a managed profile. Team activation SHALL NOT be represented as evidence that a child ran or as a guarantee that every task delegates. Incomplete observation SHALL remain distinguishable from healthy observation with no children.

#### Scenario: Two delegated children change state

- **WHEN** one of two observed active children finishes while the other continues
- **THEN** dashboard counts and the correct detail nodes update without a page reload

#### Scenario: No child evidence exists yet

- **WHEN** supported healthy observation has not seen a child
- **THEN** the view says no delegations observed yet and does not render configured agents as completed or running

#### Scenario: Runtime observation is unavailable

- **WHEN** session evidence cannot be obtained from the executor
- **THEN** both the summary and drilldown disclose limited observability rather than claiming there were no delegations

#### Scenario: Active team has not delegated

- **WHEN** a managed team is active and healthy observation has seen only its parent
- **THEN** the view separates team availability from no delegations observed and does not count available children as executed

#### Scenario: Native primary delegates successfully

- **WHEN** a native-source job has attributable child-session evidence and no captured managed profile
- **THEN** those children appear as observed delegation without a fabricated managed team
