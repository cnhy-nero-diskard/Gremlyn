## Why

Bringing Gremlyn up on a host is a prose ritual, and registering a repository is
ten hand-typed YAML keys per repo — most of them mechanically derivable from the
checkout itself. Neither step tells the operator whether the result is correct:
`loadConfig` checks only that strings are non-empty and never touches the
filesystem, and startup validates the GitHub token, Cline version, credential
source, and data-directory lock while never checking that `source_path` exists,
is a git work tree, has an `origin` remote matching `owner/name`, or that
`workspace_root` sits outside the source repository. A typo in a path is
therefore discovered by a job failing mid-run, against a real pull request.

## What Changes

- Add a guided setup CLI with three flows, sharing one inference engine and one
  verification engine:
  - `setup` — first-run host onboarding. Creates `gremlyn.yaml` from
    `config.example.yaml` when absent, resolves and confirms
    `github.orchestrator_login` against the token the environment supplies,
    confirms `git.author_name`/`author_email`, names the console token variable
    and reports whether it is set (offering a generated value to export, never
    writing it), detects the Cline `credential_source` and confirms
    `secrets.json` is present, optionally runs the seeded agent probe, then
    flows into registering the first repository.
  - `add-repo <path>` — repository registration. Infers `owner`/`name` from the
    checkout's `origin` remote, proposes a `workspace_root` guaranteed to sit
    outside `source_path`, proposes detected `package.json` scripts as candidate
    validation commands for explicit confirmation, inherits
    `agent`/`provider`/`model`/`effort` from an existing entry or the agent's
    ceiling, and appends a fully explicit block to `gremlyn.yaml`.
  - `verify` — re-runs the same registration checks against every repository
    already in `gremlyn.yaml`, so hand-edited entries can be checked on demand
    instead of at job time.
- Add add-time verification with actionable messages: source path exists and is
  a git work tree; `origin` present and matching the inferred `owner/name`;
  workspace root outside the source path, not inside another entry's source, and
  not colliding with another entry's workspace root; no duplicate `owner/name`;
  named agent present in `agents`; model within `allowed_models` when non-empty.
- Every prompt gets an equivalent flag, so all three flows run without a TTY and
  are testable.
- Edits to `gremlyn.yaml` preserve existing content, ordering, and comments — the
  file is modified in place, never re-serialized from a parsed object.
- Rewrite the README's Install/Configure sections around the CLI, keeping the
  manual YAML path documented as the explicit alternative.

Not in scope: startup behavior is unchanged — this change adds no preflight to
`npm start`, no live registry mutation from the console, and no runtime
inference of any kind.

## Capabilities

### New Capabilities

- `operator-setup`: guided host onboarding and repository registration. Covers
  inference of registry values from a local checkout, add-time verification of a
  registry entry against the filesystem and git, comment-preserving edits to the
  configuration file, non-interactive operation, and the boundary that setup
  tooling never writes secret values into configuration.

### Modified Capabilities

- `repository-registry`: the existing prohibition on inferring validation
  commands reads as forbidding any tool from proposing them. Add a requirement
  distinguishing authoring time from execution time — registration tooling MAY
  propose candidates for explicit operator confirmation and MUST record the
  confirmed result explicitly in configuration; the running orchestrator still
  never infers commands and never falls back to a default set, and an empty list
  remains a deliberate inspection-only choice.

## Impact

- New `src/setup/` module (inference, verification, comment-preserving YAML
  editing, prompt/flag input) and a CLI entry point; new `npm run setup`,
  `npm run add-repo`, and `npm run verify:config` scripts in `package.json`.
- No change to `src/index.ts`, `src/config/loader.ts`, `src/runtime/repositories.ts`,
  or the console. The loader stays the single validator of file contents at
  startup; the setup CLI reuses it rather than duplicating its rules.
- Uses the already-present `yaml` package's document API for in-place edits and
  the existing `execa`-based git helper for remote inspection. No new dependency.
- `tests/config-example.test.ts` gains a sibling: generated configuration must
  load through `loadConfig` unchanged.
- README Install/Configure/Troubleshooting sections rewritten.
