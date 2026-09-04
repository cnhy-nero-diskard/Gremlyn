## Why

Gremlyn runs exactly one agent CLI. `src/index.ts` hard-guards
`if (definition.id !== "cline") throw`, so the "replaceable executor" of design D10 is
a seam that has never had a second implementation pushed through it. Every place the
abstraction leaks — a Cline-shaped `AgentRunOptions`, a module-level credential seed
set, a `checkVersion` that is a `ClineExecutor` method rather than part of the
interface — is invisible while there is only one agent.

Adding OpenCode is worth doing on its own terms, not only as a test of the seam. It is
a closer fit than Cline in several places: a leaner event stream (14 events / 9KB for a
five-step tool-using run, against Cline's 845 lines / 511KB of token deltas), terminal
state per event instead of `accumulated` deltas needing de-duplication, a single-file
credential, and a session id that is a real export handle rather than Cline's dead-end
`taskId`.

The whole invocation surface was probe-verified against **opencode 1.18.27** before this
change was written, end to end on a real git workspace — the agent globbed, read,
edited, re-read, and summarized, and the edit landed correctly:

```
opencode run --dir <ws> -m opencode/<model> --format json --auto --thinking <prompt>
```

| `AgentRunOptions` | Cline | OpenCode |
| --- | --- | --- |
| `cwd` | `-c <dir>` | `--dir <dir>` |
| `model` | `-m` | `-m` (same `provider/model` form) |
| `provider` | `-P` | folded into `-m`; no separate argument |
| `effort` | `--thinking <tier>` | `--variant <tier>` |
| `prompt` | `-- <text>` | positional `[message..]` |
| structured stream | `--json` | `--format json` |
| approval | `--auto-approve true` | `--auto` |
| `dataDir` | `--data-dir <path>` | **env `XDG_DATA_HOME`** — not an argument |
| `retries` | `--retries <n>` | **no equivalent** |
| `timeoutSec` | `-t <sec>` | **no equivalent** |

## What Changes

- Register agents by an **executor kind** declared in configuration rather than by
  matching the agent id against the literal `"cline"`, so a second executor can be
  configured and two agents can be registered at once.
- Add an OpenCode executor implementing the existing `AgentExecutor` seam over the
  probed argv surface above.
- Move version checking onto the executor interface, and pin OpenCode to the single
  release its surface was probed against, refusing startup on a mismatch — the same
  posture `EXPECTED_CLINE_VERSION` already takes.
- Make the **credential seed set per-agent**. It is a module-level constant today
  (`CREDENTIAL_SEED_FILES`, two Cline files) and `resolution.ts` calls
  `seedAgentCredentials` without the argument that would override it. OpenCode's entire
  credential set is a single `auth.json`.
- Let an executor **contribute environment variables** to its own invocation, so
  OpenCode can receive the per-attempt `XDG_DATA_HOME` (plus `XDG_CACHE_HOME` and
  `XDG_STATE_HOME`) that isolates its state. Isolation is achieved by argument for
  Cline and by environment for OpenCode; the requirement is the same either way.
- Bound retries **in the orchestrator** for an agent whose CLI has no retry allowance
  of its own, so "bounded execution" holds for both agents rather than being delegated
  to a flag that only one of them has.
- Parse OpenCode's event stream into the existing `ActivityBlock` shape, so the console
  renders a running OpenCode attempt with no console-side changes.
- Recognize OpenCode's session id (`sessionID`) and record it as the export handle it
  actually is.
- **Distinguish a billing failure from an authentication failure.** OpenCode reports
  exhausted credit as `401 Unauthorized` carrying `CreditsError`, which the current
  classifier reads as a provider auth failure. Two different operator actions —
  re-authenticate, versus add a payment method — currently produce the same message.
- Generalize `npm run probe:agent`, which is hardwired to `ClineExecutor`, to probe
  either agent.

Not changing: the workspace, validation, publication, and reporting pipeline; the
prompt builder; `defaultRunner`; the console's rendering of activity; the environment
allowlist's exclusion of the orchestrator's GitHub token.

## Capabilities

### New Capabilities

None. This change makes an existing capability hold for a second agent rather than
introducing a new one.

### Modified Capabilities

- `agent-execution`:
  - "Replaceable executor abstraction" — it requires that substituting an executor not
    disturb the pipeline, but assumes a single configured CLI. It gains the requirement
    that more than one executor is registered concurrently, that each maps the common
    invocation contract onto its own CLI surface, and that a capability the common
    contract offers but a given CLI lacks is honored by the system rather than dropped.
  - "Bounded execution" — currently reads as though the agent's own retry flag provides
    the bound. It gains the requirement that the bound holds regardless of whether the
    CLI implements one.
  - "Isolated agent state per attempt" — currently silent on the mechanism. It gains the
    requirement that isolation is established by whatever means a given CLI provides,
    including its environment, without weakening the guarantee.
  - "Agent credential source is configuration" — currently declares a per-agent
    *location*. It gains a per-agent *credential set*, since the files to seed differ by
    agent.
  - "Authentication failure is distinguishable" — it separates auth failure from work
    failure, but a billing failure is neither. It gains a third distinct reason.
  - "Secrets are withheld from the agent" — forbids passing provider credentials through
    the environment. Clarified so that passing a filesystem *location* for isolation is
    not passing a credential; the credential remains a file the system places on disk.
- `repository-registry`:
  - "Managed repository record" — the provider identifier a repository carries is
    meaningful to one agent and folded into the model id for the other. It gains the
    requirement that per-repository agent settings are validated against the selected
    agent rather than assumed uniform.

## Impact

- **Code**: `src/index.ts` (executor registry), `src/types.ts` (`AgentExecutor`,
  `AgentRunOptions`), `src/agent/` (new OpenCode executor; `credentials.ts` per-agent
  seed set; `activity.ts` second stream parser; `environment.ts` allowlist;
  `probe.ts` generalization), `src/config/loader.ts` (executor kind, per-agent
  validation), `src/orchestrator/resolution.ts` (seed set, retry bound),
  `src/orchestrator/failures.ts` (billing classification).
- **Configuration**: agents gain an executor kind; `config.example.yaml` and the README
  gain an OpenCode example. Existing single-agent Cline configurations must keep
  loading — see design.md for the compatibility decision.
- **Depends on**: `fix-windows-shim-native-binary`. OpenCode's `.cmd` shim resolves to a
  native executable, which today is handed to Node and dies parsing a PE header, so the
  CLI cannot be spawned at all until that change lands.
- **Console**: none required. OpenCode repositories use the existing "Custom provider"
  free-text path; an OpenCode Zen model catalog is deliberately out of scope.
- **Naming debt**: `defaultRunner`, `resolveWindowsShim`, and `ProcessRunner` are
  agent-agnostic but live in `src/agent/cline.ts`. This change has cause to move them.
