# Gremlyn

Gremlyn is a local PR-resolution orchestrator. It polls configured GitHub repositories for an authorized `!RESOLVE` reply on an inline review thread, prepares an isolated git checkout, runs Cline, independently validates the result, pushes a normal commit to the existing PR branch, and replies with the outcome. The developer's normal checkout is never modified. Context: I normally use 5.6 SOL HIGH in chat mode to review my PR's since it doesn't incur weekly usage; this is the invariant I try to create gremlyn around. Would I be extending this to the whole implementation pipeline? Maybe, but I treat the ideation (explore and proposal), first run implementation(apply) and the output corrections (PR, feedback and subsequent changes) as 3 separate processes that shouldn't be time locked. 

Automatic workspace reclamation is opt-in. It only considers deterministic `pr-N` directories beneath configured workspace roots, and retains active, recent, dirty, or indeterminate workspaces. Review the decisions without deleting anything before enabling it:

```powershell
npm run setup -- reclaim --preview --config .\gremlyn.yaml
```

Set `workspace_reclamation.enabled: true` and adjust `minimum_age_seconds` only after reviewing the preview. Every reclamation and refusal is recorded in the operator audit.

## Requirements

- Windows 10/11 with PowerShell (WSL is not required)
- Node.js 22 or newer and npm 10 or newer
- Git 2.x
- Cline CLI 3.0.61, already authenticated with the provider used by your configured model
- A dedicated GitHub account and token for Gremlyn

The GitHub token should have only the repository permissions needed to read pull
requests and review comments and post review replies. Git pushes use the host's
existing Git credential configuration. Do not use your personal API token if a
dedicated bot identity is available.

## Install

```powershell
git clone https://github.com/cnhy-nero-diskard/Gremlyn.git
Set-Location Gremlyn
npm ci
npm run build
npm test
```

## Configure with the setup CLI

The guided CLI is the recommended first-run path. It keeps token values in the
process environment, creates `gremlyn.yaml` from `config.example.yaml` only
when the file is absent, reports host prerequisites, and can register the first
checkout after the prerequisites pass:

```powershell
$env:GREMLYN_GITHUB_TOKEN = 'your-dedicated-bot-token'
$env:GREMLYN_CONSOLE_TOKEN = 'generate-a-long-random-local-token'

npm run setup -- --repo C:/code/your-repo --yes `
  --provider your-provider `
  --model your-provider/lune-5.6 `
  --allowed-model your-provider/lune-5.6 `
  --no-validation
```

Omit `--yes` in an interactive PowerShell session to review each proposal. In a
non-interactive shell, pass `--yes` to accept inferred owner/name, workspace,
agent, effort, and validation-command proposals, or provide the corresponding
explicit flags. `--probe` additionally runs the optional seeded Cline probe
before registration.

After the first repository is registered, add another checkout with the same
rules:

```powershell
npm run add-repo -- C:/code/another-repo --yes `
  --provider your-provider `
  --model your-provider/lune-5.6 `
  --allowed-model your-provider/lune-5.6 `
  --no-validation
```

`add-repo` derives owner/name only from a GitHub `origin`, proposes a safe
workspace sibling, and offers recognized `package.json` scripts as literal
validation argv. It verifies the checkout, origin, workspace boundaries,
duplicates, agent, and model before writing. The write preserves comments and
unrelated entries and is rejected atomically if the generated YAML does not
load through the normal configuration loader.

Run the shared checks against every configured entry without changing files:

```powershell
npm run verify:config -- --config .\gremlyn.yaml
```

`verify` is on demand and does not become an `npm start` preflight. Startup
behavior remains unchanged: `npm start -- .\gremlyn.yaml` performs the existing
configuration, identity, Cline, data-directory, and console checks only.

The three commands are aliases for the `setup`, `add-repo`, and `verify`
subcommands in `src/setup/cli.ts`. Common flags are `--config`, `--yes`, and
`--help`; registration flags are `--owner`, `--name`, `--workspace-root`,
`--agent`, `--provider`, `--model`, `--effort`, repeated `--allowed-model`,
repeated `--validation-command`, `--no-validation`, `--agent-instructions`,
`--enabled`, and `--disabled`. `setup` also accepts `--repo`, `--probe`, and
`--example`. Use `--enabled` and `--disabled` exclusively; use either
`--no-validation` or `--validation-command`, not both.

Every setup and verification message is passed through secret redaction. Token
values are never written to `gremlyn.yaml` or another file. If the console token
is absent, setup generates a value and prints a PowerShell export line for the
current process; copy it into the environment and rerun setup.

### Manual YAML alternative

The CLI is additive, not required. To configure by hand, copy the complete
example and set the environment variables yourself:

```powershell
Copy-Item .\config.example.yaml .\gremlyn.yaml
$env:GREMLYN_GITHUB_TOKEN = 'your-dedicated-bot-token'
$env:GREMLYN_CONSOLE_TOKEN = 'your-long-random-local-token'
```

Then edit `gremlyn.yaml`: set `github.orchestrator_login`,
`git.author_name`/`git.author_email`, `allowed_authors`, each repository's exact
`owner`, `name`, `source_path`, and separate `workspace_root`, the Cline
`credential_source`, provider-qualified `model`, `allowed_models`, and explicit
`validation_commands`. Keep the token values out of the file; `token_env` names
only the environment variables that hold them. Manual edits can be checked with
`npm run verify:config -- --config .\gremlyn.yaml`.

The configured GitHub token should have only the repository permissions needed to
read pull requests and review comments and post review replies. Git pushes use
the host's existing Git credential configuration. Do not use a personal API token
if a dedicated bot identity is available. Fork PRs are deliberately unsupported.

### Agent authentication and credential isolation

Cline stores provider credentials under its data directory (`secrets.json`).
Gremlyn isolates per-attempt agent state behind a fresh `--data-dir` so
concurrent attempts cannot corrupt each other's session state (`locks.db`,
`sessions/`). To keep isolation without losing authentication, Gremlyn seeds
each attempt's `--data-dir` from the configured `credential_source` before
launching the agent, copying only `secrets.json` with owner-only permissions
(`0o600`). The seeded copy lives no longer than the attempt: it is removed
with the attempt directory on success, failure, timeout, and cancellation, and
stale directories left by a killed process are removed on the next startup.
No credential value is passed on the argument vector or through the environment,
and the source directory is never modified.

Authenticate the agent once on the host:

```powershell
cline auth login
# or: cline auth --provider cline-pass etc, depending on provider
```

Verify the credential source exists and contains `secrets.json`:

```powershell
Get-ChildItem C:/Users/<you>/.cline/data\secrets.json
```

Re-verify the credential seed set when the pinned Cline version changes
(`EXPECTED_CLINE_VERSION` in `src/agent/cline.ts`):

```powershell
# Unseeded should be Unauthorized, seeded should be completed
npm run probe:agent -- --provider cline-pass --model z-ai/glm-5.3-flash --effort xhigh --seed-source C:/Users/<you>/.cline/data
# Expected: first run Unauthorized (~300 ms, exit 1), second run completed (exit 0, READY)
```

If the seed set ever becomes incomplete (e.g. a new Cline version moves
credentials), the seeded probe will return `Unauthorized` again; widen the
declared list in `src/agent/credentials.ts:CREDENTIAL_SEED_FILES` and re-run the
probe until the seeded run reaches `finishReason: "completed"`.

A clean setup can be brought to a first successful agent invocation by
following Install → Configure → Authenticate → `npm run probe:agent -- --seed-source ...`
above; `npm start -- .\gremlyn.yaml` will then refuse startup only on a bad
credential source and otherwise run jobs with per-attempt isolation.

The bot identity polls and replies through GitHub's API. Git transport remains
separate: the host's Git credentials authenticate the push, while the configured
author name and verified email determine which human profile receives commit
attribution.

### OpenCode

Gremlyn can also run [OpenCode](https://opencode.ai) (pinned to **1.18.27**),
registered alongside or instead of Cline. Each configured agent declares an
executor `kind` (`cline` or `opencode`), defaulting to the agent's own key —
`agents.opencode` resolves to the OpenCode executor with no extra field
needed. A repository selects its agent with the existing `agent:` setting; two
agents can run concurrently, each job using its own repository's agent.

Differences from the Cline path, all handled without any repository-level
change beyond `agent: opencode`:

- **Credential**: a single `auth.json`, holding whatever OpenCode's own
  `opencode auth login` (or `opencode auth` / `providers`) stored. The
  `credential_source` for an OpenCode agent is that installation's data root —
  `opencode debug paths` reports it (typically
  `C:/Users/<you>/.local/share/opencode`). Isolation, seeding, owner-only
  permissions, and teardown per attempt all work identically to Cline.
- **Provider**: OpenCode has no separate provider argument — it is folded into
  the model id as `opencode/<model>` (`opencode models opencode` lists them).
  A repository naming an OpenCode agent does not need a `provider` field at
  all. The console's repository settings offer an "OpenCode" entry in the
  Provider picker listing every model Zen serves (the full `opencode models
  opencode` output for the pinned release); picking "Custom provider" instead
  (shared with Cline) still works for any other `provider/model` OpenCode
  understands — an installation-specific one you authenticated yourself, say
  — and whatever is typed there is accepted and ignored by the executor
  either way. Bumping the pinned OpenCode version means re-pasting that
  command's output into `OPENCODE_MODEL_IDS` in
  `src/agent/provider-catalog.ts`.
- **Retries**: OpenCode's CLI has no retry flag, so `agent_defaults.retries`
  is enforced by Gremlyn itself, re-running the whole invocation up to that
  many times on failure — see the comment in `config.example.yaml`. This
  counts whole invocations, not the consecutive-mistake allowance Cline's own
  `--retries` counts; the same number means a different thing for each agent.
- **Billing failures**: a provider that accepts the credential but refuses the
  request for lack of credit or a payment method is recorded as
  `agent-billing-failed`, distinct from `agent-auth-failed` — re-authenticating
  will not fix it; the account needs attention instead.

Verify an OpenCode installation the same way as Cline:

```powershell
npm run probe:agent -- --kind opencode --provider <id> --model opencode/<model> --seed-source C:/Users/<you>/.local/share/opencode
```

## Start and verify connectivity

```powershell
npm start -- .\gremlyn.yaml
```

Startup validates the configuration, the GitHub bot identity, every configured agent's CLI version, data-directory exclusivity, and console bind. A successful start logs `orchestrator started` and begins polling.

Open `http://127.0.0.1:4780/auth`, enter `GREMLYN_CONSOLE_TOKEN`, and sign in. The redesigned dashboard shows a health strip with the latest poll, freshness/staleness, queue depth, and active-versus-configured concurrency, followed by repository cards (agent, model, effort, timeout, validation commands, and an enable/disable control) and running, queued, and recent job lanes. Leave timeout blank for no limit, or enter seconds for that repository; the setting is live and persisted in SQLite. Each job has a structured detail page with a timeline, attempt diagnostics, validation output, status-specific actions, pull-request/comment links, and a separately confirmed danger zone for workspace reset. The **Commands** view explains every observed command, including authorization refusals and their reasons; the **Audit** view lists manual actions and their effects. Console wall-clock values use the host timezone by default; set `console.timezone` to an IANA timezone such as `Asia/Taipei` when the operator is remote. Stored instants remain UTC and are retained on each time element.

Then add `!RESOLVE` as a reply in an inline PR review thread authored by an allowlisted login. The console should show the job progressing through queued, preparing, running, validating, publishing, reporting, and a terminal state without requiring a page reload; live updates replace only the affected dashboard or job regions, preserving expanded sections and typed confirmation text. Use the retry/cancel controls when their current-state rules allow them, and use the repository toggle when ingestion should be paused.

Stop with `Ctrl+C`. Gremlyn marks jobs left in transient states as interrupted on the next startup; it does not silently rerun them. Retrying that interrupted job may resume its retained PR workspace when the recorded head and deterministic path still match; unrelated dirty workspaces remain blocked.

## Development

```powershell
npm ci
npm run build
npm run lint
npm run format:check
npm test
```

Tests use fixture GitHub clients, a fake agent, and temporary real git repositories. They do not need network access or paid agent invocations. `npm start -- .\gremlyn.yaml` is the production connectivity check and does use GitHub and Cline.

## Troubleshooting

- `Setup is incomplete`: inspect every `FAIL` prerequisite, export the named token variables, authenticate the configured agent, or correct the configuration values, then rerun `npm run setup`.
- `owner and name cannot be derived`: the checkout has no usable GitHub `origin`; supply `--owner` and `--name`, then correct the remote before retrying.
- `workspace root is the source path or lies inside the source repository`: choose a separate `--workspace-root` outside the checkout and every other configured source path.
- `registration aborted`: setup leaves the configuration unchanged; apply the remedy printed for each failed check and rerun the command.
- `missing validation-commands` or `pass --yes to accept the proposal`: use `--yes` for inferred values in automation, or provide explicit flags such as `--validation-command` and `--workspace-root`.
- `github token missing` or `console token missing`: define the named environment variable in the same PowerShell process before starting.
- `token authenticates as ..., expected ...`: correct `github.orchestrator_login` or use the dedicated account's token.
- `unsupported Cline version` or `unsupported OpenCode version`: install the pinned release (Cline 3.0.61, OpenCode 1.18.27); startup refuses a drifting CLI surface rather than failing during a job.
- `no production executor is registered for agent "..." (kind "...")`: the agent's `kind` (or its id, when `kind` is omitted) does not match a registered executor — use `cline` or `opencode`.
- `credential source for agent "cline" not found` or `is not readable`: set `agents.cline.credential_source` to the authenticated `~/.cline/data` directory (e.g. `C:/Users/<you>/.cline/data`) and confirm `secrets.json` exists; startup checks this before accepting jobs. For an OpenCode agent, the equivalent is `auth.json` under its data root (`opencode debug paths`).
- `agent-auth-failed` (or `Unauthorized` in job detail/GitHub reply): the agent could not authenticate with its provider — verify `cline auth` (or `opencode auth`) and that the credential source still contains its declared files, then retry; this is distinct from `agent-nonzero-exit`.
- `agent-billing-failed`: the credential was accepted but the provider refused the request for lack of credit or a payment method — add a payment method or credit to the account; re-authenticating will not help. Distinct from `agent-auth-failed`.
- `another Gremlyn instance is already using data directory`: stop the other process before starting a second instance against the same `data_dir`.
- `workspace-dirty`, `workspace-conflicted`, or `workspace-corrupted`: inspect the per-PR workspace. Gremlyn preserves evidence and requires an explicit confirmed reset from the console, except that retrying an interrupted, cancelled, timed-out, or crashed-nonzero-exit agent may resume its own deterministic workspace when its recorded PR head still matches.
- `pull-request-closed`, `head-changed`, or `push-rejected`: refresh the PR state and retry deliberately. Gremlyn never force-pushes.
- Console returns `401`: sign in again at `/auth`; every job-data and action route requires the console token.
- No command is detected: `!RESOLVE` must be a standalone token at the start of a line in an inline review-comment thread, not a top-level PR conversation comment or quoted code.

Captured agent and validation output is stored beneath `data_dir`; SQLite stores references and structured lifecycle records. Configured secrets are redacted from logs and console views.
