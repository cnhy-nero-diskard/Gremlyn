# Gremlyn

Gremlyn is a local PR-resolution orchestrator. It polls configured GitHub repositories for an authorized `!RESOLVE` reply on an inline review thread, prepares an isolated git worktree, runs Cline, independently validates the result, pushes a normal commit to the existing PR branch, and replies with the outcome. The developer's normal checkout is never modified.

## Requirements

- Windows 10/11 with PowerShell (WSL is not required)
- Node.js 22 or newer and npm 10 or newer
- Git 2.x
- Cline CLI 3.0.60, already authenticated with the provider used by your configured model
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

Copy the complete example configuration and create local secrets:

```powershell
Copy-Item .\config.example.yaml .\gremlyn.yaml
$env:GREMLYN_GITHUB_TOKEN = 'your-dedicated-bot-token'
$env:GREMLYN_CONSOLE_TOKEN = 'generate-a-long-random-local-token'
```

Never put either token in `gremlyn.yaml`. The file names the environment variables; secret values come from the environment only.

## Configure

Edit `gremlyn.yaml`:

- Set `github.orchestrator_login` to the login authenticated by `GREMLYN_GITHUB_TOKEN`.
- Set `git.author_name` and `git.author_email` to the human identity that should
  receive commit attribution. The email must be verified on that GitHub account;
  it does not need to belong to the bot account that pushes the commit.
- Put permitted human GitHub logins in `allowed_authors`. The bot login must not appear there.
- For each repository, set its exact `owner`, `name`, local `source_path`, and a separate `workspace_root`.
- Keep `source_path` and `workspace_root` distinct. Workspaces are created as `<workspace_root>/pr-<number>`.
- Set `agent: cline`, the provider-qualified `model`, and `allowed_models`.
- Set `agents.cline.credential_source` to the authenticated Cline data directory
  (conventional default `C:/Users/<you>/.cline/data` on Windows or `~/.cline/data`
  elsewhere). This is the directory where `cline auth` stored `secrets.json`. It
  is read-only, verified at startup, and never written to; a missing or
  unreadable source refuses startup with a configuration error naming the agent
  and location rather than failing per-job.
- Set validation commands as argument arrays, for example `[npm, test]`. An empty list intentionally performs git inspection only; Gremlyn never invents fallback commands.
- Leave `effort` unset to use Cline's highest supported tier, `xhigh`.

Confirm the configured source repository has an `origin` remote and that the host's
existing Git credentials can push to same-repository PR branches. Fork PRs are
deliberately unsupported.

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

## Start and verify connectivity

```powershell
npm start -- .\gremlyn.yaml
```

Startup validates the configuration, the GitHub bot identity, Cline version, data-directory exclusivity, and console bind. A successful start logs `orchestrator started` and begins polling.

Open `http://127.0.0.1:4780/auth`, enter `GREMLYN_CONSOLE_TOKEN`, and sign in. The redesigned dashboard shows a health strip with the latest poll, freshness/staleness, queue depth, and active-versus-configured concurrency, followed by repository cards (agent, model, effort, validation commands, and an enable/disable control) and running, queued, and recent job lanes. Each job has a structured detail page with a timeline, attempt diagnostics, validation output, status-specific actions, pull-request/comment links, and a separately confirmed danger zone for workspace reset. The **Commands** view explains every observed command, including authorization refusals and their reasons; the **Audit** view lists manual actions and their effects.

Then add `!RESOLVE` as a reply in an inline PR review thread authored by an allowlisted login. The console should show the job progressing through queued, preparing, running, validating, publishing, reporting, and a terminal state without requiring a page reload; live updates replace only the affected dashboard or job regions, preserving expanded sections and typed confirmation text. Use the retry/cancel controls when their current-state rules allow them, and use the repository toggle when ingestion should be paused.

Stop with `Ctrl+C`. Gremlyn marks jobs left in transient states as interrupted on the next startup; it does not silently rerun them.

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

- `github token missing` or `console token missing`: define the named environment variable in the same PowerShell process before starting.
- `token authenticates as ..., expected ...`: correct `github.orchestrator_login` or use the dedicated account's token.
- `unsupported Cline version`: install Cline 3.0.60; startup refuses a drifting CLI surface rather than failing during a job.
- `credential source for agent "cline" not found` or `is not readable`: set `agents.cline.credential_source` to the authenticated `~/.cline/data` directory (e.g. `C:/Users/<you>/.cline/data`) and confirm `secrets.json` exists; startup checks this before accepting jobs.
- `agent-auth-failed` (or `Unauthorized` in job detail/GitHub reply): the agent could not authenticate with its provider — verify `cline auth` and that the credential source still contains `secrets.json`, then retry; this is now distinct from `agent-nonzero-exit`.
- `another Gremlyn instance is already using data directory`: stop the other process before starting a second instance against the same `data_dir`.
- `workspace-dirty`, `workspace-conflicted`, or `workspace-corrupted`: inspect the per-PR workspace. Gremlyn preserves evidence and requires an explicit confirmed reset from the console.
- `pull-request-closed`, `head-changed`, or `push-rejected`: refresh the PR state and retry deliberately. Gremlyn never force-pushes.
- Console returns `401`: sign in again at `/auth`; every job-data and action route requires the console token.
- No command is detected: `!RESOLVE` must be a standalone token at the start of a line in an inline review-comment thread, not a top-level PR conversation comment or quoted code.

Captured agent and validation output is stored beneath `data_dir`; SQLite stores references and structured lifecycle records. Configured secrets are redacted from logs and console views.
