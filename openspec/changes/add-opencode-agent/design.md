## Context

See proposal.md — Why for motivation and the full probed argv mapping.

Three properties of the existing code shape everything below:

- The `AgentExecutor` seam is real and well-placed. `resolution.ts` calls `executor.run(opts)`
  and consumes `AgentResult`; nothing in the workspace, validation, publication, or reporting
  path knows which CLI ran. That part of D10 needs no change.
- The leaks are all at the *edges* of the seam, not inside it: executor construction
  (`index.ts` matching the literal `"cline"`), the option payload (`AgentRunOptions` mirroring
  Cline's flags), credential seeding (a module constant, and a call site that never passes the
  override), and stream parsing (`activity.ts` hard-coded to one event schema).
- Every fact about OpenCode used here was probe-verified against 1.18.27, not read from
  documentation. Where the probe left something unknown, this document says so rather than
  assuming.

This change depends on `fix-windows-shim-native-binary`. Until that lands the OpenCode CLI
cannot be spawned at all.

## Goals / Non-Goals

**Goals:**

- Two agents registered and runnable concurrently, selected per repository.
- The invocation contract stays common; each executor owns its own translation of it.
- Every guarantee the specs already make for Cline holds identically for OpenCode —
  isolation, credential lifetime, bounded execution, distinguishable failure reasons.
- Failures that need different operator actions read differently.

**Non-Goals:**

- An OpenCode Zen model catalog in the console. OpenCode repositories use the existing
  "Custom provider" free-text path. Making `ProviderCatalog` agent-aware is a Cline-only
  module rewrite plus a second refresh source, and is not required to run a job.
- Session resumption, forking, or `--continue`. Every attempt is a fresh session, matching
  the Cline path.
- OpenCode's server, ACP, MCP, plugin, and GitHub-agent surfaces. Only `run` is used.
- Non-Windows verification of the launcher. The probe was Windows-only.

## Decisions

### Executors are selected by a declared kind, not by agent id

`index.ts` currently matches `definition.id !== "cline"`. Agent ids are operator-chosen labels;
binding behavior to them means an operator cannot run two Cline builds under different names,
and cannot name their OpenCode agent anything but `opencode`.

Agents gain an explicit executor kind in configuration, and `index.ts` builds from a registry
keyed by kind. Id stays a free label.

Alternative considered — **infer the kind from `binary`**. Rejected: the binary may be an
absolute path, a renamed shim, or a wrapper script, and a wrong inference produces a confusing
argv mismatch at run time instead of a config error at startup.

**Compatibility**: an existing `agents.cline` block with no kind field must keep loading. The
kind defaults to the agent's id when omitted, which resolves existing Cline configs to the
Cline executor unchanged and requires no operator edit.

### `AgentRunOptions` stays common; executors translate, and declare what they cannot do

The option payload is Cline-flag-shaped, but the *concepts* are agent-neutral — working
directory, model, effort, prompt, bound on time, bound on retries. Keeping one payload is what
makes the seam worth having.

Two fields need care:

- **`provider`** is a first-class Cline argument (`-P`) and does not exist for OpenCode, which
  folds it into the `provider/model` form of `-m`. The field stays on the payload and becomes
  agent-interpreted: the Cline executor passes it as `-P`; the OpenCode executor ignores it and
  the loader does not require it for OpenCode entries. This is what the `repository-registry`
  delta's per-agent validation covers.
- **`retries` and `timeoutSec`** have no OpenCode flags at all.

For the second case, "translate it away" is not acceptable — the spec delta explicitly forbids
accepting a setting and silently discarding it. `timeoutSec` is already enforced outside the
CLI (`defaultRunner` passes it to execa as a process timeout), so it needs nothing. `retries`
is the real gap; see below.

Alternative considered — **a per-executor options type**. Rejected: it pushes agent knowledge
back into `resolution.ts`, which is exactly what the seam exists to prevent.

### Retries are bounded by the orchestrator when the CLI cannot bound them

Cline takes `--retries n`. OpenCode has no equivalent, so under OpenCode the spec's "bounded
retry allowance" would be satisfied by nothing at all.

An executor declares whether it honors the retry allowance itself. When it does not, the
orchestrator applies the bound around the invocation. This is the "honor it by other means"
branch of the modified requirement rather than the "reject the configuration" branch, because
rejecting would make `retries` unusable for OpenCode entirely.

**Deliberate difference in meaning**, which must be documented where operators see it: Cline's
`--retries` bounds *consecutive mistakes within one agent session*; an orchestrator-side bound
counts *whole invocations*. These are not the same unit and a retry budget of 2 does not mean
the same thing under both agents. Pretending otherwise would be worse than stating it.

### Isolation: relocate data and state, share cache and config

`opencode debug paths` distinguishes five roots. The probe established what each holds and
which environment variable moves it:

| Root | Var | Holds | Per attempt? |
| --- | --- | --- | --- |
| data | `XDG_DATA_HOME` | `auth.json`, `opencode.db` (+wal/shm), `log`, `repos` | **Yes** — sessions and credentials |
| state | `XDG_STATE_HOME` | `locks/`, `model.json`, `prompt-history.jsonl` | **Yes** — `locks/` is precisely the shared mutable state concurrency corrupts |
| cache | `XDG_CACHE_HOME` | `bin/` (downloaded executables), `models.json` (4.4MB catalog) | **No** — 8.4MB of host-level, non-session content; relocating it per attempt forces a re-download and catalog refetch on every job |
| config | `XDG_CONFIG_HOME` | operator's `opencode.jsonc` and plugins | **No** — operator-owned, read-only, the analogue of Cline's credential source |
| tmp | — | not XDG-controlled | No |

Missing `locks/` would be the same class of bug as the original credential-isolation defect:
invisible with `concurrency: 1`, corrupting at 2.

These variables are not in `AGENT_ENV_ALLOWLIST`, and should not be added to it — the allowlist
is for host variables passed through, and these are values Gremlyn computes per attempt.
`buildAgentEnvironment` already takes an `additional` map for exactly this. An executor gains a
hook to contribute its own entries, and the Cline executor contributes none.

Alternative considered — **add the XDG variables to the allowlist**. Rejected: it would leak
the *operator's* ambient XDG settings into every attempt, which is the opposite of isolating.

### Credential seed set moves onto the agent definition

`CREDENTIAL_SEED_FILES` is a module constant of two Cline paths, and `resolution.ts:386` calls
`seedAgentCredentials(source, dir)` without the `files` argument the function already accepts.
The set becomes part of the agent definition, defaulted per executor kind: Cline keeps
`secrets.json` + `settings/providers.json`, OpenCode declares `auth.json`.

Startup verification extends to the declared set, so a missing file is a config error rather
than a mid-job failure — matching the posture the credential-isolation change established.

**A verified caveat**: OpenCode Zen's *free* models authenticate anonymously. A run with no
`auth.json` at all succeeded. So a successful smoke test on a free model does **not** prove
credential seeding works, and acceptance must exercise a model that requires the credential.
This is why the probe's A/B used a paid model — unseeded gave a useless
`UnknownError: Unexpected server error`, and seeded gave `401 CreditsError`, which is the
credential being *accepted*.

### Billing refusal gets its own failure reason

OpenCode surfaces exhausted credit as HTTP 401 with the word `Unauthorized`, wrapping a
`CreditsError`. `isAgentAuthenticationFailure` matches on unauthorized wording and would
classify it as an auth failure, telling an operator to re-authenticate a credential that is
working correctly.

Classification keys on the provider's reported condition where the payload carries one, and
falls back to status and wording only when it does not. The ordering matters: the billing check
must run *before* the unauthorized check, since the billing payload also matches the auth
pattern.

Alternative considered — **treat it as a generic agent failure**. Rejected: it is not the
agent's work failing, it is an account condition with a specific and different operator action.

### A second stream parser, sharing the `ActivityBlock` output

The two streams have almost nothing in common. Cline emits ~700 `content_start` deltas per run,
each carrying both a fragment and the whole block so far, and `activity.ts` keeps the newest
`accumulated` per block to reconstruct a transcript from hundreds of records. OpenCode emits
terminal state per event — 14 events / 9KB for a five-step tool-using run — with nothing to
de-duplicate.

`ActivityRecorder` gains a per-agent line mapper; the `ActivityBlock` shape, the caps
(`MAX_BLOCK_CHARS`, `MAX_BLOCKS`), the redaction, and the snapshot writer are shared, so the
console needs no change. Mapping:

| OpenCode event | `ActivityKind` |
| --- | --- |
| `text` | `text` |
| `reasoning` | `reasoning` |
| `tool_use` (`part.tool`, `part.state.input/output/status`) | `tool` |
| `step_start` / `step_finish` | `iteration` |
| `step_finish.part.tokens` + `cost` | `usage` |
| `error` | `result` |

Alternative considered — **normalize OpenCode's events into Cline's schema and reuse the parser
unchanged**. Rejected: it would mean synthesizing `accumulated` deltas that OpenCode never
emits, to feed de-duplication logic that exists only because Cline needs it.

**`--thinking` is required to get `reasoning` events at all.** Without it the reasoning tokens
are counted but the blocks withheld. Since the console already collapses reasoning by default
and treats it as the higher-risk content, passing `--thinking` is right — but it is a flag with
a confusingly different meaning from Cline's `--thinking <tier>`, which sets effort. OpenCode's
effort flag is `--variant`. Getting these two crossed would silently change behavior on both
agents, so each executor's argv construction is asserted in a contract test.

### Version pinning is exact, matching the Cline posture

OpenCode pins to 1.18.27 and refuses startup on a mismatch, as `EXPECTED_CLINE_VERSION` does.
The argv surface here was probed against exactly one release and the honest statement is that
another release is unverified. `checkVersion` moves onto the `AgentExecutor` interface so each
executor carries its own expectation instead of `index.ts` reaching for a module constant.

Accepted cost: OpenCode releases often, so this will need bumping, and each bump should re-run
the probe rather than only editing the constant. A startup error naming both versions is a far
better failure than an argv mismatch surfacing as a mid-job agent error.

### Agent-agnostic launcher code moves out of `cline.ts`

`defaultRunner`, `ProcessRunner`, `ProcessResult`, and `resolveWindowsShim` are agent-neutral
but live in a Cline-named module that the OpenCode executor would otherwise have to import
from. They move to a neutral module, with `cline.ts` keeping only Cline's executor, version
constant, and extractors. This is import-path churn with no behavior change, and is kept as its
own task so it does not obscure the functional diff.

## Risks / Trade-offs

- **OpenCode silently accepts an invalid `--variant`** (verified: `--variant
  definitely-not-a-tier` exits 0 and completes normally) → Effort is validated against the
  agent's declared `efforts` before invocation, which the registry already does. Unlike Cline
  there is no post-hoc detection available: OpenCode's stream carries no model metadata at all
  (top-level keys are only `type`, `timestamp`, `sessionID`, `part`), so there is no analogue to
  `extractSupportedEfforts`. Documented as a known blind spot rather than papered over.
- **Per-model effort tiers are unknown for OpenCode** → The agent's `efforts` list is
  operator-declared config, as it is for Cline. The existing warning in `types.ts` about the
  ceiling being per-model applies with less recourse here.
- **A free-model smoke test gives false confidence in credential seeding** → Acceptance requires
  a model that actually needs the credential; called out as an explicit task.
- **`opencode.jsonc` and its plugins are shared across attempts** → Deliberate: it is the
  operator's read-only configuration, the analogue of the credential source. But a plugin
  installed there runs inside every attempt, which widens what agent code can do. Noted rather
  than mitigated; locking it down is out of scope.
- **Sharing the cache directory across concurrent attempts** → Accepted for the 8.4MB re-download
  it avoids. `bin/` and `models.json` are content-addressed host-level artifacts, not session
  state. If concurrent cache writes prove to contend, relocating cache per attempt is the
  fallback and costs only download time.
- **An exact version pin will break on OpenCode upgrades** → Accepted, per the decision above.
- **Two agents multiply the acceptance matrix** → Contract tests assert each executor's argv and
  environment without spawning anything; only the end-to-end acceptance runs need both CLIs
  installed.

## Open Questions

- Should the console expose `opencode export <sessionID>` as a transcript link? OpenCode's
  session id is a real export handle, unlike Cline's `taskId`, so this is newly possible — but
  it is a console feature that changes no spec here and can land separately.
- Does OpenCode honor a cancellation signal cleanly enough to leave the workspace inspectable,
  as the timeout requirement demands? The probe covered normal exit and error exit, not
  cancellation mid-run. Verifying this is an acceptance task; if it does not, the answer is a
  harder process termination, not a different design.
