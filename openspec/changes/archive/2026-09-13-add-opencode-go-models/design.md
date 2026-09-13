## Context

See proposal.md — Why.

This change was written after its implementation landed in `465b0a6`, so the
decisions below record choices already made in code and verified against the real
CLI, not options still open. Two constraints shaped them.

**The catalog is the only layer that knew about namespaces.** OpenCode takes no
provider argument; the namespace is folded into the model id and passed through to
`-m` verbatim. Credential seeding copies one `auth.json`, which carries a separate
entry per namespace the operator has logged into. So every layer below the catalog
was already namespace-agnostic and needed no change — confirmed by probing the
real CLI before writing anything:

```
opencode run --dir <ws> -m opencode-go/kimi-k3 --format json --auto --thinking --variant high <prompt>
  unseeded isolated data dir  -> exit 1, UnknownError
  seeded   isolated data dir  -> exit 0, "READY", finishReason stop, sessionID extracted
```

**The catalog serves two roles that had quietly diverged.** It is both the
console's model picker and, through `providerSupportsAgentKind`, the reference for
which providers an executor can drive. Enumerating only Zen was a gap in the first
role; the second role was consulted at startup only.

## Goals / Non-Goals

**Goals:**

- One catalog entry per OpenCode-hosted namespace, each declaring the executor
  kind it serves, so the existing kind filter and optgroup rendering carry the
  picker with no console-side change.
- A version bump remains a paste of `opencode models` output.
- The provider/executor pairing is enforced where the damage would occur, not only
  where it is first observable.

**Non-Goals:**

- Discovering namespaces at run time by shelling out to `opencode models`. See
  Decisions.
- Enumerating providers OpenCode can reach that are not OpenCode-hosted
  (`anthropic/…`, `openai/…`). Those depend on each installation's own
  `opencode auth login` state; the custom free-text path covers them.
- Per-model descriptions. OpenCode exposes none over the CLI.
- Changing how a persisted selection survives a catalog refresh — already
  specified and already correct.

## Decisions

**Static id lists, pasted per pinned release, over run-time discovery.**
`opencode models` would always be accurate, but it makes rendering the dashboard
depend on spawning a subprocess: it adds a failure mode to a page whose whole
fallback design exists so the console opens when the network does not, and it
would run on a host where the CLI may be absent entirely. The executor is already
pinned to one probed release (`EXPECTED_OPENCODE_VERSION`), so the roster is fixed
for any version the orchestrator will start against, and a stale list can only
occur alongside a version bump that already requires re-probing. Rejected:
caching a discovered list on disk — same failure modes plus cache invalidation.

**Two provider entries sharing one executor kind, rather than one entry holding
both namespaces.** The kind is what the console filters on and what
`providerSupportsAgentKind` answers about; the provider id is what an operator
selects and what is persisted. Zen and Go are one executor and two credentials, so
they are one kind and two providers. Collapsing them into a single "OpenCode"
entry with 91 models would have been fewer lines and actively misleading: it
implies one credential and one billing relationship, and it hides that
authenticating Zen gives no access to Go. Rejected also: a distinct executor kind
per namespace — the executor, argv, seed set, isolation, and version pin are
identical, so a second kind would duplicate all of it to express a difference that
lives entirely in the credential.

**A uniform tier for Go, derived per namespace rather than per id.** Zen marks
no-cost models with a `-free` suffix, which the badge is derived from. Go has no
such marker because the subscription covers its whole roster, so deriving from the
id would silently badge nothing. The tier is therefore a property of the namespace
with the suffix rule applied within it, which keeps one code path over both lists.

**Refuse the mismatch per attempt, not at startup.** Startup reporting already
existed and is kept — it is the earliest point an operator can be told. It is not
sufficient on its own for three reasons: the persisted selection is
operator-editable from the console after startup, an unread warning does not stop
a run, and the failure it guards against is silent. Placing the refusal at the
start of the attempt, before a workspace is prepared, means the guarantee holds
however the mismatch arose. Rejected: refusing at selection time in the console —
it would not cover a selection already persisted, nor one arriving from
configuration.

**Refuse only pairings the catalog describes.** An unknown provider id is
operator-supplied; the catalog makes no claim about it, so treating absence as
disqualification would reject working configurations to enforce a rule the system
cannot evaluate. Absence of evidence is not evidence of a mismatch, and the
existing `agent-cli-missing` check still covers an agent with no executor at all.

**Fail the attempt rather than skip it.** A refused attempt is recorded as failed
with its own reason, in the `preparing` stage, with no workspace and no push. A
skip would leave the operator's command with no visible outcome; a failure is
already the shape the console, the retry action, and the GitHub reply understand.

## Risks / Trade-offs

- **The id lists drift from what the CLI serves if a namespace's roster changes
  without a release bump.** → A stale entry surfaces as a model the picker offers
  and the provider rejects, which is visible and recoverable; a missing entry is
  reachable through the custom free-text path meanwhile. The pin makes the bump
  the natural moment to re-paste.
- **A third OpenCode namespace would need the same two-line addition and could be
  missed.** → The failure is the same benign one this change fixed, with the same
  workaround, and both existing lists cite the single command that reveals it.
- **The refusal rejects an attempt the operator may believe is configured
  correctly.** → The recorded reason names the provider, the executor, and the
  reason tool execution would escape the workspace, and the startup warning fires
  before any attempt does.
- **The refusal depends on the catalog being right about a pairing.** → A wrong
  claim blocks a working configuration. Limiting refusal to described pairings
  bounds the blast radius to entries the project asserted, and the custom path
  offers no escape from it by design — a pairing known to write outside the
  workspace should not be bypassable.
