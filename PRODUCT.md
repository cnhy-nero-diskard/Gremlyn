# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a developer/operator resolving review feedback on their own
GitHub pull requests from a Windows machine. They want the repetitive,
authorized resolution loop handled without giving up control of their normal
checkout or publication decisions.

## Product Purpose

Gremlyn automates the PR-resolution loop: it notices an authorized `!RESOLVE`
reply on an inline review thread, prepares an isolated workspace, runs a coding
agent, independently validates the result, publishes a normal commit to the
existing PR branch, and reports the outcome. Success means the developer can
move an approved review correction from request to validated publication while
their normal checkout remains untouched.

## Positioning

Gremlyn is a local PR-resolution orchestrator, not a general autonomous
implementation pipeline. Its distinct mechanism is the combination of explicit
GitHub-thread authorization, per-attempt isolated workspaces, independent
validation, and guarded publication with an operator-visible audit trail.

## Operating Context

Gremlyn runs locally on Windows 10/11 with PowerShell, Node.js, npm, and Git. It
polls configured GitHub repositories using a dedicated bot identity and exposes
a token-protected browser console on loopback. The operator configures
repositories, workspace roots, agent executors, models, validation commands,
and GitHub permissions, then observes queued, running, validating, publishing,
reporting, and terminal job states.

## Capabilities and Constraints

- Supports Cline and OpenCode executors with isolated per-attempt credentials
  and agent state.
- Uses deterministic `pr-<number>` workspaces beneath configured roots; the
  developer's source checkout is never modified by normal resolution work.
- Requires an allowlisted author and an authorized `!RESOLVE` reply in an
  inline PR review thread; fork PRs are unsupported.
- Independently validates agent output before pushing and replying on GitHub.
- Keeps GitHub API credentials in process environment variables and uses the
  host's Git credentials for pushes; secrets are not written to configuration.
- Retry, cancellation, repository pause, workspace reset, reclamation, and
  artifact retention follow explicit state or opt-in safety rules.
- Automated tests use fixtures, fake agents, and temporary Git repositories;
  they do not require network access or paid agent invocations.
- The product is intentionally a local browser console over a Fastify-served
  web interface, backed by SQLite.

## Brand Commitments

The product name is Gremlyn. No additional logo, voice, color, typography, or
other visual identity commitment was confirmed during initialization.

## Evidence on Hand

- `README.md` documents the product purpose, setup, operating workflow, and
  safety boundaries.
- `config.example.yaml` documents the supported configuration surface.
- `src/console/` contains the operator console and job views.
- `src/` and `tests/` contain the orchestration, workspace-safety,
  authorization, validation, publication, and agent-integration behavior.
- No testimonials, press, customer proof, or marketing claims are available;
  future surfaces must not fabricate them.

## Product Principles

- Preserve the developer's normal checkout.
- Require explicit authorization and least-privilege credentials.
- Isolate every agent attempt and independently validate before publication.
- Make state, commands, failures, and operator actions observable.
- Keep destructive or irreversible actions deliberate, bounded, and auditable.
