## MODIFIED Requirements

### Requirement: Unsafe workspace state halts the job

If the workspace cannot be brought to the expected state safely — it contains
uncommitted modifications from a previous attempt, is in a conflicted or detached
state, has diverged from the remote head, or is not a valid git checkout — the
system SHALL fail the job with a specific reason rather than discarding the
workspace contents.

Recovery from such a state SHALL require an explicit operator action, except that
a retry MAY resume retained edits from a previous attempt of the same job when
every one of the following holds:

- the previous attempt was interrupted, cancelled, ended abruptly while running
  (a timeout or a nonzero agent exit), or was blocked from publishing because its
  validation commands failed;
- the previous attempt recorded uncommitted changes;
- the deterministic workspace path and the recorded pull request head still
  match; and
- the workspace is neither conflicted nor diverged.

Edits left by a validation failure are admitted on the same basis as the other
cases and not as an exception to them: they were produced by this job's own agent,
in this workspace, against the recorded head. No other publishing failure SHALL be
admitted. A blocked publication that retained nothing, whose recorded head no
longer matches, or that found the workspace inconsistent SHALL continue to halt
the retry.

#### Scenario: Leftover modifications without an admitted retry

- **WHEN** preparation finds uncommitted modifications in the workspace without a
  retry admitted by the conditions above
- **THEN** the job fails with a reason identifying the unexpected state, the
  modifications are preserved, and no agent runs

#### Scenario: Retry resumes an abruptly ended attempt

- **WHEN** a retry follows an interrupted, cancelled, or timed-out running attempt
  whose deterministic workspace is still at the same recorded PR head
- **THEN** the job keeps the retained modifications, prepares that workspace
  without discarding them, and runs the agent there

#### Scenario: Retry resumes an attempt that failed validation

- **WHEN** a retry follows an attempt that was blocked from publishing because a
  validation command failed, and that attempt's deterministic workspace is still
  at the same recorded PR head with its uncommitted edits intact
- **THEN** the job keeps those edits, prepares that workspace without discarding
  them, and runs the agent there

#### Scenario: Another publishing failure does not admit a resume

- **WHEN** a retry follows an attempt blocked from publishing for a reason other
  than a validation failure, and the workspace holds uncommitted modifications
- **THEN** the retry fails with the unexpected-state reason and the modifications
  are preserved

#### Scenario: Conflicted workspace

- **WHEN** the workspace is in a conflicted merge state
- **THEN** the job fails with a specific reason and the state is left intact for
  inspection

#### Scenario: Operator resets a workspace explicitly

- **WHEN** an operator explicitly requests that a workspace be discarded and
  recreated
- **THEN** the workspace is removed and rebuilt, and the action is recorded
