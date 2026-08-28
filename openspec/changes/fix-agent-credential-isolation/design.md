## Context

See proposal.md — Why, for the defect and its evidence.

The constraint that shapes everything here is that cline draws no line between
credentials and mutable state. Both live under one directory:

```
~/.cline/            <- --config <path>
  data/              <- --data-dir <path>
    secrets.json     <- credentials       (must be shared across attempts)
    db, locks.db     <- run state, locks  (must be isolated per attempt)
    sessions/        <- session history
    globalState.json <- provider/model selection (unclassified)
```

`--config` and `--data-dir` are separate flags, but the credential file sits on the
`--data-dir` side, so relocating state relocates authentication with it. Design D10
of `add-pr-resolution-orchestrator` chose per-attempt relocation to stop concurrent
attempts racing on `locks.db` and the session store. That decision is sound; it
simply took the credential along with the state.

Two properties of the existing system bound the solution. The queue runs attempts
for different pull requests concurrently, and that parallelism is a stated goal
(design D7, task 6.2). And the environment allowlist deliberately withholds every
credential from the agent process (`AGENT_ENV_ALLOWLIST`), so credentials have so
far never been Gremlyn's to hold.

## Goals / Non-Goals

**Goals:**

- Restore agent authentication without giving up per-attempt state isolation.
- Keep the operator's authenticated cline installation read-only.
- Make an unusable credential source a startup failure, not a per-job failure.
- Keep the credential off the argument vector and out of the environment.

**Non-Goals:**

- Managing provider authentication itself. The operator still runs `cline auth`;
  this design consumes the result, it does not replace it.
- Supporting agents other than cline. The seam is per-agent, but only cline is
  implemented.
- Encrypting credential material at rest. The seeded copy is protected by
  filesystem permissions and lifetime, not cryptography.

## Decisions

### D1 — Seed each attempt directory from a configured credential source

Before invoking the agent, copy the credential material from a configured,
authenticated source directory into the attempt's fresh `--data-dir`. Remove it
with the attempt directory when the attempt ends.

This keeps D10's isolation intact — each attempt still gets its own `locks.db`,
session store, and state — while giving the agent what it needs to authenticate.
Concurrency is unchanged.

*Alternative: share one data directory and serialize agent runs.* Rejected. It
removes credential handling from Gremlyn entirely, which is attractive, but it
forces agent concurrency to 1 and makes Gremlyn's attempts share `locks.db` and
session history with the operator's own interactive cline usage. Giving up
cross-repository parallelism to avoid copying one file is the wrong trade.

*Alternative: pass the credential per invocation with `-k/--key`.* Rejected. It
puts a secret on the argument vector, visible in process listings to any user on
the host — a worse exposure than a permission-restricted file, and it would require
Gremlyn to read and hold the credential value rather than move an opaque file.

*Alternative: symlink or junction the credential into each attempt directory.*
Rejected. Windows symlink creation needs elevation or developer mode, and
junctions are directory-only. Fragile on the primary supported platform.

### D2 — The credential source is per-agent configuration, verified at startup

Each agent definition declares the directory holding its credentials. The startup
sequence already probes the agent CLI version; it gains a check that the declared
source exists and is readable, and refuses to start otherwise.

Startup is the right place because the failure is static: a missing credential
source is wrong for every job, and discovering it per-job produces a stream of
identical agent failures on real pull requests, each one a comment posted to a
reviewer. The existing version check sets the precedent.

### D3 — Copy the narrowest sufficient set of files

The seed set is a declared list, not the whole source directory. Copying the whole
directory would drag `locks.db`, `sessions/`, and `db/` along and reintroduce
exactly the sharing D10 removed.

Empirically verified against cline 3.0.60 via `npm run probe:agent --seed-source`.
One provider was not enough to find the set — credential shape varies by provider:

| Provider | Kind | Unseeded | `secrets.json` only | Confirmed set |
| --- | --- | --- | --- | --- |
| `cline-pass` | API key | `Unauthorized` | `completed` | sufficient |
| `openai-codex` | OAuth/PKCE | key missing | **key missing** | needs `settings/providers.json` |

`openai-codex` is the case that corrected the assumption. Seeding `secrets.json`
alone left it failing with "OpenAI API key is missing … or the `OPENAI_API_KEY`
environment variable", which reads like a provider that wants its credential from
the environment — a transport this design deliberately blocks. It is not. Running
the same argv with **no** `--data-dir` succeeded, proving the credential was on
disk all along, in `settings/providers.json` (the PKCE refresh token), a file whose
mtime moves on `cline auth`. That "run it unisolated" check is the reliable way to
separate an absent credential from an unseeded one, and it is now the probe's
guidance on a seeded failure.

`globalState.json` was tested for both providers and is not required: it carries
provider/model selection, which the orchestrator supplies via argv.

The declared list is therefore `["secrets.json", "settings/providers.json"]` (see
`src/agent/credentials.ts:CREDENTIAL_SEED_FILES`), and both providers reach
`finishReason: "completed"` on an isolated `--data-dir` with it. Entries may name
nested paths; seeding creates parent directories. Startup verification requires
every declared file, so a source missing the OAuth file fails at startup rather
than per-job on whichever repository happens to use that provider.

If a future Cline version changes storage layout, re-running the probe against the
new version is the re-verification step (README) and the list grows; the design
does not otherwise change.

### D4 — Treat the seeded credential as attempt-scoped

The copy is written into the attempt's data directory, which is already created per
attempt and already removed with it. Nothing new governs its lifetime, and
cancellation and timeout paths already delete that directory, so the credential
cannot outlive its attempt through a path that does not also leak the workspace.

File permissions are set to owner-only on creation so a concurrent attempt running
under a different account cannot read it.

### D5 — Authentication failure gets its own reason code

`Unauthorized` currently surfaces as `agent-nonzero-exit`, which is indistinguishable
from the agent running and failing on the work. Layer1 §27 requires each failure mode
to map to a distinct reason, so authentication failure becomes its own reason,
detected from the agent's result rather than inferred from the exit code alone.

This matters beyond tidiness: an authentication failure means every subsequent job
will fail identically, and an operator reading the console should see that
immediately rather than deducing it from a run of unrelated-looking failures.

## Risks / Trade-offs

**A provider credential is written to Gremlyn-managed disk** → This widens the
current position, where Gremlyn holds no provider credentials at all. Mitigated by
lifetime (bounded by the attempt), permissions (owner-only), location (under the
configured data directory, never the workspace the agent edits or any directory
that gets committed), and by copying an opaque file rather than reading its
contents. The alternative that avoids this entirely costs all agent concurrency.

**The seed set may be incomplete** → An incomplete set fails the same way the bug
does today: `Unauthorized`, fast, on every job. Mitigated by determining the set
empirically first (task 1), and by D5 making that failure legible the moment it
happens rather than a mystery.

**Cline may change where it stores credentials** → The version pin is exact-match,
so an upgrade already requires a deliberate edit; that edit becomes the moment to
re-verify the seed set. `npm run probe:agent` exercises the isolated path directly,
so re-verification is one command.

**A crash between seeding and cleanup leaves a credential on disk** → The startup
interrupted-job sweep already reconciles attempts left in a non-terminal status. It
gains removal of stale attempt directories, which is the same mechanism.

## Migration Plan

Configuration gains a required per-agent field. An existing `gremlyn.yaml` without
it fails to load with a message naming the field and the conventional default
(`~/.cline/data`), consistent with how the loader reports every other missing
required field.

No data migration: attempt directories are ephemeral, and the change alters no
schema. Rollback is reverting the code; the operator's cline installation was never
modified, so nothing outside the repository needs undoing.

## Open Questions

None. The one unknown that would change the approach — whether the credential file
alone is a sufficient seed — is resolved by the first task before any dependent
work begins, and a broader set changes only a declared list.
