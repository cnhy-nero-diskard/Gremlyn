## MODIFIED Requirements

### Requirement: Job detail view

For any job the console SHALL present the repository, pull request, triggering
command and comment, the reconstructed review feedback, the ordered status timeline
with timestamps, the agent and model used, the workspace path, captured agent
output, validation results per command, the resulting commit when one exists, the
GitHub reporting outcome, and error detail when the job failed.

The job detail view SHALL present an ordered safety and progress summary before
the forensic detail. The summary SHALL contain the steps `Authorized`, `Workspace
isolated`, `Agent finished`, `Validation passed`, `Published`, and `GitHub
reported`, in that order. Each step SHALL expose a textual state equivalent to
pending, active, passed, failed, skipped, or not applicable; color or iconography
SHALL NOT be the only means of distinguishing the state.

A step SHALL be marked passed only when persisted evidence proves its outcome. A
later step SHALL NOT imply that an earlier failed or unknown step passed, and an
agent exit with code zero SHALL NOT by itself present the job as successful. A
terminal success SHALL state that the applicable work was validated, pushed, and
reported. A terminal failure, cancellation, or interruption SHALL identify the
step at which progress stopped and SHALL leave later steps visibly incomplete or
skipped rather than presenting them as successful.

When workspace preparation succeeds, the summary SHALL show the exact workspace
path and SHALL state that the configured source checkout was left untouched. If an
existing non-source checkout was adopted, the console SHALL identify it as adopted
and SHALL NOT describe that adopted checkout as a Gremlyn-created isolated
workspace. If workspace preparation has not succeeded, the console SHALL NOT make
an isolation reassurance it cannot substantiate.

The publication step SHALL distinguish no commit, a local unpushed commit, and a
pushed commit. The reporting step SHALL distinguish a posted GitHub outcome from a
failed or pending report. When publication succeeded but GitHub reporting failed,
the terminal summary SHALL state that the commit remains pushed and SHALL NOT
collapse the two outcomes into a generic failure.

The status timeline SHALL show the elapsed time in each stage and the total elapsed
time for the job.

For each attempt the console SHALL additionally present the agent's exit code when
the agent exited, whether the resulting commit was pushed, whether uncommitted
changes were left in the workspace, and the head commit the workspace was prepared
against.

Validation results SHALL be presented per command with the command, its exit code
and its duration directly legible, and its captured output available. The status
timeline, validation results and structured log SHALL NOT be presented as
undifferentiated serialized data.

#### Scenario: Diagnosing a failure without a terminal

- **WHEN** an operator opens a failed job
- **THEN** the failing stage, the reason, the agent output, and the validation
  results are all available in the view

#### Scenario: Attempts are distinguishable

- **WHEN** a job has been retried
- **THEN** each attempt's output and outcome are viewable separately

#### Scenario: Identifying which validation command failed

- **WHEN** an attempt failed validation and more than one validation command ran
- **THEN** the operator can see which command failed, its exit code and its
  duration, without reading serialized data

#### Scenario: Work left behind in a workspace

- **WHEN** an attempt produced changes that were not committed or a commit that was
  not pushed
- **THEN** the console shows that state on the attempt

#### Scenario: Running job exposes end-to-end progress

- **WHEN** an operator opens a job whose agent is running in a prepared workspace
- **THEN** authorization and workspace isolation read as passed, the agent step
  reads as active, later steps remain incomplete, and the view does not call the
  job successful

#### Scenario: Workspace reassurance is evidence-backed

- **WHEN** an attempt records a prepared workspace distinct from the configured
  source checkout
- **THEN** the console shows that workspace path and states that the source
  checkout was left untouched

#### Scenario: Adopted checkout is described accurately

- **WHEN** an attempt records that it adopted an existing non-source checkout
- **THEN** the console shows its path and adopted status without claiming that the
  checkout was created as an isolated Gremlyn workspace

#### Scenario: Agent completion is not job success

- **WHEN** an agent exits successfully but validation, publication, or reporting
  has not completed successfully
- **THEN** the agent step reads as passed while the job remains in progress or
  terminally unsuccessful, with the downstream state that prevents success shown

#### Scenario: Stalled and timed-out agents remain distinct

- **WHEN** an attempt ends because of its inactivity bound or maximum duration
- **THEN** the agent step reads as failed and identifies the outcome as stalled or
  timed out respectively

#### Scenario: Commit exists only in the workspace

- **WHEN** an attempt records a commit but does not record a successful push
- **THEN** the publication step identifies the commit as local and unpushed and
  the terminal summary states that nothing was published

#### Scenario: Push succeeds but GitHub reporting fails

- **WHEN** an attempt records a pushed commit and a failed GitHub report
- **THEN** publication reads as passed, reporting reads as failed, and the terminal
  summary states that the named commit remains pushed

#### Scenario: Successful job has a conclusive peak state

- **WHEN** a job records terminal success
- **THEN** the primary summary states that authorization, isolation, agent work,
  validation, publication, and GitHub reporting all completed, and names the
  pushed commit without requiring the operator to inspect attempts or logs
