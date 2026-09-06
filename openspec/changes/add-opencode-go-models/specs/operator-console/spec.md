## ADDED Requirements

### Requirement: The picker offers every provider a repository's agent can reach

For each repository, the console SHALL offer every provider its configured agent
can authenticate against, and for each such provider the models that provider
serves. A model an agent can reach SHALL NOT be selectable only by typing an
identifier into the custom free-text path.

Where an agent authenticates against more than one provider namespace, each
namespace SHALL be presented as its own provider entry, identified by name and by
how it is authenticated, and SHALL NOT be collapsed into a single entry. Two
namespaces sharing an agent, a credential file, or an identifier prefix are not
thereby the same provider.

The custom free-text path SHALL remain available for a provider the catalog does
not describe, and a selection made through it SHALL be accepted.

#### Scenario: Every namespace an agent authenticates against is offered

- **WHEN** an operator opens the settings for a repository whose agent
  authenticates against more than one provider namespace
- **THEN** each of those namespaces is offered as its own provider entry, and
  selecting one offers the models that namespace serves

#### Scenario: A reachable model needs no custom entry

- **WHEN** a repository's agent can reach a given model through one of its
  providers
- **THEN** that model is selectable from the catalog, without the operator typing
  a provider or model identifier

#### Scenario: A provider for another agent is not offered

- **WHEN** a repository's settings are opened
- **THEN** providers only another agent could authenticate against are not offered
  for that repository

#### Scenario: An undescribed provider is still reachable

- **WHEN** an operator selects the custom free-text path and supplies a provider
  and model the catalog does not describe
- **THEN** the selection is accepted and persisted

### Requirement: The offered providers do not depend on catalog availability

The set of providers offered for a repository SHALL be the same whether the
catalog is served from its live source or from the offline fallback. Refreshing
the catalog from its live source SHALL NOT remove a provider, and a provider
SHALL NOT be reachable only while the live source is unavailable.

#### Scenario: A refresh from the live source removes no provider

- **WHEN** the catalog is refreshed from its live source
- **THEN** every provider offered before the refresh is still offered afterwards,
  with the models it serves

#### Scenario: Offline and live agree on what is offered

- **WHEN** the catalog's live source is unavailable and the offline fallback is
  used
- **THEN** the providers offered for each repository are the same ones the live
  source would have offered
