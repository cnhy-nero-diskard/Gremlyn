## Context

See `proposal.md` — Why. The constraints that shape the approach:

- `loadConfig` (`src/config/loader.ts`) is the single validator of configuration
  content, and it already accepts an injected `env`. Setup must reuse it rather
  than grow a second, drifting set of rules.
- Startup (`src/index.ts`) already verifies the GitHub identity, the Cline
  version, and the agent credential source. Setup reports on the same conditions
  and must call the same code, or the two will disagree.
- `gremlyn.yaml` is an operator-authored document. `config.example.yaml` is
  mostly comments explaining each key, and those comments are the current
  onboarding documentation. Any edit path that drops them makes setup worse.
- The `repository-registry` spec forbids the *running system* from inferring
  validation commands. This change adds an authoring tool, and the accompanying
  delta scopes that prohibition to execution time. The design must keep the two
  sides visibly separate: nothing in `src/` outside the setup module may consult
  a checkout's contents.
- `yaml`, `execa`, and `octokit` are already dependencies. `node:util parseArgs`
  is already the argument parser used by `src/agent/probe.ts`.

## Goals / Non-Goals

**Goals:**

- One inference engine and one verification engine, shared by all three flows, so
  a check cannot exist in registration but be missing from verification.
- Verification results are data, not printed side effects, so they can be
  asserted in tests and rendered differently per flow.
- Configuration edits are proposals the operator confirms, then explicit literal
  YAML — never a runtime lookup deferred to job time.
- Failure leaves the configuration file untouched, always.

**Non-Goals:**

- No preflight added to `npm start`; startup keeps its current checks exactly.
- No editing or removal of existing repository entries. `add-repo` appends, and
  refuses on a duplicate `owner/name`. Changing an entry stays a manual edit.
- No console UI and no live registry mutation; the registry still syncs one-way
  from YAML at startup.
- No support for repositories whose `origin` is not GitHub — the orchestrator
  cannot serve them anyway.

## Decisions

### One CLI entry point with three subcommands, not three scripts

`src/setup/cli.ts` dispatches `setup`, `add-repo`, and `verify`; `package.json`
adds thin `npm run setup`, `npm run add-repo`, and `npm run verify:config`
wrappers. Argument parsing uses `node:util parseArgs`, matching `probe.ts`.

*Alternative rejected:* three separate entry modules. They would each need the
config-loading, YAML-editing, and verification wiring, and the first divergence
between `add-repo`'s checks and `verify`'s checks would be silent.

### Comment-preserving edits via the `yaml` Document API

Edits go through `parseDocument()`, mutate the `repositories` sequence node with
`doc.createNode()`, and re-emit with `doc.toString()`. The `yaml` package
preserves comments and blank-line placement across this round trip.

*Alternative rejected:* `parse()` then `stringify()` — discards every comment,
which is where the current configuration's documentation lives. Also rejected:
splicing text at a located line offset — correct only until someone reorders
their file.

*Known imprecision:* `doc.toString()` re-emits the whole document and may
normalize scalar quoting or list indentation even in untouched regions. This is
why the spec says unrelated entries are "unchanged" rather than
byte-for-byte identical, and why a test asserts that parsing and re-emitting
`config.example.yaml` with no edits reproduces its input. If that assertion ever
fails, the divergence is known at build time instead of surprising an operator.

### Writes are validated, then atomic, then reversible

The write path is: build the new document text → run `loadConfig` against it in a
temporary location, with a synthetic env supplying placeholder token values so
only structural problems surface → write to a sibling temp file → rename over the
target. A `ConfigError` from the check aborts before anything is written.

This makes "generated configuration is loadable" a property of the code rather
than a hope, and it reuses the real loader, so setup cannot generate YAML the
orchestrator would reject.

*Alternative rejected:* writing first and validating after. Recovering a
half-written operator file is worse than refusing.

### Verification is a pure function over an injected environment

```
checkEntry(prospective, existingEntries, agents, env) -> CheckResult[]
```

`env` supplies `pathExists`, `isGitWorkTree`, and `originUrl`. Real
implementations use `node:fs` and the existing `git()` helper from
`src/workspace/gitops.ts`; tests inject fakes for the branch-heavy cases and use
the existing temporary-real-repo helpers for one end-to-end case.

Each `CheckResult` carries an id, pass/fail, the observed value, and the remedy
sentence. `add-repo` aborts on the first failure set; `verify` renders all of
them per entry and exits non-zero if any failed. Same function, two renderings —
which is the point.

### Path containment is compared on resolved real paths

Workspace-root and source-path containment is decided after `path.resolve` and
case-normalization on Windows, comparing with a trailing separator so
`D:/x/Gremlyn-workspaces` is correctly *not* inside `D:/x/Gremlyn`. Symlinked
checkouts resolve through `realpath` when the path exists.

### Owner/name parsed from `origin`, GitHub hosts only

`git -C <path> remote get-url origin` is parsed for the SSH
(`git@github.com:owner/name.git`), HTTPS, and `ssh://` forms, trimming a trailing
`.git`. A non-GitHub host, or no `origin`, yields no derivation: the flow reports
that the values must be supplied explicitly rather than guessing from the
directory name — a wrong `owner/name` would point the orchestrator at someone
else's repository.

### Proposals are inert until confirmed

The inference layer returns candidates with provenance (`derived from origin`,
`sibling of source path`, `package.json script`), and the input layer resolves
each field as: explicit flag → interactive confirmation → `--yes` acceptance of
the derived value → hard failure naming the missing input. Nothing is written
from a proposal that took none of the first three paths, which is what keeps
`add-repo` inside the registry spec's authoring/execution boundary.

Validation-command candidates come from `package.json` `scripts`: `test` maps to
`[npm, test]`, and `build`/`typecheck`/`lint` map to `[npm, run, <name>]`. A repo
with no recognized scripts produces no candidates, and an empty confirmed list is
written as an empty list — a deliberate inspection-only choice, not an omission.

### Prerequisite checks call the startup code

`setup` reports on prerequisites by calling `verifyCredentialSource`,
`OctokitGitHubClient.getAuthenticatedLogin()`, and `ClineExecutor.checkVersion` —
the same functions `src/index.ts` calls — catching their errors and rendering
them as unmet prerequisites instead of crashes. The agent probe is offered as an
optional step that shells out to the existing probe entry point.

*Alternative rejected:* reimplementing lighter-weight checks in the setup module.
Two implementations of "is this host ready" is exactly the failure this change
exists to remove.

### The console token is generated but never stored

`crypto.randomBytes(32).toString("base64url")`, printed with the PowerShell line
that exports it. The configuration file continues to name only the variable. All
setup output passes through the existing log redaction path so a token value
cannot reach a transcript.

## Risks / Trade-offs

- **`yaml` round-trip normalizes untouched regions** → An explicit round-trip
  stability test over `config.example.yaml` and a comment-heavy fixture; the spec
  promises preserved comments and content, not byte identity.
- **Setup's view of readiness drifts from startup's** → Setup calls the startup
  functions directly; a divergence requires deleting a call, not merely forgetting
  to update a copy.
- **`verify` is mistaken for a guarantee that startup enforces** → Both the spec
  and the README state that startup is unchanged and that `verify` is on demand.
- **Inference makes a wrong `owner/name` easy to accept quickly** → Derivation is
  restricted to GitHub `origin` URLs, is always displayed before confirmation, and
  is re-checked against the remote by the same verification the flow runs before
  writing.
- **A partially completed `setup` leaves a config file with placeholder values
  from the example** → The file is created from the example only, prerequisites
  are reported unmet until real values are confirmed, and `verify` re-reports them
  at any time.
- **Interactive prompting adds a code path CI never exercises** → Every prompt has
  a flag, the non-interactive path is the one under test, and the interactive path
  is a thin `node:readline/promises` wrapper over the same resolver.

## Migration Plan

Purely additive. Existing `gremlyn.yaml` files keep loading unchanged, and the
orchestrator's startup and runtime behavior are untouched — the only production
code outside `src/setup/` that changes is `package.json` scripts and the README.
Rollback is deleting the module and its scripts; no data, schema, or config
format migration is involved.

## Open Questions

- Which `package.json` scripts to offer as validation candidates beyond
  `test`/`build`/`typecheck`/`lint`, and in what order. Deferrable: candidates are
  confirmed by the operator either way, so the ranking can be tuned after the
  first real use without touching the specs or the task breakdown.
