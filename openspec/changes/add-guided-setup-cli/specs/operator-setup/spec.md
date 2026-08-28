## Purpose

Provides the operator-facing path from a fresh host to a running orchestrator with
at least one registered repository, replacing hand-edited configuration with
inferred values that are verified against the filesystem and git before they are
written, while keeping the configuration file the operator's own document.

## ADDED Requirements

### Requirement: Guided host onboarding

The system SHALL provide a setup flow that prepares a configuration file and
reports the state of every host prerequisite the orchestrator requires: the
configuration file itself, the GitHub token and the identity it authenticates,
the commit-attribution identity, the console token, and the agent credential
source.

Each prerequisite SHALL be reported as met or unmet individually, with the unmet
ones naming both the specific condition that failed and the action that resolves
it. The flow SHALL NOT report success while any prerequisite is unmet, and SHALL
NOT silently substitute a value for one it could not confirm.

When the configuration file is absent, the flow SHALL create it from the shipped
example. When it is present, the flow SHALL treat it as authoritative and SHALL
NOT overwrite it.

#### Scenario: No configuration file present

- **WHEN** setup runs in a directory with no configuration file
- **THEN** a configuration file is created from the shipped example, the operator
  is told which path was created, and setup continues from that file

#### Scenario: Configuration file already present

- **WHEN** setup runs where a configuration file already exists
- **THEN** the existing file is used as-is and no part of it is overwritten or
  reordered

#### Scenario: Token environment variable is not set

- **WHEN** the environment variable named by the configuration for the GitHub or
  console token holds no value
- **THEN** that prerequisite is reported unmet, naming the variable, and setup
  does not report overall success

#### Scenario: Token authenticates as a different identity

- **WHEN** the GitHub token authenticates as a login other than the configured
  orchestrator login
- **THEN** the prerequisite is reported unmet, naming both the authenticated
  login and the configured one

#### Scenario: Agent credential source is incomplete

- **WHEN** the configured agent credential source is missing or does not contain
  the agent's stored credentials
- **THEN** the prerequisite is reported unmet, naming the expected location, and
  the operator is directed to authenticate the agent

#### Scenario: Onboarding leads into registration

- **WHEN** every prerequisite is met and no repository is yet configured
- **THEN** setup offers to register a first repository and, on acceptance,
  performs registration under the same rules as the registration flow

### Requirement: Registry values inferred from a local checkout

The system SHALL provide a registration flow that accepts a path to a local
checkout and derives registry values from it: the GitHub owner and repository
name from the checkout's `origin` remote, a proposed workspace root, and
candidate validation commands from the checkout's contents.

The agent, provider, model, and reasoning effort SHALL be inherited from an
existing repository entry when one exists, and otherwise from the configured
agent's supported tiers.

Every derived value SHALL be presented to the operator for confirmation and SHALL
be recorded explicitly in the configuration file. The system SHALL NOT record a
derived value that the operator did not confirm, and SHALL NOT leave any required
registry field implicit in the written entry.

#### Scenario: Owner and name derived from the origin remote

- **WHEN** registration runs against a checkout whose `origin` remote addresses a
  GitHub repository, in either SSH or HTTPS form
- **THEN** the owner and repository name are derived from that remote and offered
  as the proposed values

#### Scenario: Checkout has no usable origin remote

- **WHEN** the checkout has no `origin` remote, or its remote does not address a
  GitHub repository
- **THEN** registration reports that the owner and name cannot be derived, states
  that they may be supplied explicitly, and writes nothing

#### Scenario: Proposed workspace root is outside the source

- **WHEN** a workspace root is proposed for a checkout
- **THEN** the proposed path lies outside that checkout and outside every other
  configured source path

#### Scenario: Settings inherited from an existing entry

- **WHEN** registration runs and the configuration already contains a repository
  entry
- **THEN** the agent, provider, model, and reasoning effort of that entry are
  offered as the proposed values for the new entry

#### Scenario: Derived values are written explicitly

- **WHEN** an entry is written after the operator confirms the proposals
- **THEN** every required registry field appears explicitly in the written entry,
  rather than relying on a value being derived again later

### Requirement: Registration is verified before it is written

The system SHALL verify a prospective registry entry before writing it, checking
that: the source path exists and is a git work tree; the checkout has an `origin`
remote addressing the entry's owner and repository name; the workspace root lies
outside the source path and outside every other configured source path; the
workspace root does not collide with another entry's workspace root; no entry
with the same owner and name already exists; the named agent exists in the
configuration; and the model is permitted by the entry's allowed-model list when
that list is non-empty.

A failed check SHALL abort registration with a message naming the field, the
observed condition, and the action that resolves it. When registration aborts,
the configuration file SHALL be left byte-for-byte unchanged.

#### Scenario: Source path is not a git work tree

- **WHEN** the supplied path does not exist, or exists but is not a git work tree
- **THEN** registration aborts naming the path and the condition, and the
  configuration file is unchanged

#### Scenario: Origin remote disagrees with the entry

- **WHEN** the checkout's `origin` remote addresses a repository other than the
  entry's owner and name
- **THEN** registration aborts naming both the remote's repository and the
  entry's, and the configuration file is unchanged

#### Scenario: Workspace root inside the source repository

- **WHEN** the workspace root is the source path or lies inside it
- **THEN** registration aborts stating that workspaces must live outside the
  source repository, and the configuration file is unchanged

#### Scenario: Workspace root collides with another entry

- **WHEN** the workspace root equals another configured entry's workspace root,
  or lies inside another configured entry's source path
- **THEN** registration aborts naming the conflicting entry, and the
  configuration file is unchanged

#### Scenario: Repository already registered

- **WHEN** an entry with the same owner and name already exists
- **THEN** registration aborts naming the existing entry, and the configuration
  file is unchanged

#### Scenario: Unknown agent or disallowed model

- **WHEN** the entry names an agent absent from the configuration, or a model
  outside a non-empty allowed-model list
- **THEN** registration aborts naming the unsupported value and the permitted
  ones, and the configuration file is unchanged

### Requirement: On-demand verification of configured entries

The system SHALL provide a verification flow that applies the registration checks
to every repository already present in the configuration file and reports each
entry's result individually. The flow SHALL exit with a failure status when any
entry fails a check, and SHALL make no modification to the configuration file, the
checkouts, the workspace roots, or the orchestrator's stored state.

Orchestrator startup SHALL be unaffected by this capability: it neither gains
these checks nor refuses to start on an entry that would fail one.

#### Scenario: Hand-edited entry has a bad path

- **WHEN** verification runs against a configuration containing an entry whose
  source path no longer exists
- **THEN** that entry is reported as failing, naming the path, other entries are
  still reported, and the command exits with a failure status

#### Scenario: All entries pass

- **WHEN** every configured entry satisfies every check
- **THEN** each entry is reported as passing and the command exits successfully

#### Scenario: Verification changes nothing

- **WHEN** verification runs
- **THEN** the configuration file is unchanged and no worktree, workspace, or
  stored job state is created or modified

#### Scenario: Startup behavior is unchanged

- **WHEN** the orchestrator is started with a configuration whose entry would
  fail a registration check
- **THEN** startup succeeds or fails exactly as it did before this capability
  existed

### Requirement: Configuration edits preserve the operator's file

The system SHALL apply configuration changes in place, preserving comments,
key ordering, formatting, and every entry it did not modify. The system SHALL NOT
rewrite the configuration file by re-serializing a parsed representation of it.

A write SHALL be all-or-nothing: a failure while writing SHALL leave the previous
contents intact. The resulting file SHALL load through the orchestrator's normal
configuration path without error.

#### Scenario: Comments survive an edit

- **WHEN** an entry is appended to a configuration file containing comments and
  operator-chosen key ordering
- **THEN** the comments and ordering are present and unchanged in the written
  file

#### Scenario: Unrelated entries are untouched

- **WHEN** a second repository is registered
- **THEN** the first repository's entry is unchanged

#### Scenario: Generated configuration is loadable

- **WHEN** a configuration file produced or edited by the setup flows is loaded by
  the orchestrator
- **THEN** it loads without configuration errors and yields the values the
  operator confirmed

### Requirement: Setup never writes secret values

The system SHALL keep secret values out of the configuration file. Setup flows
SHALL record only the names of environment variables holding secrets, SHALL NOT
write a token value into the configuration file, and SHALL NOT persist a token
value anywhere else on disk.

When setup offers a generated console token, it SHALL present the value for the
operator to place in their environment and SHALL NOT store it. Secret values
SHALL be redacted from all setup and verification output.

#### Scenario: Generated console token is not persisted

- **WHEN** setup generates a console token for the operator
- **THEN** the value is displayed with instructions to set it in the environment,
  and the configuration file names only the environment variable

#### Scenario: Token values are redacted from output

- **WHEN** setup or verification reports on a token-dependent prerequisite
- **THEN** no token value appears in the output

### Requirement: Every flow runs without a terminal

The system SHALL accept an explicit input for every value it would otherwise
prompt for, so that each flow can run without an interactive terminal.

When a required value is neither supplied explicitly nor derivable, and no
interactive terminal is available, the flow SHALL exit with a failure status
naming the missing input. It SHALL NOT wait for input that cannot arrive, and
SHALL NOT substitute a value of its own choosing.

#### Scenario: Fully specified registration without a terminal

- **WHEN** registration runs with every value supplied explicitly and no
  interactive terminal attached
- **THEN** the entry is verified and written without prompting

#### Scenario: Missing input without a terminal

- **WHEN** a required value is absent and no interactive terminal is attached
- **THEN** the flow exits with a failure status naming the missing input, and the
  configuration file is unchanged

#### Scenario: Confirmation is still required for proposals

- **WHEN** registration runs non-interactively without an explicit instruction to
  accept derived values
- **THEN** the derived values are not written, and the flow reports which inputs
  must be supplied or accepted explicitly
