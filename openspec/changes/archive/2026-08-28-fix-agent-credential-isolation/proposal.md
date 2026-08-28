## Why

Design D10 gives every attempt a fresh `--data-dir` so concurrent attempts cannot
corrupt each other's agent state. Cline stores provider credentials in that same
directory (`~/.cline/data/secrets.json`), so an isolated attempt directory contains
no credentials and the agent exits `Unauthorized` before reading a line of code.
This is not an edge case: it is every job, every time.

Verified against cline 3.0.60 by A/B invocation — identical arguments, the flag as
the only difference:

| Invocation | Result |
| --- | --- |
| with a fresh `--data-dir` | `Unauthorized`, exit 1, ~330 ms |
| without `--data-dir` | `finishReason: "completed"`, exit 0 |

The parent change `add-pr-resolution-orchestrator` is otherwise implementation-
complete, with its final acceptance task (11.6, a real agent invocation against a
real repository) still open. That task cannot pass until this is resolved, and it
is where the defect would otherwise have been discovered.

## What Changes

- Establish a configured, authenticated **credential source directory** for each
  agent, separate from the per-attempt state directory.
- Seed each attempt's fresh `--data-dir` from that source before invoking the
  agent, copying only the credential material required to authenticate.
- Remove the seeded credential with the attempt directory, so it lives no longer
  than the attempt that needed it.
- Verify at startup that the credential source exists and is readable, failing as a
  clear configuration error rather than as a per-job agent failure.
- Preserve per-attempt state isolation exactly as it is today: concurrent attempts
  across different pull requests continue to run in parallel.
- Record on the attempt whether credential seeding occurred, so an authentication
  failure is distinguishable from an agent failure in the console.

Not changing: the environment allowlist still withholds the orchestrator's GitHub
token from the agent, and no provider credential is passed on the argument vector
(where it would be visible in process listings) or through the environment.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-execution`: the "Isolated agent state per attempt" requirement currently
  mandates isolation without qualifying what must remain shared for the agent to
  function. It gains the requirement that credentials are available to every
  attempt despite that isolation, and that an unusable credential source is a
  startup configuration error rather than a job failure.

Note: `openspec/specs/` is empty because `add-pr-resolution-orchestrator` has not
been synced or archived. This change's delta layers on that change's
`specs/agent-execution/spec.md` and should be synced after it.

## Impact

- **Code**: `src/agent/cline.ts` (seeding before invocation), `src/config/loader.ts`
  (credential source directory field and validation), `src/orchestrator/resolution.ts`
  (attempt data-dir preparation and cleanup), `src/index.ts` (startup check).
- **Configuration**: a new per-agent field naming the authenticated cline data
  directory; `config.example.yaml` and the README gain it.
- **Security posture**: a provider credential is written to Gremlyn-managed disk for
  the lifetime of an attempt. This is a deliberate widening of the current position,
  which keeps all credentials out of Gremlyn's control, and is recorded as a
  trade-off in design.md.
- **Blocked work**: task 11.6 of `add-pr-resolution-orchestrator`.
- **Unverified assumption**: that the credential file alone is a sufficient seed.
  Confirming this empirically is the first task of this change and may widen the
  set of files copied.
