## Why

Two behaviors shipped in commit `465b0a6` ("split opencode zen/go providers and
refuse provider-executor mismatches") with no planning artifacts behind them, and
neither is described by any spec. This change captures them.

The first is a reachability gap. OpenCode serves models from more than one hosted
namespace, and the console's provider catalog enumerated only one of them. On the
pinned 1.18.27, `opencode models` reports 91 ids: 64 under `opencode/` (the
pay-as-you-go Zen gateway) and 27 under `opencode-go/` (the OpenCode Go
subscription). Go is a separate provider, not a billing mode of Zen — `auth.json`
carries a distinct credential for each, and the rosters only partly overlap: Go
alone serves `glm-5.3`, `longcat-2.0`, `hy3`/`hy4-preview`, `omen-alpha`,
`mimo-v2.5-pro`, and the `qwen3.7`/`qwen3.8` tiers, while Zen alone serves the
Anthropic and most GPT tiers. An operator with a Go subscription therefore could
not select any of the 27 models they were paying for from the picker; the only
route was the free-text "Custom provider" path, which offers no name, badge, or
default and no indication the models exist.

Nothing in the execution path was at fault. A probe against the real CLI confirmed
`opencode-go/kimi-k3` runs green through the existing executor — unseeded fails,
seeded `auth.json` succeeds, session id extracted — because `-m` is passed through
verbatim and the single seeded `auth.json` already authenticates both namespaces.
The catalog was the whole gap, which is why it went unnoticed: every layer below
it already worked.

The second is a workspace-confinement gap, found while splitting the namespaces.
A provider whose *executor cannot drive it* is not merely an authentication
problem. Cline's `opencode` provider executes tools server-side, inside a
long-lived `opencode serve` process whose working directory is fixed when that
server starts — so the workspace path the orchestrator passes is ignored, and
every edit lands in whatever checkout the server happened to be launched in. The
attempt then reports success while its own workspace stays untouched, fails as
`no-changes`, and the real work is stranded in an unrelated repository. Startup
only warned about such a pairing; the run proceeded.

## What Changes

- Enumerate **each OpenCode-hosted namespace as its own catalog provider** —
  "OpenCode Zen" (`opencode/<model>`) and "OpenCode Go" (`opencode-go/<model>`) —
  both declaring the `opencode` executor kind, so an OpenCode repository is
  offered both and every model its agent can authenticate against is selectable
  without the free-text path.
- Badge Go's entries uniformly as subscription-included rather than deriving a
  tier from an id suffix. Zen marks no-cost models with a `-free` suffix; Go's
  roster has no such marker because the plan covers all of it.
- Keep both namespaces present after a **live catalog refresh**. The Cline
  featured-model feed rebuilds the whole snapshot, so a namespace defined only in
  the offline fallback would be selectable offline and nowhere else.
- **Refuse, per attempt, a provider its configured executor cannot drive**,
  before the agent is launched and before a workspace is prepared, recording a
  reason distinct from an authentication failure. A startup warning is not enough:
  the failure mode is silent, and its damage is writes outside the attempt's
  workspace.
- Leave an **unknown provider id usable**. The catalog makes no claim about an
  operator-supplied provider, so refusing one would break configurations the
  catalog was never meant to govern.

Not changing: the OpenCode executor's argv surface, the credential seed set
(one `auth.json` already covers every namespace), isolation, activity parsing,
the version pin, or the reasoning-effort mapping. No operator configuration is
required to reach a Go model beyond having authenticated the plan.

## Capabilities

### New Capabilities

None. This change makes existing capabilities hold for a second OpenCode
namespace and closes a confinement hole in an existing guarantee.

### Modified Capabilities

- `operator-console`:
  - Gains a requirement that the picker offers **every provider a repository's
    agent can authenticate against**, so no model reachable by that agent is
    available only through the custom free-text path. The console's existing
    requirements govern how a persisted selection survives a catalog refresh and
    how a mismatch is reported, but none of them says the catalog must be
    complete for the agent — which is exactly what was wrong.
- `agent-execution`:
  - "Orchestrator owns the working directory" — it forbids delegating checkout
    selection to the agent, but assumes the agent honors the working directory it
    is given. It gains the requirement that a provider whose execution model would
    place tool execution outside the prepared workspace is refused rather than
    run.
  - "Authentication failure is distinguishable" — it separates auth failure from
    work failure. A provider the executor cannot drive is neither; it gains a
    distinct reason, so the operator is not told to re-authenticate for a
    misconfiguration re-authenticating cannot fix.
- `repository-registry`:
  - "A repository's provider is reconciled against its agent" — it currently
    requires only that a mismatched entry be *reported*, and its companion
    scenario says a usable pairing runs. Read alone it implies a reported
    mismatch still executes. It gains the requirement that such an entry produces
    no agent run.

## Impact

- **Code** (already landed in `465b0a6`): `src/agent/provider-catalog.ts` (Go id
  list, per-namespace provider entries, tier derivation generalized over both),
  `src/orchestrator/resolution.ts` (per-attempt refusal),
  `src/orchestrator/failures.ts` (`provider-executor-mismatch` reason).
- **Tests** (already landed): `tests/provider-catalog.test.ts`,
  `tests/resolution-orchestrator.test.ts`.
- **Docs** (already landed): `README.md`, `config.example.yaml`.
- **Console**: none beyond the catalog. The picker already groups models by
  provider and filters providers by the repository's agent kind, so a second
  OpenCode namespace needed no rendering change.
- **Operator configuration**: an OpenCode agent must be registered in
  `gremlyn.yaml` before any repository can select an OpenCode namespace at all.
  That is per-installation config, outside this change.
- **Version coupling**: both id lists are pasted from `opencode models` on the
  pinned release, so bumping `EXPECTED_OPENCODE_VERSION` means re-pasting both.
- **Relationship to `add-opencode-agent`**: that change declared "an OpenCode Zen
  model catalog is deliberately out of scope" and routed OpenCode repositories
  through the custom-provider path. A Zen catalog was added later anyway, without
  amending that decision. This change supersedes it for both namespaces.
