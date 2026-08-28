## MODIFIED Requirements

### Requirement: Per-repository validation commands

Validation commands SHALL be configured per repository as an ordered list of
executable command specifications. At execution time the system SHALL NOT infer
validation commands from repository contents, and SHALL NOT fall back to a
built-in default command set when the list is empty.

Registration tooling MAY propose candidate commands derived from a local
checkout's contents at authoring time, and SHALL record only commands the
operator explicitly confirmed, written literally into the configuration. A
proposal that the operator declines SHALL leave the list empty, which remains a
deliberate inspection-only choice rather than an absence to be filled in later.

#### Scenario: Configured validation runs in order

- **WHEN** a repository configures validation commands `[typecheck, test]`
- **THEN** validation runs `typecheck` first and `test` second, recording each
  command's exit status separately

#### Scenario: No validation configured

- **WHEN** a repository has an empty validation command list
- **THEN** validation performs worktree inspection only, and the job records that
  no repository validation commands were configured

#### Scenario: Proposed commands require confirmation

- **WHEN** registration tooling derives candidate commands from a checkout's
  contents and the operator confirms a subset of them
- **THEN** exactly the confirmed commands are written into the repository entry,
  and the declined ones appear nowhere in the configuration

#### Scenario: Execution never reconsults the checkout

- **WHEN** a job runs for a repository whose checkout would yield candidate
  commands
- **THEN** validation runs only the commands recorded in the registry entry, and
  the checkout's contents do not influence which commands run
