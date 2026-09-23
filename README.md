# Gremlyn

Gremlyn is a local PR-resolution orchestrator. It polls configured GitHub repositories for an authorized `!RESOLVE` reply on an inline review thread, prepares an isolated git checkout, runs Cline, independently validates the result, pushes a normal commit to the existing PR branch, and replies with the outcome. The developer's normal checkout is never modified. Context: I normally use 5.6 SOL HIGH in chat mode to review my PR's since it doesn't incur weekly usage; this is the invariant I try to create gremlyn around. Would I be extending this to the whole implementation pipeline? Maybe, but I treat the ideation (explore and proposal), first run implementation(apply) and the output corrections (PR, feedback and subsequent changes) as 3 separate processes that shouldn't be time locked.

Automatic workspace reclamation is opt-in. It only considers deterministic `pr-N` directories beneath configured workspace roots, and retains active, recent, dirty, or indeterminate workspaces. Review the decisions without deleting anything before enabling it:

```powershell
npm run setup -- reclaim --preview --config .\gremlyn.yaml
```

Set `workspace_reclamation.enabled: true` and adjust `minimum_age_seconds` only after reviewing the preview. Every reclamation and refusal is recorded in the operator audit.

Artifact retention is separately opt-in. Set `artifact_retention.enabled: true`
to trim terminal-job output, validation files, and per-attempt state after
`maximum_age_seconds` or when the combined `maximum_total_bytes` ceiling is
exceeded. Trimming is oldest-first and never removes artifacts for a live job;
the job view labels files that are no longer retained.

Foreign branch holders are cloned into the configured workspace root by default.
Set a repository's `adopt_worktree: true` only when you explicitly want a clean,
validated operator checkout to be used in place; dirty or claimed checkouts are
left untouched and cloned instead. Adopted attempts are marked in the console.

## Requirements

- Windows 10/11 with PowerShell (WSL is not required)
- Node.js 22 or newer and npm 10 or newer
- Git 2.x
- Cline CLI 3.0.62, already authenticated with the provider used by your configured model
  (both agent CLIs are version-pinned; `npm start` keeps the pins current — see
  [Keeping the agent CLI pins current](#keeping-the-agent-cli-pins-current))
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

Gremlyn can also run [OpenCode](https://opencode.ai) (pinned to **1.18.32**),
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
  the model id as `<namespace>/<model>` (`opencode models` lists every id the
  installation can reach). A repository naming an OpenCode agent does not need
  a `provider` field at all. The console's repository settings offer three
  entries in the Provider picker, one per namespace `opencode auth login` can
  authenticate: **OpenCode Zen** (`opencode/<model>`, pay-as-you-go),
  **OpenCode Go** (`opencode-go/<model>`, the Go subscription), and **OpenAI**
  (`openai/<model>`, your own OpenAI account). They are genuinely separate
  providers, not billing modes of one: `auth.json` holds a distinct credential
  for each, and their model rosters only partly overlap — Go alone serves
  `longcat-2.0`, the `hy*` tiers and `qwen3.7`/`3.8`, while Zen
  alone serves the Anthropic and most GPT tiers (1.18.29 also brought Zen
  `glm-5.3`/`glm-5.3-flash`, previously Go-only). OpenAI is the one namespace
  OpenCode does not host: OpenCode logs into OpenAI directly — its login menu
  offers "OpenAI (ChatGPT Plus/Pro or API key)" — and those models bill to
  whichever of the two you authenticated, which is also why the picker shows
  them without a subscription badge. Note this is _not_ the same route as
  Cline's **OpenAI Codex** provider, which is Cline's own
  ChatGPT-subscription OAuth driven by the Cline binary; neither executor can
  use the other's credential, so each is offered only to repositories running
  its own agent. All three are covered by the same seeded `auth.json`, so
  selecting a Go or OpenAI model needs no configuration beyond having run
  `opencode auth login` for that plan. Picking "Custom provider"
  instead (shared with Cline) still works for any other `provider/model`
  OpenCode understands — an installation-specific one you authenticated
  yourself, say — and whatever is typed there is accepted and ignored by the
  executor either way. Bumping the pinned OpenCode version means re-pasting
  that command's output into `OPENCODE_ZEN_MODEL_IDS`,
  `OPENCODE_GO_MODEL_IDS`, and `OPENCODE_OPENAI_MODEL_IDS` in
  `src/agent/provider-catalog.ts`, then setting `OPENCODE_ROSTER_VERSION`
  there to the new pin. `pin:sync` bumps the pin on its own but cannot refresh
  a hand-pasted roster, so that constant is what a test compares against
  `EXPECTED_OPENCODE_VERSION` — a bump stays red until the lists are
  refreshed. Note the rosters are served dynamically, so ids also come and go
  between releases; re-paste, do not assume the previous list is still
  current.
- **Provider/executor pairing**: A Cline repository configured with the
  `opencode` provider is refused per attempt, before its workspace is prepared.
  Cline's OpenCode provider runs tools inside a long-lived server whose working
  directory was fixed when the server started, so merely warning at startup
  would leave the attempt's workspace unprotected.
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

Use the model id you actually intend to run, including a Go one — the Zen and
Go namespaces authenticate independently, so a green Zen probe says nothing
about Go:

```powershell
npm run probe:agent -- --kind opencode --provider "" --model opencode-go/kimi-k3 --seed-source C:/Users/<you>/.local/share/opencode
```

## Start and verify connectivity

```powershell
npm start -- .\gremlyn.yaml
```

Startup validates the configuration, the GitHub bot identity, every configured agent's CLI version, data-directory exclusivity, and console bind. A successful start logs `orchestrator started` and begins polling.

Open `http://127.0.0.1:4780/auth`, enter `GREMLYN_CONSOLE_TOKEN`, and sign in. The redesigned dashboard shows a health strip with the latest poll, freshness/staleness, queue depth, and active-versus-configured concurrency, followed by repository cards (agent, model, effort, timeout, validation commands, and an enable/disable control) and running, queued, and recent job lanes. Leave timeout blank for no limit, or enter seconds for that repository; the setting is live and persisted in SQLite. Each job has a structured detail page with a timeline, attempt diagnostics, validation output, status-specific actions, pull-request/comment links, and a separately confirmed danger zone for workspace reset. The **Commands** view explains every observed command, including authorization refusals and their reasons; the **Audit** view lists manual actions and their effects. Console wall-clock values use the host timezone by default; set `console.timezone` to an IANA timezone such as `Asia/Taipei` when the operator is remote. Stored instants remain UTC and are retained on each time element.

Then add `!RESOLVE` as a reply in an inline PR review thread authored by an allowlisted login. The console should show the job progressing through queued, preparing, running, validating, publishing, reporting, and a terminal state without requiring a page reload; live updates replace only the affected dashboard or job regions, preserving expanded sections and typed confirmation text. Use the retry/cancel controls when their current-state rules allow them, and use the repository toggle when ingestion should be paused.

Stop with `Ctrl+C`. Gremlyn marks jobs left in transient states as interrupted on the next startup; it does not silently rerun them. Retrying that interrupted job may resume its retained PR workspace when the recorded head and deterministic path still match; unrelated dirty workspaces remain blocked.

### Keeping the agent CLI pins current

Both agent CLIs are pinned to one release (`EXPECTED_CLINE_VERSION`,
`EXPECTED_OPENCODE_VERSION`) and startup refuses anything else, because each
executor builds argv against a surface that was probed by hand. OpenCode ships
patch releases several times a week and updates itself, so that gate would
otherwise stop a working installation over a release that changed nothing
Gremlyn passes.

`npm start` therefore runs the pin sync first (`prestart`). It compares each
installed CLI against its pin and, when they differ, re-probes the surface the
executor actually depends on before doing anything:

- **in sync** — silent; startup proceeds.
- **newer, surface intact** — the pin and its documented mentions are rewritten,
  and startup proceeds. The rewrite is a real source change: commit it.
- **surface moved** — nothing is written and the pin stays put. Startup then
  refuses with the usual `unsupported ... version`, which is the correct
  outcome: a flag the executor passes has been renamed or dropped.

The surface checks are the same commands the pin's own bump note names —
`opencode run --help`, `opencode debug paths`, `opencode export --help`, and
`cline --help` — asserting each flag the executor passes (`--dir`, `-m`,
`--format json`, `--auto`, `--thinking`, `--variant`, the `sessionID`
positional, and Cline's `--data-dir`/`--auto-approve`/`--retries`/`-t`). It also
reports when `opencode models` no longer matches the bundled picker roster,
which never blocks a run but does leave the console's model list stale.

```powershell
npm run pin:sync    # sync now, writing any verified bump
npm run pin:check   # report only; exits non-zero when a pin is behind (CI)
npm run pin:sync -- --kind opencode
```

A bump made this way is verified against the CLI's help surface, not against a
real invocation. Before trusting one for a long run, re-probe with a live
credential: `npm run probe:agent -- --kind opencode --provider <id> --model <id>`.
`start:built` runs compiled output and has no `prestart`; there, run
`npm run pin:sync; npm run build` first.

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
- `unsupported Cline version` or `unsupported OpenCode version`: run `npm run pin:sync` — when the newer CLI still exposes the probed surface it bumps the pin for you, and `npm start` does this automatically. Seeing this error after a sync means the surface really moved: reinstall the pinned release (Cline 3.0.62, OpenCode 1.18.32) with `npm install -g opencode-ai@1.18.32`, then re-probe before pinning forward. Startup refuses a drifting CLI surface rather than failing during a job.
- `no production executor is registered for agent "..." (kind "...")`: the agent's `kind` (or its id, when `kind` is omitted) does not match a registered executor — use `cline` or `opencode`.
- `credential source for agent "cline" not found` or `is not readable`: set `agents.cline.credential_source` to the authenticated `~/.cline/data` directory (e.g. `C:/Users/<you>/.cline/data`) and confirm `secrets.json` exists; startup checks this before accepting jobs. For an OpenCode agent, the equivalent is `auth.json` under its data root (`opencode debug paths`).
- `agent-auth-failed` (or `Unauthorized` in job detail/GitHub reply): the agent could not authenticate with its provider — verify `cline auth` (or `opencode auth`) and that the credential source still contains its declared files, then retry; this is distinct from `agent-nonzero-exit`.
- `provider-executor-mismatch`: the provider cannot be driven by the configured agent, so tool execution would leave the attempt's workspace; Gremlyn refuses the attempt before preparing that workspace. Change the provider/agent pairing — re-authenticating will not help. This is distinct from both `agent-auth-failed` and `agent-billing-failed`.
- `agent-billing-failed`: the credential was accepted but the provider refused the request for lack of credit or a payment method — add a payment method or credit to the account; re-authenticating will not help. Distinct from `agent-auth-failed`.
- `another Gremlyn instance is already using data directory`: stop the other process before starting a second instance against the same `data_dir`.
- `workspace-dirty`, `workspace-conflicted`, or `workspace-corrupted`: inspect the per-PR workspace. Gremlyn preserves evidence and requires an explicit confirmed reset from the console, except that a retry may resume the attempt's own deterministic workspace when its recorded PR head still matches. That applies to an interrupted, cancelled, timed-out, or crashed-nonzero-exit agent, and to an attempt blocked at publication by a failing validation command — a retry of that last case resumes the edits and tells the agent which command rejected them, so there is no need to clean the workspace by hand first. Every other publication block (`no-changes`, `head-changed`, `pull-request-closed`, a conflicted or invalid workspace) still requires the manual route.
- `pull-request-closed`, `head-changed`, or `push-rejected`: refresh the PR state and retry deliberately. Gremlyn never force-pushes.
- Console returns `401`: sign in again at `/auth`; every job-data and action route requires the console token.
- No command is detected: `!RESOLVE` must be at the start of a line (text after it on that line is ignored) in an inline review-comment thread, not a top-level PR conversation comment or quoted code.

Captured agent and validation output is stored beneath `data_dir`; SQLite stores references and structured lifecycle records. Configured secrets are redacted from logs and console views.
