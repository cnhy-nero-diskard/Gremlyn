## MODIFIED Requirements

### Requirement: Orchestrator owns the working directory

The system SHALL pass the workspace path prepared for the job as the agent's
working directory, and SHALL NOT delegate workspace or checkout selection to the
agent, including through agent features that create their own worktrees.

Passing the workspace path is not by itself sufficient. Some providers execute
the agent's tools somewhere other than the process the system launched — for
example in a separate long-lived service whose working directory was fixed before
the attempt existed — so the path the system passes is ignored and the agent's
edits land in an unrelated checkout. The system SHALL determine, before launching
an agent, whether the repository's provider can be driven by its configured
executor, and SHALL refuse the attempt when it cannot, rather than running an
agent whose writes would fall outside the prepared workspace.

The refusal SHALL occur per attempt and before a workspace is prepared. Reporting
such a pairing at startup does not satisfy this requirement: the failure is
silent at run time, and an attempt that proceeds reports success while its own
workspace stays untouched.

A provider the system holds no pairing information about SHALL remain usable. An
operator may configure a provider the system does not describe, and refusing one
on that basis would reject a configuration the system was never in a position to
judge.

#### Scenario: Agent worktree feature not used

- **WHEN** the agent offers to create its own isolated checkout
- **THEN** that feature is not used, and the agent runs in the workspace the
  orchestrator prepared

#### Scenario: A provider its executor cannot drive is refused

- **WHEN** an attempt is started for a repository whose provider its configured
  executor cannot drive
- **THEN** no agent is launched, no workspace is prepared, and the attempt is
  recorded as failed

#### Scenario: The repository is left untouched by a refused attempt

- **WHEN** an attempt is refused for that reason
- **THEN** nothing is written to the repository's workspace and no branch is
  published

#### Scenario: A provider the system does not describe still runs

- **WHEN** an attempt is started for a repository whose provider the system holds
  no pairing information about
- **THEN** the attempt proceeds and the agent runs normally

### Requirement: Authentication failure is distinguishable

An attempt that fails because the agent could not authenticate SHALL be recorded
with a reason distinct from an attempt whose agent ran and failed on the work
itself. The console SHALL show which occurred.

An attempt refused because the repository's provider cannot be driven by its
configured executor SHALL be recorded with a reason distinct from both. The
condition is a configuration mismatch: the credential is irrelevant to it, and
re-authenticating cannot resolve it. The system SHALL classify by the condition
that actually occurred, so the operator is not directed at a remedy that cannot
apply.

#### Scenario: Authentication failure is reported as its own reason

- **WHEN** an agent exits because it could not authenticate with its provider
- **THEN** the attempt records an authentication reason, not a generic agent
  failure, and the operator can tell the two apart without reading the transcript

#### Scenario: A provider-executor mismatch is not reported as an auth failure

- **WHEN** an attempt is refused because its provider cannot be driven by its
  configured executor
- **THEN** the attempt records a reason distinct from both an authentication
  failure and a failure of the work, and the recorded reason identifies the
  mismatch
