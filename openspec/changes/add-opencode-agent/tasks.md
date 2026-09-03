## 1. Prerequisites

- [ ] 1.1 Confirm `fix-windows-shim-native-binary` is merged, and verify `defaultRunner("opencode", ["--version"])` returns exit 0 with `1.18.27` rather than a `SyntaxError`
- [ ] 1.2 Move `ProcessRunner`, `ProcessResult`, `defaultRunner`, and `resolveWindowsShim` out of `src/agent/cline.ts` into a neutral launcher module, leaving Cline's executor, version constant, and extractors behind; verify `npm test`, `npm run build`, and `npm run lint` pass with only import paths changed

## 2. Generalize the executor seam

- [ ] 2.1 Add `checkVersion(env)` to the `AgentExecutor` interface in `src/types.ts`, each executor carrying its own expected release; verify the Cline executor still rejects a wrong version with the existing `AgentVersionError` test
- [ ] 2.2 Add an executor-owned hook contributing per-attempt environment entries, defaulting to none; verify a unit test shows the Cline executor contributes nothing and the resulting environment is byte-identical to today's
- [ ] 2.3 Add an executor declaration of whether it honors the retry allowance itself; verify the Cline executor declares that it does
- [ ] 2.4 Replace the `definition.id !== "cline"` guard in `src/index.ts` with a registry keyed by executor kind; verify startup with an unknown kind fails naming the agent and the kind
- [ ] 2.5 Add an `executor kind` field to the agent config schema in `src/config/loader.ts`, defaulting to the agent's id when omitted; verify an existing Cline config with no kind field loads unchanged (extend `tests/config.test.ts`)
- [ ] 2.6 Make per-repository agent-facing settings validate against the named agent, so `provider` is required for Cline and not for OpenCode; verify an OpenCode entry omitting `provider` loads and a Cline entry omitting it is rejected at startup

## 3. Per-agent credential seed set

- [ ] 3.1 Move the credential seed set from the `CREDENTIAL_SEED_FILES` module constant onto the agent definition, defaulted per executor kind (Cline: `secrets.json` + `settings/providers.json`; OpenCode: `auth.json`); verify `tests/agent-credentials.test.ts` still passes for the Cline set
- [ ] 3.2 Pass the agent's declared set at the `seedAgentCredentials` call site in `src/orchestrator/resolution.ts`, which currently omits the argument; verify a test with two agents seeds a different file set for each
- [ ] 3.3 Extend startup verification to check every file in the agent's declared set, naming the agent and the missing file; verify startup fails with that message when `auth.json` is absent from an OpenCode credential source

## 4. OpenCode executor

- [ ] 4.1 Add the OpenCode executor implementing `AgentExecutor`, building the probed argv `run --dir <cwd> -m <model> --format json --auto --thinking [--variant <effort>] <prompt>`; verify a contract test asserts the exact argv against an injected `ProcessRunner`
- [ ] 4.2 Assert in that contract test that `--variant` carries the effort tier and `--thinking` is a bare flag, and that Cline's `--thinking <tier>` is unaffected; verify both executors' argv in one test so the two meanings cannot be crossed
- [ ] 4.3 Contribute per-attempt `XDG_DATA_HOME` and `XDG_STATE_HOME` pointing into the attempt directory, leaving `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` inherited; verify a test asserts both are set, both are absolute, and no credential value appears in the environment
- [ ] 4.4 Pin the expected release to 1.18.27 via `checkVersion`; verify startup against a different reported version fails naming the agent, expected, and installed versions
- [ ] 4.5 Extend `extractSessionId` to recognize OpenCode's top-level `sessionID`; verify it returns `ses_…` from a captured OpenCode stream fixture and Cline's `taskId` extraction is unchanged
- [ ] 4.6 Ignore `provider` in the OpenCode executor, since it is folded into the `provider/model` form of `-m`; verify the argv contract test shows no `-P` argument

## 5. Bounded execution without a CLI retry flag

- [ ] 5.1 Apply the retry allowance in the orchestrator for an executor that declares it does not honor it; verify a test with a failing fake executor stops after the configured number of invocations
- [ ] 5.2 Record in `config.example.yaml` and the README that the allowance counts whole invocations for OpenCode and consecutive in-session mistakes for Cline; verify `tests/config-example.test.ts` still passes

## 6. Activity stream

- [ ] 6.1 Add a per-agent line mapper to `ActivityRecorder`, keeping `ActivityBlock`, the block/char caps, redaction, and the snapshot writer shared; verify `tests/agent-activity.test.ts` passes unchanged for the Cline mapper
- [ ] 6.2 Implement the OpenCode mapper for `text`, `reasoning`, `tool_use`, `step_start`/`step_finish`, and `error` per the design's mapping table; verify against a captured real stream fixture that tool calls, iterations, token usage, and cost are all recovered
- [ ] 6.3 Verify an unparsable or unknown OpenCode event line is swallowed rather than failing the attempt, matching the Cline mapper's behavior

## 7. Failure classification

- [ ] 7.1 Add a billing failure reason distinct from authentication failure and generic agent failure in `src/orchestrator/failures.ts`; verify the console renders it with its own label
- [ ] 7.2 Classify on the provider's reported condition before falling back to status and wording, ordering the billing check ahead of the unauthorized check; verify with the captured `401 CreditsError` payload that it classifies as billing, and with a genuine unauthorized payload that it still classifies as authentication

## 8. Probe

- [ ] 8.1 Generalize `src/agent/probe.ts` to probe either agent by executor kind rather than constructing `ClineExecutor` directly; verify `npm run probe:agent` against cline produces the same report as before this change
- [ ] 8.2 Verify `npm run probe:agent` against opencode reports the argv, isolated state directories, seeded credential files, and extracted session id

## 9. Configuration and documentation

- [ ] 9.1 Add an OpenCode agent block and an OpenCode repository entry to `config.example.yaml`, including the executor kind and credential source; verify `npm run verify:config` accepts it and `tests/config-example.test.ts` passes
- [ ] 9.2 Document in the README that OpenCode repositories use the console's "Custom provider" free-text path and that the model id takes the `opencode/<model>` form; verify by loading the console and configuring an OpenCode repository through it

## 10. Acceptance

- [ ] 10.1 Run a real resolution end to end under OpenCode against a real PR, and verify the agent edits the workspace, validation runs, and the result publishes
- [ ] 10.2 Run two attempts concurrently under OpenCode and verify neither observes the other's session state and neither fails on a lock in `XDG_STATE_HOME`
- [ ] 10.3 Run an attempt with a model that REQUIRES the credential — not a free OpenCode Zen model, which the probe showed authenticates anonymously — and verify it succeeds seeded and fails unseeded
- [ ] 10.4 Verify no credential material remains in the attempt directory after the attempt finishes, for success, failure, timeout, and cancellation
- [ ] 10.5 Cancel a running OpenCode attempt mid-run and verify the process terminates and the workspace is preserved for inspection (design.md — Open Questions)
- [ ] 10.6 Run one Cline attempt and one OpenCode attempt concurrently and verify each uses its own argv, environment, and credential set
- [ ] 10.7 Run `npm test`, `npm run build`, and `npm run lint`, and `openspec validate add-opencode-agent`; verify all pass
