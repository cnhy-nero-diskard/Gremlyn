## MODIFIED Requirements

### Requirement: Structured process invocation

The system SHALL launch agent processes using an argument vector rather than a
concatenated shell command string. The prompt SHALL be passed as a discrete
argument or via a non-shell channel.

The system SHALL only invoke non-interactive agent operations, and SHALL NOT invoke
agent subcommands that require a terminal.

The system SHALL launch a configured agent CLI correctly regardless of how that CLI
is packaged on the host, including when it is installed as a launcher script that
delegates to a separate program. Where the host imposes a command-line length limit
smaller than the prompt the system generates, the system SHALL launch the agent by a
route not subject to that limit. The system SHALL NOT interpret a program as a
script for the host runtime unless it is one.

#### Scenario: Prompt containing shell syntax

- **WHEN** the reconstructed context contains quotes, newlines, or shell
  metacharacters
- **THEN** the agent receives the text intact and no shell interpretation occurs

#### Scenario: Non-interactive execution

- **WHEN** the agent is invoked with no terminal attached
- **THEN** execution proceeds without prompting and terminates on its own

#### Scenario: CLI packaged as a native executable

- **WHEN** the configured agent CLI is installed through a launcher script that
  delegates to a native executable rather than to a script for the host runtime
- **THEN** the agent process starts and runs normally, and the executable is not
  handed to the host runtime to be parsed as source

#### Scenario: Long prompt survives a host command-line limit

- **WHEN** an agent is launched with a resolution prompt longer than the host's
  command-line limit for launcher scripts
- **THEN** the agent receives the whole prompt and the launch is not rejected for
  argument length
