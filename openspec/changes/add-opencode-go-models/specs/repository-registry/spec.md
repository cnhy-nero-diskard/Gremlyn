## MODIFIED Requirements

### Requirement: A repository's provider is reconciled against its agent

The system SHALL determine whether a registry entry's provider is usable by the
agent that entry names, and SHALL report an entry whose provider its agent cannot
use. Such an entry SHALL be reported rather than silently reassigned to a
different provider or model.

Reporting SHALL NOT be the system's only response. An entry whose provider its
agent cannot use SHALL NOT produce an agent run: the pairing is refused when work
arrives for that repository, not merely noted when the entry is read. An operator
who has not seen or acted on the report SHALL still be protected from the run.

An entry naming a provider the system holds no pairing information about SHALL
remain usable, because the system cannot claim such a pairing is wrong.

#### Scenario: Agent changed under an existing selection

- **WHEN** a repository's configured agent is changed to one that cannot use the
  provider previously selected for that repository
- **THEN** the mismatch is reported and neither the provider nor the model is
  silently replaced

#### Scenario: Provider is usable by the agent

- **WHEN** a registry entry's provider is one its configured agent can use
- **THEN** no mismatch is reported and jobs for that repository run with that
  provider

#### Scenario: A reported mismatch does not run

- **WHEN** work arrives for a repository whose provider its configured agent
  cannot use
- **THEN** no agent runs for that repository, and the attempt is recorded as
  failed with the mismatch as its reason

#### Scenario: An undescribed provider is not treated as a mismatch

- **WHEN** a registry entry names a provider the system holds no pairing
  information about
- **THEN** no mismatch is reported and jobs for that repository run normally
